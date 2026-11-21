import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

import {
  completeIosChangeDetection,
  nativeSelectorChangedFiles,
  planIosChangeDetection,
  readSelectorDecision,
  selectorDecisionErrors,
  type DetectSelectionPlan,
  type GateContext,
  type SelectorDecisions,
} from '../src/ios/iosChangeGate.ts';
import { affectedUiOwners } from '../src/ios/affectedUiOwners.ts';
import { createGithubReader } from '../src/ios/shared/githubRest.ts';
import type { StepOutput } from '../src/ios/shared/stepIo.ts';
import {
  MAC_LANES,
  candidateMacMinutes,
  NO_NATIVE_JOBS,
  attemptJobsSettled,
  sampleMinutes,
  laneOutcomes,
  laneReuseBlockers,
  median,
  replayCandidate,
  selectedMacLanes,
  type FirstParentCommit,
  type LaneOutcome,
  type MacLane,
  type MacLaneMinutes,
  type NativeJobPlan,
  type ReplayJob,
} from '../src/mergeGroupReplay.ts';
import {
  deriveNativeExecutionPlan, iosLaneSchema, selectionModeSchema, type IosLane,
} from '../src/nativeExecutionPlan.ts';
import { parseGitChangeInventory } from '../src/prChangeInventory.ts';

/**
 * Merge-queue plan S2 replay (docs/ci/merge-queue-plan.md).
 *
 * Replays the last N first-parent commits of `develop` as single-entry queue
 * candidates through the S1 planner (the iOS change gate and affected-test
 * selector at this checkout, fed `diff(B, C)`), applies the plan's reuse rule
 * to each selected Mac lane, estimates Mac minutes, and checks every reuse it
 * granted against the next develop-lineage run (promotion evidence and
 * promotion pull requests) that executed that lane.
 *
 * Usage: GITHUB_TOKEN=$(gh auth token) node ci/scripts/replayMergeGroupPlan.ts
 *          [--count 300] [--ref origin/develop] [--out report.json] [--cache dir]
 */

const REPOSITORY = 'example-org/example-app';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const REPO_ROOT = resolve(import.meta.dirname, '../..');

const { values: args } = parseArgs({
  options: {
    count: { type: 'string', default: '300' },
    ref: { type: 'string', default: 'origin/develop' },
    out: { type: 'string', default: join(tmpdir(), 'merge-group-replay.json') },
    cache: { type: 'string', default: join(tmpdir(), 'merge-group-replay-cache') },
  },
});

function git(gitArgs: readonly string[], allowFailure = false): { status: number; stdout: string } {
  const result = spawnSync('git', gitArgs, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (result.error !== undefined) throw result.error;
  const status = result.status ?? 1;
  if (status !== 0 && !allowFailure) {
    throw new Error(`git ${gitArgs.join(' ')} failed (exit ${status}): ${result.stderr}`);
  }
  return { status, stdout: result.stdout };
}

const token = process.env['GITHUB_TOKEN'] ?? '';
if (token.length === 0) throw new Error('GITHUB_TOKEN is required; run with GITHUB_TOKEN=$(gh auth token).');
const liveReader = createGithubReader({ tokens: [token] });
mkdirSync(args.cache, { recursive: true });

/** Budget E2E occupies a Mac only while this switch is on (`budget-e2e` job condition). */
const budgetSwitch = await liveReader(`${API}/actions/variables/IOS_ENABLE_BUDGET_E2E`);
if (budgetSwitch.status !== 200) {
  throw new Error(`Could not read vars.IOS_ENABLE_BUDGET_E2E (HTTP ${budgetSwitch.statusLabel}); the token needs repository variable read access.`);
}
const budgetSwitchValue = z.object({ value: z.string(), updated_at: z.string() }).parse(budgetSwitch.body);
const budgetE2eEnabled = budgetSwitchValue.value === 'true';
const budgetSwitchUpdatedAt = budgetSwitchValue.updated_at;

/** One live GitHub read; anything but HTTP 200 fails the replay. */
async function fetchJson(url: string): Promise<unknown> {
  const response = await liveReader(`${API}${url}`);
  if (response.status !== 200) throw new Error(`GET ${url} answered HTTP ${response.statusLabel}.`);
  return response.body;
}

/**
 * Bumped whenever what the cache may hold changes. Entries written by any
 * other version (or by the unversioned first replay, which also cached
 * mutable run lists) are ignored and overwritten.
 */
const CACHE_VERSION = 'example.merge-group-replay-cache.v2';
const cacheEntrySchema = z.object({ version: z.literal(CACHE_VERSION), value: z.unknown() });

/**
 * The only cached reads: resources the caller proves can no longer change
 * (`settled`), such as a merged PR or the jobs of one completed run attempt.
 * Everything else goes through `fetchJson`/`allPages` live, so a rerun never
 * reuses a stale run list or an in-progress run.
 */
async function readSettled<T>(key: string, load: () => Promise<T>, settled: (value: T) => boolean): Promise<T> {
  const file = join(args.cache, `${createHash('sha256').update(`${CACHE_VERSION}\n${key}`).digest('hex')}.json`);
  if (existsSync(file)) {
    const entry = cacheEntrySchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (entry.success) return entry.data.value as T;
  }
  const value = await load();
  if (settled(value)) writeFileSync(file, JSON.stringify({ version: CACHE_VERSION, value }));
  return value;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

interface PageReader<T> {
  readonly items: (body: unknown) => readonly T[];
  /** `total_count` when the endpoint reports one. */
  readonly total?: (body: unknown) => number;
  /** For a newest-first list: stop once an item is older than the window. */
  readonly pastWindow?: (item: T) => boolean;
}

/**
 * Every item of a paginated list, read live. A list that is still incomplete
 * after MAX_PAGES fails the replay rather than being judged on part of it.
 */
async function allPages<T>(path: string, reader: PageReader<T>): Promise<T[]> {
  const collected: T[] = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await fetchJson(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
    const items = reader.items(body);
    collected.push(...items);
    const total = reader.total?.(body);
    const last = items.at(-1);
    if (items.length < PAGE_SIZE || (total !== undefined && collected.length >= total)) return collected;
    if (last !== undefined && reader.pastWindow?.(last) === true) return collected;
  }
  throw new Error(`GET ${path} has more than ${MAX_PAGES * PAGE_SIZE} items; refusing to judge a partial list.`);
}

const runPages = (pastWindow?: (run: Run) => boolean): PageReader<Run> => ({
  items: (body) => runsSchema.parse(body).workflow_runs,
  total: (body) => runsSchema.parse(body).total_count,
  ...(pastWindow === undefined ? {} : { pastWindow }),
});

const pullSchema = z.object({
  merge_commit_sha: z.string().nullable(),
  merged_at: z.string().nullable(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
});
const runSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  event: z.string(),
  head_sha: z.string(),
  head_branch: z.string().nullable(),
  run_attempt: z.number().int().positive(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  created_at: z.string(),
  html_url: z.string(),
});
type Run = z.infer<typeof runSchema>;
const runsSchema = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(runSchema) });
const jobsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    labels: z.array(z.string()),
    steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })).default([]),
  })),
});
const commitsSchema = z.array(z.object({ sha: z.string() }));

interface RunJobs {
  readonly run: Run;
  readonly jobs: readonly ReplayJob[];
  readonly macJobs: readonly ReplayJob[];
}

const jobCache = new Map<number, RunJobs>();
async function runJobs(run: Run): Promise<RunJobs> {
  const cached = jobCache.get(run.id);
  if (cached !== undefined) return cached;
  // The jobs of the run's latest attempt, every page of them; a rerun is a new
  // attempt and so a new cache key.
  type AttemptJob = z.infer<typeof jobsSchema>['jobs'][number];
  const attemptJobs = await readSettled<{ readonly total_count: number; readonly jobs: AttemptJob[] }>(
    `attempt-jobs ${run.id} ${run.run_attempt}`,
    async () => {
      let total = 0;
      const jobs = await allPages<AttemptJob>(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, {
        items: (body) => jobsSchema.parse(body).jobs,
        total: (body) => {
          total = jobsSchema.parse(body).total_count;
          return total;
        },
      });
      return { total_count: total, jobs };
    },
    (value) => attemptJobsSettled(run.status, value),
  );
  const jobs = jobsSchema.parse(attemptJobs).jobs.map((job) => ({
    name: job.name, conclusion: job.conclusion, startedAt: job.started_at, completedAt: job.completed_at,
    steps: job.steps, mac: job.labels.includes('macOS'),
  }));
  const entry = { run, jobs, macJobs: jobs.filter((job) => job.mac && job.conclusion !== 'skipped') };
  jobCache.set(run.id, entry);
  return entry;
}

function listFirstParentCommits(ref: string, count: number): (FirstParentCommit & { committedAt: string })[] {
  const out = git(['log', '--first-parent', `-n${count}`, '--format=%H%x1f%P%x1f%s%x1f%cI', ref]).stdout;
  return out.trim().split('\n').map((line) => {
    const [sha = '', parents = '', subject = '', committedAt = ''] = line.split('\x1f');
    return { sha, parents: parents.split(' ').filter(Boolean), subject, committedAt };
  });
}

function changedPaths(from: string, to: string): { changed: string[]; deleted: string[] } {
  const inventory = parseGitChangeInventory(
    git(['diff', '--name-status', '-z', '--find-renames', from, to]).stdout,
  );
  return { changed: [...inventory.changed], deleted: [...inventory.deleted] };
}

function hasCommit(sha: string): boolean {
  return git(['cat-file', '-e', `${sha}^{commit}`], true).status === 0;
}

function ensureCommit(sha: string): boolean {
  if (hasCommit(sha)) return true;
  git(['fetch', '--quiet', '--no-tags', 'origin', sha], true);
  return hasCommit(sha);
}

const GIT_COMMON_DIR = resolve(REPO_ROOT, git(['rev-parse', '--git-common-dir']).stdout.trim());

/** Runs the affected-test selector at this checkout against the candidate tree, as the queue gate does. */
function runSelector(workspace: string, lane: 'evidence' | 'main', changedFiles: string, extra: Record<string, string>): string {
  const output = join(workspace, `.selector-${lane}.txt`);
  writeFileSync(output, '');
  const { GITHUB_ACTIONS: _ignored, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/select-ios-affected-tests.ts')], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: {
      ...inherited,
      ...extra,
      GIT_DIR: GIT_COMMON_DIR,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: workspace,
      IOS_AFFECTED_TESTS_WORKSPACE: workspace,
      IOS_AFFECTED_TESTS_CHANGED_FILES: changedFiles,
      IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY: String(changedFiles.trim() === ''),
      IOS_AFFECTED_TESTS_LANE: lane,
      IOS_AFFECTED_TESTS_MODE: 'affected',
    },
  });
  if (result.status !== 0) throw new Error(`selector (${lane}) failed: ${result.stderr.slice(-2000)}`);
  return readFileSync(output, 'utf8');
}

function lastValue(output: string, key: string): string {
  let value = '';
  for (const line of output.split('\n')) if (line.startsWith(`${key}=`)) value = line.slice(key.length + 1);
  return value;
}

function materialize(sha: string): string {
  const workspace = mkdtempSync(join(tmpdir(), 'merge-group-replay-'));
  const archive = spawnSync('git', ['archive', '--format=tar', sha, 'ios', 'scripts', 'ci', 'shared'], {
    cwd: REPO_ROOT, maxBuffer: 1 << 30,
  });
  if (archive.status !== 0) throw new Error(`git archive ${sha} failed: ${String(archive.stderr)}`);
  const extract = spawnSync('tar', ['-x', '-C', workspace], { input: archive.stdout });
  if (extract.status !== 0) throw new Error(`tar -x for ${sha} failed: ${String(extract.stderr)}`);
  return workspace;
}

/** The S1 `Detect iOS Changes` decision for a candidate, as its published outputs. */
function detectIosOutputs(baseSha: string, candidateSha: string, changedFiles: string): IosDetection {
  const context: GateContext = { forcedIosLanesRaw: '[]', reuseNativeEvidenceRaw: '', changedFilesDelimiter: 'EOF' };
  const plan = planIosChangeDetection(context, { eventName: 'merge_group', baseRef: '', changedFiles, reuseNativeEvidence: '', forcedIosAuxiliaryRaw: '[]' });
  if (plan.kind === 'final') return { outputs: outputMap(plan.outputs), nativeJobs: NO_NATIVE_JOBS };
  try {
    const { decisions, nativeJobs } = selectorDecisions(plan, baseSha, candidateSha);
    return { outputs: outputMap(completeIosChangeDetection(context, plan, decisions, '')), nativeJobs };
  } catch (error: unknown) {
    // The live gate step fails on a selector refusal and the queue ejects the
    // entry; the Mac estimate counts the fail-closed upper bound instead.
    const upperBound = { evidenceRequired: true, mainRequired: true, onboardingRequired: false };
    const message = error instanceof Error ? error.message : String(error);
    const refusal = /(?:^|\n)Error: ([^\n]*)/.exec(message)?.[1] ?? message.slice(0, 300);
    return {
      outputs: outputMap(completeIosChangeDetection(context, plan, upperBound, '')),
      nativeJobs: ALL_NATIVE_JOBS,
      plannerError: refusal,
    };
  }
}

function outputMap(outputs: readonly StepOutput[]): Map<string, string> {
  return new Map(outputs.map((output) => [output.key, output.value]));
}

interface IosDetection {
  readonly outputs: Map<string, string>;
  /** The native Mac jobs the planner schedules when the native lanes execute. */
  readonly nativeJobs: NativeJobPlan;
  /** Set when the selector refused the candidate, which fails the live gate. */
  readonly plannerError?: string;
}

/** Every native job, for a candidate the selector refused (the fail-closed upper bound). */
const ALL_NATIVE_JOBS: NativeJobPlan = { releaseArchive: true, executionLanes: [...iosLaneSchema.options] };

/**
 * The gate's `Classify selected UI work` step: the typed native planner over
 * the main selector's outputs, which decides the Release archive and the
 * execution matrix independently of `main_required`.
 */
function nativeJobPlan(mainSelection: string): NativeJobPlan {
  const onlyTestingFile = lastValue(mainSelection, 'only_testing_file');
  const evidenceGroups = lastValue(mainSelection, 'evidence_groups').split(',').map((group) => group.trim())
    .filter((group) => group.length > 0);
  const identifiers = onlyTestingFile.length === 0 ? [] : readFileSync(onlyTestingFile, 'utf8').split('\n')
    .map((line) => line.trim()).filter((line) => line.length > 0);
  const plan = deriveNativeExecutionPlan({
    selectionMode: selectionModeSchema.parse(lastValue(mainSelection, 'mode')),
    selectionRequired: lastValue(mainSelection, 'should_run') === 'true',
    releaseArchiveRequired: lastValue(mainSelection, 'release_archive_required') === 'true',
    onlyTestingIdentifiers: identifiers,
    evidenceGroups,
    narrowPaywallRequired: lastValue(mainSelection, 'narrow_paywall_required') === 'true',
    forcedLanes: [],
    uiMethodOwners: onlyTestingFile.length === 0 ? {} : affectedUiOwners(onlyTestingFile, evidenceGroups),
  });
  return { releaseArchive: plan.releaseArchiveRequired, executionLanes: plan.executionLanes };
}

function selectorDecisions(
  plan: DetectSelectionPlan,
  baseSha: string,
  candidateSha: string,
): { readonly decisions: SelectorDecisions; readonly nativeJobs: NativeJobPlan } {
  const workspace = materialize(candidateSha);
  try {
    const selectorEnv = { IOS_AFFECTED_TESTS_BASE: baseSha, IOS_AFFECTED_TESTS_HEAD: candidateSha };
    const nativeFiles = nativeSelectorChangedFiles(plan.changedFiles);
    const evidence = runSelector(workspace, 'evidence', nativeFiles, selectorEnv);
    const main = runSelector(workspace, 'main', nativeFiles, {
      ...selectorEnv, IOS_AFFECTED_TESTS_STOREKIT_REQUIRED: String(plan.classification.storekitRequired),
    });
    return {
      decisions: {
        evidenceRequired: readSelectorDecision(lastValue(evidence, 'should_run'), selectorDecisionErrors.evidenceShouldRun),
        mainRequired: readSelectorDecision(lastValue(main, 'should_run'), selectorDecisionErrors.mainShouldRun),
        onboardingRequired: readSelectorDecision(lastValue(main, 'onboarding_required'), selectorDecisionErrors.mainOnboarding),
      },
      nativeJobs: nativeJobPlan(main),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

type LaneVerdict =
  | { readonly kind: 'executed'; readonly reason: string }
  | { readonly kind: 'reused'; readonly sourceRun: string; readonly testedSha: string }
  | { readonly kind: 'not-selected' };

interface CandidateRecord {
  readonly sha: string;
  readonly committedAt: string;
  readonly shape: 'merge' | 'squash';
  readonly prNumber: string;
  readonly baseSha: string;
  readonly prHeadSha: string;
  readonly lanes: Partial<Record<MacLane, LaneVerdict>>;
  readonly lint: 'executed';
  readonly validate: LaneVerdict;
  readonly nativeJobs: NativeJobPlan;
  readonly plannerError?: string;
}

const NOT_SELECTED: LaneVerdict = { kind: 'not-selected' };
const verdictOf = (record: CandidateRecord, lane: MacLane): LaneVerdict => record.lanes[lane] ?? NOT_SELECTED;

/** GitHub lists at most this many commits of a pull request. */
const PULL_COMMIT_LIMIT = 250;

/**
 * The PR's own `ios-tests.yml` runs on any of its heads, newest first. A
 * commit list at GitHub's cap may be truncated, so such a PR offers no
 * evidence (its lanes execute) rather than evidence from a partial list.
 */
async function prIosRuns(prNumber: string, headRef: string, merged: boolean): Promise<Run[]> {
  const commits = await readSettled(
    `pull-commits ${prNumber}`,
    async () => commitsSchema.parse(await allPages(`/pulls/${prNumber}/commits`, { items: (body) => commitsSchema.parse(body) })),
    (list) => merged && list.length < PULL_COMMIT_LIMIT,
  );
  if (commits.length >= PULL_COMMIT_LIMIT) return [];
  const heads = new Set(commits.map((commit) => commit.sha));
  const runs = await allPages(
    `/actions/workflows/ios-tests.yml/runs?event=pull_request&branch=${encodeURIComponent(headRef)}`, runPages(),
  );
  return runs.filter((run) => heads.has(run.head_sha))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

/**
 * The plan's reuse rule for one selected Mac lane against the PR's own runs,
 * newest first. Only a completed, successful run is evidence: a cancelled or
 * failed run may have stopped before every job of the lane ran.
 */
async function macLaneVerdict(lane: MacLane, candidateSha: string, runs: readonly Run[]): Promise<LaneVerdict> {
  for (const run of runs.filter((candidate) => candidate.conclusion === 'success').slice(0, 20)) {
    const outcome = laneOutcomes((await runJobs(run)).jobs).get(lane);
    if (outcome !== 'passed') continue;
    if (!ensureCommit(run.head_sha)) return { kind: 'executed', reason: `tested head ${run.head_sha} unavailable` };
    const since = changedPaths(run.head_sha, candidateSha);
    const blockers = laneReuseBlockers(lane, [...since.changed, ...since.deleted]);
    if (blockers === undefined) return { kind: 'executed', reason: 'server comparison incomplete' };
    if (blockers.length > 0) return { kind: 'executed', reason: `closure changed since ${run.head_sha.slice(0, 9)}: ${blockers.slice(0, 3).join(', ')}` };
    return { kind: 'reused', sourceRun: run.html_url, testedSha: run.head_sha };
  }
  return { kind: 'executed', reason: 'no passing PR evidence for the lane' };
}

async function validateVerdict(candidateSha: string, prHeadSha: string): Promise<LaneVerdict> {
  const sameTree = git(['rev-parse', `${candidateSha}^{tree}`]).stdout.trim()
    === git(['rev-parse', `${prHeadSha}^{tree}`]).stdout.trim();
  if (!sameTree) return { kind: 'executed', reason: 'candidate tree differs from the PR head tree' };
  const headRuns = await allPages(`/actions/runs?head_sha=${prHeadSha}&event=pull_request`, runPages());
  const run = headRuns.filter((candidate) => candidate.name === 'PR Checks')
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
  if (run === undefined) return { kind: 'executed', reason: 'no PR Checks run at the PR head' };
  const validate = (await runJobs(run)).jobs.find((job) => job.name === 'Validate pull request changes');
  return validate?.conclusion === 'success'
    ? { kind: 'reused', sourceRun: run.html_url, testedSha: prHeadSha }
    : { kind: 'executed', reason: `PR Checks Validate ended ${validate?.conclusion ?? 'missing'}` };
}

async function replayCommit(commit: FirstParentCommit & { committedAt: string }): Promise<CandidateRecord | string> {
  const candidate = replayCandidate(commit);
  if (candidate.kind === 'unattributed') return `${commit.sha.slice(0, 9)} ${candidate.reason}`;
  const pull = await readSettled(
    `pull ${candidate.prNumber}`,
    async () => pullSchema.parse(await fetchJson(`/pulls/${candidate.prNumber}`)),
    (value) => value.merged_at !== null,
  );
  if (candidate.kind === 'squash' && pull.merge_commit_sha !== commit.sha) {
    return `${commit.sha.slice(0, 9)} is not the merge commit of #${candidate.prNumber}`;
  }
  const prHeadSha = candidate.kind === 'merge' ? candidate.prHeadSha : pull.head.sha;
  if (!ensureCommit(prHeadSha)) return `${commit.sha.slice(0, 9)} PR head ${prHeadSha} unavailable`;
  const inventory = changedPaths(candidate.baseSha, commit.sha);
  const detected = detectIosOutputs(candidate.baseSha, commit.sha, inventory.changed.join('\n'));
  const selected = selectedMacLanes(detected.outputs, budgetE2eEnabled);
  const runs = selected.size > 0 ? await prIosRuns(candidate.prNumber, pull.head.ref, pull.merged_at !== null) : [];
  const lanes: Partial<Record<MacLane, LaneVerdict>> = {};
  for (const lane of MAC_LANES) {
    lanes[lane] = selected.has(lane) ? await macLaneVerdict(lane, commit.sha, runs) : { kind: 'not-selected' };
  }
  return {
    sha: commit.sha, committedAt: commit.committedAt, shape: candidate.kind, prNumber: candidate.prNumber,
    baseSha: candidate.baseSha, prHeadSha, lanes, lint: 'executed', nativeJobs: detected.nativeJobs,
    validate: await validateVerdict(commit.sha, prHeadSha),
    ...(detected.plannerError === undefined ? {} : { plannerError: detected.plannerError }),
  };
}

/** Promotion evidence dispatches on develop and promotion PR runs: the develop lineage's own Mac verdicts. */
async function developLineageRuns(since: string): Promise<Run[]> {
  // Both lists are newest first, so reading stops at the first page that
  // reaches back past the window instead of truncating inside it.
  const dispatched = await allPages(
    '/actions/workflows/ios-tests.yml/runs?event=workflow_dispatch&branch=develop',
    runPages((run) => run.created_at < since),
  );
  const runs = dispatched.filter((run) => run.created_at >= since);
  const pullSummary = z.array(z.object({ head: z.object({ ref: z.string() }), created_at: z.string() }));
  type PullSummary = z.infer<typeof pullSummary>[number];
  const pulls = await allPages<PullSummary>('/pulls?state=all&base=main&sort=created&direction=desc', {
    items: (body) => pullSummary.parse(body),
    pastWindow: (pull) => pull.created_at < since,
  });
  for (const pull of pulls.filter((candidate) => candidate.created_at >= since && candidate.head.ref.startsWith('promotion/'))) {
    runs.push(...await allPages(
      `/actions/workflows/ios-tests.yml/runs?event=pull_request&branch=${encodeURIComponent(pull.head.ref)}`, runPages(),
    ));
  }
  return runs.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

interface Contradiction {
  readonly sha: string;
  readonly prNumber: string;
  readonly lane: MacLane;
  readonly failingRun: string;
}

function isAncestor(ancestor: string, descendant: string): boolean | undefined {
  if (!ensureCommit(descendant)) return undefined;
  return git(['merge-base', '--is-ancestor', ancestor, descendant], true).status === 0;
}

/** Each reuse against the first later develop-lineage run that executed the lane on a tree containing it. */
async function checkReuse(records: readonly CandidateRecord[], lineage: readonly Run[]) {
  const contradictions: Contradiction[] = [];
  let confirmed = 0;
  let unobserved = 0;
  for (const record of records) {
    for (const lane of MAC_LANES) {
      if (verdictOf(record, lane).kind !== 'reused') continue;
      let first: { run: Run; outcome: LaneOutcome } | undefined;
      for (const run of lineage) {
        if (Date.parse(run.created_at) < Date.parse(record.committedAt)) continue;
        const outcome = laneOutcomes((await runJobs(run)).jobs).get(lane);
        if (outcome === undefined || isAncestor(record.sha, run.head_sha) !== true) continue;
        first = { run, outcome };
        break;
      }
      if (first === undefined) unobserved++;
      else if (first.outcome === 'passed') confirmed++;
      else contradictions.push({ sha: record.sha, prNumber: record.prNumber, lane, failingRun: first.run.html_url });
    }
  }
  return { contradictions, confirmed, unobserved };
}

function laneMinutes(): MacLaneMinutes {
  const samples = new Map<string, number[]>();
  const add = (key: string, value: number | undefined): void => {
    if (value === undefined || value < 1) return;
    samples.set(key, [...(samples.get(key) ?? []), value]);
  };
  for (const { macJobs } of jobCache.values()) {
    const sum = (prefix: string): number | undefined =>
      sampleMinutes(macJobs.filter((job) => job.name.startsWith(prefix)));
    add('nativeBuild', sum('Build shared native iOS test products'));
    add('releaseArchive', sum('Verify unsigned Release archive'));
    for (const lane of iosLaneSchema.options) add(lane, sum(`Test - iOS execution (${lane})`));
    add('e2eBuild', sum('Build shared iOS E2E test products'));
    for (const lane of ['onboarding', 'chat-plaid', 'income', 'budget'] as const) {
      add(lane, sum(`Real-server E2E execution (${lane}`));
    }
  }
  const of = (key: string): number => median(samples.get(key) ?? []);
  const execution: Record<IosLane, number> = {
    native1: of('native1'), native2: of('native2'), native3: of('native3'), native4: of('native4'),
    'evidence-account-update': of('evidence-account-update'),
    'evidence-account-update-2': of('evidence-account-update-2'),
    'evidence-visual': of('evidence-visual'),
  };
  return {
    nativeBuild: of('nativeBuild'), releaseArchive: of('releaseArchive'), execution, e2eBuild: of('e2eBuild'),
    realServer: { onboarding: of('onboarding'), 'chat-plaid': of('chat-plaid'), income: of('income'), budget: of('budget') },
  };
}

function summarize(records: readonly CandidateRecord[], minutes: MacLaneMinutes) {
  const perLane = Object.fromEntries(MAC_LANES.map((lane) => {
    const verdicts = records.map((record) => verdictOf(record, lane).kind);
    return [lane, {
      executed: verdicts.filter((kind) => kind === 'executed').length,
      reused: verdicts.filter((kind) => kind === 'reused').length,
      notSelected: verdicts.filter((kind) => kind === 'not-selected').length,
    }];
  }));
  let withoutReuse = 0;
  let withReuse = 0;
  let macCandidatesWithoutReuse = 0;
  let macCandidatesWithReuse = 0;
  for (const record of records) {
    const selected = new Set(MAC_LANES.filter((lane) => verdictOf(record, lane).kind !== 'not-selected'));
    const executed = new Set(MAC_LANES.filter((lane) => verdictOf(record, lane).kind === 'executed'));
    withoutReuse += candidateMacMinutes(selected, record.nativeJobs, minutes);
    withReuse += candidateMacMinutes(executed, record.nativeJobs, minutes);
    if (selected.size > 0) macCandidatesWithoutReuse++;
    if (executed.size > 0) macCandidatesWithReuse++;
  }
  const validate = records.map((record) => record.validate.kind);
  return {
    candidates: records.length,
    plannerErrors: records.filter((record) => record.plannerError !== undefined).length,
    perLane,
    validate: { executed: validate.filter((kind) => kind === 'executed').length, reused: validate.filter((kind) => kind === 'reused').length },
    macCandidatesWithoutReuse, macCandidatesWithReuse,
    macMinutesWithoutReuse: Math.round(withoutReuse), macMinutesWithReuse: Math.round(withReuse),
    laneMinutes: minutes,
  };
}

const commits = listFirstParentCommits(args.ref, Number(args.count));
const oldest = commits.at(-1)?.committedAt ?? '';
// The switch is read as it is now; a change inside the window would apply the
// wrong value to part of the history, so that replay is refused.
if (Date.parse(budgetSwitchUpdatedAt) > Date.parse(oldest)) {
  throw new Error(`vars.IOS_ENABLE_BUDGET_E2E changed at ${budgetSwitchUpdatedAt}, inside the replay window `
    + `(from ${oldest}); replay a window that starts after that change.`);
}
const records: CandidateRecord[] = [];
const skipped: string[] = [];
for (const [index, commit] of commits.entries()) {
  const result = await replayCommit(commit);
  if (typeof result === 'string') skipped.push(result);
  else records.push(result);
  if ((index + 1) % 25 === 0) process.stderr.write(`replayed ${index + 1}/${commits.length}\n`);
}
const lineage = await developLineageRuns(new Date(Date.parse(oldest)).toISOString());
const reuseCheck = await checkReuse(records, lineage);
const summary = summarize(records, laneMinutes());
const shapes = { merge: records.filter((record) => record.shape === 'merge').length, squash: records.filter((record) => record.shape === 'squash').length };
const report = {
  schema: 'example.merge-group-replay.v1', ref: args.ref, budgetE2eEnabled, head: commits[0]?.sha, oldest, shapes, summary,
  lineageRuns: lineage.length, reuseCheck, skipped, records,
};
writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, records: undefined }, null, 2));

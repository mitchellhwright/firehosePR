import { appendFileSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { readFanOutCandidates } from '../fanOutCandidateReads.ts';
import { fetchGithubGraphqlQuery, fetchGithubWithReadRetry } from '../githubReadRetry.ts';
import {
  admitChildUpdate, candidateBaseRange, resolveFanOutChange, staleChildReason, staleSourceReason,
  type FanOutRange,
} from '../fanOutEvent.ts';
import {
  changedPathsFromTrees, changedRuntimeSourcesFromTrees,
  newlyRequiredRuntimeSourceFiles, newlyRequiredPrHeadWorkflowRuntimeFiles,
  prHeadWorkflowRuntimeFiles, protectedPrRuntimeWorkflows, runtimeSourceFiles,
} from '../workflowRuntimeSkew.ts';
import {
  classifyUpdateBranchResponse,
  candidateNativeIntegrationWorkflow,
  hasRepairableCheckScope,
  latestBaseRetargetAt,
  mayBeSelected,
  MERGE_QUEUE_QUERY,
  mergeQueuePullRequests,
  mergesBaseIntoPullRequests,
  nativeIntegrationEvidence,
  nativeIntegrationJobSchema,
  nativeIntegrationRunSchema,
  openPullRequestSchema,
  overlapMergeability,
  pullRequestTimelineEventSchema,
  reportOnlyOverlaps,
  retiredWorkflowPaths,
  selectPullRequestsToUpdate,
  type FanoutDecision,
  type OpenPullRequest,
} from '../baseUpdateFanout.ts';

/**
 * Runs on protected-base pushes and same-repository PR synchronizations. Reads
 * the base changes each open eligible same-repository pull request still lacks
 * and that pull request's file set once. On `develop` no pull request is ever
 * updated: GitHub's mergeability is read for the pull requests the push
 * overlaps, pull requests in the merge queue are left to the queue, and a
 * conflict is reported. Elsewhere (`main`, a stacked child's parent branch)
 * GitHub is asked to update branches that share a file with those changes,
 * carry a failed check a shared CI repair can fix, carry a retired workflow's
 * check run, or lack a newly required workflow executable. Each pull request
 * gets one `base-update: pr=#N action=... reason=...` line in the log and
 * summary.
 * A push judges every pull request against its own
 * `before..after`; a synchronization judges each stacked child against its
 * merge base with the new head, so a replaced pending synchronization cannot
 * hide the commits it carried (see `FanOutChange`).
 * The update commit is made by GitHub (web-flow), which the base-update
 * classifier treats as a verified base update, so unaffected evidence is
 * reused and a conflict is reported on the pull request within a minute of
 * the merge that caused it. Nothing here waits: the update itself is
 * asynchronous on GitHub's side and the pull request's own events carry on.
 */

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const repository = requiredEnvironment('REPOSITORY');
const change = resolveFanOutChange(
  requiredEnvironment('GITHUB_EVENT_NAME'),
  JSON.parse(readFileSync(requiredEnvironment('GITHUB_EVENT_PATH'), 'utf8')),
  repository,
);
const token = requiredEnvironment('UPDATE_TOKEN');
const readToken = requiredEnvironment('READ_TOKEN');
const baseUpdateRunId = requiredEnvironment('GITHUB_RUN_ID');

async function github(path: string, init: RequestInit = {}, requestToken = readToken): Promise<Response> {
  return fetchGithubWithReadRetry(`${apiUrl}/repos/${repository}/${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${requestToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
}

async function githubJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await github(path);
  if (!response.ok) throw new Error(`GET ${path} returned HTTP ${response.status}`);
  return schema.parse(await response.json());
}

/**
 * Walk a paginated endpoint to its end. Every inventory this reads is
 * paginated, and a truncated one is worse than no answer: it silently narrows
 * the fan-out to a prefix and leaves the rest of the fleet stuck.
 */
async function eachPage<T>(path: string, read: (paged: string) => Promise<T[]>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await read(`${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`${path} exceeded the pagination limit`);
}

const pagedJson = <T>(path: string, item: z.ZodType<T>): Promise<T[]> =>
  eachPage(path, (paged) => githubJson(paged, z.array(item)));

const changedFileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string().optional(),
});

/** The commit a branch points at, or `null` when the branch does not exist. */
async function branchTip(branch: string): Promise<string | null> {
  const response = await github(`git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Reading branch ${branch} returned HTTP ${response.status}`);
  return z.object({ object: z.object({ sha: z.string() }) }).parse(await response.json()).object.sha;
}

/**
 * A synchronize run acts only while its `after` is still the live source tip.
 * Checked before any read that decides a mutation and again before each one:
 * an obsolete run must not update children to an older tip, and a deleted or
 * closed source must not fan out at all. The newer synchronize is already
 * queued in the same per-PR group and reconciles cumulatively.
 */
async function sourceStaleness(): Promise<string | null> {
  if (change.reconciliation !== 'pending-base') return null;
  const [livePull, tip] = await Promise.all([
    githubJson(`pulls/${change.sourcePullRequest}`, z.unknown()),
    branchTip(change.baseBranch),
  ]);
  return staleSourceReason(change, repository, livePull, tip);
}

const initialStaleness = await sourceStaleness();
if (initialStaleness !== null) {
  const line = `Skipped fan-out for ${change.baseBranch} at ${change.after.slice(0, 7)}: ${initialStaleness}. `
    + 'A newer synchronize reconciles every child cumulatively.';
  console.log(`::notice::${line}`);
  const skippedSummary = process.env.GITHUB_STEP_SUMMARY;
  if (skippedSummary) appendFileSync(skippedSummary, `## Base-update fan-out\n\n- ${line}\n`);
  process.exit(0);
}

const checkRunSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});

const failedConclusions = new Set([
  'action_required', 'cancelled', 'failure', 'startup_failure', 'timed_out',
]);

async function failedCheckNames(headSha: string): Promise<string[]> {
  const runs = await eachPage(`commits/${headSha}/check-runs?filter=latest`, async (paged) => {
    const result = await githubJson(paged, z.object({ check_runs: z.array(checkRunSchema) }));
    return result.check_runs;
  });
  return [...new Set(runs
    .filter((run) => run.status === 'completed' && run.conclusion !== null && failedConclusions.has(run.conclusion))
    .map((run) => run.name))].sort();
}

/** A rename touches both names, and either side can be what a pull request shares. */
function touchedPaths(file: z.infer<typeof changedFileSchema>): string[] {
  return file.previous_filename ? [file.filename, file.previous_filename] : [file.filename];
}

const COMPARE_FILE_CAP = 300;

/** What one base range asks of the pull requests that still lack it. */
interface RangeAnalysis {
  readonly range: FanOutRange;
  readonly pushedFiles: readonly string[];
  readonly comparisonTruncated: boolean;
  readonly readsFailedChecks: boolean;
  readonly retiredWorkflows: readonly string[];
  readonly newWorkflowRuntimeFiles: readonly string[];
}

type ChangedFile = z.infer<typeof changedFileSchema>;

interface RangePaths {
  readonly comparison: readonly ChangedFile[];
  readonly completeTrees: readonly [unknown, unknown] | null;
  readonly pushedFiles: readonly string[];
}

// Compare caps its file list at 300 for the whole comparison and returns it on
// the first page only — `page` walks the commits, not the files — so there is
// no pagination to do here. A range at the cap uses complete Git trees for
// every path decision instead of trusting that comparison prefix.
async function rangePaths({ before, after }: FanOutRange): Promise<RangePaths> {
  const comparison = (await githubJson(
    `compare/${before}...${after}`,
    z.object({ files: z.array(changedFileSchema).optional() }),
  )).files ?? [];
  if (comparison.length < COMPARE_FILE_CAP) {
    return { comparison, completeTrees: null, pushedFiles: comparison.flatMap(touchedPaths) };
  }
  const completeTrees = await Promise.all([
    githubJson(`git/trees/${before}?recursive=1`, z.unknown()),
    githubJson(`git/trees/${after}?recursive=1`, z.unknown()),
  ] as const);
  return { comparison, completeTrees, pushedFiles: changedPathsFromTrees(completeTrees[0], completeTrees[1]) };
}

/**
 * A deleted workflow can never supersede the check runs it already wrote, so
 * every open pull request keeps them and stays blocked until it gets a new
 * head. Those pull requests overlap no pushed file, so only this reaches them.
 *
 * Asked of the two trees rather than read out of the comparison: the
 * comparison's file list is capped at 300, so a bulk push that also deleted a
 * workflow would report no deletion at all and leave the fleet stuck. A
 * directory listing has no such cap, and two of them answer this exactly.
 *
 * One retirement this cannot catch is its own. A push event dispatches the
 * workflow definition at the pushed revision, so a push that deletes
 * `refresh-pr-ci-after-base-edit.yml` leaves nothing to run and no fan-out
 * happens — for that workflow or for anything deleted alongside it. Retiring
 * this controller therefore means refreshing the open pull requests by hand.
 */
async function workflowFilesAt(ref: string): Promise<Set<string>> {
  const response = await github(`contents/.github/workflows?ref=${encodeURIComponent(ref)}`);
  // A revision from before the directory existed is not an error, it is empty.
  if (response.status === 404) return new Set();
  if (!response.ok) throw new Error(`Listing .github/workflows at ${ref} returned HTTP ${response.status}`);
  const entries = z.array(z.object({ name: z.string(), type: z.string() })).parse(await response.json());
  return new Set(entries.filter((entry) => entry.type === 'file').map((entry) => `.github/workflows/${entry.name}`));
}

const sourceReads = new Map<string, Promise<string>>();
async function sourceAt(path: string, ref: string): Promise<string> {
  const key = `${ref}:${path}`;
  let read = sourceReads.get(key);
  if (read === undefined) {
    read = (async () => {
      const response = await github(`contents/${path}?ref=${encodeURIComponent(ref)}`);
      if (!response.ok) throw new Error(`Reading ${path} at ${ref} returned HTTP ${response.status}`);
      const content = z.object({ content: z.string(), encoding: z.literal('base64') }).parse(await response.json());
      return Buffer.from(content.content, 'base64').toString('utf8');
    })();
    sourceReads.set(key, read);
  }
  return read;
}

async function activeRuntimeFilesAt(ref: string, protectedWorkflows: readonly string[]): Promise<ReadonlySet<string>> {
  const workflowSources = await Promise.all(protectedWorkflows.map((path) => sourceAt(path, ref)));
  const active = new Set(workflowSources.flatMap(prHeadWorkflowRuntimeFiles));
  const pending = [...active];
  // Cache exact-revision reads across all workflows. A capped closure is safer
  // than silently ignoring a dependency cycle or unexpectedly broad source.
  for (let index = 0; index < pending.length; index += 20) {
    if (active.size > 500) throw new Error('Protected workflow runtime closure exceeded 500 files.');
    const batch = pending.slice(index, index + 20).filter((path) => !path.startsWith('scripts/tests/'));
    const sources = await Promise.all(batch.map((path) => sourceAt(path, ref)));
    for (const source of sources) {
      for (const dependency of runtimeSourceFiles(source)) {
        if (active.has(dependency)) continue;
        active.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return active;
}

// A workflow can call a typed action that spawns a shell adapter that in turn
// starts a newly added typed helper. Read changed sources at the exact pushed
// revision as data; never execute them or broaden this controller's checkout.
const runtimeFile = /^(?:ci\/src\/actions\/[A-Za-z0-9_./-]+\.ts|scripts\/[A-Za-z0-9_./-]+\.(?:sh|js|mjs|py))$/;

async function newlyRequiredRuntimeFiles(
  { before, after }: FanOutRange,
  paths: RangePaths,
  workflowsBefore: ReadonlySet<string>,
  workflowsAfter: ReadonlySet<string>,
): Promise<string[]> {
  // A base workflow can start running a newly added entrypoint against an old PR
  // checkout even when the PR shares no changed product file with the push.
  // Compare the before/after workflow commands rather than only new files in
  // this push: an older executable can also become newly required today. At
  // GitHub's 300-file comparison cap, inspect every surviving workflow so a
  // changed workflow hidden past the cap cannot silently escape this guard.
  const protectedWorkflowsAfter = [...workflowsAfter].filter((path) => protectedPrRuntimeWorkflows.has(path));
  const changedWorkflowPaths = paths.completeTrees !== null
    ? protectedWorkflowsAfter
    : [...new Set(paths.comparison.flatMap(touchedPaths))].filter((path) =>
      workflowsAfter.has(path) && protectedPrRuntimeWorkflows.has(path));
  const workflowSourcePairs = await Promise.all(changedWorkflowPaths.map(async (path) => ({
    after: await sourceAt(path, after),
    before: workflowsBefore.has(path) ? await sourceAt(path, before) : '',
  })));
  const changedRuntimePaths = paths.completeTrees === null
    ? paths.comparison.filter((file) => file.status !== 'removed' && runtimeFile.test(file.filename))
    : changedRuntimeSourcesFromTrees(paths.completeTrees[0], paths.completeTrees[1]);
  const runtimeSourcePairs = await Promise.all(changedRuntimePaths.map(async (file) => {
    const afterSource = await sourceAt(file.filename, after);
    if (runtimeSourceFiles(afterSource).length === 0) return { before: '', after: '' };
    const previous = ('previous_filename' in file ? file.previous_filename : undefined) ?? file.filename;
    return {
      before: file.status === 'added' ? '' : await sourceAt(previous, before),
      after: afterSource,
    };
  }));
  const candidateRuntimeFiles = [...new Set([
    ...newlyRequiredPrHeadWorkflowRuntimeFiles(
      workflowSourcePairs.map((pair) => pair.before),
      workflowSourcePairs.map((pair) => pair.after),
    ),
    ...newlyRequiredRuntimeSourceFiles(
      runtimeSourcePairs.map((pair) => pair.before),
      runtimeSourcePairs.map((pair) => pair.after),
    ),
  ])].sort();
  if (candidateRuntimeFiles.length === 0) return [];
  const activeRuntime = await activeRuntimeFilesAt(after, protectedWorkflowsAfter);
  return candidateRuntimeFiles.filter((path) => activeRuntime.has(path));
}

const mergesBase = mergesBaseIntoPullRequests(change.baseBranch);

async function analyzeRange(range: FanOutRange): Promise<RangeAnalysis> {
  const paths = await rangePaths(range);
  // Failed checks, retired workflows and missing executables only select
  // updates. A base that is never merged into pull requests needs just the
  // changed paths, which decide whose mergeability is read.
  if (!mergesBase) {
    return {
      range,
      pushedFiles: paths.pushedFiles,
      comparisonTruncated: paths.completeTrees !== null,
      readsFailedChecks: false,
      retiredWorkflows: [],
      newWorkflowRuntimeFiles: [],
    };
  }
  const [workflowsBefore, workflowsAfter] = await Promise.all([
    workflowFilesAt(range.before),
    workflowFilesAt(range.after),
  ]);
  return {
    range,
    pushedFiles: paths.pushedFiles,
    comparisonTruncated: paths.completeTrees !== null,
    readsFailedChecks: hasRepairableCheckScope(paths.pushedFiles),
    retiredWorkflows: retiredWorkflowPaths([...workflowsBefore].filter((path) => !workflowsAfter.has(path))),
    newWorkflowRuntimeFiles: await newlyRequiredRuntimeFiles(range, paths, workflowsBefore, workflowsAfter),
  };
}

// Stacked children usually share one merge base, and a push shares one range
// with every candidate, so each distinct range is read exactly once.
const rangeAnalyses = new Map<string, Promise<RangeAnalysis>>();
function analysisOf(range: FanOutRange): Promise<RangeAnalysis> {
  const key = `${range.before}..${range.after}`;
  let analysis = rangeAnalyses.get(key);
  if (analysis === undefined) {
    analysis = analyzeRange(range);
    rangeAnalyses.set(key, analysis);
  }
  return analysis;
}

async function missingRuntimeFilesAt(headSha: string, required: readonly string[]): Promise<readonly string[]> {
  return (await Promise.all(required.map(async (path) => {
    const response = await github(`contents/${path}?ref=${encodeURIComponent(headSha)}`);
    if (response.status === 404) return path;
    if (!response.ok) throw new Error(`Reading ${path} at ${headSha} returned HTTP ${response.status}`);
    return null;
  }))).filter((path): path is string => path !== null);
}

const comparisons = new Map<string, Promise<unknown>>();
function compareCommits(base: string, head: string): Promise<unknown> {
  const key = `${base}...${head}`;
  let comparison = comparisons.get(key);
  if (comparison === undefined) {
    comparison = githubJson(`compare/${key}`, z.unknown());
    comparisons.set(key, comparison);
  }
  return comparison;
}

// Every page: a truncated inventory would leave the oldest eligible pull requests
// holding a check run nothing can supersede, which is what this run clears.
const openPulls = await pagedJson(
  `pulls?state=open&base=${encodeURIComponent(change.baseBranch)}`,
  z.object({
    number: z.number().int().positive(),
    draft: z.boolean(),
    user: z.object({ login: z.string().min(1) }),
    head: z.object({
      sha: z.string(),
      ref: z.string().min(1),
      repo: z.object({ full_name: z.string() }).nullable(),
    }),
  }),
);
const headRefs = new Map(openPulls.map((pull) => [pull.number, pull.head.ref]));

type DecisionAction = 'update' | 'report' | 'skip';
/** One machine-readable line per pull request; the last one recorded wins. */
const decisionLines = new Map<number, string>();
function recordDecision(number: number, action: DecisionAction, reason: string): void {
  decisionLines.set(number, `base-update: pr=#${number} action=${action} reason=${reason}`);
}

/**
 * Pull requests this run confirmed in merge conflict at an exact head. Their
 * queued validation can never back a merge, because resolving the conflict
 * makes a new head; the workflow hands this list to the terminal-run cleanup.
 */
interface ConflictedPullRequest {
  readonly number: number;
  readonly headRef: string;
  readonly headSha: string;
}
const conflictedPullRequests: ConflictedPullRequest[] = [];
function recordConflict(number: number, headSha: string): void {
  const headRef = headRefs.get(number);
  if (headRef === undefined) throw new Error(`#${number} is missing from the open pull-request inventory`);
  conflictedPullRequests.push({ number, headRef, headSha });
}

interface RangeCandidates {
  readonly analysis: RangeAnalysis;
  readonly candidates: OpenPullRequest[];
}

// `mayBeSelected` owns the draft, fork and Dependabot ownership rules. Only a
// range's retirement can admit a draft, so the permissive answer decides
// whether a pull request's range is worth reading and the range's own answer
// decides whether its files are worth enumerating.
const rangeGroups = new Map<string, RangeCandidates>();
const nothingNew: number[] = [];
const candidateReads = await readFanOutCandidates(openPulls, async (pull) => {
  const owner = {
    draft: pull.draft,
    authorLogin: pull.user.login,
    headRepositoryFullName: pull.head.repo?.full_name ?? '',
  };
  if (!mayBeSelected(owner, repository, true)) {
    return { kind: 'skip', number: pull.number, reason: 'ineligible' } as const;
  }
  const range = await candidateBaseRange(change, pull.head.sha, compareCommits);
  if (range === null) {
    return { kind: 'skip', number: pull.number, reason: 'already-contains-base' } as const;
  }
  const analysis = await analysisOf(range);
  const retiring = analysis.retiredWorkflows.length > 0;
  if (!mayBeSelected(owner, repository, retiring)) {
    return { kind: 'skip', number: pull.number, reason: 'ineligible' } as const;
  }
  const candidate = openPullRequestSchema.parse({
    number: pull.number,
    ...owner,
    headSha: pull.head.sha,
    // A retirement selects every eligible pull request whatever it touches, so
    // its files would only decorate the log — and enumerating a very large one
    // can exhaust the page limit and abort the fan-out before anything moves.
    files: retiring ? [] : (await pagedJson(`pulls/${pull.number}/files`, changedFileSchema)).flatMap(touchedPaths),
    failedChecks: analysis.readsFailedChecks ? await failedCheckNames(pull.head.sha) : [],
    missingWorkflowRuntimeFiles: await missingRuntimeFilesAt(pull.head.sha, analysis.newWorkflowRuntimeFiles),
  });
  return { kind: 'candidate', range, analysis, candidate } as const;
});
for (const result of candidateReads) {
  if (result.kind === 'skip') {
    if (result.reason === 'already-contains-base') nothingNew.push(result.number);
    recordDecision(result.number, 'skip', result.reason);
    continue;
  }
  const key = `${result.range.before}..${result.range.after}`;
  const group = rangeGroups.get(key) ?? { analysis: result.analysis, candidates: [] };
  rangeGroups.set(key, group);
  group.candidates.push(result.candidate);
}

const candidateCount = [...rangeGroups.values()].reduce((count, group) => count + group.candidates.length, 0);
const selected = [...rangeGroups.values()]
  .flatMap(({ analysis, candidates }) => selectPullRequestsToUpdate(
    repository, change.baseBranch, analysis.pushedFiles, candidates, analysis.retiredWorkflows))
  .sort((left, right) => left.number - right.number);
for (const { candidates } of rangeGroups.values()) {
  for (const candidate of candidates) recordDecision(candidate.number, 'skip', 'no-overlap');
}

// A report-only overlap must not discard passing checks: an overlap on
// develop that changes no selected native product, and a generated-only
// overlap elsewhere. Check GitHub's actual
// mergeability, though: a conflict still needs an explicit resolution by the
// author and must not disappear from this controller's report.
//
// Mergeability is read exactly once: nothing here waits for GitHub to finish
// computing it. An uncomputed answer is logged and skipped. A missed conflict
// only means its queued validation is not cancelled early; GitHub still
// blocks the merge and the queue rejects it, and the next push to the base
// that overlaps the pull request reads it again.
const selectedNumbers = new Set(selected.map((decision) => decision.number));
const overlapping = [...rangeGroups.values()]
  .flatMap(({ analysis, candidates }) =>
    reportOnlyOverlaps(repository, change.baseBranch, analysis.pushedFiles, candidates))
  .filter((candidate) => !selectedNumbers.has(candidate.number));

/** The base's merge queue, read once and only when some pull request could be acted on. */
async function queuedPullRequests(): Promise<ReadonlySet<number>> {
  const [owner, name] = repository.split('/');
  const graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? `${apiUrl}/graphql`;
  const response = await fetchGithubGraphqlQuery(graphqlUrl, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${readToken}` },
    query: MERGE_QUEUE_QUERY,
    variables: { owner, name, branch: change.baseBranch },
  });
  if (!response.ok) throw new Error(`Reading the ${change.baseBranch} merge queue returned HTTP ${response.status}`);
  return mergeQueuePullRequests(await response.json());
}

// The queue builds each entry on the latest base and ejects it on conflict,
// so this controller neither updates nor reports a queued pull request.
const queued = overlapping.length + selected.length > 0 ? await queuedPullRequests() : new Set<number>();
const leaveToQueue = <T extends { readonly number: number }>(pullRequests: readonly T[]): T[] =>
  pullRequests.filter((pullRequest) => {
    if (!queued.has(pullRequest.number)) return true;
    recordDecision(pullRequest.number, 'skip', 'in-merge-queue');
    return false;
  });
const reportOnly = leaveToQueue(overlapping);
const selectedDecisions = leaveToQueue(selected);
const incoherentHeads = new Map<number, string>();
const admissionNotes = new Map<number, string>();
const admitted = await Promise.all(selectedDecisions.map(async (decision) => {
  const admission = await admitChildUpdate(
    change.baseBranch, decision.headSha, repository,
    await githubJson(`pulls/${decision.number}`, z.unknown()), branchTip,
  );
  if (admission.kind === 'current') return decision;
  admissionNotes.set(decision.number, `#${decision.number}: not updated because ${admission.reason}`);
  if (admission.kind === 'incoherent') {
    incoherentHeads.set(decision.number, admission.reason);
    recordDecision(decision.number, 'report', 'head-ref-incoherent');
  } else recordDecision(decision.number, 'skip', 'child-moved');
  console.log(`::${admission.kind === 'incoherent' ? 'error' : 'notice'}::#${decision.number}: ${admission.reason}`);
  return null;
}));
const decisions = admitted.filter((decision): decision is FanoutDecision => decision !== null);
const overlapConflicts: string[] = [];
const unknownOverlapMergeability: string[] = [];
await Promise.all(reportOnly.map(async (candidate) => {
  const live = await githubJson(`pulls/${candidate.number}`, z.unknown());
  if (staleChildReason(change.baseBranch, candidate.headSha, live) !== null) {
    recordDecision(candidate.number, 'skip', 'child-moved');
    return;
  }
  const status = z.object({ mergeable: z.boolean().nullable(), mergeable_state: z.string() }).parse(live);
  const mergeability = overlapMergeability(status.mergeable, status.mergeable_state);
  if (mergeability === 'conflict') {
    recordConflict(candidate.number, candidate.headSha);
    recordDecision(candidate.number, 'report', 'conflict');
    overlapConflicts.push(`#${candidate.number}: conflicts with ${change.baseBranch} on ${candidate.files.join(', ')}; resolve it on the PR before merging.`);
    return;
  }
  if (mergeability === 'clean') {
    recordDecision(candidate.number, 'skip', 'no-conflict');
    return;
  }
  recordDecision(candidate.number, 'skip', 'mergeability-unknown');
  unknownOverlapMergeability.push(`#${candidate.number}: GitHub has not computed mergeability for the overlap on ${candidate.files.join(', ')}.`);
}));

const baseUpdateRun = await githubJson(
  `actions/runs/${encodeURIComponent(baseUpdateRunId)}`,
  z.object({ created_at: z.iso.datetime({ offset: true }) }),
);

/**
 * A delayed fan-out must not rewrite a branch after GitHub has already
 * constructed and started validating the same head against this pushed base.
 * Read all evidence before the first mutation, so a transient inventory error
 * cannot leave the fleet half-updated.
 */
const evidenceByPullRequest = new Map<number, ReturnType<typeof nativeIntegrationEvidence>>();
await Promise.all(decisions.map(async (decision) => {
  // Retiring a workflow is the one intentional exception: its old check run
  // can only disappear after a new head exists, even if native validation for
  // the current integration candidate already started.
  if (decision.retiredWorkflows !== undefined || decision.missingWorkflowRuntimeFiles !== undefined) return;
  // Historical workflow-run pull_requests[].base fields are mutable. The
  // timeline records the last base retarget, so older runs cannot stand in for
  // validation of the PR's current target branch.
  const timeline = await pagedJson(`issues/${decision.number}/timeline`, pullRequestTimelineEventSchema);
  const latestRetarget = latestBaseRetargetAt(timeline);
  const runs = await eachPage(
    `actions/runs?event=pull_request&head_sha=${encodeURIComponent(decision.headSha)}`,
    async (paged) => {
      const result = await githubJson(paged, z.object({ workflow_runs: z.array(nativeIntegrationRunSchema) }));
      return result.workflow_runs;
    },
  );
  const baseUpdateTime = Date.parse(baseUpdateRun.created_at);
  const retargetTime = latestRetarget === null ? 0 : Date.parse(latestRetarget);
  const evidenceCutoff = Math.max(baseUpdateTime, retargetTime);
  const runsWithJobs = await Promise.all(runs.map(async (run) => {
    if (candidateNativeIntegrationWorkflow(decision.number, decision.headSha, evidenceCutoff, run) === null) {
      return { ...run, jobs: [] };
    }
    const jobs = await eachPage(`actions/runs/${run.id}/jobs`, async (paged) => {
      const result = await githubJson(paged, z.object({ jobs: z.array(nativeIntegrationJobSchema) }));
      return result.jobs;
    });
    return { ...run, jobs };
  }));
  evidenceByPullRequest.set(
    decision.number,
    nativeIntegrationEvidence(decision.number, decision.headSha, baseUpdateRun.created_at, runsWithJobs, latestRetarget),
  );
}));

const alreadyValidating = decisions.filter((decision) => evidenceByPullRequest.get(decision.number)?.complete === true);
const updates = decisions.filter((decision) => evidenceByPullRequest.get(decision.number)?.complete !== true);
const short = (sha: string): string => sha.slice(0, 7);
const { baseBranch, after } = change;
const summary: string[] = [
  change.reconciliation === 'event-range'
    ? `Push ${short(change.before)}..${short(after)}: `
    : `Stacked base ${baseBranch} at ${short(after)}, each child judged from its merge base: `,
];
summary[0] += `${decisions.length} of ${candidateCount} open pull request(s) matched, `
  + `${alreadyValidating.length} already validate this base, and ${updates.length} require a branch update.`;
if (!mergesBase) {
  summary.push(`${baseBranch} updates a pull request only when a changed native iOS execution input `
    + `invalidates its selected iOS product; other file overlaps are checked for conflicts.`);
}
for (const line of overlapConflicts.sort()) {
  summary.push(line);
  console.log(`::warning::${line}`);
}
for (const line of unknownOverlapMergeability.sort()) {
  summary.push(line);
  console.log(`::notice::${line}`);
}
if (nothingNew.length > 0) {
  summary.push(`Already contain ${short(after)}, so nothing to merge: ${nothingNew.map((number) => `#${number}`).join(', ')}.`);
}
for (const { analysis, candidates } of rangeGroups.values()) {
  const { range } = analysis;
  const prefix = `Base ${short(range.before)}..${short(range.after)} (${candidates.map((pull) => `#${pull.number}`).join(', ')})`;
  summary.push(`${prefix} touched ${analysis.pushedFiles.length} file(s).`);
  if (analysis.comparisonTruncated) {
    summary.push(`${prefix}: the comparison hit GitHub's ${COMPARE_FILE_CAP}-file cap; complete Git trees supplied the path and runtime inventories.`);
    console.log(`::notice::Comparison ${short(range.before)}..${short(range.after)} hit GitHub's ${COMPARE_FILE_CAP}-file cap; used complete Git trees.`);
  }
  if (analysis.retiredWorkflows.length > 0) {
    summary.push(`${prefix}: retired ${analysis.retiredWorkflows.length} workflow(s) — ${analysis.retiredWorkflows.join(', ')} — so every open pull request is refreshed: their check runs can no longer be superseded and would block the merge box forever.`);
  }
  if (analysis.newWorkflowRuntimeFiles.length > 0) {
    summary.push(`${prefix}: new protected-workflow executable reference(s): ${analysis.newWorkflowRuntimeFiles.join(', ')}. Only eligible heads missing one of these files are refreshed.`);
  }
  if (analysis.readsFailedChecks) {
    summary.push(`${prefix}: repairs shared CI validation paths, so pull requests carrying a matching failed check are refreshed even when their product files do not overlap. Successful and unrelated iOS checks are left alone.`);
  }
}
console.log(summary[0]);
for (const decision of alreadyValidating) {
  recordDecision(decision.number, 'skip', 'already-validating');
  const evidence = evidenceByPullRequest.get(decision.number);
  const workflows = evidence?.workflows.join(', ') ?? 'native pull-request workflows';
  const line = `#${decision.number}: retained head ${decision.headSha.slice(0, 7)} because ${workflows} already validate base ${after.slice(0, 7)}.`;
  summary.push(line);
  console.log(line);
}
/** The machine-readable reason a pull request was selected for an update. */
function updateReason(decision: FanoutDecision): string {
  if (decision.retiredWorkflows) return 'retired-workflow';
  if (decision.missingWorkflowRuntimeFiles) return 'missing-workflow-runtime';
  if (decision.repairedChecks) return 'repaired-checks';
  if (decision.iosBaseImpact) return 'ios-base-input';
  return 'overlap';
}

summary.push(...admissionNotes.values());

const failed: number[] = [];
const headUnchanged: number[] = [];
for (const decision of updates) {
  const sourceMoved = await sourceStaleness();
  if (sourceMoved !== null) {
    const line = `Stopped before #${decision.number}: ${sourceMoved}. A newer synchronize reconciles the remaining children.`;
    summary.push(line);
    console.log(`::notice::${line}`);
    for (const remaining of updates.slice(updates.indexOf(decision))) {
      recordDecision(remaining.number, 'skip', 'source-moved');
    }
    break;
  }
  // Update Branch merges the child's current base, so a child retargeted or
  // pushed since it was judged must not receive a merge decided for another tuple.
  const admission = await admitChildUpdate(
    baseBranch, decision.headSha, repository,
    await githubJson(`pulls/${decision.number}`, z.unknown()), branchTip,
  );
  if (admission.kind !== 'current') {
    const line = `#${decision.number}: not updated because ${admission.reason}`;
    summary.push(line);
    console.log(`::${admission.kind === 'incoherent' ? 'error' : 'notice'}::${line}`);
    if (admission.kind === 'incoherent') incoherentHeads.set(decision.number, admission.reason);
    recordDecision(decision.number, admission.kind === 'incoherent' ? 'report' : 'skip',
      admission.kind === 'incoherent' ? 'head-ref-incoherent' : 'child-moved');
    continue;
  }
  const response = await github(`pulls/${decision.number}/update-branch`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_head_sha: decision.headSha }),
  }, token);
  const outcome = classifyUpdateBranchResponse(response.status, await response.text());
  // HTTP 202 only accepts an asynchronous merge. Nothing records it as done:
  // a later run re-reads this child's actual merge base, so a merge that
  // fails or is superseded leaves the child selectable.
  // On a retirement no files were read, so say why it was selected instead of
  // reporting the empty overlap as though it shared nothing with the push.
  if (outcome.kind === 'conflict') recordDecision(decision.number, 'report', 'conflict');
  else recordDecision(decision.number, 'update', `${updateReason(decision)} result=${outcome.kind}`);
  const why = decision.retiredWorkflows
    ? `${decision.retiredWorkflows.length} retired workflow(s)`
    : decision.missingWorkflowRuntimeFiles
      ? `missing workflow executable(s): ${decision.missingWorkflowRuntimeFiles.join(', ')}`
    : decision.repairedChecks
      ? `shared CI repair for ${decision.repairedChecks.join(', ')}`
      : decision.iosBaseImpact
        ? `native iOS base input(s): ${decision.iosBaseImpact.slice(0, 5).join(', ')}${decision.iosBaseImpact.length > 5 ? ', …' : ''}`
      : `${decision.overlap.length} shared file(s): ${decision.overlap.slice(0, 5).join(', ')}${decision.overlap.length > 5 ? ', …' : ''}`;
  const line = `#${decision.number} (${why}): ${outcome.kind}${outcome.kind === 'error' ? ` HTTP ${outcome.status} ${outcome.message}` : ''}`;
  summary.push(line);
  if (outcome.kind === 'conflict') {
    recordConflict(decision.number, decision.headSha);
    const where = decision.overlap.length > 0 ? ` on ${decision.overlap.join(', ')}` : '';
    console.log(`::warning::Pull request #${decision.number} now conflicts with ${baseBranch}${where}.`);
  }
  // An error includes GitHub's 422 when the child's head moved between the
  // guard above and this call (`expected_head_sha` no longer matches).
  else if (outcome.kind === 'error') {
    failed.push(decision.number);
    console.log(`::error::Update Branch for #${decision.number} failed: HTTP ${outcome.status} ${outcome.message}`);
  }
  // A branch already containing this push — one stacked on the branch that was
  // just merged — gets no new head, and only a new head clears a check run
  // nothing can supersede. On a retirement that is the whole job left undone.
  else if (outcome.kind === 'already-current'
    && (decision.retiredWorkflows !== undefined || decision.missingWorkflowRuntimeFiles !== undefined)) {
    headUnchanged.push(decision.number);
    console.log(`::error::Pull request #${decision.number} got no new head and still has an unresolved workflow runtime or retired-check mismatch.`);
  }
  else console.log(line);
}

const orderedDecisionLines = [...decisionLines.entries()]
  .sort(([left], [right]) => left - right)
  .map(([, line]) => line);
for (const line of orderedDecisionLines) {
  summary.push(`\`${line}\``);
  console.log(line);
}

const numbers = (list: readonly number[]): string => list.map((number) => `#${number}`).join(', ');
// Every pull request was attempted before either of these, so one bad response
// never costs the rest their refresh.
if (failed.length > 0) {
  // After a protected-base push nothing selects these a second time — a
  // retirement is read from this push's own pair of revisions, and a later
  // push only reaches what overlaps it — so a transient 403 would otherwise
  // leave a dead check on that head for good. A stacked child is judged from
  // its merge base again on the next source push, but a re-run is still the
  // prompt fix. Re-running re-reads the same revisions and decides the same way.
  summary.push(`${failed.length} pull request(s) were not refreshed: ${numbers(failed)}. Re-run this workflow.`);
}
if (headUnchanged.length > 0) {
  // GitHub cannot make a new head from a base the branch already contains.
  // A runtime file may have been deliberately deleted by that branch; only
  // its author can restore it. A retired workflow check also needs a new head.
  summary.push(`${headUnchanged.length} pull request(s) got no new head and still have a workflow runtime or retired-check mismatch: ${numbers(headUnchanged)}. Inspect the decision above and repair the branch; re-running this fan-out cannot resolve an already-current head.`);
}

// Written even when this run fails below: a conflict is final for its head
// whatever happened to the other pull requests.
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile && conflictedPullRequests.length > 0) {
  const ordered = [...conflictedPullRequests].sort((left, right) => left.number - right.number);
  appendFileSync(outputFile, `conflicted_pull_requests=${JSON.stringify(ordered)}\n`);
}

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) appendFileSync(summaryFile, `## Base-update fan-out\n\n${summary.map((line) => `- ${line}`).join('\n')}\n`);

if (failed.length > 0 || headUnchanged.length > 0 || incoherentHeads.size > 0) {
  console.log(`::error::${failed.length + headUnchanged.length + incoherentHeads.size} pull request(s) are still blocked; see the run summary for which and why.`);
  process.exitCode = 1;
}

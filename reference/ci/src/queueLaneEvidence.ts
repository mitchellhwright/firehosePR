import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GithubReader } from './ios/shared/githubRest.ts';
import { validationLaneNames, type ValidationLane } from './prValidationVerdict.ts';
import {
  LANE_REUSE_REFUSALS, REUSABLE_LINUX_LANES, prChecksLaneEvidenceLogPrefix,
  type LaneEvidencePlan, type LaneReuseRefusal, type LaneVerdict, type PrChecksLaneEvidence, type QueueLaneEvidenceRecord, type ReusableLinuxLane,
} from './queueLaneEvidenceRecord.ts';

export * from './queueLaneEvidenceRecord.ts';

/**
 * Reuse of a pull request's PR Checks lane evidence on its merge queue candidate.
 *
 * A candidate `C` for pull request head `H` integrates `H` with the queue
 * base. The PR's own PR Checks run tested the merge commit `M` of `H` with
 * the develop tip of that moment. For each Linux lane the candidate's plan
 * selects, the lane is reused instead of executed only when every one of
 * these holds, in this order:
 *
 *  1. the PR's newest completed PR Checks run for exactly `H` concluded
 *     `success`, and its `Validate pull request changes` job printed the
 *     evidence marker below (so its plan and per-lane results are known);
 *  2. the marker names this PR, this head and the run it was printed in,
 *     and `M` is a two-parent merge whose last parent is `H`;
 *  3. the lane executed and passed in that run, and the lane's obligations on
 *     the candidate are covered by the obligations that run discharged;
 *  4. the lane's input tree in `C` is byte-identical to the lane's input tree
 *     in `M`: the digest below is over Git object ids of the whole tree with
 *     only `docs/` removed, and the documentation paths that any Linux lane
 *     reads put back. Nothing is compared as a patch; a candidate whose
 *     develop base changed any input reruns the lane.
 *
 * A reused lane is a skipped job on the candidate; the aggregate reports it
 * as `reused:` with its source run, never as executed. `lint` is itself a
 * required context and always runs. `validation-policy` scans commit
 * history and reads the PR body, neither of which is a tree, so it always
 * runs too.
 */

/**
 * The tree entries that are not inputs of any Linux lane, and the paths under
 * them that are. `docs/` is documentation to the trusted planner
 * (`isDocumentation`), except for the files below, which server or CI tests
 * read as contract inputs. `ci/tests/linuxLaneDocumentationInputs.test.ts`
 * derives this list from the sources in every non-docs PR lint run, so a new
 * documentation read fails before it could be excluded here.
 */
export const LINUX_LANE_EXCLUDED_ROOT_ENTRIES = ['docs'] as const;
export const LINUX_LANE_DOCUMENTATION_INPUTS = [
  'docs/CODEOWNERS',
  'docs/TESTING.md',
  'docs/TYPE_GENERATION.md',
  'docs/advisor',
  'docs/archive/SharedFixtureUITests.swift',
  'docs/b.md',
  'docs/ci-architecture.md',
  'docs/ci.md',
  'docs/ci/dependency-currency.md',
  'docs/ci/merge-queue-plan.md',
  'docs/ci/self-hosted-linux-runner.md',
  'docs/ci/self-hosted-macos-runner.md',
  'docs/ci/video-finding-inventory-2026-09-05.json',
  'docs/credit.md',
  'docs/evidence/ci-infrastructure-contracts.md',
  'docs/evidence/issue-6013/vehicle-link-preflight.sql',
  'docs/evidence/notifications/n7-2026-09-26',
  'docs/gcp-platform-migration-runbook.md',
  'docs/generated',
  'docs/github-repository-security.md',
  'docs/guide.md',
  'docs/long.md',
  'docs/moved.md',
  'docs/new.md',
  'docs/notYetGenerated.md',
  'docs/notes.md',
  'docs/private-profile-media-migration.md',
  'docs/product-guide.md',
  'docs/readme.md',
  'docs/removed.md',
  'docs/secret',
  'docs/security/branch-policy-monitor.md',
  'docs/synthetic-approved.md',
  'docs/synthetic-metric.md',
  'docs/synthetic.md',
  'docs/unrelated.md',
  'docs/videos',
  'docs/weak.md',
  'docs/wrong',
  'docs/x.md',
] as const;

/**
 * The module that declares the lane inputs above. The planner runs from the
 * trusted queue base, so it digests with the base's declaration; a candidate
 * whose copy of this file differs could declare inputs the base's list omits,
 * so its lanes execute instead of reusing a digest over the wrong inputs.
 */
export const LINUX_LANE_INPUT_DECLARATION_PATH = 'ci/src/queueLaneEvidence.ts';

/** The Git blob object id of `content`, as `git hash-object` computes it. */
export function gitBlobSha(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const positiveInteger = z.number().int().positive();
const serverTestPath = z.string().regex(/^server\/tests\/.+\.ts$/);

/** The plan fields whose discharge on the PR run must cover the candidate's plan. */
export const laneEvidencePlanSchema = z.object({
  serverTestMode: z.enum(['none', 'targeted', 'full']),
  targetedServerTests: z.array(serverTestPath),
  targetedIntegrationTests: z.array(serverTestPath),
  entitlementAcceptanceRequired: z.boolean(),
  testOnlyHelpersToTypecheck: z.array(serverTestPath),
  processHeavyRequired: z.boolean(),
  serverStaticRequired: z.boolean(),
  workflowContractsRequired: z.boolean(),
  iosContractsRequired: z.boolean(),
  databaseRequired: z.boolean(),
}).strict() satisfies z.ZodType<LaneEvidencePlan>;

const laneResultsSchema = z.object(
  Object.fromEntries(validationLaneNames.map((lane) => [lane, z.string()])) as Record<ValidationLane, z.ZodString>,
).strict();

/** Printed by the PR run's aggregate, so a candidate can read what that run discharged. */
export const prChecksLaneEvidenceSchema = z.object({
  schema: z.literal('example.pr-checks-lane-evidence.v1'),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prNumber: z.string().regex(/^[1-9][0-9]*$/),
  prHeadSha: sha,
  prBaseSha: sha,
  /** `github.sha` of the PR run: the merge commit every lane checked out. */
  mergeSha: sha,
  workflowSha: sha,
  runId: positiveInteger,
  runAttempt: positiveInteger,
  plan: laneEvidencePlanSchema,
  results: laneResultsSchema,
}).strict() satisfies z.ZodType<PrChecksLaneEvidence>;

/** Exactly one marker in the log, or an error naming what was found. */
export function parsePrChecksLaneEvidenceLog(log: string): PrChecksLaneEvidence {
  const markers = log.split(/\r?\n/)
    .map((line) => line.slice(line.indexOf(prChecksLaneEvidenceLogPrefix)))
    .filter((line) => line.startsWith(prChecksLaneEvidenceLogPrefix));
  if (markers.length !== 1) {
    throw new Error(`Expected exactly one PR Checks lane evidence marker, found ${markers.length}.`);
  }
  const encoded = markers[0]!.slice(prChecksLaneEvidenceLogPrefix.length).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid PR Checks lane evidence log encoding.');
  const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  return prChecksLaneEvidenceSchema.parse(parsed);
}

/** Proves a record the planner wrote has exactly the declared shape. */
export function parseQueueLaneEvidenceRecord(raw: unknown): QueueLaneEvidenceRecord {
  return queueLaneEvidenceRecordSchema.parse(raw);
}

/** One Git tree entry, as `GET /repos/{o}/{r}/git/trees/{sha}` lists it. */
export interface GitTreeEntry {
  readonly path: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly mode: string;
  readonly sha: string;
}

export type TreeReader = (treeSha: string) => Promise<readonly GitTreeEntry[]>;

/** A declared input with its object id, or `absent` when the tree has no such path. */
export interface LaneInputEntry {
  readonly path: string;
  readonly type: GitTreeEntry['type'] | 'absent';
  readonly mode: string;
  readonly sha: string;
}

async function resolvePath(root: readonly GitTreeEntry[], path: string, read: TreeReader): Promise<LaneInputEntry> {
  const segments = path.split('/');
  let entries = root;
  for (const [index, segment] of segments.entries()) {
    const entry = entries.find((candidate) => candidate.path === segment);
    if (entry === undefined) return { path, type: 'absent', mode: '', sha: '' };
    if (index === segments.length - 1) return { path, type: entry.type, mode: entry.mode, sha: entry.sha };
    if (entry.type !== 'tree') return { path, type: 'absent', mode: '', sha: '' };
    entries = await read(entry.sha);
  }
  throw new Error(`Empty lane input path: ${JSON.stringify(path)}`);
}

/**
 * The declared Linux lane inputs of one commit tree: every root entry except
 * the excluded ones, plus the documentation inputs resolved to their own
 * object ids. The result is sorted by path so two trees compare by content.
 */
export async function linuxLaneInputEntries(rootTreeSha: string, read: TreeReader): Promise<LaneInputEntry[]> {
  const root = await read(rootTreeSha);
  if (root.length === 0) throw new Error(`Root tree ${rootTreeSha} lists no entries; refusing to digest it.`);
  const excluded: ReadonlySet<string> = new Set(LINUX_LANE_EXCLUDED_ROOT_ENTRIES);
  const entries: LaneInputEntry[] = root
    .filter((entry) => !excluded.has(entry.path))
    .map((entry) => ({ path: entry.path, type: entry.type, mode: entry.mode, sha: entry.sha }));
  for (const path of LINUX_LANE_DOCUMENTATION_INPUTS) entries.push(await resolvePath(root, path, read));
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The blob id of the lane input declaration in one commit tree, or `absent`. */
export async function linuxLaneInputDeclarationSha(rootTreeSha: string, read: TreeReader): Promise<string> {
  const entry = await resolvePath(await read(rootTreeSha), LINUX_LANE_INPUT_DECLARATION_PATH, read);
  return entry.type === 'blob' ? entry.sha : 'absent';
}

/** The content identity of a lane's inputs in one tree. Equal digests mean byte-identical inputs. */
export function linuxLaneInputDigest(lane: ReusableLinuxLane, entries: readonly LaneInputEntry[]): string {
  const canonical = JSON.stringify({ schema: 'example.linux-lane-inputs.v1', lane, entries });
  return createHash('sha256').update(canonical).digest('hex');
}

export const queueLaneEvidenceRecordSchema = z.object({
  schema: z.literal('example.linux-queue-evidence-reuse.v1'),
  candidateSha: sha,
  queueBaseSha: sha,
  prNumber: z.string().regex(/^[1-9][0-9]*$/),
  prHeadSha: sha,
  lanes: z.array(z.discriminatedUnion('verdict', [
    z.object({ lane: z.enum(REUSABLE_LINUX_LANES), verdict: z.literal('not-selected') }).strict(),
    z.object({
      lane: z.enum(REUSABLE_LINUX_LANES), verdict: z.literal('reused'),
      sourceRunId: positiveInteger, sourceRunAttempt: positiveInteger, sourceHeadSha: sha,
      testedMergeSha: sha, inputDigest: z.string().regex(/^[0-9a-f]{64}$/), jobs: z.array(z.string()),
    }).strict(),
    z.object({
      lane: z.enum(REUSABLE_LINUX_LANES), verdict: z.literal('executed'),
      reason: z.enum(LANE_REUSE_REFUSALS), detail: z.string(),
    }).strict(),
  ])),
}).strict() satisfies z.ZodType<QueueLaneEvidenceRecord>;

function assertNever(value: never): never {
  throw new Error(`Unexpected lane: ${JSON.stringify(value)}`);
}

/** Whether the candidate's plan selects the lane, mirroring `prValidationVerdict`. */
export function laneSelected(lane: ReusableLinuxLane, plan: LaneEvidencePlan): boolean {
  switch (lane) {
    case 'workflow-contracts': return plan.workflowContractsRequired;
    case 'server-static': return plan.serverStaticRequired;
    case 'server-process-tests': return plan.processHeavyRequired || plan.serverTestMode === 'full';
    case 'server-tests': return plan.serverTestMode === 'full';
    case 'targeted-server-tests': return plan.serverTestMode === 'targeted';
    case 'ios-contracts': return plan.iosContractsRequired;
    case 'database-integration': return plan.databaseRequired;
    default: return assertNever(lane);
  }
}

function subset(needed: readonly string[], discharged: readonly string[]): string[] {
  const have = new Set(discharged);
  return needed.filter((path) => !have.has(path));
}

/**
 * Whether the obligations the PR run discharged for `lane` cover the
 * candidate's. Full server tests cover full server tests; a targeted list is
 * covered when every candidate test was in the run's list; a flag is covered
 * when the run had it set too. Returns the uncovered items, empty when covered.
 */
export function uncoveredObligations(lane: ReusableLinuxLane, candidate: LaneEvidencePlan, tested: LaneEvidencePlan): string[] {
  switch (lane) {
    case 'workflow-contracts':
    case 'ios-contracts':
    case 'server-process-tests':
      return [];
    case 'server-static':
      return subset(candidate.testOnlyHelpersToTypecheck, tested.testOnlyHelpersToTypecheck);
    case 'server-tests':
      return tested.serverTestMode === 'full' ? [] : [`server_test_mode=${tested.serverTestMode}`];
    case 'targeted-server-tests':
      return tested.serverTestMode === 'targeted'
        ? subset(candidate.targetedServerTests, tested.targetedServerTests)
        : [`server_test_mode=${tested.serverTestMode}`];
    case 'database-integration':
      return [
        ...subset(candidate.targetedIntegrationTests, tested.targetedIntegrationTests),
        ...(candidate.entitlementAcceptanceRequired && !tested.entitlementAcceptanceRequired
          ? ['entitlement_acceptance_required'] : []),
      ];
    default:
      return assertNever(lane);
  }
}

/** The PR Checks job names each lane's evidence is read from; a prefix matches every matrix job. */
export const linuxLaneJobNames: Readonly<Record<ReusableLinuxLane, { readonly prefix: string }>> = {
  'workflow-contracts': { prefix: 'Workflow contracts' },
  'server-static': { prefix: 'Server static validation' },
  'server-process-tests': { prefix: 'Server process-heavy tests' },
  'server-tests': { prefix: 'Server tests (' },
  'targeted-server-tests': { prefix: 'Targeted server tests' },
  'ios-contracts': { prefix: 'iOS-server contracts' },
  'database-integration': { prefix: 'Run database integration tests' },
};

export interface SourceRunJob {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
}

export interface SourceRun {
  readonly id: number;
  readonly attempt: number;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly jobs: readonly SourceRunJob[];
}

const PR_CHECKS_WORKFLOW_FILE = 'pr-checks.yml';
const sourceRunsSchema = z.object({
  workflow_runs: z.array(z.object({
    id: positiveInteger,
    run_attempt: positiveInteger,
    head_sha: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    created_at: z.string(),
  })),
});
const sourceJobsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(z.object({ id: positiveInteger, name: z.string(), conclusion: z.string().nullable() })),
});

async function readSourceJson<T>(read: GithubReader, url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await read(url);
  if (response.status !== 200) throw new Error(`GET ${url} answered HTTP ${response.statusLabel}.`);
  return schema.parse(response.body);
}

/**
 * The PR's newest completed PR Checks run for exactly `headSha` with all its
 * jobs, `undefined` when there is none, or why it could not be read. A newer
 * run still in progress (a rerun) never hides a completed one, and a read
 * failure is a refusal, never a planner failure: every lane then executes.
 */
export async function readNewestCompletedRun(
  read: GithubReader,
  apiRoot: string,
  headSha: string,
): Promise<SourceRun | { readonly error: string } | undefined> {
  try {
    const runs = await readSourceJson(read, `${apiRoot}/actions/workflows/${PR_CHECKS_WORKFLOW_FILE}/runs`
      + `?event=pull_request&status=completed&head_sha=${headSha}&per_page=20`, sourceRunsSchema);
    const newest = runs.workflow_runs
      .filter((run) => run.head_sha === headSha && run.status === 'completed')
      .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
    if (newest === undefined) return undefined;
    const jobs = await readSourceJson(read,
      `${apiRoot}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`, sourceJobsSchema);
    if (jobs.jobs.length !== jobs.total_count) {
      return { error: `run ${newest.id} lists ${jobs.total_count} jobs; only ${jobs.jobs.length} were read` };
    }
    return {
      id: newest.id, attempt: newest.run_attempt, headSha: newest.head_sha, status: newest.status,
      conclusion: newest.conclusion, jobs: jobs.jobs,
    };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface TestedMerge {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly treeSha: string;
}

export interface LaneReuseInput {
  readonly candidate: { readonly prNumber: string; readonly prHeadSha: string; readonly candidateSha: string; readonly queueBaseSha: string };
  readonly repository: string;
  readonly plan: LaneEvidencePlan;
  /** The PR's newest completed PR Checks run for its head, if any, or why it could not be read. */
  readonly sourceRun: SourceRun | { readonly error: string } | undefined;
  /** The marker its aggregate printed, or why it could not be read. */
  readonly marker: PrChecksLaneEvidence | { readonly error: string };
  /** The merge commit the marker names, or why it could not be read. */
  readonly testedMerge: TestedMerge | { readonly error: string };
  /** Lane input entries of the tested merge and of the candidate, or why one could not be read. */
  readonly testedEntries: readonly LaneInputEntry[] | { readonly error: string };
  readonly candidateEntries: readonly LaneInputEntry[] | { readonly error: string };
  /**
   * Blob ids of `LINUX_LANE_INPUT_DECLARATION_PATH` in the running (trusted
   * base) checkout and in the candidate tree, or why one could not be read.
   */
  readonly inputDeclaration: { readonly running: string; readonly candidate: string } | { readonly error: string };
}

type Gate = { readonly reason: LaneReuseRefusal; readonly detail: string } | undefined;

function runGate(input: LaneReuseInput): Gate {
  const run = input.sourceRun;
  if (run === undefined) {
    return { reason: 'no-pull-request-run', detail: `no completed PR Checks run for head ${input.candidate.prHeadSha}` };
  }
  if ('error' in run) return { reason: 'pull-request-run-unreadable', detail: run.error };
  if (run.status !== 'completed') return { reason: 'pull-request-run-in-progress', detail: `run ${run.id} is ${run.status}` };
  if (run.conclusion !== 'success') {
    return { reason: 'pull-request-run-not-successful', detail: `run ${run.id} concluded ${run.conclusion ?? 'unknown'}` };
  }
  if (run.headSha !== input.candidate.prHeadSha) {
    return { reason: 'pull-request-run-mismatch', detail: `run ${run.id} tested head ${run.headSha}, not ${input.candidate.prHeadSha}` };
  }
  return undefined;
}

function markerGate(input: LaneReuseInput, run: SourceRun): Gate {
  if ('error' in input.marker) return { reason: 'evidence-marker-missing', detail: input.marker.error };
  const marker = input.marker;
  const mismatches: string[] = [];
  if (marker.repository !== input.repository) mismatches.push(`repository ${marker.repository}`);
  if (marker.prNumber !== input.candidate.prNumber) mismatches.push(`pull request #${marker.prNumber}`);
  if (marker.prHeadSha !== input.candidate.prHeadSha) mismatches.push(`head ${marker.prHeadSha}`);
  if (marker.runId !== run.id || marker.runAttempt !== run.attempt) {
    mismatches.push(`run ${marker.runId} attempt ${marker.runAttempt}`);
  }
  if (mismatches.length > 0) {
    return { reason: 'evidence-marker-mismatch', detail: `marker names ${mismatches.join(', ')}` };
  }
  return undefined;
}

function mergeGate(input: LaneReuseInput, marker: PrChecksLaneEvidence): Gate {
  if ('error' in input.testedMerge) return { reason: 'tested-tree-unreadable', detail: input.testedMerge.error };
  const merge = input.testedMerge;
  if (merge.sha !== marker.mergeSha || merge.parents.length !== 2 || merge.parents[1] !== input.candidate.prHeadSha) {
    return {
      reason: 'tested-merge-not-pr-head',
      detail: `merge ${merge.sha} has parents [${merge.parents.join(', ')}]; expected [base, ${input.candidate.prHeadSha}]`,
    };
  }
  if ('error' in input.testedEntries) return { reason: 'tested-tree-unreadable', detail: input.testedEntries.error };
  if ('error' in input.candidateEntries) return { reason: 'tested-tree-unreadable', detail: input.candidateEntries.error };
  return declarationGate(input);
}

function declarationGate(input: LaneReuseInput): Gate {
  const declaration = input.inputDeclaration;
  if ('error' in declaration) return { reason: 'tested-tree-unreadable', detail: declaration.error };
  if (declaration.running !== declaration.candidate) {
    return {
      reason: 'input-declaration-changed',
      detail: `${LINUX_LANE_INPUT_DECLARATION_PATH} is ${declaration.candidate} in the candidate `
        + `but ${declaration.running} in the running planner`,
    };
  }
  return undefined;
}

function laneGate(lane: ReusableLinuxLane, input: LaneReuseInput, run: SourceRun, marker: PrChecksLaneEvidence): LaneVerdict {
  const result = marker.results[lane];
  if (result !== 'success') {
    return { lane, verdict: 'executed', reason: 'lane-not-executed-on-pull-request', detail: `run ${run.id} recorded ${lane}: ${result}` };
  }
  const jobs = run.jobs.filter((job) => job.name.startsWith(linuxLaneJobNames[lane].prefix));
  const unsuccessful = jobs.filter((job) => job.conclusion !== 'success');
  if (jobs.length === 0 || unsuccessful.length > 0) {
    return {
      lane, verdict: 'executed', reason: 'lane-job-not-successful',
      detail: jobs.length === 0 ? `run ${run.id} has no ${lane} job` : unsuccessful.map((job) => `${job.name}: ${job.conclusion ?? 'unknown'}`).join(', '),
    };
  }
  const uncovered = uncoveredObligations(lane, input.plan, marker.plan);
  if (uncovered.length > 0) {
    return { lane, verdict: 'executed', reason: 'selection-not-covered', detail: uncovered.join(', ') };
  }
  const tested = input.testedEntries as readonly LaneInputEntry[];
  const candidate = input.candidateEntries as readonly LaneInputEntry[];
  const testedDigest = linuxLaneInputDigest(lane, tested);
  const candidateDigest = linuxLaneInputDigest(lane, candidate);
  if (testedDigest !== candidateDigest) {
    const changed = changedInputs(tested, candidate);
    return { lane, verdict: 'executed', reason: 'input-digest-changed', detail: changed.join(', ') };
  }
  return {
    lane, verdict: 'reused', sourceRunId: run.id, sourceRunAttempt: run.attempt, sourceHeadSha: run.headSha,
    testedMergeSha: marker.mergeSha, inputDigest: candidateDigest, jobs: jobs.map((job) => job.name),
  };
}

/** The declared inputs whose object ids differ, for the `executed` detail. */
export function changedInputs(tested: readonly LaneInputEntry[], candidate: readonly LaneInputEntry[]): string[] {
  const byPath = new Map(tested.map((entry) => [entry.path, entry]));
  const changed = new Set<string>();
  for (const entry of candidate) {
    const before = byPath.get(entry.path);
    if (before === undefined || before.sha !== entry.sha || before.type !== entry.type || before.mode !== entry.mode) {
      changed.add(entry.path);
    }
    byPath.delete(entry.path);
  }
  for (const path of byPath.keys()) changed.add(path);
  return [...changed].sort();
}

/** The reuse decision for every reusable lane the candidate's plan selects. */
export function planLinuxLaneReuse(input: LaneReuseInput): QueueLaneEvidenceRecord {
  const lanes: LaneVerdict[] = [];
  for (const lane of REUSABLE_LINUX_LANES) {
    if (!laneSelected(lane, input.plan)) {
      lanes.push({ lane, verdict: 'not-selected' });
      continue;
    }
    const run = runGate(input);
    if (run !== undefined) { lanes.push({ lane, verdict: 'executed', ...run }); continue; }
    const sourceRun = input.sourceRun as SourceRun;
    const marker = markerGate(input, sourceRun);
    if (marker !== undefined) { lanes.push({ lane, verdict: 'executed', ...marker }); continue; }
    const evidence = input.marker as PrChecksLaneEvidence;
    const merge = mergeGate(input, evidence);
    if (merge !== undefined) { lanes.push({ lane, verdict: 'executed', ...merge }); continue; }
    lanes.push(laneGate(lane, input, sourceRun, evidence));
  }
  return parseQueueLaneEvidenceRecord({
    schema: 'example.linux-queue-evidence-reuse.v1',
    candidateSha: input.candidate.candidateSha,
    queueBaseSha: input.candidate.queueBaseSha,
    prNumber: input.candidate.prNumber,
    prHeadSha: input.candidate.prHeadSha,
    lanes,
  });
}

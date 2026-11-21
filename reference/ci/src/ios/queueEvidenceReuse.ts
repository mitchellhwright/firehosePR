import { REQUIRED_NATIVE_INPUTS } from './testProductInputs.ts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifiedGitBlobSource } from '../githubGitBlob.ts';

import { GithubTransportError, type GithubReader, type GithubResponse } from './shared/githubRest.ts';
import { isIosEvidenceInvalidatingInput, isIosRealServerRuntimeInput } from './iosExecutionInputs.ts';
import { sameQueueLaneExecutionContract } from './queueLaneExecutionContract.ts';
import {
  requiredEvidenceJobs,
  selectionCoverage,
  type CoveredReplanOutput,
  type NativeSelectionRecord,
  type RecordedSelection,
} from './nativeSelectionRecord.ts';
import {
  QUEUE_EVIDENCE_REUSE_SCHEMA,
  QUEUE_REUSE_LANES,
  queueEvidenceReuseRecordSchema,
  type ExecuteReason,
  type LaneVerdict,
  type QueueEvidenceReuseRecord,
  type QueueReuseLane,
  type RealServerQueueLane,
  type SourceRefusal,
} from './queueEvidenceReuseRecord.ts';

/**
 * Whether a merge queue candidate may carry its pull request's Mac evidence
 * instead of running a Mac lane again.
 *
 * The pull request run tested the exact PR head `H`. The candidate `C` is
 * develop (plus any queue entries ahead of it) merged with `H`. A lane's
 * result on `H` stands for `C` only when every source input the lane reads is
 * byte-identical in the two trees. The generated workflow may change only
 * when this lane's parsed execution contract remains identical. A changed
 * workflow that cannot be fetched, parsed or recognized makes the lane run.
 *
 * On top of the digest a lane is reused only when the pull request run
 *  - is the newest completed `pull_request` run of Test - iOS on exactly `H`,
 *    and it succeeded;
 *  - recorded its own selection (`example.ios-native-selection-record.v1`) as
 *    `executed`, not retained from an earlier run;
 *  - selected every test and lane the candidate's selection needs, as the
 *    queue base's selector computes it (`selectionCoverage`);
 *  - has a successful job, in its latest attempt, for every evidence job the
 *    recorded and the current selection rely on.
 *
 * A real-server lane additionally needs its backend inputs unchanged
 * (`isIosRealServerRuntimeInput`), and a lane the pull request did not run
 * (one deferred to the queue, say) is never reused. A reused real-server lane
 * still has the candidate's development E2E schema verified on the candidate
 * (`real_server_evidence_reused`), and the aggregates refuse the reuse unless
 * that verification succeeded.
 */

type LaneFlag = keyof RecordedSelection['lanes'];

const REAL_SERVER_FLAGS: Readonly<Record<RealServerQueueLane, LaneFlag>> = {
  onboarding: 'onboarding',
  'chat-plaid': 'chatPlaid',
  income: 'income',
  budget: 'budget',
};

const NATIVE_FLAGS: readonly LaneFlag[] = ['main', 'storekit', 'evidence'];

/**
 * Files every Test - iOS tree has. A tree missing one of them is not a tree
 * the lanes could have run, so no digest is taken over it. The two pins name
 * the Xcode builds every Mac lane selects and verifies its products against.
 */
export { REQUIRED_NATIVE_INPUTS } from './testProductInputs.ts';

const REQUIRED_REAL_SERVER_INPUTS = [...REQUIRED_NATIVE_INPUTS, 'next.config.mjs'] as const;

const gitTreeSchema = z.object({
  truncated: z.literal(false),
  tree: z.array(z.object({
    path: z.string().min(1),
    mode: z.string().regex(/^[0-9]{6}$/),
    type: z.enum(['blob', 'tree', 'commit']),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
  })),
});
export type GitTreeEntry = z.infer<typeof gitTreeSchema>['tree'][number];

/** A complete recursive tree from `GET /git/trees/<sha>?recursive=1`, or `null`. */
export function parseGitTree(value: unknown): readonly GitTreeEntry[] | null {
  const parsed = gitTreeSchema.safeParse(value);
  return parsed.success ? parsed.data.tree : null;
}

/**
 * Reads a GitHub resource for a decision that fails closed to execution.
 *
 * A transport failure (the reader throws after its retries) is handed to
 * `onTransportFailure` and answered with `null`, so the caller executes the
 * lanes instead of failing the whole gate. Any other exception is a defect
 * and propagates.
 */
async function readOrNull(
  read: GithubReader,
  url: string,
  onTransportFailure: (message: string) => void,
): Promise<GithubResponse | null> {
  try {
    return await read(url);
  } catch (cause: unknown) {
    if (!(cause instanceof GithubTransportError)) throw cause;
    onTransportFailure(cause.message);
    return null;
  }
}

/**
 * The complete recursive tree of `commit`, or `null` with the cause passed to
 * `warn` when it cannot be read: a transport failure, a non-200 answer, or a
 * truncated or malformed body. `null` makes every compared lane execute with
 * reason `tree-unreadable`.
 */
export async function readGitTree(
  read: GithubReader,
  apiRoot: string,
  commit: string,
  warn: (message: string) => void,
): Promise<readonly GitTreeEntry[] | null> {
  const context = `Git tree of ${commit} is unreadable, so lanes compared against it execute`;
  const response = await readOrNull(read, `${apiRoot}/git/trees/${commit}?recursive=1`,
    (message) => warn(`${context}: ${message}`));
  if (response === null) return null;
  if (response.status !== 200) {
    warn(`${context}: HTTP ${response.statusLabel}`);
    return null;
  }
  const tree = parseGitTree(response.body);
  if (tree === null) warn(`${context}: the answer is truncated or malformed`);
  return tree;
}

/** Resolve the workflow's own commit, reusing a tree only for that same SHA. */
export async function readWorkflowRevisionTree(
  read: GithubReader,
  apiRoot: string,
  revision: string,
  cached: readonly { readonly sha: string; readonly tree: readonly GitTreeEntry[] | null }[],
  warn: (message: string) => void,
): Promise<readonly GitTreeEntry[] | null> {
  const snapshot = cached.find((entry) => entry.sha === revision);
  return snapshot === undefined ? readGitTree(read, apiRoot, revision, warn) : snapshot.tree;
}

/** Read the workflow blob named by a verified tree entry, or refuse reuse. */
export async function readWorkflowBlob(
  read: GithubReader,
  apiRoot: string,
  tree: readonly GitTreeEntry[] | null,
  warn: (message: string) => void,
): Promise<string | null> {
  const entry = tree?.find((item) => item.path === IOS_TESTS_WORKFLOW_PATH && item.type === 'blob');
  if (entry === undefined) return null;
  const response = await readOrNull(read, `${apiRoot}/git/blobs/${entry.sha}`,
    (message) => warn(`Test - iOS workflow blob ${entry.sha} unreadable: ${message}`));
  if (response?.status !== 200) {
    if (response !== null) warn(`Test - iOS workflow blob ${entry.sha} returned HTTP ${response.statusLabel}`);
    return null;
  }
  const source = verifiedGitBlobSource(response.body, entry.sha);
  if (source === null) warn(`Test - iOS workflow blob ${entry.sha} did not match its tree entry or bounded UTF-8 contract`);
  return source;
}

export function isQueueLaneInput(lane: QueueReuseLane, path: string): boolean {
  if (isIosEvidenceInvalidatingInput(path)) return true;
  return lane !== 'native' && isIosRealServerRuntimeInput(path, lane);
}

export interface LaneInputs {
  readonly digest: string;
  /** Path to `<mode> <object id>`, for naming what changed. */
  readonly entries: ReadonlyMap<string, string>;
}

function byPath(left: GitTreeEntry, right: GitTreeEntry): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

/**
 * The sha256 over `[mode, path, object id]` of every file (and submodule) in
 * the lane's closure, framed as JSON so no path can imitate two entries.
 */
export function laneInputs(lane: QueueReuseLane, tree: readonly GitTreeEntry[]): LaneInputs | null {
  const entries = tree
    .filter((entry) => entry.type !== 'tree' && isQueueLaneInput(lane, entry.path))
    .sort(byPath);
  const paths = new Set(entries.map((entry) => entry.path));
  const required = lane === 'native' ? REQUIRED_NATIVE_INPUTS : REQUIRED_REAL_SERVER_INPUTS;
  if (!required.every((path) => paths.has(path))
    || !entries.some((entry) => entry.path.startsWith('ios/'))) {
    return null;
  }
  const canonical = JSON.stringify({
    schema: 'example.ios-queue-lane-inputs.v1',
    closure: lane === 'native' ? 'native' : 'real-server',
    entries: entries.map((entry) => [entry.mode, entry.path, entry.sha]),
  });
  return {
    digest: createHash('sha256').update(canonical).digest('hex'),
    entries: new Map(entries.map((entry) => [entry.path, `${entry.mode} ${entry.sha}`])),
  };
}

/** Closure paths added, removed or changed between the tested head and the candidate. */
export function changedLaneInputs(head: LaneInputs, candidate: LaneInputs): string[] {
  const paths = new Set([...head.entries.keys(), ...candidate.entries.keys()]);
  return [...paths].filter((path) => head.entries.get(path) !== candidate.entries.get(path)).sort();
}

export interface PullRequestRunEvidence {
  readonly runId: number;
  readonly runAttempt: number;
  readonly headSha: string;
  readonly recordAttempt: number;
  /** `kind:lane` keys of the jobs that succeeded in the run's latest attempt. */
  readonly successfulJobs: readonly string[];
  readonly record: NativeSelectionRecord;
}

export type EvidenceSource =
  | { readonly kind: 'found'; readonly evidence: PullRequestRunEvidence }
  | { readonly kind: 'unavailable'; readonly reason: SourceRefusal; readonly detail: string };

function projection(selection: RecordedSelection, lane: QueueReuseLane): RecordedSelection {
  const lanes = {
    storekit: false, main: false, onboarding: false, chatPlaid: false,
    budget: false, income: false, evidence: false,
  };
  if (lane === 'native') {
    for (const flag of NATIVE_FLAGS) lanes[flag] = selection.lanes[flag];
    return { lanes, native: selection.native };
  }
  const flag = REAL_SERVER_FLAGS[lane];
  lanes[flag] = selection.lanes[flag];
  return { lanes, native: null };
}

function laneSelected(selection: RecordedSelection, lane: QueueReuseLane): boolean {
  const projected = projection(selection, lane);
  return Object.values(projected.lanes).some(Boolean) || requiredEvidenceJobs(projected).length > 0;
}

export interface QueueReuseInput {
  readonly candidateSha: string;
  readonly queueBaseSha: string;
  readonly prNumber: string;
  /** `null` when the candidate could not be re-read; the source is then unavailable. */
  readonly prHeadSha: string | null;
  /** The candidate's selection, computed by the queue base's selector. */
  readonly current: RecordedSelection;
  readonly budgetE2eEnabled: boolean;
  readonly source: EvidenceSource;
  readonly headTree: readonly GitTreeEntry[] | null;
  readonly candidateTree: readonly GitTreeEntry[] | null;
  /** Workflow blobs from the revisions actually executed by the two runs. */
  readonly workflowBlobs?: {
    readonly headSha: string;
    readonly candidateSha: string;
    readonly sources: { readonly head: string; readonly candidate: string } | null;
  } | null;
}

function executed(lane: QueueReuseLane, reason: ExecuteReason, detail: string): LaneVerdict {
  return { lane, verdict: 'executed', reason, detail };
}

function namedPaths(paths: readonly string[]): string {
  return paths.length <= 5 ? paths.join(', ') : `${paths.slice(0, 5).join(', ')} (+${paths.length - 5} more)`;
}

function evidenceVerdict(
  lane: QueueReuseLane,
  input: QueueReuseInput,
  evidence: PullRequestRunEvidence,
): LaneVerdict {
  if (!laneSelected(evidence.record.selection, lane)) {
    return executed(lane, 'lane-not-executed-on-pull-request',
      `run ${evidence.runId} did not select the ${lane} lane`);
  }
  const prior = projection(evidence.record.selection, lane);
  const current = projection(input.current, lane);
  const coverage = selectionCoverage(prior, current);
  if (!coverage.covered) return executed(lane, 'selection-not-covered', coverage.uncovered);
  const jobs = [...new Set([...requiredEvidenceJobs(prior), ...requiredEvidenceJobs(current)])].sort();
  if (jobs.length === 0) {
    return executed(lane, 'lane-job-not-successful', `run ${evidence.runId} has no evidence job for ${lane}`);
  }
  const missing = jobs.find((job) => !evidence.successfulJobs.includes(job));
  if (missing !== undefined) {
    return executed(lane, 'lane-job-not-successful', `${missing} did not succeed in run ${evidence.runId}`);
  }
  if (evidence.record.run.workflowSha === undefined) {
    return executed(lane, 'tree-unreadable',
      `run ${evidence.runId} did not record the workflow revision that executed its jobs`);
  }
  const head = input.headTree === null ? null : laneInputs(lane, input.headTree);
  const candidate = input.candidateTree === null ? null : laneInputs(lane, input.candidateTree);
  if (head === null || candidate === null) {
    return executed(lane, 'tree-unreadable',
      `${head === null ? 'pull request head' : 'candidate'} tree could not be read completely `
        + 'or is not a Test - iOS tree');
  }
  const workflow = input.workflowBlobs;
  if (workflow === null || workflow === undefined) {
    return executed(lane, 'tree-unreadable', 'the executed workflow revisions could not be proven');
  }
  if (workflow.headSha !== workflow.candidateSha && (workflow.sources === null
    || !sameQueueLaneExecutionContract(workflow.sources.head, workflow.sources.candidate, lane))) {
    return executed(lane, 'input-digest-changed', IOS_TESTS_WORKFLOW_PATH);
  }
  const invalidating = changedLaneInputs(head, candidate)
    .filter((path) => path !== IOS_TESTS_WORKFLOW_PATH);
  if (invalidating.length > 0) {
    return executed(lane, 'input-digest-changed', namedPaths(invalidating));
  }
  return {
    lane,
    verdict: 'reused',
    sourceRunId: evidence.runId,
    sourceRunAttempt: evidence.runAttempt,
    sourceHeadSha: evidence.headSha,
    inputDigest: candidate.digest,
    jobs,
  };
}

function laneVerdict(lane: QueueReuseLane, input: QueueReuseInput): LaneVerdict {
  const selected = laneSelected(input.current, lane) && (lane !== 'budget' || input.budgetE2eEnabled);
  if (!selected) return { lane, verdict: 'not-selected' };
  if (input.source.kind === 'unavailable') return executed(lane, input.source.reason, input.source.detail);
  const { evidence } = input.source;
  if (evidence.headSha !== input.prHeadSha || evidence.record.run.headSha !== input.prHeadSha) {
    return executed(lane, 'pull-request-run-mismatch',
      `run head ${evidence.headSha} and record head ${evidence.record.run.headSha} must both be the queued head ${input.prHeadSha}`);
  }
  if (evidence.record.evidence.kind !== 'executed') {
    return executed(lane, 'evidence-not-executed-on-head',
      `run ${evidence.runId} retained run ${evidence.record.evidence.runId}'s evidence`);
  }
  return evidenceVerdict(lane, input, evidence);
}

export function planQueueEvidenceReuse(input: QueueReuseInput): QueueEvidenceReuseRecord {
  return queueEvidenceReuseRecordSchema.parse({
    schema: QUEUE_EVIDENCE_REUSE_SCHEMA,
    candidateSha: input.candidateSha,
    queueBaseSha: input.queueBaseSha,
    prNumber: input.prNumber,
    prHeadSha: input.prHeadSha,
    lanes: QUEUE_REUSE_LANES.map((lane) => laneVerdict(lane, input)),
  });
}

/**
 * Set when any real-server lane is reused. The lane's own `*_required` flag
 * turns false (it does not execute), but its evidence still stands on the
 * shared development database, so this keeps the Linux schema verification
 * selected for the candidate.
 */
export const REAL_SERVER_EVIDENCE_REUSED_OUTPUT = 'real_server_evidence_reused';

type GateOutputName = CoveredReplanOutput | typeof REAL_SERVER_EVIDENCE_REUSED_OUTPUT;
type GateOutput = readonly [GateOutputName, string];

/** Gate outputs a reused native lane clears: the pull request run already proved this work. */
const NATIVE_REUSE_OUTPUTS: readonly GateOutput[] = [
  ['main_required', 'false'],
  ['storekit_required', 'false'],
  ['evidence_required', 'false'],
  ['native_should_run', 'false'],
  ['native_mode', 'skip'],
  ['native_ui_required', 'false'],
  ['native_execution_required', 'false'],
  ['native_execution_lanes', '[]'],
  ['native_full_execution_lanes', '[]'],
  ['native_release_archive_required', 'false'],
  ['native_handoff_required', 'false'],
  ['native_changed_files_explicit_empty', 'true'],
];

const REAL_SERVER_REUSE_OUTPUT: Readonly<Record<RealServerQueueLane, CoveredReplanOutput>> = {
  onboarding: 'onboarding_required',
  'chat-plaid': 'chat_plaid_required',
  income: 'income_required',
  budget: 'budget_required',
};

/**
 * The gate outputs the reused lanes replace. A lane that executes, or was not
 * selected, keeps the gate's own answer; `should_run` turns false only when
 * nothing selected is left to execute. A reused real-server lane also sets
 * `real_server_evidence_reused`, which selects the schema verification.
 */
export function reuseGateOutputs(record: QueueEvidenceReuseRecord): GateOutput[] {
  const outputs: GateOutput[] = [];
  for (const verdict of record.lanes) {
    if (verdict.verdict !== 'reused') continue;
    if (verdict.lane === 'native') outputs.push(...NATIVE_REUSE_OUTPUTS);
    else outputs.push([REAL_SERVER_REUSE_OUTPUT[verdict.lane], 'false']);
  }
  if (record.lanes.some((verdict) => verdict.verdict === 'reused' && verdict.lane !== 'native')) {
    outputs.push([REAL_SERVER_EVIDENCE_REUSED_OUTPUT, 'true']);
  }
  const reused = record.lanes.some((verdict) => verdict.verdict === 'reused');
  const executes = record.lanes.some((verdict) => verdict.verdict === 'executed');
  if (reused && !executes) outputs.push(['should_run', 'false']);
  return outputs;
}

export const IOS_TESTS_WORKFLOW_PATH = '.github/workflows/ios-tests.yml';

export const workflowRunListingSchema = z.object({
  workflow_runs: z.array(z.object({
    id: z.number().int().positive(),
    run_attempt: z.number().int().positive(),
    head_sha: z.string(),
    event: z.string(),
    status: z.string().nullable(),
    conclusion: z.string().nullable(),
    path: z.string(),
    head_repository: z.object({ full_name: z.string() }).nullable(),
  })),
});
export type WorkflowRunSummary = z.infer<typeof workflowRunListingSchema>['workflow_runs'][number];

export type PullRequestRunListing =
  | { readonly kind: 'listed'; readonly runs: readonly WorkflowRunSummary[] }
  | { readonly kind: 'unreadable'; readonly detail: string };

/**
 * The Test - iOS `pull_request` runs on `headSha`, or why they could not be
 * read. A transport failure is an answer here (`unreadable`), not a thrown
 * gate failure: without the listing every selected lane executes.
 */
export async function readPullRequestRuns(
  read: GithubReader,
  apiRoot: string,
  headSha: string,
): Promise<PullRequestRunListing> {
  const url = `${apiRoot}/actions/workflows/ios-tests.yml/runs`
    + `?event=pull_request&head_sha=${headSha}&per_page=100`;
  const unreadable = (cause: string): PullRequestRunListing => ({
    kind: 'unreadable', detail: `could not read Test - iOS runs for ${headSha} (${cause})`,
  });
  let transportFailure = '';
  const response = await readOrNull(read, url, (message) => { transportFailure = message; });
  if (response === null) return unreadable(transportFailure);
  if (response.status !== 200) return unreadable(`HTTP ${response.statusLabel}`);
  const listing = workflowRunListingSchema.safeParse(response.body);
  if (!listing.success) return unreadable('HTTP 200 with an unexpected run listing');
  return { kind: 'listed', runs: listing.data.workflow_runs };
}

export type PullRequestRunChoice =
  | { readonly kind: 'run'; readonly runId: number; readonly runAttempt: number }
  | { readonly kind: 'unavailable'; readonly reason: SourceRefusal; readonly detail: string };

/**
 * The newest completed `pull_request` run of Test - iOS on exactly the queued
 * head, from this repository. Only that run's verdict is the pull request's
 * current iOS verdict, so an older green run behind a newer red one is never
 * used, and a run still in progress has no final jobs to read.
 */
export function choosePullRequestRun(
  runs: readonly WorkflowRunSummary[],
  headSha: string,
  repository: string,
): PullRequestRunChoice {
  const candidates = runs
    .filter((run) => run.head_sha === headSha && run.event === 'pull_request'
      && run.path === IOS_TESTS_WORKFLOW_PATH && run.head_repository?.full_name === repository)
    .sort((left, right) => right.id - left.id);
  const completed = candidates.find((run) => run.status === 'completed');
  if (completed === undefined) {
    const pending = candidates[0];
    return pending === undefined
      ? { kind: 'unavailable', reason: 'no-pull-request-run',
        detail: `no pull_request Test - iOS run on ${headSha} in ${repository}` }
      : { kind: 'unavailable', reason: 'pull-request-run-in-progress',
        detail: `run ${pending.id} on ${headSha} has not completed` };
  }
  if (completed.conclusion !== 'success') {
    return { kind: 'unavailable', reason: 'pull-request-run-not-successful',
      detail: `run ${completed.id} attempt ${completed.run_attempt} concluded `
        + `${completed.conclusion ?? 'without a conclusion'}` };
  }
  return { kind: 'run', runId: completed.id, runAttempt: completed.run_attempt };
}

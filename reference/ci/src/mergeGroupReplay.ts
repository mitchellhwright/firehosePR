import {
  IOS_E2E_AUXILIARY_LANES,
  iosBaseLineageReusePlan,
  isIosEvidenceInvalidatingInput,
  isIosRealServerRuntimeInput,
} from './ios/iosExecutionInputs.ts';
import { QUEUE_MERGE_SUBJECT } from './mergeGroupCandidate.ts';
import type { IosLane } from './nativeExecutionPlan.ts';

/**
 * The decisions behind the merge-queue S2 replay (`ci/scripts/replayMergeGroupPlan.ts`),
 * with none of its I/O.
 *
 * Every first-parent commit on `develop` is replayed as a single-entry queue
 * candidate `C` on queue base `B` for pull request head `H`. The lanes the S1
 * planner selects from `diff(B, C)` are the obligations; each one is then
 * `reused` when the plan's reuse rule admits the PR's own evidence, otherwise
 * `executed`, and a lane the planner does not select is `not-selected`.
 */

export const MAC_LANES = [
  'native', 'evidence', 'storekit', 'onboarding', 'chat-plaid', 'income', 'budget',
] as const;
export type MacLane = typeof MAC_LANES[number];
const REAL_SERVER_LANES: ReadonlySet<MacLane> = new Set(['onboarding', 'chat-plaid', 'income', 'budget']);

export type ReplayCandidate =
  | { readonly kind: 'merge'; readonly prNumber: string; readonly baseSha: string; readonly prHeadSha: string }
  | { readonly kind: 'squash'; readonly prNumber: string; readonly baseSha: string }
  | { readonly kind: 'unattributed'; readonly reason: string };

export interface FirstParentCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly subject: string;
}

const SQUASH_SUBJECT = /\(#([1-9][0-9]*)\)$/;

/**
 * A merge commit gives `B = P1`, `H = P2` and names its PR in the subject the
 * queue parser reads. A squash commit gives `B` = its parent; its PR number
 * comes from the `(#N)` suffix and `H` from the pulls API.
 */
export function replayCandidate(commit: FirstParentCommit): ReplayCandidate {
  const [first, second] = commit.parents;
  if (first === undefined) return { kind: 'unattributed', reason: 'root commit' };
  if (commit.parents.length === 2 && second !== undefined) {
    const merged = QUEUE_MERGE_SUBJECT.exec(commit.subject);
    if (merged?.[1] === undefined) return { kind: 'unattributed', reason: `merge without PR subject: ${commit.subject}` };
    return { kind: 'merge', prNumber: merged[1], baseSha: first, prHeadSha: second };
  }
  if (commit.parents.length !== 1) return { kind: 'unattributed', reason: `${commit.parents.length}-parent commit` };
  const squashed = SQUASH_SUBJECT.exec(commit.subject);
  if (squashed?.[1] === undefined) return { kind: 'unattributed', reason: `direct commit: ${commit.subject}` };
  return { kind: 'squash', prNumber: squashed[1], baseSha: first };
}

/**
 * The Mac lanes the gate's `Detect iOS Changes` outputs select. Budget runs on
 * a Mac only while `vars.IOS_ENABLE_BUDGET_E2E` is on; otherwise its job is
 * skipped whatever the gate selected.
 */
export function selectedMacLanes(
  outputs: ReadonlyMap<string, string>,
  budgetE2eEnabled: boolean,
): ReadonlySet<MacLane> {
  if (outputs.get('should_run') !== 'true') return new Set();
  const flags: readonly (readonly [MacLane, string])[] = [
    ['native', 'main_required'],
    ['evidence', 'evidence_required'],
    ['storekit', 'storekit_required'],
    ['onboarding', 'onboarding_required'],
    ['chat-plaid', 'chat_plaid_required'],
    ['income', 'income_required'],
    ['budget', 'budget_required'],
  ];
  return new Set(flags
    .filter(([lane, key]) => outputs.get(key) === 'true' && (lane !== 'budget' || budgetE2eEnabled))
    .map(([lane]) => lane));
}

export interface ReplayJobStep {
  readonly name: string;
  readonly conclusion: string | null;
}

export interface ReplayJob {
  readonly name: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly steps: readonly ReplayJobStep[];
}

export type LaneOutcome = 'passed' | 'failed';

const REAL_SERVER_STEPS: Readonly<Record<string, string>> = {
  onboarding: 'Run onboarding E2E',
  'chat-plaid': 'Run Chat Plaid E2E',
  income: 'Run Income activation E2E',
  budget: 'Run Budget real-server E2E',
};

function stepOutcome(job: ReplayJob, stepName: string): LaneOutcome | undefined {
  const step = job.steps.find((candidate) => candidate.name === stepName);
  if (step?.conclusion === 'success') return 'passed';
  if (step?.conclusion === 'failure') return 'failed';
  return undefined;
}

/**
 * A lane that owns its whole job: the test step must pass and so must the job,
 * because later steps (evidence validation, result recording) can still fail
 * the lane after the tests themselves passed.
 */
function jobLaneOutcome(job: ReplayJob, testStep: string): LaneOutcome | undefined {
  const tests = stepOutcome(job, testStep);
  if (tests !== 'passed') return tests;
  if (job.conclusion === 'success') return 'passed';
  return job.conclusion === 'failure' ? 'failed' : undefined;
}

const STOREKIT_VERDICT_STEP = 'Verify consolidated StoreKit execution result';

/**
 * StoreKit runs inside the shared native build with `continue-on-error`, and
 * `Record StoreKit result` only turns its outcome into a job output, so
 * neither step fails when the purchase test fails. The verdict is the
 * `StoreKit Purchase - iOS` aggregate's check of that output, counted only
 * when the purchase step actually ran in this run.
 */
function storekitOutcome(jobs: readonly ReplayJob[]): LaneOutcome | undefined {
  const nativeBuild = jobs.find((job) => job.name === 'Build shared native iOS test products');
  const purchase = nativeBuild?.steps.find((step) => step.name === 'Run StoreKit purchase test');
  if (purchase?.conclusion !== 'success' && purchase?.conclusion !== 'failure') return undefined;
  const aggregate = jobs.find((job) => job.name === 'StoreKit Purchase - iOS');
  return aggregate === undefined ? undefined : stepOutcome(aggregate, STOREKIT_VERDICT_STEP);
}

/**
 * One lane made of matrix jobs: any failed job fails it, and it passed only
 * when every matrix job ran its test step and passed. A job cancelled or
 * skipped before its step ran leaves the lane unproven, never passed.
 */
function combined(outcomes: readonly (LaneOutcome | undefined)[]): LaneOutcome | undefined {
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.length === 0 || outcomes.includes(undefined)) return undefined;
  return 'passed';
}

function executionOutcomes(jobs: readonly ReplayJob[], prefix: string): (LaneOutcome | undefined)[] {
  return jobs.filter((job) => job.name.startsWith(`Test - iOS execution (${prefix}`))
    .map((job) => jobLaneOutcome(job, 'Execute Precompiled iOS Tests'));
}

/**
 * What one run of `ios-tests.yml` proves per Mac lane, read from the step that
 * actually runs the lane's tests. A lane whose step did not run is absent; a
 * skipped job is never evidence.
 */
export function laneOutcomes(jobs: readonly ReplayJob[]): ReadonlyMap<MacLane, LaneOutcome> {
  const outcomes = new Map<MacLane, LaneOutcome>();
  const record = (lane: MacLane, outcome: LaneOutcome | undefined): void => {
    if (outcome !== undefined) outcomes.set(lane, outcome);
  };
  record('native', combined(executionOutcomes(jobs, 'native')));
  record('evidence', combined(executionOutcomes(jobs, 'evidence')));
  record('storekit', storekitOutcome(jobs));
  for (const lane of ['onboarding', 'chat-plaid', 'income'] as const) {
    const job = jobs.find((candidate) => candidate.name === `Real-server E2E execution (${lane})`);
    record(lane, job === undefined ? undefined : jobLaneOutcome(job, REAL_SERVER_STEPS[lane] ?? ''));
  }
  const budgetShards = jobs.filter((job) => job.name.startsWith('Real-server E2E execution (budget-'))
    .map((job) => jobLaneOutcome(job, REAL_SERVER_STEPS['budget'] ?? ''));
  record('budget', combined(budgetShards));
  return outcomes;
}

const SCHEMA_PATH = /^(?:server\/db\/|drizzle\.config\.ts$)/;

/**
 * Paths changed between the tree the evidence tested (`T_E`) and the candidate
 * that block reuse of lane `lane`. Empty means the lane's input closure is
 * byte-identical in both trees. `undefined` means the comparison could not be
 * judged and reuse fails closed.
 */
export function laneReuseBlockers(lane: MacLane, changedSinceEvidence: readonly string[]): readonly string[] | undefined {
  const closure = changedSinceEvidence.filter(isIosEvidenceInvalidatingInput);
  if (!REAL_SERVER_LANES.has(lane)) return closure;
  const schema = changedSinceEvidence.filter((path) => SCHEMA_PATH.test(path));
  // Only server-runtime paths can change the auxiliary plan; the rest are
  // dropped so a large but irrelevant comparison is not treated as truncated.
  const serverRuntime = changedSinceEvidence.filter((path) => (
    IOS_E2E_AUXILIARY_LANES.some((lane) => isIosRealServerRuntimeInput(path, lane))
  ));
  const plan = iosBaseLineageReusePlan(serverRuntime.map((filename) => ({ filename, status: 'modified' })));
  if (plan === null) return undefined;
  const auxiliary = IOS_E2E_AUXILIARY_LANES.find((candidate) => candidate === lane);
  const server = auxiliary !== undefined && plan.rerunAuxiliary.includes(auxiliary) ? plan.changedFiles : [];
  return [...new Set([...closure, ...schema, ...server])];
}

export interface MacLaneMinutes {
  readonly nativeBuild: number;
  readonly releaseArchive: number;
  /** Per `Test - iOS execution (<lane>)` matrix job. */
  readonly execution: Readonly<Record<IosLane, number>>;
  readonly e2eBuild: number;
  readonly realServer: Readonly<Record<'onboarding' | 'chat-plaid' | 'income' | 'budget', number>>;
}

/**
 * The native Mac jobs the typed native planner (`deriveNativeExecutionPlan`)
 * schedules for a candidate: the Release archive verification is gated on
 * its own flag, and only the listed execution lanes get a matrix job. A
 * unit-preflight-only plan has neither.
 */
export interface NativeJobPlan {
  readonly releaseArchive: boolean;
  readonly executionLanes: readonly IosLane[];
}

export const NO_NATIVE_JOBS: NativeJobPlan = { releaseArchive: false, executionLanes: [] };

/**
 * Mac minutes one candidate spends on `executed`. The shared native build
 * (which carries the unit preflight and StoreKit) runs once for any native,
 * evidence or StoreKit lane; the Release archive and each execution lane are
 * charged only when the native plan schedules them and their Mac lane
 * executes; the shared E2E build runs once for any real-server lane.
 */
export function candidateMacMinutes(
  executed: ReadonlySet<MacLane>,
  nativeJobs: NativeJobPlan,
  minutes: MacLaneMinutes,
): number {
  let total = 0;
  if (executed.has('native') || executed.has('evidence') || executed.has('storekit')) total += minutes.nativeBuild;
  if (executed.has('native') && nativeJobs.releaseArchive) total += minutes.releaseArchive;
  for (const lane of nativeJobs.executionLanes) {
    const owner: MacLane = lane.startsWith('evidence') ? 'evidence' : 'native';
    if (executed.has(owner)) total += minutes.execution[lane];
  }
  const realServer = (['onboarding', 'chat-plaid', 'income', 'budget'] as const).filter((lane) => executed.has(lane));
  if (realServer.length > 0) total += minutes.e2eBuild;
  for (const lane of realServer) total += minutes.realServer[lane];
  return total;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2;
}

/**
 * Total minutes of one run's matching jobs, or `undefined` unless every one of
 * them succeeded with a recorded duration. A cancelled, failed or unfinished
 * job stopped early (or has not stopped), so a total including it would bias
 * the median down.
 */
export function sampleMinutes(jobs: readonly ReplayJob[]): number | undefined {
  if (jobs.length === 0) return undefined;
  let total = 0;
  for (const job of jobs) {
    const minutes = jobMinutes(job);
    if (job.conclusion !== 'success' || minutes === undefined) return undefined;
    total += minutes;
  }
  return total;
}

export interface AttemptJobsPage {
  readonly total_count: number;
  readonly jobs: readonly { readonly status: string }[];
}

/**
 * Whether one run attempt's jobs answer can never change and may be cached.
 * The run itself must be completed (GitHub can list no jobs yet for a run
 * that just started), the page must hold every job, and every job must be
 * completed. An empty answer is never settled.
 */
export function attemptJobsSettled(runStatus: string | null, page: AttemptJobsPage): boolean {
  return runStatus === 'completed'
    && page.jobs.length > 0
    && page.jobs.length === page.total_count
    && page.jobs.every((job) => job.status === 'completed');
}

export function jobMinutes(job: ReplayJob): number | undefined {
  if (job.startedAt === null || job.completedAt === null) return undefined;
  const minutes = (Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 60_000;
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : undefined;
}

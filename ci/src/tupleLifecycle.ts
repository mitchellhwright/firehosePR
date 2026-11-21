import { z } from 'zod';

/**
 * The decision half of the single `Test - iOS` cancellation owner,
 * `ci/src/actions/cancelObsoleteIosRuns.ts`. That controller gathers the facts
 * from GitHub; this module decides, from those facts alone, which active runs
 * of a pull request it cancels and which it keeps.
 *
 * Two pull-request events can make an active run obsolete:
 * - `synchronize`: runs for an older head, unless the run is a verified
 *   patch-equivalent predecessor whose evidence the new head reuses, or its
 *   iOS execution inputs match the live head and it is still executing;
 * - `edited` with a base change (a retarget): runs for the current head that
 *   were created for a different base branch.
 *
 * The same `synchronize` is decided a second time once the new head's iOS
 * gate has routed it in full (`full-routing`: no verified base-update
 * increment, nothing superseded, nothing deferred). The new head then waits
 * for no predecessor, so a verified predecessor is kept only while it is
 * still executing; one that has not started would later run a stale head.
 *
 * Workflow-level `cancel-in-progress` cannot express either rule: it would also
 * destroy the retained predecessor that evidence reuse depends on.
 */

const shaPattern = /^[0-9a-f]{40}$/;
const shaSchema = z.string().regex(shaPattern, 'Expected a 40-character lowercase commit SHA');
const runIdSchema = z.number().int().positive();

export const activeRunStatuses = ['queued', 'in_progress', 'pending', 'requested', 'waiting'] as const;
export const workflowRunStatusSchema = z.enum([...activeRunStatuses, 'completed']);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

const pullRequestRefSchema = z.object({
  sha: shaSchema,
  ref: z.string().min(1),
  repository: z.string(),
}).strict();

export const pullRequestTupleSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  head: pullRequestRefSchema,
  base: pullRequestRefSchema,
}).strict();
export type PullRequestTuple = z.infer<typeof pullRequestTupleSchema>;

export const workflowRunSchema = z.object({
  id: runIdSchema,
  workflow: z.string().min(1),
  headSha: shaSchema,
  status: workflowRunStatusSchema,
  /** `null` when GitHub reported no parseable creation time; such a run is never retained. */
  createdAt: z.iso.datetime({ offset: true }).nullable(),
  pullRequests: z.array(z.object({
    number: z.number().int().positive(),
    baseRef: z.string().min(1).optional(),
  }).strict()),
}).strict();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

const verifiedAncestorSchema = z.object({
  headSha: shaSchema,
  completedReusableEvidence: z.boolean(),
}).strict();
export type VerifiedAncestor = z.infer<typeof verifiedAncestorSchema>;

export const tupleLifecycleInputSchema = z.object({
  repository: z.string().min(1),
  event: z.object({
    action: z.string(),
    previousHeadSha: z.string().nullable(),
    /** Whether an `edited` event carries `changes.base`, i.e. the pull request was retargeted. */
    baseChanged: z.boolean(),
    /**
     * Whether the new head's iOS gate routed this `synchronize` in full, so the
     * head defers to no predecessor (`release-full-routing-predecessor`).
     */
    fullRouting: z.boolean().default(false),
  }).strict(),
  pullRequest: pullRequestTupleSchema,
  livePullRequest: pullRequestTupleSchema.nullable(),
  /**
   * Per obsolete run head: whether its iOS execution inputs differ from the
   * live head's. Measured from each run's own head, never from the event's
   * `before`, so a replaced synchronize cannot hide an older head's change.
   * A retarget does not read it.
   */
  iosExecutionScopeChangedByHead: z.record(shaSchema, z.boolean()).nullable(),
  patchEquivalentPredecessor: z.boolean().nullable(),
  verifiedLineage: z.array(verifiedAncestorSchema),
  runs: z.array(workflowRunSchema),
  queuedOnlyRunIds: z.array(runIdSchema).default([]),
}).strict().superRefine((input, context) => {
  if (input.patchEquivalentPredecessor !== true && input.verifiedLineage.length > 0) {
    context.addIssue({
      code: 'custom',
      message: 'A verified lineage requires a patch-equivalent predecessor',
      path: ['verifiedLineage'],
    });
  }
});
export type TupleLifecycleInput = z.input<typeof tupleLifecycleInputSchema>;

export const tupleDispositionSchema = z.enum([
  'current',
  'cancel-obsolete',
  'cancel-prior-base',
  'retain-patch-equivalent-predecessor',
]);
export type TupleDisposition = z.infer<typeof tupleDispositionSchema>;

export const planReasonCodeSchema = z.enum([
  'decisions-derived',
  'event-not-handled',
  'previous-head-unknown',
  'tuple-outside-repository',
  'pull-request-not-ready',
  'tuple-superseded',
  'ios-scope-unchanged',
  'facts-incomplete',
]);
export type PlanReasonCode = z.infer<typeof planReasonCodeSchema>;

const decisionReasonCodeSchema = z.enum([
  'current-head',
  'obsolete-head',
  'prior-base-branch',
  'retained-verified-ancestor',
  'predecessor-not-executing',
]);
const ignoredReasonCodeSchema = z.enum([
  'workflow-out-of-scope',
  'pull-request-mismatch',
  'run-not-active',
  'ios-scope-unchanged',
  'not-current-head',
]);

export const tupleLifecyclePlanSchema = z.object({
  schema: z.literal('firehosepr.tuple-lifecycle-plan.v2'),
  workflow: z.literal('Test - iOS'),
  trigger: z.enum(['synchronize', 'full-routing', 'retarget']).nullable(),
  tuple: z.object({
    pullRequest: z.number().int().positive(),
    headSha: shaSchema,
    baseSha: shaSchema,
    baseRef: z.string().min(1),
  }).strict(),
  applicable: z.boolean(),
  reasonCode: planReasonCodeSchema,
  decisions: z.array(z.object({
    runId: runIdSchema,
    headSha: shaSchema,
    disposition: tupleDispositionSchema,
    reasonCode: decisionReasonCodeSchema,
  }).strict()),
  ignoredRuns: z.array(z.object({
    runId: runIdSchema,
    reasonCode: ignoredReasonCodeSchema,
  }).strict()),
  /** In the order the owner cancels them (`cancellationOrder`). */
  cancelRunIds: z.array(runIdSchema),
  retainRunIds: z.array(runIdSchema),
}).strict();
export type TupleLifecyclePlan = z.infer<typeof tupleLifecyclePlanSchema>;

type ParsedInput = z.infer<typeof tupleLifecycleInputSchema>;
type Trigger = NonNullable<TupleLifecyclePlan['trigger']>;
type Decision = TupleLifecyclePlan['decisions'][number];
type IgnoredRun = TupleLifecyclePlan['ignoredRuns'][number];

const controlledWorkflow = 'Test - iOS';

/** Which cancellation rule an event invokes, or `null` when it invokes none. */
export function triggerOf(event: ParsedInput['event']): Trigger | null {
  if (event.action === 'synchronize') return event.fullRouting ? 'full-routing' : 'synchronize';
  if (event.action === 'edited' && event.baseChanged) return 'retarget';
  return null;
}

function sameTuple(expected: PullRequestTuple, live: PullRequestTuple): boolean {
  return live.state === 'open'
    && live.draft === false
    && live.number === expected.number
    && live.head.sha === expected.head.sha
    && live.head.repository === expected.head.repository
    && live.base.sha === expected.base.sha
    && live.base.ref === expected.base.ref
    && live.base.repository === expected.base.repository;
}

function isActive(run: WorkflowRun): boolean {
  switch (run.status) {
    case 'queued':
    case 'in_progress':
    case 'pending':
    case 'requested':
    case 'waiting':
      return true;
    case 'completed':
      return false;
  }
}

function belongsToPullRequest(run: WorkflowRun, pullRequest: PullRequestTuple): boolean {
  return run.pullRequests.some((candidate) => candidate.number === pullRequest.number);
}

function matchesPullRequestBase(run: WorkflowRun, pullRequest: PullRequestTuple): boolean {
  return run.pullRequests.some((candidate) => (
    candidate.number === pullRequest.number && candidate.baseRef === pullRequest.base.ref
  ));
}

function createdForPriorBase(run: WorkflowRun, pullRequest: PullRequestTuple): boolean {
  return run.pullRequests.some((candidate) => (
    candidate.number === pullRequest.number
    && candidate.baseRef !== undefined
    && candidate.baseRef !== pullRequest.base.ref
  ));
}

function tupleApplicability(input: ParsedInput, trigger: Trigger): PlanReasonCode | null {
  if (trigger !== 'retarget'
    && (input.event.previousHeadSha === null || !shaPattern.test(input.event.previousHeadSha))) {
    return 'previous-head-unknown';
  }
  if (input.pullRequest.head.repository !== input.repository
    || input.pullRequest.base.repository !== input.repository) {
    return 'tuple-outside-repository';
  }
  if (trigger === 'retarget' && (input.pullRequest.state !== 'open' || input.pullRequest.draft)) {
    return 'pull-request-not-ready';
  }
  if (input.livePullRequest === null || !sameTuple(input.pullRequest, input.livePullRequest)) {
    return 'tuple-superseded';
  }
  return null;
}

function obsoleteRuns(input: ParsedInput): WorkflowRun[] {
  return input.runs.filter(run => run.workflow === controlledWorkflow
    && run.headSha !== input.pullRequest.head.sha
    && isActive(run)
    && belongsToPullRequest(run, input.pullRequest));
}

function synchronizeFactsApplicability(input: ParsedInput): PlanReasonCode {
  const scopeByHead = input.iosExecutionScopeChangedByHead;
  if (scopeByHead === null || input.patchEquivalentPredecessor === null) return 'facts-incomplete';
  const obsolete = obsoleteRuns(input);
  if (obsolete.some(run => scopeByHead[run.headSha] === undefined)) return 'facts-incomplete';
  if (!input.patchEquivalentPredecessor && obsolete.length > 0
    && !obsolete.some(run => scopeByHead[run.headSha] === true || run.status === 'pending'
      || input.queuedOnlyRunIds.includes(run.id))) {
    return 'ios-scope-unchanged';
  }
  return 'decisions-derived';
}

function applicability(input: ParsedInput, trigger: Trigger | null): PlanReasonCode {
  if (trigger === null) return 'event-not-handled';
  const tupleReason = tupleApplicability(input, trigger);
  if (tupleReason !== null) return tupleReason;
  return trigger === 'retarget' ? 'decisions-derived' : synchronizeFactsApplicability(input);
}

function preferExecutingThenNewest(left: WorkflowRun, right: WorkflowRun): number {
  const priority = (run: WorkflowRun) => run.status === 'in_progress' ? 2
    : run.status === 'queued' ? 1 : 0;
  return priority(right) - priority(left)
    || Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? '');
}

function isExecuting(run: WorkflowRun): boolean {
  return run.status === 'in_progress' || run.status === 'queued';
}

function retainedRunIds(input: ParsedInput): Set<number> {
  const retained = new Set<number>();
  for (const ancestor of input.verifiedLineage) {
    if (ancestor.completedReusableEvidence) break;
    const newest = input.runs
      .filter((run) => (
        run.workflow === controlledWorkflow
        && run.headSha === ancestor.headSha
        && isActive(run)
        && run.createdAt !== null
        && matchesPullRequestBase(run, input.pullRequest)
      ))
      .sort(preferExecutingThenNewest)[0];
    // A verified predecessor with no executing job is released: its unstarted
    // Mac jobs can only fail the exact-revision guard.
    if (newest && !input.queuedOnlyRunIds.includes(newest.id)) retained.add(newest.id);
  }
  return retained;
}

function outOfScope(run: WorkflowRun, input: ParsedInput): IgnoredRun | null {
  if (run.workflow !== controlledWorkflow) return { runId: run.id, reasonCode: 'workflow-out-of-scope' };
  if (!belongsToPullRequest(run, input.pullRequest)) {
    return { runId: run.id, reasonCode: 'pull-request-mismatch' };
  }
  if (!isActive(run)) return { runId: run.id, reasonCode: 'run-not-active' };
  return null;
}

function decideSynchronizeRun(
  run: WorkflowRun,
  input: ParsedInput,
  retained: ReadonlySet<number>,
  trigger: Trigger,
): Decision | IgnoredRun {
  if (retained.has(run.id)) {
    // A fully routed head waits for no predecessor, so only a predecessor that
    // is still producing its evidence keeps running.
    if (trigger === 'full-routing' && !isExecuting(run)) {
      return {
        runId: run.id,
        headSha: run.headSha,
        disposition: 'cancel-obsolete',
        reasonCode: 'predecessor-not-executing',
      };
    }
    return {
      runId: run.id,
      headSha: run.headSha,
      disposition: 'retain-patch-equivalent-predecessor',
      reasonCode: 'retained-verified-ancestor',
    };
  }
  if (run.headSha === input.pullRequest.head.sha) {
    return { runId: run.id, headSha: run.headSha, disposition: 'current', reasonCode: 'current-head' };
  }
  // Same-scope work stays only while it is executing; an old run whose
  // unfinished jobs are all queued blocks the waiting exact-head run.
  if (input.iosExecutionScopeChangedByHead?.[run.headSha] === false && !input.patchEquivalentPredecessor
    && run.status !== 'pending' && !input.queuedOnlyRunIds.includes(run.id)) {
    return { runId: run.id, reasonCode: 'ios-scope-unchanged' };
  }
  return { runId: run.id, headSha: run.headSha, disposition: 'cancel-obsolete', reasonCode: 'obsolete-head' };
}

/**
 * A retarget acts only on the current head: older heads belong to the
 * synchronize rule, and a current-head run for the new base is the work the
 * retarget is waiting for.
 */
function decideRetargetRun(run: WorkflowRun, input: ParsedInput): Decision | IgnoredRun {
  if (run.headSha !== input.pullRequest.head.sha) return { runId: run.id, reasonCode: 'not-current-head' };
  if (createdForPriorBase(run, input.pullRequest)) {
    return { runId: run.id, headSha: run.headSha, disposition: 'cancel-prior-base', reasonCode: 'prior-base-branch' };
  }
  return { runId: run.id, headSha: run.headSha, disposition: 'current', reasonCode: 'current-head' };
}

function isDecision(entry: Decision | IgnoredRun): entry is Decision {
  return 'disposition' in entry;
}

function ascending(left: number, right: number): number {
  return left - right;
}

/**
 * The order the owner cancels in, which decides the outcome only when the
 * tuple moves mid-way. Each rule keeps the order of the controller it
 * replaced: run id for `synchronize` and a retarget, newest run first for
 * `full-routing`.
 */
function cancellationOrder(input: ParsedInput, trigger: Trigger): (left: number, right: number) => number {
  if (trigger !== 'full-routing') return ascending;
  const createdAt = new Map(input.runs.map(run => [run.id, Date.parse(run.createdAt ?? '')]));
  return (left, right) => {
    const delta = (createdAt.get(right) ?? Number.NaN) - (createdAt.get(left) ?? Number.NaN);
    return Number.isNaN(delta) || delta === 0 ? right - left : delta;
  };
}

function decide(input: ParsedInput, trigger: Trigger): (Decision | IgnoredRun)[] {
  const retained = trigger === 'retarget' ? new Set<number>() : retainedRunIds(input);
  return input.runs.map((run) => outOfScope(run, input)
    ?? (trigger === 'retarget'
      ? decideRetargetRun(run, input)
      : decideSynchronizeRun(run, input, retained, trigger)));
}

export function deriveTupleLifecyclePlan(rawInput: TupleLifecycleInput): TupleLifecyclePlan {
  const input = tupleLifecycleInputSchema.parse(rawInput);
  const trigger = triggerOf(input.event);
  const reasonCode = applicability(input, trigger);
  const header = {
    schema: 'firehosepr.tuple-lifecycle-plan.v2',
    workflow: controlledWorkflow,
    trigger,
    tuple: {
      pullRequest: input.pullRequest.number,
      headSha: input.pullRequest.head.sha,
      baseSha: input.pullRequest.base.sha,
      baseRef: input.pullRequest.base.ref,
    },
    reasonCode,
  };
  if (trigger === null || reasonCode !== 'decisions-derived') {
    return tupleLifecyclePlanSchema.parse({
      ...header, applicable: false, decisions: [], ignoredRuns: [], cancelRunIds: [], retainRunIds: [],
    });
  }

  const outcomes = decide(input, trigger);
  const decisions = outcomes.filter(isDecision);
  const runIdsWith = (
    dispositions: readonly TupleDisposition[],
    order: (left: number, right: number) => number = ascending,
  ): number[] => decisions
    .filter((decision) => dispositions.includes(decision.disposition))
    .map((decision) => decision.runId)
    .sort(order);

  return tupleLifecyclePlanSchema.parse({
    ...header,
    applicable: true,
    decisions,
    ignoredRuns: outcomes.filter((entry): entry is IgnoredRun => !isDecision(entry)),
    cancelRunIds: runIdsWith(['cancel-obsolete', 'cancel-prior-base'], cancellationOrder(input, trigger)),
    retainRunIds: runIdsWith(['retain-patch-equivalent-predecessor']),
  });
}

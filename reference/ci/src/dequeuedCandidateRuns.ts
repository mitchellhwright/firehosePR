import { MERGE_QUEUE_BASE_BRANCH, MERGE_QUEUE_REF_PATTERN } from './mergeQueueRef.ts';

/**
 * Cancelling the runs of a merge queue candidate GitHub has dropped.
 *
 * GitHub does not cancel a candidate's workflow runs when its queue entry
 * merges, fails, times out or is dequeued (merge-queue plan §4); the runs
 * keep queueing for Linux and Mac capacity and post verdicts on a SHA no
 * queue entry will ever read. Every removal deletes the candidate's ref,
 * which fires `on: delete` with the short ref in `payload.ref`, so that event
 * is the cancellation trigger.
 *
 * A run is cancelled only when all of these hold at the time of the cancel:
 *  - the deleted ref has the queue shape `gh-readonly-queue/develop/pr-<N>-<base>`;
 *  - the run belongs to a validation workflow, is still active, was started
 *    by `merge_group` and names the deleted ref as its branch;
 *  - the ref is still absent, or exists again but points at a different
 *    candidate (a re-queued entry on the same base reuses the ref name);
 *  - the run's candidate is not contained in `develop`: a merged entry's
 *    candidate is develop's new tip, and its remaining jobs may still report
 *    on that commit.
 * Anything that cannot be read leaves the run alone; a missed cancel costs
 * capacity, a wrong one costs a queue entry.
 */

export const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'pending', 'requested', 'waiting'] as const;

export interface CandidateRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
}

export type DevelopContainment = 'contained' | 'not-contained' | 'unknown';

export type RunDecision =
  | { readonly kind: 'cancel'; readonly run: CandidateRun }
  | { readonly kind: 'keep'; readonly run: CandidateRun; readonly reason: string };

/** The short ref a `delete` event carries, or `undefined` for anything that is not a develop queue ref. */
export function deletedQueueRef(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const payload = event as Record<string, unknown>;
  if (payload['ref_type'] !== 'branch' || typeof payload['ref'] !== 'string') return undefined;
  const ref = payload['ref'];
  return MERGE_QUEUE_REF_PATTERN.test(`refs/heads/${ref}`) ? ref : undefined;
}

export function decideCandidateRun(options: {
  readonly run: CandidateRun;
  readonly deletedRef: string;
  readonly workflowNames: ReadonlySet<string>;
  /** Where the ref points now, or `undefined` when it is still deleted. */
  readonly liveRefSha: string | undefined;
  readonly containment: DevelopContainment;
  readonly currentRunId?: number | undefined;
}): RunDecision {
  const { run } = options;
  const keep = (reason: string): RunDecision => ({ kind: 'keep', run, reason });
  if (!options.workflowNames.has(run.name)) return keep(`workflow ${run.name} is not a validation workflow`);
  if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) return keep(`run is ${run.status}`);
  if (run.event !== 'merge_group') return keep(`run was started by ${run.event}`);
  if (run.headBranch !== options.deletedRef) return keep(`run is for ${run.headBranch}`);
  if (run.id === options.currentRunId) return keep('run is this workflow');
  if (options.liveRefSha === run.headSha) return keep(`ref exists again and points at this candidate ${run.headSha}`);
  switch (options.containment) {
    case 'contained':
      return keep(`candidate ${run.headSha} is on ${MERGE_QUEUE_BASE_BRANCH}`);
    case 'unknown':
      return keep(`containment of ${run.headSha} in ${MERGE_QUEUE_BASE_BRANCH} could not be read`);
    case 'not-contained':
      return { kind: 'cancel', run };
    default:
      return assertNever(options.containment);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected containment: ${JSON.stringify(value)}`);
}

/** GitHub's `compare/{base}...{head}` status, as containment of `head` in `base`. */
export function containmentFromCompareStatus(status: unknown): DevelopContainment {
  switch (status) {
    case 'identical':
    case 'behind':
      return 'contained';
    case 'ahead':
    case 'diverged':
      return 'not-contained';
    default:
      return 'unknown';
  }
}

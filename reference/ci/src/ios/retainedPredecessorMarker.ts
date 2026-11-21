import { notice, pass, type StepDecision } from './shared/stepDecision.ts';

/**
 * The deferred head's success marker.
 *
 * A head whose delta is patch-equivalent to an active predecessor owns no
 * checks of its own yet. This job publishes that fact and must *succeed*:
 * `ci/src/actions/resumeRetainedIosPredecessor.ts` finds the deferred run by this
 * job's static name and its step's dynamic name, and ignores a job that
 * concluded anything other than success. The aggregate fails instead, which is
 * what keeps the head red until the rerun.
 *
 * The identities are rendered rather than interpolated into a shell line, so a
 * run id or SHA that is not what it should be cannot forge an annotation or a
 * second summary line.
 */

export interface RetainedPredecessor {
  readonly predecessorRunId: string;
  readonly deferredBaseSha: string;
}

/** Both identities come from the gate; neither may contain markup or newlines. */
const identifierPattern = /^[0-9a-zA-Z]+$/;

export function retainedPredecessorMarker(input: RetainedPredecessor): StepDecision {
  for (const [label, value] of [
    ['predecessor run id', input.predecessorRunId],
    ['deferred base SHA', input.deferredBaseSha],
  ] as const) {
    if (!identifierPattern.test(value)) {
      throw new Error(`Retained ${label} is not a bare identifier: ${value}`);
    }
  }
  return pass(
    notice(
      `Patch-equivalent iOS run ${input.predecessorRunId} is still active. ` +
        'This workflow will rerun automatically after it completes.',
    ),
  );
}

/** The one line the job adds to the run summary. */
export function retainedPredecessorSummary(input: RetainedPredecessor): string {
  return (
    `Awaiting retained iOS predecessor run \`${input.predecessorRunId}\` ` +
    `at \`${input.deferredBaseSha}\`.`
  );
}

import { appendStepSummary, requiredEnv } from '../../ios/shared/actionIo.ts';
import { runStepProgram } from '../../ios/shared/stepDecision.ts';
import {
  retainedPredecessorMarker,
  retainedPredecessorSummary,
} from '../../ios/retainedPredecessorMarker.ts';

/**
 * The deferred head's success marker.
 *
 * This job exists to conclude success while a patch-equivalent predecessor is
 * still running, so `ci/src/actions/resumeRetainedIosPredecessor.ts` can find it
 * and rerun this workflow afterwards. It must therefore do as little as
 * possible: it reads two identities, refuses anything that is not a bare
 * identifier, prints one notice and writes one summary line.
 */
runStepProgram('Retained predecessor marker', () => {
  const predecessor = {
    predecessorRunId: requiredEnv('PREDECESSOR_ID'),
    deferredBaseSha: requiredEnv('DEFERRED_BASE_SHA'),
  };
  const decision = retainedPredecessorMarker(predecessor);
  appendStepSummary(retainedPredecessorSummary(predecessor));
  return decision;
});

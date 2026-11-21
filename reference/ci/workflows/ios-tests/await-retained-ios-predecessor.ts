import { concat, expr, suffixed, typedJob, typedStep } from '../lib/index.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import {
  controlLane, iosControlRunner, iosGateOutput, setupNode, TRUSTED_VERIFIER_SHA, typedLayerCheckout,
} from './shared.ts';

/**
 * Record which run this deferred head is waiting on.
 *
 * A head the classifier deferred owns no checks of its own: the run it is a
 * verified increment of is still producing the evidence both heads share. This
 * job publishes that identity and nothing else — it starts no work, waits on
 * nothing, and succeeds immediately. The aggregate is what keeps the head red
 * until `resumeRetainedIosPredecessor.ts` reruns the deferred lanes, which
 * it does by reading the predecessor identity back out of the marker step's
 * name.
 */

const checkoutPredecessorMarker = typedLayerCheckout({
  name: 'Checkout typed predecessor marker',
  path: '.ci/trusted-predecessor-marker',
  ref: TRUSTED_VERIFIER_SHA,
});

/**
 * This job is a success marker, so its own name stays static and
 * human-readable and the retained predecessor identity travels in this step's
 * name instead. The job must not fail while the predecessor is still active;
 * the aggregate fails instead and keeps the head red until that rerun.
 */
const publishMarker = typedStep({
  name: suffixed(
    'Await retained iOS predecessor',
    concat(
      iosGateOutput('base_update_predecessor_run_id'),
      ' at ',
      iosGateOutput('base_update_deferred_base_sha'),
    ),
    expr(
      "needs.ios-change-gate.outputs.base_update_predecessor_run_ids != '' "
      + "&& format(' [ancestors: {0}]', needs.ios-change-gate.outputs.base_update_predecessor_run_ids) "
      + "|| ''",
    ),
  ),
  doc: {
    purpose: 'Publishes which run this deferred head is reusing, for the resume handler to read back.',
    recovery: 'a missing predecessor id is the failure; rerun the gate so the classifier republishes it',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'step',
  env: {
    PREDECESSOR_ID: iosGateOutput('base_update_predecessor_run_id'),
    DEFERRED_BASE_SHA: iosGateOutput('base_update_deferred_base_sha'),
  },
  command: 'node .ci/trusted-predecessor-marker/ci/src/actions/ios/publishRetainedPredecessorMarker.ts',
});

export const awaitRetainedIosPredecessor = typedJob('await-retained-ios-predecessor', {
  name: 'Await retained iOS predecessor',
  doc: {
    purpose: 'Names the retained predecessor run whose evidence this deferred head is reusing.',
    successMeaning: 'The resume handler can find the run this head is waiting on.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  needs: [iosChangeGate],
  if: expr("needs.ios-change-gate.outputs.base_update_deferred == 'true'"),
  runsOn: iosControlRunner,
  // Two steps materialise the typed marker program before it runs. The bound
  // is a failure bound only; nothing in this job waits on anything.
  timeoutMinutes: 5,
  lane: controlLane,
  steps: [
    checkoutPredecessorMarker,
    setupNode('Setup Node for the typed predecessor marker'),
    publishMarker,
  ],
});

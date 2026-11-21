import { expr, github, typedJob, typedStep } from '../lib/index.ts';
import { budgetE2e } from './budget-e2e.ts';
import { budgetE2eVideoProcessing } from './budget-e2e-video-processing.ts';
import { buildIosE2eTestProducts } from './build-ios-e2e-test-products.ts';
import { buildIosNativeTestProducts } from './build-ios-native-test-products.ts';
import { chatPlaidE2e } from './chat-plaid-e2e.ts';
import { incomeE2e } from './income-e2e.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { onboardingE2e } from './onboarding-e2e.ts';
import {
  cleanupLane, iosControlRunner, setupNode, TRUSTED_VERIFIER_SHA, typedLayerCheckout,
} from './shared.ts';
import { testIos } from './test-ios.ts';
import { testIosExecution } from './test-ios-execution.ts';
import { verifyIosReleaseArchive } from './verify-ios-release-archive.ts';

/**
 * Give the Actions artifact budget back once nothing can read it.
 *
 * Every artifact this run uploads is either an intra-run handoff (the
 * test-products fallbacks) or evidence that only a failed run needs, and all
 * of it is billed against the same Actions budget until retention expires it.
 * Once every producer has finished without failing or being cancelled,
 * nothing can rerun against them and nobody needs to read them, so remove
 * them. A run with a failed or cancelled job keeps its artifacts for their
 * short retention so the failure can be diagnosed.
 */

const deleteRunArtifacts = typedStep({
  name: "Delete this run's artifacts",
  doc: {
    purpose: 'Deletes every artifact this run uploaded, now that no job can still be rerun against them.',
    recovery: 'the cleanup is advisory; unread artifacts expire on their own retention if it fails',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  env: {
    GH_TOKEN: github('token'),
    RUN_ID: github('run_id'),
    REPOSITORY: github('repository'),
  },
  command: 'node .ci/trusted-artifact-cleanup/ci/src/actions/ios/removeRunArtifacts.ts',
});

export const removeRunArtifactsAfterSuccess = typedJob('remove-run-artifacts-after-success', {
  name: 'Remove run artifacts after success',
  doc: {
    purpose: 'Removes the artifacts of a run whose every producer finished without failing.',
    successMeaning: 'The Actions artifact budget is no longer holding evidence nobody can read.',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'suite',
  needs: [
    iosChangeGate,
    verifyIosReleaseArchive,
    buildIosNativeTestProducts,
    testIosExecution,
    buildIosE2eTestProducts,
    onboardingE2e,
    chatPlaidE2e,
    incomeE2e,
    budgetE2e,
    budgetE2eVideoProcessing,
    // The required verdict must claim scarce control capacity before this
    // advisory cleanup can enter the runner queue.
    testIos,
  ],
  if: expr(
    'always() && !cancelled() '
    + "&& needs.ios-change-gate.result == 'success' "
    + "&& needs.ios-change-gate.outputs.verifier_sha != '' "
    + "&& !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled')",
  ),
  runsOn: iosControlRunner,
  timeoutMinutes: 5,
  // Losing the artifacts is a budget problem, not a correctness one, so a
  // failure here never turns a green run red.
  continueOnError: true,
  permissions: {
    // `contents: read` materialises the typed cleanup program; the deletions
    // themselves need `actions: write` and nothing else.
    actions: 'write',
    contents: 'read',
  },
  lane: cleanupLane,
  steps: [
    typedLayerCheckout({
      name: 'Checkout typed artifact cleanup',
      path: '.ci/trusted-artifact-cleanup',
      ref: TRUSTED_VERIFIER_SHA,
    }),
    setupNode('Setup Node for the typed artifact cleanup'),
    deleteRunArtifacts,
  ],
});

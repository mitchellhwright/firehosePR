import {
  ciEventField, ciEventFieldWith, expr, typedJob, typedStep,
} from '../lib/index.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import {
  controlLane, installTypedCiDependencies, iosControlRunner, iosGateOutput, prMetadataToken,
  setupNode, TRUSTED_VERIFIER_SHA, typedLayerCheckout,
} from './shared.ts';

/**
 * Check the pull request still is what it was when the run was queued.
 *
 * Mac capacity is physical and shared, and a queued run can sit behind other
 * lanes long enough for its pull request to be closed, retargeted or pushed
 * over. Every Mac job is gated on this answer, so the comparison happens once,
 * here, on Linux — before the first Mac is allocated rather than after an hour
 * of Xcode has already been spent on a tuple nobody is merging.
 */

const prMetadataTokenStep = prMetadataToken('Create final tuple fallback token');

const checkoutLiveTupleGuard = typedLayerCheckout({
  name: 'Checkout typed live tuple guard',
  path: '.ci/trusted-live-tuple-guard',
  ref: TRUSTED_VERIFIER_SHA,
});

// GitHub records the commit containing the workflow it actually executed.
// For pull_request this can be the synthetic merge commit, including a
// promotion's new workflow; the base commit can describe a different program.
// Read this checkout only as inventory. The guard still executes from the
// independently proven verifier checkout above.
const checkoutExecutingWorkflow = typedLayerCheckout({
  name: 'Checkout executing iOS workflow inventory',
  path: '.ci/executing-ios-workflow',
  ref: expr('github.workflow_sha'),
  if: expr("steps.current.outputs.current == 'true'"),
  sparseCheckout: 'ci\nscripts\n.github/workflows\n',
});

const current = typedStep({
  id: 'current',
  name: 'Compare the queued tuple with the live pull request',
  doc: {
    purpose: 'Compares the head, base and base branch this run was queued for with the live pull request.',
    recovery: 'a moved tuple is the expected answer, not a failure; rerun only if the API call itself failed',
  },
  owner: 'automation',
  category: 'quality',
  unit: 'step',
  outputs: ['current'] as const,
  env: {
    GH_TOKEN: expr('steps.pr-metadata-token.outputs.token || github.token'),
    PR_NUMBER: iosGateOutput('pr_number'),
    EXPECTED_HEAD: iosGateOutput('expected_head_sha'),
    EXPECTED_BASE: iosGateOutput('expected_base_sha'),
    EXPECTED_BASE_REF: iosGateOutput('expected_base_ref'),
  },
  command: 'node .ci/trusted-live-tuple-guard/ci/src/actions/ios/confirmCurrentPullRequest.ts',
});

// Both the tuple comparison and the runtime verifier import the typed CI layer
// (zod through ciEvent.ts) from this nested checkout, so its pinned packages
// are installed before either runs.
const installLiveTupleGuardDependencies = installTypedCiDependencies(
  'Install trusted live tuple guard dependencies',
  '.ci/trusted-live-tuple-guard/ci',
);

const runtimeGuardCondition = expr(
  "steps.current.outputs.current == 'true' "
  + "&& hashFiles('.ci/trusted-live-tuple-guard/ci/src/actions/ios/verifyWorkflowRuntimeFiles.ts') != ''",
);

const runtime = typedStep({
  id: 'runtime',
  name: 'Verify workflow executables exist at the exact head',
  doc: {
    purpose: 'Stops a base workflow from allocating a Mac when its new action or script is absent from the PR checkout.',
    recovery: 'update the PR branch onto develop; its next synchronize event will re-run this guard',
  },
  owner: 'automation',
  category: 'quality',
  unit: 'step',
  // This PR's workflow can run before the protected base has the new trusted
  // action. Once merged, every base checkout contains it and the guard runs.
  if: runtimeGuardCondition,
  env: {
    GH_TOKEN: expr('steps.pr-metadata-token.outputs.token || github.token'),
    EXACT_HEAD_SHA: ciEventField('headSha'),
    HEAD_REPOSITORY: ciEventFieldWith('headRepository', { workflow_dispatch: 'github.repository' }),
    WORKFLOW_CHECKOUT_ROOT: '.ci/executing-ios-workflow',
    WORKFLOW_PATH: '.ci/executing-ios-workflow/.github/workflows/ios-tests.yml',
  },
  command: 'node .ci/trusted-live-tuple-guard/ci/src/actions/ios/verifyWorkflowRuntimeFiles.ts',
});

export const confirmCurrentIosPr = typedJob('confirm-current-ios-pr', {
  name: 'Confirm current iOS PR tuple before Mac allocation',
  doc: {
    purpose: 'Confirms the queued pull request tuple is still the live one before any Mac is allocated.',
    successMeaning: 'The Mac lanes are about to build the tuple the pull request actually has.',
  },
  owner: 'automation',
  category: 'quality',
  unit: 'job',
  needs: [iosChangeGate],
  // A non-iOS change has no downstream Mac allocation to protect. Keep the
  // tuple guard out of the runner queue unless the typed gate selected iOS
  // work for this exact event.
  if: expr(
    "always() && !cancelled() && needs.ios-change-gate.result == 'success' "
    + "&& needs.ios-change-gate.outputs.should_run == 'true'",
  ),
  runsOn: iosControlRunner,
  permissions: { contents: 'read', 'pull-requests': 'read' },
  lane: controlLane,
  outputs: {
    current: expr("steps.current.outputs.current == 'true' && (steps.runtime.outcome == 'success' || steps.runtime.outcome == 'skipped')"),
  },
  steps: [
    prMetadataTokenStep,
    checkoutLiveTupleGuard,
    setupNode('Setup Node for the typed live tuple guard'),
    installLiveTupleGuardDependencies,
    current,
    checkoutExecutingWorkflow,
    runtime,
  ],
});

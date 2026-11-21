import {
  ciEventField, expr, github, needsOutput, typedJob, typedStep,
} from '../lib/index.ts';
import { buildIosNativeTestProducts } from './build-ios-native-test-products.ts';
import { promotionVerdictAt } from './promotion-verdict.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { queueEvidenceReportAt } from './queue-evidence-report.ts';
import {
  installTypedCiDependencies, iosControlRunner, iosGateOutput, controlLane, setupNode,
  iosGateOutputPath, STATUS_AGGREGATE_CONDITION, TRUSTED_VERIFIER_SHA, typedLayerCheckout,
} from './shared.ts';

/**
 * The required check that says whether the StoreKit purchase test passed.
 *
 * The test itself no longer has a job: it runs inside the native products
 * build, from the same compiled test products as everything else on that Mac,
 * and reports its outcome as an output. This job exists because the branch
 * rulesets on develop and main list "StoreKit Purchase - iOS" as a context,
 * and a context only exists while a job renders that name — so the name
 * survives the consolidation even though the work behind it moved.
 */

/** Where the reviewed copy of the verdict lands, beside the workspace. */
const TRUSTED_PATH = '.ci/trusted-storekit-status';

/**
 * The verdict below is the same typed decision the Test - iOS aggregate
 * publishes, so this job materialises the trusted base's copy of it rather
 * than carrying a second transcription of the rules.
 */
const checkoutTrustedStatus = typedLayerCheckout({
  name: 'Checkout trusted base workspace',
  path: TRUSTED_PATH,
  ref: TRUSTED_VERIFIER_SHA,
});

/**
 * The verdict runs out of the trusted checkout, so its dependencies have to be
 * installed there: `--prefix ci` would populate the workspace copy the program
 * never loads. The iOS gate precheck installs the same way.
 */
const installStatusDependencies = installTypedCiDependencies(
  'Install typed StoreKit status dependencies',
  `${TRUSTED_PATH}/ci`,
);

const verifyStorekitResult = typedStep({
  name: 'Verify consolidated StoreKit execution result',
  doc: {
    purpose: 'Decides whether the StoreKit purchase outcome the native products build reported is fit to merge.',
    recovery: 'read the outcome the step prints; a failing purchase test is fixed in the branch, not here',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("needs.ios-change-gate.outputs.production_promotion != 'true'"),
  env: {
    CHANGE_GATE_RESULT: expr('needs.ios-change-gate.result'),
    EVENT_NAME: github('event_name'),
    EXECUTION_RESULT: needsOutput(buildIosNativeTestProducts, 'storekit_result'),
    HEAD_REPOSITORY: ciEventField('headRepository'),
    PARENT_EXECUTION_RESULT: expr('needs.build-ios-native-test-products.result'),
    REPOSITORY: github('repository'),
    STOREKIT_REQUIRED: iosGateOutput('storekit_required'),
  },
  command: `node ${TRUSTED_PATH}/ci/src/actions/ios/verifyStorekitPurchaseStatus.ts`,
});

export const storekitPurchaseStatus = typedJob('storekit-purchase-status', {
  // GitHub reports a skipped job's dynamic name as its literal expression.
  // The required context must therefore be static when the native skip path
  // applies. workflow_dispatch checks cannot satisfy PR branch rulesets.
  name: 'StoreKit Purchase - iOS',
  requiredCheckContext: 'StoreKit Purchase - iOS',
  doc: {
    purpose: 'Publishes the StoreKit purchase verdict the develop and main rulesets list as a required check.',
    successMeaning: 'The in-app purchase path either passed its test or was not reached by this change.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  needs: [iosChangeGate, buildIosNativeTestProducts],
  // A skipped job still publishes the required context as Success. Only the
  // gate's explicit false selection may take that native GitHub fast path;
  // missing or failed gate evidence must reach the verifier and fail closed.
  if: expr(
    `${STATUS_AGGREGATE_CONDITION} && !(github.event_name == 'pull_request' `
    + `&& needs.ios-change-gate.result == 'success' `
    + `&& ${iosGateOutputPath('storekit_required')} == 'false')`,
  ),
  runsOn: iosControlRunner,
  timeoutMinutes: 10,
  lane: controlLane,
  steps: [
    checkoutTrustedStatus,
    setupNode('Setup Node for the typed StoreKit status'),
    installStatusDependencies,
    promotionVerdictAt(TRUSTED_PATH),
    queueEvidenceReportAt(['native'], TRUSTED_PATH),
    verifyStorekitResult,
  ],
});

import {
  byEvent, ciEventCondition, ciEventField, expr, github, needsOutput, typedJob, typedStep,
} from '../lib/index.ts';
import { awaitRetainedIosPredecessor } from './await-retained-ios-predecessor.ts';
import { budgetE2e } from './budget-e2e.ts';
import { buildIosNativeTestProducts } from './build-ios-native-test-products.ts';
import { chatPlaidE2e } from './chat-plaid-e2e.ts';
import { incomeE2e } from './income-e2e.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { onboardingE2e } from './onboarding-e2e.ts';
import { prepareDevE2eSchema } from './prepare-dev-e2e-schema.ts';
import { testIosExecution } from './test-ios-execution.ts';
import { verifyIosReleaseArchive } from './verify-ios-release-archive.ts';
import { promotionVerdict } from './promotion-verdict.ts';
import { queueEvidenceReportAt } from './queue-evidence-report.ts';
import {
  controlLane, installTypedCiDependencies, iosCompletionVerdictRunner, iosGateOutput, setupNode,
  trustedBaseCheckout,
} from './shared.ts';

/**
 * The verdict develop and main require of an iOS change.
 *
 * Every lane above this one is selected, so a red or missing lane means
 * nothing on its own: a suite that was not planned is not a failure, and a
 * suite that was planned and never ran is. Reading those two apart is what
 * this job does, and it is the only job here whose name a branch ruleset
 * lists — which is why it runs the trusted base's programs on a control
 * runner rather than anything the pull request supplied.
 */

/**
 * A draft is not ready to be judged. Metadata edits do not start this workflow;
 * a base retarget produces a synchronize event through the trusted controller.
 */
const ADMITTED_EVENT = ciEventCondition('ready');

const verifyTestLanes = typedStep({
  name: 'Verify iOS test lanes',
  doc: {
    purpose: 'Decides whether every native lane this change needed was planned, ran and passed.',
    recovery: 'read the lane it names; a lane that was required and did not run is the failure',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  // A promotion can require the real-server onboarding journey without
  // selecting native XCTest. The first such promotion still checks out the
  // previous main verifier, whose native-only no-selection rule predates this
  // routing. Its separate real-server verdict below remains mandatory.
  if: expr(
    "needs.ios-change-gate.outputs.production_promotion != 'true' && ("
    + `!${ciEventCondition('pullRequestIntoMain')} `
    + "|| needs.ios-change-gate.outputs.should_run != 'true' "
    + "|| needs.ios-change-gate.outputs.main_required == 'true' "
    + "|| needs.ios-change-gate.outputs.evidence_required == 'true' "
    + "|| needs.ios-change-gate.outputs.native_release_archive_required == 'true')",
  ),
  env: {
    BASE_BRANCH: ciEventField('baseBranch'),
    CHANGE_GATE_RESULT: expr('needs.ios-change-gate.result'),
    CHANGE_GATE_SHOULD_RUN: iosGateOutput('should_run'),
    EVENT_NAME: github('event_name'),
    HEAD_REPOSITORY: ciEventField('headRepository'),
    MAC_RUNNER_RESOLUTION_RESULT: expr("needs.ios-change-gate.outputs.mac_runner_resolution || 'skipped'"),
    NATIVE_PREPARATION_RESULT: expr("needs.ios-change-gate.outputs.native_preparation || 'skipped'"),
    RELEASE_ARCHIVE_REQUIRED: iosGateOutput('native_release_archive_required'),
    RELEASE_ARCHIVE_RESULT: expr('needs.verify-ios-release-archive.result'),
    NATIVE_BUILD_RESULT: expr('needs.build-ios-native-test-products.result'),
    MAIN_EXECUTION_RESULT: expr('needs.test-ios-execution.result'),
    MAIN_REQUIRED: iosGateOutput('main_required'),
    EVIDENCE_REQUIRED: iosGateOutput('evidence_required'),
    BASE_UPDATE_DEFERRED: iosGateOutput('base_update_deferred'),
    NATIVE_EXECUTION_REQUIRED: iosGateOutput('native_execution_required'),
    REPOSITORY: github('repository'),
    TEST_SCOPE: expr("inputs.test_scope || ''"),
    DISPATCH_REF: github('ref'),
  },
  command: 'node ci/src/actions/ios/verifyNativeTestLanes.ts',
});

/**
 * Compatibility status for the existing required-check context. StoreKit runs
 * inside the native producer from the same compiled test products, advisory
 * there, and this is where its outcome becomes required.
 */
const verifyStorekitResult = typedStep({
  name: 'Verify consolidated StoreKit execution result',
  doc: {
    purpose: 'Turns the advisory StoreKit outcome the producer recorded into a required verdict.',
    recovery: 'read the producer\'s StoreKit result bundle; the failure is in the purchase test',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("!cancelled() && needs.ios-change-gate.outputs.production_promotion != 'true'"),
  env: {
    CHANGE_GATE_RESULT: expr('needs.ios-change-gate.result'),
    EVENT_NAME: github('event_name'),
    EXECUTION_RESULT: needsOutput(buildIosNativeTestProducts, 'storekit_result'),
    HEAD_REPOSITORY: ciEventField('headRepository'),
    PARENT_EXECUTION_RESULT: expr('needs.build-ios-native-test-products.result'),
    REPOSITORY: github('repository'),
    STOREKIT_REQUIRED: iosGateOutput('storekit_required'),
  },
  command: 'node ci/src/actions/ios/verifyStorekitPurchaseStatus.ts',
});

const verifyRealServerE2e = typedStep({
  name: 'Verify onboarding execution result',
  doc: {
    purpose: 'Decides whether every real-server E2E lane this change needed ran and passed.',
    recovery: 'read the lane it names; a lane that was required and did not run is the failure',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("!cancelled() && needs.ios-change-gate.outputs.production_promotion != 'true'"),
  env: {
    STATUS_AGGREGATE: 'test-ios',
    CHANGE_GATE_RESULT: expr('needs.ios-change-gate.result'),
    EVENT_NAME: github('event_name'),
    EXECUTION_RESULT: expr('needs.onboarding-e2e.result'),
    CHAT_PLAID_EXECUTION_RESULT: expr('needs.chat-plaid-e2e.result'),
    BUDGET_EXECUTION_RESULT: expr('needs.budget-e2e.result'),
    INCOME_EXECUTION_RESULT: expr('needs.income-e2e.result'),
    ONBOARDING_REQUIRED: iosGateOutput('onboarding_required'),
    CHAT_PLAID_REQUIRED: iosGateOutput('chat_plaid_required'),
    BUDGET_REQUIRED: iosGateOutput('budget_required'),
    INCOME_REQUIRED: iosGateOutput('income_required'),
    BUDGET_E2E_ENABLED: expr("vars.IOS_ENABLE_BUDGET_E2E == 'true'"),
    HEAD_REPOSITORY: ciEventField('headRepository'),
    REPOSITORY: github('repository'),
    BASE_BRANCH: ciEventField('baseBranch'),
    DISPATCH_REF: github('ref'),
    TEST_SCOPE: expr("inputs.test_scope || ''"),
    SCHEMA_PREPARATION_RESULT: expr('needs.prepare-dev-e2e-schema.result'),
  },
  command: 'node ci/src/actions/ios/verifyRealServerE2eStatus.ts',
});

export const testIos = typedJob('test-ios', {
  // "Test - iOS" is the context develop and main require; the dispatch form
  // deliberately does not render it, so a manual run cannot satisfy the gate.
  name: byEvent({ workflow_dispatch: 'Manual - Test - iOS' }, 'Test - iOS'),
  requiredCheckContext: 'Test - iOS',
  doc: {
    purpose: 'Reports whether every iOS lane this change needed was planned, ran and passed.',
    successMeaning: 'The iOS change has the native and real-server evidence its branch requires.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  needs: [
    iosChangeGate,
    awaitRetainedIosPredecessor,
    verifyIosReleaseArchive,
    buildIosNativeTestProducts,
    testIosExecution,
    onboardingE2e,
    chatPlaidE2e,
    incomeE2e,
    budgetE2e,
    prepareDevE2eSchema,
  ],
  if: expr(
    "always() && !cancelled() && inputs.test_scope != 'observability-credential-sync' "
    + `&& (${ADMITTED_EVENT})`,
  ),
  runsOn: iosCompletionVerdictRunner,
  timeoutMinutes: 10,
  permissions: { contents: 'read', 'pull-requests': 'read' },
  lane: controlLane,
  steps: [
    // The aggregates below are typed programs under `ci/`, so this job needs a
    // tree and that layer's dependencies. It checks out the trusted base, not
    // the pull request head, so the required verdict comes from reviewed code.
    trustedBaseCheckout(),
    setupNode('Setup Node for the typed aggregates'),
    installTypedCiDependencies('Install typed aggregate dependencies', 'ci'),
    promotionVerdict,
    queueEvidenceReportAt(['native', 'onboarding', 'chat-plaid', 'income', 'budget']),
    verifyTestLanes,
    verifyStorekitResult,
    verifyRealServerE2e,
  ],
});

import {
  ciEventCondition, concat, expr, github, typedJob, typedStep,
} from '../lib/index.ts';
import { pinnedIosSimulatorRuntimeIdentifier, pinnedIosXcodeToolchain } from '../../src/ios/toolchainPolicy.ts';
import type { TransportFailurePolicy } from '../../src/ios/testProductHandoff.ts';
import { confirmCurrentIosPr } from './confirm-current-ios-pr.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import {
  CACHE_RESTORE, CACHE_SAVE, EXACT_HEAD, IOS_PROJECT_DEFAULTS, UPLOAD_ARTIFACT,
  TRUSTED_VERIFIER_SHA, evidenceScopeMacs, exactHeadMacCheckout,
  installTypedCiDependencies, iosGateOutput, laneConcurrency, POOL_MAC_ONLY,
  prepareNativeSelectorHistory, routedNativeMacLane,
  setupNode, typedLayerCheckout,
} from './shared.ts';

/**
 * Compile the native test products once, for every lane that runs them.
 *
 * Building the application and its test bundles is the expensive half of a
 * native run, and the execution shards differ only in which tests they invoke.
 * So one Mac builds, publishes the products through the run's cache, and the
 * shards restore them — which is also why this job holds the unit preflight
 * and the StoreKit purchase test: both want the products the moment they
 * exist, on the machine that just made them, before any handoff can fail.
 */

/** The revision guard has admitted this head; from here the head's own code runs. */
const GATE_PLAN = "needs.confirm-current-ios-pr.outputs.current == 'true' "
  + "&& needs.ios-change-gate.outputs.native_planned == 'true' "
  + "&& needs.ios-change-gate.outputs.native_should_run == 'true'";

/**
 * Who may spend a Mac on this. A pull request qualifies when it is this
 * repository's own head into a release branch, and a develop queue candidate
 * always does; a dispatch qualifies on a release branch, or as one of the two
 * evidence scopes, which name the open pull request whose head they are
 * collecting evidence for.
 */
const ADMITTED_EVENT = `${ciEventCondition('reviewedChangeIntoTarget')} `
  + "|| (github.event_name == 'workflow_dispatch' "
  + "&& ((github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main') "
  + "|| ((inputs.test_scope == 'financial-independence-evidence' "
  + "|| inputs.test_scope == 'shared-cta-evidence') && inputs.pull_request_number != '')))";

/** The cache entry the execution shards restore the products from. */
const HANDOFF_ARCHIVE = '.example-ci/handoff/example-ios-native-products.zip';
const HANDOFF_KEY = concat('ios-native-test-products-v1-', EXACT_HEAD, '-', github('run_id'));
const HANDOFF_REQUIRED = expr("needs.ios-change-gate.outputs.native_handoff_required == 'true'");
const STOREKIT_REQUIRED = expr("needs.ios-change-gate.outputs.storekit_required == 'true'");

/** Where the run's result bundles and logs land, for the diagnostics upload. */
const RESULT_ROOT = concat(
  expr('runner.temp'), '/example-ios-tests.', github('run_id'), '.', github('run_attempt'), '.',
);

/**
 * An evidence dispatch names the single file its scope is about; anything else
 * uses the gate's native inventory, and an inventory that is explicitly empty
 * stays empty rather than falling back to the whole suite.
 */
const CHANGED_FILES = expr(
  "github.event_name == 'workflow_dispatch' && inputs.test_scope == 'evidence' "
  + "&& 'ios/example-iosUITests/CardAccountUpdateReturnCashSavingsUITests.swift' "
  + "|| github.event_name == 'workflow_dispatch' && inputs.test_scope == 'onboarding-copy-evidence' "
  + "&& 'ios/example-iosUITests/OnboardingCopyAccessibilityEvidenceUITests.swift' "
  + "|| github.event_name == 'workflow_dispatch' && inputs.test_scope == 'shared-cta-evidence' "
  + "&& 'ios/example-iosUITests/CardEditFirstTapEvidenceUITests.swift' "
  + "|| github.event_name == 'workflow_dispatch' && inputs.test_scope == 'mortgage-assignment-evidence' "
  + "&& 'ios/example-iosTests/MortgageAssignmentDraftModelTests.swift' "
  + "|| github.event_name == 'workflow_dispatch' && inputs.test_scope == 'financial-independence-evidence' "
  + "&& 'ios/example-iosTests/FinancialIndependenceEvidenceTests.swift' "
  + "|| needs.ios-change-gate.outputs.native_changed_files || ''",
);

const checkoutExactRevision = exactHeadMacCheckout('Checkout exact native test revision');

const checkoutTrustedNativeControls = typedLayerCheckout({
  name: 'Checkout trusted native selection controls',
  path: '.ci/trusted-native-controls',
  ref: TRUSTED_VERIFIER_SHA,
  sparseCheckout: 'ci\nscripts\n',
});

/**
 * The guard below is a typed program, so the runtime comes first. The action
 * only provisions an interpreter and reads nothing from the checkout, so it
 * cannot be what an unverified head influences; nothing from the revision
 * under review runs until the guard has admitted it.
 */
const setupNodeForGuard = setupNode('Set up the Node.js runtime');

/**
 * The guard comes from the gate-proven verifier, not the exact head: a head that
 * predates the script must still be checked, and the tuple it checks against
 * was captured from that same base.
 */
const verifyExactRevision = typedStep({
  name: 'Verify exact native test revision',
  doc: {
    purpose: 'Refuses to build anything but the head, base and branch the gate captured for this run.',
    recovery: 'a moved tuple is the expected answer; rerun the gate rather than this lane',
  },
  owner: 'infrastructure',
  category: 'quality',
  unit: 'step',
  env: {
    GH_TOKEN: github('token'),
    EXACT_HEAD_SHA: EXACT_HEAD,
    EXAMPLE_CI_PR_NUMBER: iosGateOutput('pr_number'),
    EXAMPLE_CI_EXACT_HEAD_SHA: iosGateOutput('expected_head_sha'),
    EXAMPLE_CI_TRUSTED_BASE_SHA: iosGateOutput('expected_base_sha'),
    EXAMPLE_CI_GUARD_SHA: iosGateOutput('verifier_sha'),
    EXAMPLE_CI_TRUSTED_BASE_REF: iosGateOutput('expected_base_ref'),
  },
  command: 'node ../.ci/trusted-native-controls/ci/src/actions/ios/verifyExactIosRevision.ts',
});

const selectXcode = typedStep({
  name: 'Select exact Xcode',
  doc: {
    purpose: 'Points the lane at the one pinned Xcode build (ci/src/ios/toolchainPolicy.ts) CI compiles with.',
    recovery: 'install the pinned Xcode build on the runner; the step prints what it found instead',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: `node ../ci/src/actions/ios/selectXcode.ts ${pinnedIosXcodeToolchain}`,
});

const verifyImagePrerequisites = typedStep({
  name: 'Verify exact Xcode, SDK, and simulator runtime',
  doc: {
    purpose: 'Confirms the selected Xcode brings the SDK and simulator runtime the lane expects.',
    recovery: 'read the mismatch it prints and install the missing runtime on this runner',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: 'python3 ../scripts/ios-ci-image-prerequisites.py',
});

const reclaimStaleArtifacts = typedStep({
  name: 'Reclaim stale native runner artifacts',
  doc: {
    purpose: 'Frees the disk a physical Mac needs for this build by removing evidence nothing reads.',
    recovery: 'read the free-space figure it prints; a runner still short of it needs a person',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr(POOL_MAC_ONLY),
  env: {
    EXAMPLE_ACTIONS_READ_TOKEN: github('token'),
    IOS_RUNNER_MIN_FREE_KB: iosGateOutput('ios_macos_minimum_free_kb'),
    IOS_RUNNER_COMPACT_DURABLE_EVIDENCE: '1',
    IOS_RUNNER_PRUNE_MERGED_PR_EVIDENCE: '1',
    IOS_RUNNER_PRUNE_SUPERSEDED_EVIDENCE: '1',
    IOS_RUNNER_RECLAIM_RUNNER_DIAGNOSTICS: '1',
    IOS_RUNNER_RECLAIM_CI_SIMULATORS: '1',
    IOS_RUNNER_PRIMARY_RUNTIME_IDENTIFIER: pinnedIosSimulatorRuntimeIdentifier,
    IOS_RUNNER_RECLAIM_XCTEST_DEVICES: '1',
  },
  command: 'bash ../scripts/reclaim-ios-runner-disk.sh preflight',
});

const affectedTests = typedStep({
  id: 'affected-tests',
  name: 'Determine native build selection',
  doc: {
    purpose: 'Chooses the native tests the changed Swift reaches, which is what the products must cover.',
    recovery: 'read the selection it prints; an unexpected mode is a changed-file inventory problem',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  outputs: ['mode', 'only_testing_file', 'evidence_groups', 'narrow_paywall_required'] as const,
  env: {
    IOS_AFFECTED_TESTS_BASE: iosGateOutput('expected_base_sha'),
    IOS_AFFECTED_TESTS_CHANGED_FILES: CHANGED_FILES,
    IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY: iosGateOutput('native_changed_files_explicit_empty'),
    IOS_AFFECTED_TESTS_HEAD: EXACT_HEAD,
    IOS_AFFECTED_TESTS_LANE: 'main',
    IOS_AFFECTED_TESTS_MODE: iosGateOutput('native_mode'),
    IOS_AFFECTED_TESTS_STOREKIT_REQUIRED: iosGateOutput('storekit_required'),
    IOS_AFFECTED_TESTS_WORKSPACE: github('workspace'),
  },
  command: 'node ../.ci/trusted-native-controls/scripts/select-ios-affected-tests.ts',
});

const productBuildMode = typedStep({
  id: 'product-build-mode',
  name: 'Resolve native product build mode',
  doc: {
    purpose: 'Turns the selection and the forced lanes into the one build mode the products are made in.',
    recovery: 'read the mode it prints; it names the selection input that produced it',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  outputs: ['mode', 'evidence_plan_required'] as const,
  env: {
    PREPARED_SELECTION_MODE: affectedTests.outputs.mode,
    PREPARED_UI_REQUIRED: iosGateOutput('native_ui_required'),
    PREPARED_EVIDENCE_GROUPS: affectedTests.outputs.evidence_groups,
    PREPARED_NARROW_PAYWALL_REQUIRED: affectedTests.outputs.narrow_paywall_required,
    FORCED_EXECUTION_LANES: iosGateOutput('rerun_ios_lanes'),
    FULL_EXECUTION_LANES: iosGateOutput('native_full_execution_lanes'),
  },
  command: 'node ../ci/src/actions/ios/resolveNativeProductBuildMode.ts',
});

const prepareBuildCache = typedStep({
  name: 'Prepare native build cache',
  doc: {
    purpose: 'Claims this lane entry of the persistent derived-data cache before Xcode writes into it.',
    recovery: 'read the entry-ownership error; a lane name that is not this one is the failure',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  env: {
    IOS_CI_CACHE_LANE: 'main',
    IOS_CI_PACKAGE_RESOLVED: concat(
      github('workspace'),
      '/ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    ),
  },
  command: 'bash ../scripts/manage-ios-build-cache.sh prepare "$IOS_CI_CACHE_LANE"',
});

const resetSimulatorHost = typedStep({
  name: 'Reset CoreSimulator host',
  doc: {
    purpose: 'Restarts the CoreSimulator service so a simulator can be provisioned on this host.',
    recovery: 'an "(ipc/mig) server died" marker means the host needs the reset this step performs',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: 'bash "$GITHUB_WORKSPACE/scripts/ensure-ios-simulator-host.sh"',
});

const primarySimulator = typedStep({
  id: 'primary-simulator',
  name: 'Provision unit-test simulator',
  doc: {
    purpose: 'Creates the simulator the products are built against and the unit preflight runs on.',
    recovery: 'read the runtime it asked for; a missing simulator runtime is an image problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  outputs: ['dest', 'provisioned_udid'] as const,
  env: {
    IOS_CI_LANE: 'main',
    IOS_EVIDENCE_GROUPS: affectedTests.outputs.evidence_groups,
  },
  command: 'python3 ../scripts/provision-ios-ci-simulator.py --purpose main',
});

const prepareTestEnvironment = typedStep({
  name: 'Prepare CI test environment',
  doc: {
    purpose: 'Publishes the result-bundle and log paths the build and the preflight write into.',
    recovery: 'retry; a failure here is the runner refusing to write the job environment file',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  env: { PRIMARY_DESTINATION: primarySimulator.outputs.dest },
  command: 'node ../ci/src/actions/ios/prepareNativeCiTestEnvironment.ts',
});

const buildTestProducts = typedStep({
  id: 'build-test-products',
  name: 'Build native iOS test products once',
  doc: {
    purpose: 'Compiles the application and the test bundles every native lane in this run executes, with Swift warnings as errors.',
    recovery: 'read the Swift error (including warnings treated as errors) in the uploaded xcodebuild log and fix it in the branch',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  env: {
    IOS_CI_LANE: 'main',
    IOS_ONLY_TESTING_FILE: affectedTests.outputs.only_testing_file,
    IOS_TEST_SELECTION_MODE: productBuildMode.outputs.mode,
    IOS_NARROW_PAYWALL_REQUIRED: affectedTests.outputs.narrow_paywall_required,
    IOS_EVIDENCE_GROUPS: affectedTests.outputs.evidence_groups,
    IOS_EVIDENCE_PLAN_REQUIRED: productBuildMode.outputs.evidence_plan_required,
    IOS_PRIMARY_DESTINATION: primarySimulator.outputs.dest,
    STOREKIT_REQUIRED: iosGateOutput('storekit_required'),
  },
  command: 'bash ../scripts/build-ios-ci-test-products.sh',
});

const measureCompiledTests = typedStep({
  name: 'Measure unfiltered compiled iOS tests',
  doc: {
    purpose: 'Compares the authored test plan with methods in the products just built and reports enumeration time.',
    recovery: 'read the advisory warning; a missing selector or slow enumeration needs investigation before enforcement',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  // Affected builds can compile a filtered .xctestproducts bundle. Comparing
  // that bundle with the complete test plan would report false omissions.
  if: expr("steps.product-build-mode.outputs.mode != 'affected'"),
  env: {
    IOS_PRIMARY_DESTINATION: primarySimulator.outputs.dest,
    IOS_PRODUCT_WORKSPACE: github('workspace'),
  },
  command: 'node ../.ci/trusted-native-controls/ci/src/actions/ios/measureCompiledTestEnumeration.ts',
});

const unitPreflight = typedStep({
  id: 'unit-preflight',
  name: 'Run native unit preflight',
  doc: {
    purpose: 'Runs the unit partition here, on the machine that just built it, before any handoff.',
    recovery: 'read the failing test in the uploaded result bundle and fix it in the branch',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  env: {
    IOS_MAIN_TEST_PARTITION: 'unit',
    IOS_ONLY_TESTING_FILE: affectedTests.outputs.only_testing_file,
    IOS_TEST_SELECTION_MODE: affectedTests.outputs.mode,
    IOS_PRIMARY_DESTINATION: primarySimulator.outputs.dest,
    IOS_NARROW_PAYWALL_REQUIRED: 'false',
  },
  command: 'node ../ci/src/actions/ios/runNativeUnitPreflight.ts',
});

const removeUnitSimulator = typedStep({
  name: 'Remove unit-test simulator',
  doc: {
    purpose: 'Deletes the unit simulator so its device data does not outlive the job on a shared Mac.',
    recovery: 'delete the named device by hand on that runner if the step could not',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr('always()'),
  env: {
    IOS_RUNNER_CURRENT_SIMULATOR_PURPOSE: 'Main',
    IOS_RUNNER_CURRENT_SIMULATOR_UDID: primarySimulator.outputs.provisioned_udid,
    IOS_RUNNER_RECLAIM_CI_SIMULATORS: '1',
  },
  command: 'bash ../scripts/reclaim-ios-runner-disk.sh simulator',
});

const storekitSimulator = typedStep({
  id: 'storekit-simulator',
  name: 'Provision StoreKit simulator',
  doc: {
    purpose: 'Creates the separate simulator the StoreKit purchase test needs its own device state on.',
    recovery: 'read the runtime it asked for; a missing simulator runtime is an image problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: STOREKIT_REQUIRED,
  outputs: ['destination', 'provisioned_udid'] as const,
  env: { IOS_CI_LANE: 'storekit' },
  command: 'python3 ../scripts/provision-ios-ci-simulator.py --purpose storekit',
});

/**
 * Advisory here and required in the aggregate: the outcome is recorded below
 * and `test-ios` decides what it means, so a StoreKit failure cannot take the
 * products down with it and lose every other lane's build.
 */
const storekit = typedStep({
  id: 'storekit',
  name: 'Run StoreKit purchase test',
  doc: {
    purpose: 'Exercises a purchase against the local StoreKit configuration in an in-process session.',
    recovery: 'read the result bundle; an Apple StoreKit defect is recorded, not worked around',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: STOREKIT_REQUIRED,
  continueOnError: true,
  env: { STOREKIT_DESTINATION: storekitSimulator.outputs.destination },
  command: 'node ../ci/src/actions/ios/runStorekitPurchaseTest.ts',
});

const storekitResult = typedStep({
  id: 'storekit-result',
  name: 'Record StoreKit result',
  doc: {
    purpose: 'Publishes what the advisory StoreKit step did, for the aggregate that makes it required.',
    recovery: 'read the outcome it recorded; an empty one means the step above never started',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  if: expr('always()'),
  outputs: ['result'] as const,
  env: {
    REQUIRED: iosGateOutput('storekit_required'),
    OUTCOME: expr('steps.storekit.outcome'),
  },
  command: 'node ../ci/src/actions/ios/recordStorekitResult.ts',
});

const removeStorekitSimulator = typedStep({
  name: 'Remove StoreKit simulator',
  doc: {
    purpose: 'Deletes the StoreKit simulator so its device data does not outlive the job.',
    recovery: 'delete the named device by hand on that runner if the step could not',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr("always() && steps.storekit-simulator.outputs.provisioned_udid != ''"),
  env: {
    IOS_RUNNER_CURRENT_SIMULATOR_PURPOSE: 'StoreKit',
    IOS_RUNNER_CURRENT_SIMULATOR_UDID: storekitSimulator.outputs.provisioned_udid,
    IOS_RUNNER_RECLAIM_CI_SIMULATORS: '1',
  },
  command: 'bash ../scripts/reclaim-ios-runner-disk.sh simulator',
});

const packTestProducts = typedStep({
  name: 'Pack exact-head native test products',
  doc: {
    purpose: 'Archives the built products and the plan a consumer shard needs to run them unchanged.',
    recovery: 'read the missing path it names; a product that was never built is the failure',
  },
  owner: 'automation',
  category: 'artifact',
  unit: 'step',
  if: HANDOFF_REQUIRED,
  env: {
    EVIDENCE_PLAN_REQUIRED: productBuildMode.outputs.evidence_plan_required,
    EXACT_HEAD_SHA: EXACT_HEAD,
  },
  command: 'node ../ci/src/actions/ios/packNativeTestProducts.ts',
});

const saveTestProducts = typedStep({
  id: 'save-native-test-products-cache',
  name: 'Save exact-head native test products',
  doc: {
    purpose: 'Publishes the archive under a key the execution shards of this run restore it by.',
    recovery: 'retry; a repeated failure is the Actions cache service, and the fallback upload covers it',
  },
  owner: 'automation',
  category: 'artifact',
  unit: 'step',
  if: HANDOFF_REQUIRED,
  continueOnError: true,
  uses: CACHE_SAVE,
  with: { path: HANDOFF_ARCHIVE, key: HANDOFF_KEY },
});

/**
 * `actions/cache/save` can exit successfully after an upload timed out, and a
 * published entry can still fail a later cross-runner download. This looks the
 * key up so the failure is visible here rather than in every shard.
 */
const verifyCachePublication = typedStep({
  id: 'verify-native-test-products-cache',
  name: 'Verify exact-head native cache publication',
  doc: {
    purpose: 'Looks the published cache key up, so a silent save failure is seen here not in the shards.',
    recovery: 'a miss means the shards will use the artifact fallback; read the save step above',
  },
  owner: 'automation',
  category: 'quality',
  unit: 'step',
  if: HANDOFF_REQUIRED,
  continueOnError: true,
  uses: CACHE_RESTORE,
  with: { path: HANDOFF_ARCHIVE, key: HANDOFF_KEY, 'lookup-only': true },
});

/**
 * The verified cache is the primary handoff. Only publish an artifact when
 * that handoff is unavailable; consumers can rebuild at their exact head if
 * a later cache restore fails.
 */
const uploadProductsFallback = typedStep({
  id: 'upload-native-test-products-fallback',
  name: 'Upload exact-head native products fallback',
  doc: {
    purpose: 'Publishes a short-lived artifact only when the producer cannot read back its cache handoff.',
    recovery: 'the exact-head native consumers rebuild when both transports are unavailable',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  if: expr(
    "needs.ios-change-gate.outputs.native_handoff_required == 'true' "
      + "&& (steps.verify-native-test-products-cache.outcome != 'success' "
      + "|| steps.verify-native-test-products-cache.outputs.cache-hit != 'true')",
  ),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('ios-native-test-products-fallback-', github('run_id')),
    path: HANDOFF_ARCHIVE,
    'compression-level': 0,
    'include-hidden-files': true,
    'if-no-files-found': 'error',
    overwrite: true,
    'retention-days': 1,
  },
});

const verifyHandoff = typedStep({
  name: 'Verify native product handoff transport',
  doc: {
    purpose: 'Accepts either transport, or lets exact-head native consumers rebuild if both are unavailable.',
    recovery: 'read the transport warning and inspect each consumer rebuild if both transports failed',
  },
  owner: 'automation',
  category: 'quality',
  unit: 'step',
  if: expr(
    "always() && !cancelled() "
      + "&& needs.ios-change-gate.outputs.native_handoff_required == 'true'",
  ),
  env: {
    TRANSPORT_FAILURE_POLICY: 'consumer-rebuild' satisfies TransportFailurePolicy,
    CACHE_SAVE_OUTCOME: expr('steps.save-native-test-products-cache.outcome'),
    CACHE_LOOKUP_OUTCOME: expr('steps.verify-native-test-products-cache.outcome'),
    CACHE_HIT: expr('steps.verify-native-test-products-cache.outputs.cache-hit'),
    ARTIFACT_OUTCOME: expr('steps.upload-native-test-products-fallback.outcome'),
  },
  command: 'node ../ci/src/actions/ios/verifyTestProductHandoff.ts',
});

const removeHandoffArchive = typedStep({
  name: 'Remove native handoff archive',
  doc: {
    purpose: 'Deletes the packed archive from the runner once both transports have taken their copy.',
    recovery: 'delete the named file by hand on that runner if the step could not',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr("always() && needs.ios-change-gate.outputs.native_handoff_required == 'true'"),
  command: `rm -f "$GITHUB_WORKSPACE/${HANDOFF_ARCHIVE}"`,
});

const uploadDiagnostics = typedStep({
  id: 'upload-native-producer-diagnostics',
  name: 'Upload native unit and StoreKit diagnostics',
  doc: {
    purpose: 'Publishes the result bundles and logs a failing unit or StoreKit run is read from.',
    recovery: 'no action here: the retain step below keeps the same evidence on the runner',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  if: expr("always() && (steps.build-test-products.outcome == 'failure' "
    + "|| steps.unit-preflight.outcome == 'failure' || steps.storekit.outcome == 'failure')"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('ios-native-producer-results-', github('run_id'), '-', github('run_attempt')),
    'compression-level': 0,
    'retention-days': 1,
    'if-no-files-found': 'error',
    path: concat(
      expr('env.IOS_TEST_RESULT_BUNDLE'), '\n',
      RESULT_ROOT, '*/*.first-launch-failure.xcresult\n',
      expr('env.IOS_TEST_XCODEBUILD_LOG'), '\n',
      RESULT_ROOT, '*/*.first-launch-busy.log\n',
      RESULT_ROOT, '*/*.storekit-prime.log\n',
      expr('env.IOS_STOREKIT_RESULT_BUNDLE'), '\n',
      expr('env.IOS_STOREKIT_XCODEBUILD_LOG'), '\n',
    ),
  },
});

const retainDiagnostics = typedStep({
  name: 'Retain native producer diagnostics on runner',
  doc: {
    purpose: 'Keeps the diagnostics on the runner and says where, when the upload quota refused them.',
    recovery: 'read the retained path it prints and collect the evidence from that runner',
  },
  owner: 'infrastructure',
  category: 'evidence',
  unit: 'step',
  if: expr("always() && steps.upload-native-producer-diagnostics.outcome == 'failure'"),
  command: 'node ../ci/src/actions/ios/retainNativeProducerDiagnostics.ts',
});

const removeCurrentArtifacts = typedStep({
  name: 'Remove current native producer artifacts',
  doc: {
    purpose: 'Returns this run\'s disk to the shared Mac so the next lane finds the space it admits on.',
    recovery: 'read the free-space figure it prints; a runner still short of it needs a person',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr('always()'),
  command: 'bash ../scripts/reclaim-ios-runner-disk.sh current',
});

export const buildIosNativeTestProducts = typedJob('build-ios-native-test-products', {
  name: 'Build shared native iOS test products',
  doc: {
    purpose: 'Builds the native test products once, for every execution shard this run selected.',
    successMeaning: 'Every native shard can restore products built from the exact head under test.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'suite',
  concurrency: laneConcurrency('native-products'),
  needs: [iosChangeGate, confirmCurrentIosPr],
  // The padding inside the outer parentheses is the committed spelling, kept
  // so the generated file is that file rather than a tidied version of it.
  if: expr(`always() && !cancelled() && ${GATE_PLAN} && ( ${ADMITTED_EVENT} )`),
  // GitHub assigns the producer to an eligible physical Mac.
  runsOn: evidenceScopeMacs,
  permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read' },
  defaults: IOS_PROJECT_DEFAULTS,
  lane: routedNativeMacLane,
  outputs: { storekit_result: storekitResult.outputs.result },
  steps: [
    checkoutExactRevision,
    setupNodeForGuard,
    checkoutTrustedNativeControls,
    verifyExactRevision,
    installTypedCiDependencies('Install typed native producer dependencies', '../ci'),
    selectXcode,
    verifyImagePrerequisites,
    reclaimStaleArtifacts,
    prepareNativeSelectorHistory(),
    affectedTests,
    productBuildMode,
    prepareBuildCache,
    resetSimulatorHost,
    primarySimulator,
    prepareTestEnvironment,
    buildTestProducts,
    measureCompiledTests,
    unitPreflight,
    removeUnitSimulator,
    storekitSimulator,
    storekit,
    storekitResult,
    removeStorekitSimulator,
    packTestProducts,
    saveTestProducts,
    verifyCachePublication,
    uploadProductsFallback,
    verifyHandoff,
    removeHandoffArchive,
    uploadDiagnostics,
    retainDiagnostics,
    removeCurrentArtifacts,
  ],
});

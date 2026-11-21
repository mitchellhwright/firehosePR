import {
  ciEventCondition, concat, expr, fromJSON, github, matrixSuffixed, typedJob, typedStep,
} from '../lib/index.ts';
import { pinnedIosSimulatorRuntimeIdentifier, pinnedIosXcodeToolchain } from '../../src/ios/toolchainPolicy.ts';
import { buildIosNativeTestProducts } from './build-ios-native-test-products.ts';
import { confirmCurrentIosPr } from './confirm-current-ios-pr.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import {
  CACHE_RESTORE, DOWNLOAD_ARTIFACT, EXACT_HEAD, IOS_PROJECT_DEFAULTS, UPLOAD_ARTIFACT,
  TRUSTED_VERIFIER_SHA, evidenceScopeMacs, exactHeadMacCheckout,
  exportSimulatorRunnerEnvironment, iosGateOutput, laneConcurrency, POOL_MAC_ONLY,
  prepareNativeSelectorHistory, resetOversizedDedicatedRunnerCheckout,
  routedNativeMacLane, setupNode, typedLayerCheckout,
} from './shared.ts';

/**
 * Run one shard of the native iOS suite against products it did not build.
 *
 * The matrix comes from the gate, so this job exists once per lane the changed
 * Swift actually reaches; each shard restores the archive the producer
 * published and runs only the tests its lane owns. Restoring rather than
 * rebuilding is the whole point — it is what lets several physical Macs share
 * one compile — so most of the steps below are about proving the restored
 * products belong to this head, and about giving the Mac back the disk and the
 * simulators it lent this shard.
 */

/** Every step past the selection is skipped when the lane selects no tests. */
const SHOULD_RUN = "steps.affected-tests.outputs.should_run == 'true'";

/** The evidence lanes differ from the numbered ones in device class and thresholds. */
const EVIDENCE_LANE = "startsWith(matrix.lane, 'evidence-')";

/** Account evidence also needs exact methods transferred from the main selector. */
const ACCOUNT_UPDATE_EVIDENCE_LANE = "matrix.lane == 'evidence-account-update' "
  + "|| matrix.lane == 'evidence-account-update-2'";

/** The combined selector carries account methods, but paywall work stays on its owner. */
const NARROW_PAYWALL_REQUIRED_IN_LANE = `!(${ACCOUNT_UPDATE_EVIDENCE_LANE}) `
  + "&& steps.affected-tests.outputs.narrow_paywall_required == 'true'";
const NARROW_PAYWALL_REQUIRED_VALUE = expr(
  `${NARROW_PAYWALL_REQUIRED_IN_LANE} && 'true' || 'false'`,
);

/** Every evidence lane can produce screenshots; the native1 manual scope can too. */
const SCREENSHOT_LANES = `${SHOULD_RUN} && ((matrix.lane == 'native1' `
  + "&& github.event_name == 'workflow_dispatch' "
  + "&& inputs.test_scope == 'financial-independence-evidence') "
  + `|| ${EVIDENCE_LANE})`;

/** Where this run's result bundles and logs land under the runner temp directory. */
const RESULT_ROOT = concat(
  expr('runner.temp'), '/example-ios-tests.', github('run_id'), '.', github('run_attempt'), '.',
);

/** The one dedicated Mac whose host-specific reclamation the lane still carries. */
const DEDICATED_MAC = "runner.name == 'Mitchells-MacBook-Air-ios-24gb'";
const LEGACY_MAC = "runner.name == 't-runner-2'";

/** The handoff the producer published, and the artifact that covers a cache miss. */
const HANDOFF_ARCHIVE = '.example-ci/handoff/example-ios-native-products.zip';
const HANDOFF_KEY = concat('ios-native-test-products-v1-', EXACT_HEAD, '-', github('run_id'));

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

const checkout = exactHeadMacCheckout('Checkout the workflow revision');
const checkoutTrustedNativeControls = typedLayerCheckout({
  name: 'Checkout trusted native selection controls',
  path: '.ci/trusted-native-controls',
  ref: TRUSTED_VERIFIER_SHA,
  sparseCheckout: 'ci\nscripts\n',
});

/**
 * The revision guard below is a typed program, so Node is set up before it
 * rather than with the lane's other tooling. `setup-node` installs a runtime
 * and reads nothing from the checkout, so it cannot be what an unverified head
 * influences; the lane's `npm ci` still waits until the guard has admitted
 * this revision.
 */
const setupNodeForGuard = setupNode('Set up the Node.js runtime');

const verifyExactRevision = typedStep({
  name: 'Verify exact iOS test revision',
  doc: {
    purpose: 'Refuses to run anything but the head, base and branch the gate captured for this run.',
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
  shell: 'bash',
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

/**
 * Most of this environment is host-specific: the two named runners are private
 * machines with their own tool caches, archives and legacy simulators, and
 * everything keyed on `runner.name` is empty on every other worker.
 */
const reclaimStaleArtifacts = typedStep({
  name: 'Reclaim stale iOS runner artifacts',
  doc: {
    purpose: 'Frees the disk a physical Mac needs for this shard by removing evidence nothing reads.',
    recovery: 'read the free-space figure it prints; a runner still short of it needs a person',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr(POOL_MAC_ONLY),
  timeoutMinutes: 10,
  env: {
    EXAMPLE_ACTIONS_READ_TOKEN: github('token'),
    IOS_RUNNER_COMPACT_DURABLE_EVIDENCE: '1',
    IOS_RUNNER_MIN_FREE_KB: expr(
      `${EVIDENCE_LANE} && needs.ios-change-gate.outputs.ios_evidence_macos_minimum_free_kb `
      + '|| needs.ios-change-gate.outputs.ios_macos_minimum_free_kb',
    ),
    IOS_RUNNER_PRUNE_MERGED_PR_EVIDENCE: '1',
    IOS_RUNNER_PRUNE_SUPERSEDED_EVIDENCE: '1',
    IOS_RUNNER_RECLAIM_RUNNER_DIAGNOSTICS: '1',
    IOS_RUNNER_DIAGNOSTIC_RETENTION_HOURS: expr(`${DEDICATED_MAC} && '6' || '72'`),
    IOS_RUNNER_RECLAIM_ACTIONS_TOOLING: expr(`${DEDICATED_MAC} && '1' || ''`),
    IOS_RUNNER_RECLAIM_GCLOUD_TOOL_CACHE: expr(`${DEDICATED_MAC} && '1' || ''`),
    EXAMPLE_ACTIONS_RUNNER_ROOT: expr(
      `${DEDICATED_MAC} && '/home/example/actions-runner-example-app' || ''`,
    ),
    EXAMPLE_ACTIONS_RUNNER_WORKSPACE_NAME: 'example-app',
    IOS_RUNNER_ACTIVE_NODE_TOOL_VERSION: '26.5.0',
    IOS_RUNNER_ACTIVE_NODE_TOOL_ARCH: 'arm64',
    IOS_RUNNER_RECLAIM_CI_SIMULATORS: '1',
    IOS_RUNNER_PRIMARY_RUNTIME_IDENTIFIER: pinnedIosSimulatorRuntimeIdentifier,
    IOS_RUNNER_SHUTDOWN_BOOTED_LEGACY_SIMULATORS: expr(`${DEDICATED_MAC} && '1' || ''`),
    IOS_RUNNER_RECLAIM_XCTEST_DEVICES: '1',
    IOS_RUNNER_RECLAIM_LOCAL_IOS_ARTIFACTS: expr(`${DEDICATED_MAC} && '1' || ''`),
    EXAMPLE_LOCAL_IOS_ARTIFACT_ROOT: expr(`${DEDICATED_MAC} && '/private/tmp' || ''`),
    IOS_RUNNER_RECLAIM_XCODEBUILDMCP_EXAMPLE_ARTIFACTS: expr(`${DEDICATED_MAC} && '1' || ''`),
    IOS_RUNNER_XCODEBUILDMCP_EXAMPLE_WORKSPACE_NAME: expr(
      `${DEDICATED_MAC} && 'example-app-8f1cba0234bb' || ''`,
    ),
    IOS_RUNNER_RECLAIM_XCODE_ARCHIVES: expr(`${LEGACY_MAC} && '1' || ''`),
    IOS_RUNNER_RECLAIM_XCODE_DEVICE_SUPPORT: expr(`${LEGACY_MAC} && '1' || ''`),
    IOS_RUNNER_RECLAIM_LEGACY_SIMULATOR_NAME: expr(
      `${LEGACY_MAC} && 'iPhone 17' || ${DEDICATED_MAC} && 'iPhone 13 mini Test' || ''`,
    ),
    IOS_RUNNER_RECLAIM_LEGACY_SIMULATOR_RUNTIME: expr(
      `${LEGACY_MAC} && 'com.apple.CoreSimulator.SimRuntime.iOS-26-2' `
      + `|| ${DEDICATED_MAC} && 'com.apple.CoreSimulator.SimRuntime.iOS-26-3' || ''`,
    ),
    IOS_RUNNER_RECLAIM_LEGACY_SIMULATOR_UDID: expr(
      `${LEGACY_MAC} && '4e07f379-2a83-5804-81ae-2e043229a548' `
      + `|| ${DEDICATED_MAC} && 'e2ef0691-a80c-5318-9d17-8a017a20e1e0' || ''`,
    ),
    IOS_RUNNER_RECLAIM_SECONDARY_LEGACY_SIMULATOR_NAME: expr(
      `${DEDICATED_MAC} && 'iPhone 17 Pro Max' || ''`,
    ),
    IOS_RUNNER_RECLAIM_SECONDARY_LEGACY_SIMULATOR_RUNTIME: expr(
      `${DEDICATED_MAC} && 'com.apple.CoreSimulator.SimRuntime.iOS-26-3' || ''`,
    ),
    IOS_RUNNER_RECLAIM_SECONDARY_LEGACY_SIMULATOR_UDID: expr(
      `${DEDICATED_MAC} && '44ae288e-5329-5a9a-8522-4af2c9d5c4b5' || ''`,
    ),
    IOS_RUNNER_RECLAIM_ADDITIONAL_LEGACY_SIMULATORS_JSON: expr(
      `${DEDICATED_MAC} && '[{"name":"iPhone 17 Pro","runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-0",`
      + '"udid":"f39f2a52-cbe6-5719-86ee-3f9ce3a7d81d"},{"name":"iPhone 17",'
      + '"runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-0",'
      + '"udid":"b16072c6-7af0-5703-9dec-72596d4cddd6"},{"name":"iPhone 17 Pro",'
      + '"runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-3",'
      + '"udid":"c4223962-45e0-5b77-aa31-058e756cfa1f"},{"name":"iPhone 16e",'
      + '"runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-3",'
      + '"udid":"69cc431a-5d70-54d7-904b-00f9a675d9ed"},{"name":"iPhone 17 Pro Max",'
      + '"runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-0",'
      + '"udid":"d997d72b-cce5-5bfd-808b-284c578dfcfa"}]\' || \'[]\'',
    ),
  },
  command: 'bash ../scripts/reclaim-ios-runner-disk.sh preflight',
});

/**
 * The typed lane runner carries only `ci/package.json`'s dependencies, so it
 * installs before the application does and cannot be delayed by it. It runs
 * from the workspace root rather than the job's `ios/` default: `--prefix ci`
 * is resolved against the working directory.
 */
const installLaneRunner = typedStep({
  name: 'Install typed lane runner dependencies',
  doc: {
    purpose: 'Installs the typed CI dependencies the lane programs below are executed with.',
    recovery: 'read the npm log; a lockfile conflict is fixed in the branch, a registry error retried',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  workingDirectory: String(github('workspace')),
  command: 'npm ci --prefix ci --no-audit --no-fund --ignore-scripts',
});

const laneSelection = typedStep({
  id: 'lane-selection',
  name: 'Resolve native lane test selection',
  doc: {
    purpose: 'Decides what this one lane runs, given the gate plan and any lane the classifier forced.',
    recovery: 'read the mode it prints; it names the plan input that produced it',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  outputs: ['mode'] as const,
  env: {
    PREPARED_SELECTION_MODE: iosGateOutput('native_mode'),
    PREPARED_UI_REQUIRED: iosGateOutput('native_ui_required'),
    FORCED_EXECUTION_LANE: expr(
      "contains(fromJSON(needs.ios-change-gate.outputs.rerun_ios_lanes), matrix.lane) && 'true' || 'false'",
    ),
    FORCE_FULL_EXECUTION_LANE: expr(
      'contains(fromJSON(needs.ios-change-gate.outputs.native_full_execution_lanes), matrix.lane) '
      + "&& 'true' || 'false'",
    ),
    EXECUTION_LANE: expr('matrix.lane'),
  },
  command: 'node ../ci/src/actions/ios/resolveLaneTestSelection.ts',
});

const affectedTests = typedStep({
  id: 'affected-tests',
  name: 'Determine Affected iOS Tests',
  doc: {
    purpose: 'Turns the changed files into the test identifiers this lane invokes, or skips the lane.',
    recovery: 'read the selection it prints; an unexpected mode is a changed-file inventory problem',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  outputs: [
    'should_run', 'summary', 'mode', 'only_testing_file', 'evidence_groups', 'narrow_paywall_required',
    'account_update_test_count', 'wellness_required', 'wellness_only_testing_file', 'wellness_test_count',
  ] as const,
  env: {
    IOS_AFFECTED_TESTS_BASE: iosGateOutput('expected_base_sha'),
    IOS_AFFECTED_TESTS_CHANGED_FILES: CHANGED_FILES,
    IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY: iosGateOutput('native_changed_files_explicit_empty'),
    IOS_AFFECTED_TESTS_HEAD: EXACT_HEAD,
    IOS_AFFECTED_TESTS_LANE: expr(
      `${EVIDENCE_LANE} && !(${ACCOUNT_UPDATE_EVIDENCE_LANE}) && 'evidence' || 'main'`,
    ),
    IOS_AFFECTED_TESTS_MODE: laneSelection.outputs.mode,
    IOS_AFFECTED_TESTS_STOREKIT_REQUIRED: iosGateOutput('storekit_required'),
    IOS_AFFECTED_TESTS_WORKSPACE: github('workspace'),
  },
  command: 'node ../.ci/trusted-native-controls/scripts/select-ios-affected-tests.ts',
});

const evidenceShard = typedStep({
  id: 'evidence-shard',
  name: 'Select evidence groups for shard',
  doc: {
    purpose: 'Splits the evidence groups across the shards so no two of them record the same one.',
    recovery: 'read the groups it assigned; an empty assignment means the lane owns no evidence',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(`${SHOULD_RUN} && (${EVIDENCE_LANE} || matrix.lane == 'native1')`),
  outputs: ['evidence_groups'] as const,
  env: {
    ALL_EVIDENCE_GROUPS: affectedTests.outputs.evidence_groups,
    ACCOUNT_UPDATE_GROUP_REQUIRED: expr(
      "contains(steps.affected-tests.outputs.evidence_groups, 'account-update') && 'true' || 'false'",
    ),
    EXECUTION_LANE: expr('matrix.lane'),
  },
  command: 'node ../ci/src/actions/ios/selectEvidenceShardGroups.ts',
});

const skipTests = typedStep({
  name: 'Skip iOS Tests',
  doc: {
    purpose: 'Records in the run summary why this lane selected no tests, so a green lane is legible.',
    recovery: 'no action: a lane the changed files do not reach is expected to skip',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'step',
  if: expr("steps.affected-tests.outputs.should_run == 'false'"),
  env: { IOS_TEST_SELECTION_SUMMARY: affectedTests.outputs.summary },
  command: 'node ../ci/src/actions/ios/reportSkippedIosTests.ts',
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
  if: expr(SHOULD_RUN),
  timeoutMinutes: 2,
  shell: 'bash',
  command: 'bash "$GITHUB_WORKSPACE/scripts/ensure-ios-simulator-host.sh"',
});

const primarySimulator = typedStep({
  id: 'primary-simulator',
  name: 'Provision primary iOS Simulator',
  doc: {
    purpose: 'Creates the device this lane runs its tests on, sized for the lane it belongs to.',
    recovery: 'read the runtime it asked for; a missing simulator runtime is an image problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(SHOULD_RUN),
  outputs: ['dest', 'provisioned_udid'] as const,
  env: {
    IOS_CI_LANE: expr(`${EVIDENCE_LANE} && 'evidence' || 'main'`),
    IOS_EVIDENCE_GROUPS: evidenceShard.outputs.evidence_groups,
  },
  command: 'python3 ../scripts/provision-ios-ci-simulator.py --purpose "$IOS_CI_LANE"',
});

const narrowSimulator = typedStep({
  id: 'narrow-simulator',
  name: 'Provision narrow iOS Simulator',
  doc: {
    purpose: 'Creates the narrow device the layout and paywall evidence has to be recorded on.',
    recovery: 'read the runtime it asked for; a missing simulator runtime is an image problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(
    `${SHOULD_RUN} && ((${EVIDENCE_LANE} `
    + "&& (steps.evidence-shard.outputs.evidence_groups != '' "
    + `|| (${NARROW_PAYWALL_REQUIRED_IN_LANE}))) `
    + "|| (matrix.lane == 'native1' "
    + "&& contains(steps.evidence-shard.outputs.evidence_groups, 'account-update')) "
    // native1 runs the narrow paywall phase after its affected UI tests.
    + `|| (matrix.lane == 'native1' && ${NARROW_PAYWALL_REQUIRED_IN_LANE}))`,
  ),
  outputs: ['dest', 'provisioned_udid'] as const,
  // simulatorCleanupPlan releases the device by this purpose's name: native1
  // owns an evidence device only for account-update evidence, otherwise its
  // paywall-only device is Main Narrow.
  env: {
    IOS_CI_LANE: expr(
      `(${EVIDENCE_LANE} `
      + "|| contains(steps.evidence-shard.outputs.evidence_groups, 'account-update')) "
      + "&& 'evidence' || 'main'",
    ),
  },
  command: 'python3 ../scripts/provision-ios-ci-simulator.py --purpose "$IOS_CI_LANE" --device-class narrow',
});

const prepareTestEnvironment = typedStep({
  name: 'Prepare CI Test Environment',
  doc: {
    purpose: 'Publishes the result-bundle and log paths this lane writes its evidence into.',
    recovery: 'retry; a failure here is the runner refusing to write the job environment file',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(SHOULD_RUN),
  env: { PRIMARY_DESTINATION: primarySimulator.outputs.dest },
  command: 'node ../ci/src/actions/ios/prepareCiTestEnvironment.ts',
});

const restoreTestProducts = typedStep({
  id: 'restore-native-test-products',
  name: 'Restore exact-head native test products',
  doc: {
    purpose: 'Takes the products the producer built for this head rather than compiling them again.',
    recovery: 'a miss is handled by the artifact download below; read the producer lane instead',
  },
  owner: 'automation',
  category: 'artifact',
  unit: 'step',
  if: expr(SHOULD_RUN),
  outputs: ['cache-hit'] as const,
  continueOnError: true,
  timeoutMinutes: 5,
  uses: CACHE_RESTORE,
  with: { path: HANDOFF_ARCHIVE, key: HANDOFF_KEY },
});

const retryRestoreTestProducts = typedStep({
  id: 'retry-restore-native-test-products',
  name: 'Retry exact-head native test products restore once',
  doc: {
    purpose: 'Retries a transient cache transfer failure once before using the artifact fallback.',
    recovery: 'if both cache reads miss, inspect the artifact fallback and producer transport',
  },
  owner: 'automation',
  category: 'artifact',
  unit: 'step',
  if: expr(`${SHOULD_RUN} && (steps.restore-native-test-products.outcome != 'success' `
    + "|| steps.restore-native-test-products.outputs.cache-hit != 'true')"),
  outputs: ['cache-hit'] as const,
  continueOnError: true,
  timeoutMinutes: 5,
  uses: CACHE_RESTORE,
  with: { path: HANDOFF_ARCHIVE, key: HANDOFF_KEY },
});

/** The next step reports a missing archive itself, naming both sources. */
const downloadProductsFallback = typedStep({
  name: 'Download exact-head native products fallback',
  doc: {
    purpose: 'Takes the independent artifact copy of the products when the run cache missed.',
    recovery: 'no action here: the preparation step below names both transports it tried',
  },
  owner: 'automation',
  category: 'artifact',
  unit: 'step',
  if: expr(`${SHOULD_RUN} && (steps.restore-native-test-products.outcome != 'success' `
    + "|| steps.restore-native-test-products.outputs.cache-hit != 'true') "
    + "&& (steps.retry-restore-native-test-products.outcome != 'success' "
    + "|| steps.retry-restore-native-test-products.outputs.cache-hit != 'true')"),
  continueOnError: true,
  uses: DOWNLOAD_ARTIFACT,
  with: {
    name: concat('ios-native-test-products-fallback-', github('run_id')),
    path: '.example-ci/handoff',
  },
});

const prepareNativeProducts = typedStep({
  id: 'prepare-native-products',
  name: 'Prepare native test products and result paths',
  doc: {
    purpose: 'Verifies restored exact-head products or selects an exceptional consumer rebuild when both transports fail.',
    recovery: 'read the cache and artifact steps; if both miss, the next step builds from this checked-out head',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(SHOULD_RUN),
  outputs: ['rebuild_required'] as const,
  env: {
    EXACT_HEAD_SHA: EXACT_HEAD,
    EXECUTION_LANE: expr('matrix.lane'),
  },
  command: 'node ../ci/src/actions/ios/prepareNativeTestProducts.ts',
});

const prepareConsumerCache = typedStep({
  name: 'Prepare native consumer build cache',
  doc: {
    purpose: 'Claims this lane entry of the derived-data cache for the rebuild that follows it.',
    recovery: 'read the entry-ownership error; a lane name that is not this one is the failure',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(`${SHOULD_RUN} && steps.prepare-native-products.outputs.rebuild_required == 'true'`),
  env: {
    IOS_CI_CACHE_LANE: 'main',
    IOS_CI_PACKAGE_RESOLVED: concat(
      github('workspace'),
      '/ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    ),
  },
  command: 'bash ../scripts/manage-ios-build-cache.sh prepare "$IOS_CI_CACHE_LANE"',
});

const rebuildTestProducts = typedStep({
  id: 'rebuild-native-products',
  name: 'Rebuild native test products for consumer Xcode',
  doc: {
    purpose: 'Rebuilds from this checked-out head when the products are absent or use an incompatible Xcode.',
    recovery: 'read the Swift error in the uploaded xcodebuild log and fix it in the branch',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  if: expr(`${SHOULD_RUN} && steps.prepare-native-products.outputs.rebuild_required == 'true'`),
  env: {
    IOS_CI_LANE: 'main',
    IOS_ONLY_TESTING_FILE: affectedTests.outputs.only_testing_file,
    IOS_TEST_SELECTION_MODE: affectedTests.outputs.mode,
    IOS_NARROW_PAYWALL_REQUIRED: NARROW_PAYWALL_REQUIRED_VALUE,
    IOS_EVIDENCE_GROUPS: evidenceShard.outputs.evidence_groups,
    IOS_PRIMARY_DESTINATION: primarySimulator.outputs.dest,
    STOREKIT_REQUIRED: iosGateOutput('storekit_required'),
  },
  command: 'bash ../scripts/build-ios-ci-test-products.sh',
});

const executeTests = typedStep({
  id: 'execute-tests',
  name: 'Execute Precompiled iOS Tests',
  doc: {
    purpose: 'Runs this lane\'s partition of the suite against the products it restored.',
    recovery: 'read the failing test in the uploaded result bundle and fix it in the branch',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(SHOULD_RUN),
  env: {
    IOS_CI_LANE: expr(`${EVIDENCE_LANE} && 'evidence' || matrix.lane`),
    IOS_MAIN_TEST_PARTITION: expr('matrix.lane'),
    IOS_ONLY_TESTING_FILE: affectedTests.outputs.only_testing_file,
    IOS_TEST_SELECTION_MODE: affectedTests.outputs.mode,
    IOS_EVIDENCE_GROUPS: evidenceShard.outputs.evidence_groups,
    IOS_ACCOUNT_UPDATE_GROUP_REQUIRED: expr(
      "contains(steps.affected-tests.outputs.evidence_groups, 'account-update') && 'true' || 'false'",
    ),
    IOS_ACCOUNT_UPDATE_TEST_COUNT: affectedTests.outputs.account_update_test_count,
    IOS_UI_METHOD_OWNERS: iosGateOutput('native_ui_method_owners'),
    IOS_PRIMARY_DESTINATION: primarySimulator.outputs.dest,
    IOS_NARROW_DESTINATION: narrowSimulator.outputs.dest,
    IOS_NARROW_PAYWALL_REQUIRED: NARROW_PAYWALL_REQUIRED_VALUE,
    IOS_WELLNESS_REQUIRED: affectedTests.outputs.wellness_required,
    IOS_WELLNESS_ONLY_TESTING_FILE: affectedTests.outputs.wellness_only_testing_file,
    IOS_WELLNESS_TEST_COUNT: affectedTests.outputs.wellness_test_count,
    IOS_TEST_EXECUTION_MIN_FREE_KB: expr(
      `${EVIDENCE_LANE} && needs.ios-change-gate.outputs.ios_evidence_macos_minimum_execution_free_kb `
      + '|| needs.ios-change-gate.outputs.ios_macos_minimum_execution_free_kb',
    ),
    // wipe-current asserts entry ownership, so this must name the lane
    // "Prepare native consumer build cache" prepared.
    IOS_CI_CACHE_LANE: 'main',
    EXACT_HEAD_SHA: EXACT_HEAD,
  },
  command: 'node ../ci/src/actions/ios/executePrecompiledTests.ts',
});

const summarizeFailures = typedStep({
  id: 'summarize-ios-test-failures',
  name: 'Summarize iOS Test Failures',
  doc: {
    purpose: 'Writes the failing test names into the run summary so a red lane is readable at a glance.',
    recovery: 'no action: this step describes the failure above rather than causing one',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr(
    `always() && ${SHOULD_RUN} `
    + '&& contains(fromJSON(\'["success", "failure", "cancelled"]\'), steps.execute-tests.outcome)',
  ),
  command: 'node ../ci/src/actions/ios/summarizeIosTestFailures.ts',
});

const exportScreenshots = typedStep({
  id: 'export-ios-test-screenshots',
  name: 'Export iOS Test Screenshots',
  doc: {
    purpose: 'Pulls the screenshots the evidence tests recorded out of the result bundle.',
    recovery: 'read the bundle path it names; no attachments means the test recorded none',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr(`always() && ${SCREENSHOT_LANES}`),
  command: 'node ../ci/src/actions/ios/exportIosTestScreenshots.ts',
});

const validateFinancialIndependence = typedStep({
  id: 'validate-financial-independence',
  name: 'Validate financial independence evidence',
  doc: {
    purpose: 'Checks the dispatched financial-independence scope produced the evidence it was run for.',
    recovery: 'read the missing artefact it names and rerun the scope that records it',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(
    "matrix.lane == 'native1' && github.event_name == 'workflow_dispatch' "
    + `&& inputs.test_scope == 'financial-independence-evidence' && ${SHOULD_RUN}`,
  ),
  env: {
    EXACT_HEAD_SHA: github('sha'),
    IOS_EVIDENCE_VALIDATION: 'financial-independence',
  },
  command: 'node ../ci/src/actions/ios/validateIosEvidence.ts',
});

const validateOnboardingCopy = typedStep({
  id: 'validate-onboarding-copy',
  name: 'Validate Issue 4549 onboarding-copy accessibility evidence',
  doc: {
    purpose: 'Checks the onboarding-copy accessibility shard recorded the screenshots the issue asks for.',
    recovery: 'read the missing artefact it names and rerun the shard that records it',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(
    `always() && ${EVIDENCE_LANE} && ${SHOULD_RUN} `
    + "&& (contains(steps.evidence-shard.outputs.evidence_groups, 'accessibility') "
    + "|| contains(steps.evidence-shard.outputs.evidence_groups, 'onboarding-copy'))",
  ),
  env: {
    EXACT_HEAD_SHA: EXACT_HEAD,
    IOS_EVIDENCE_VALIDATION: 'onboarding-copy',
  },
  command: 'node ../ci/src/actions/ios/validateIosEvidence.ts',
});

const retainWellnessEvidence = typedStep({
  name: 'Retain required Wellness execution evidence',
  doc: {
    purpose: 'Keeps the Wellness contract this lane produced, which outlives the lane diagnostics.',
    recovery: 'no action: the contract is advisory evidence, and the lane result is the verdict',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr(
    `always() && matrix.lane == 'native1' `
    + `&& steps.affected-tests.outputs.wellness_required == 'true' && ${SHOULD_RUN} `
    + "&& steps.execute-tests.outcome == 'failure'",
  ),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('wellness-native-', github('run_id'), '-', github('run_attempt')),
    'retention-days': 3,
    'if-no-files-found': 'error',
    path: concat(RESULT_ROOT, '*/wellness-contract.*'),
  },
});

/** Upload only when the XCTest run or a screenshot-dependent validation failed. */
const EVIDENCE_FAILURE = [
  'steps.validate-financial-independence.outcome',
  'steps.validate-onboarding-copy.outcome',
  'steps.export-ios-test-screenshots.outcome',
].map((outcome) => `${outcome} == 'failure'`).join(' || ');
const TEST_OR_EVIDENCE_FAILURE = `steps.execute-tests.outcome == 'failure' || steps.summarize-ios-test-failures.outcome == 'failure' || ${EVIDENCE_FAILURE}`;

const uploadScreenshots = typedStep({
  id: 'upload-ios-test-screenshots',
  name: 'Upload iOS Test Screenshots',
  doc: {
    purpose: 'Publishes the exported screenshots as the evidence a reviewer reads the scope from.',
    recovery: 'no action here: the retain step below keeps the same evidence on the runner',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr(`always() && ${SCREENSHOT_LANES} && (${TEST_OR_EVIDENCE_FAILURE})`),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('ios-test-', expr('matrix.lane'), '-screenshots-', github('run_id'), '-', github('run_attempt')),
    'retention-days': 3,
    path: concat(RESULT_ROOT, '*/screenshots'),
    'if-no-files-found': 'ignore',
  },
});

const retainScreenshotEvidence = typedStep({
  name: 'Retain iOS Test screenshot evidence in job summary',
  doc: {
    purpose: 'Keeps the screenshots on the runner and says where, when the upload quota refused them.',
    recovery: 'read the retained path it prints and collect the evidence from that runner',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("always() && steps.upload-ios-test-screenshots.outcome == 'failure'"),
  env: {
    EXECUTION_LANE: expr('matrix.lane'),
    IOS_RETAINED_EVIDENCE: 'screenshots',
  },
  command: 'node ../ci/src/actions/ios/retainIosCiEvidence.ts',
});

const uploadDiagnostics = typedStep({
  id: 'upload-ios-test-diagnostics',
  name: 'Upload iOS Test Diagnostics',
  doc: {
    purpose: 'Publishes every result bundle and build log a failing lane is diagnosed from.',
    recovery: 'no action here: the retain step below keeps the same evidence on the runner',
  },
  owner: 'infrastructure',
  category: 'evidence',
  unit: 'step',
  if: expr(`always() && ${SHOULD_RUN} && (steps.rebuild-native-products.outcome == 'failure' || ${TEST_OR_EVIDENCE_FAILURE})`),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('ios-test-', expr('matrix.lane'), '-diagnostics-', github('run_id'), '-', github('run_attempt')),
    'compression-level': 0,
    'retention-days': 1,
    path: concat(
      RESULT_ROOT, '*/example-ios-tests.xcresult\n',
      RESULT_ROOT, '*/example-ios-storekit-tests.xcresult\n',
      RESULT_ROOT, '*/example-ios-account-update-tests.xcresult\n',
      RESULT_ROOT, '*/example-ios-accessibility-tests.xcresult\n',
      RESULT_ROOT, '*/*.first-launch-failure.xcresult\n',
      RESULT_ROOT, '*/narrow-paywall-lane.xcresult\n',
      RESULT_ROOT, '*/xcodebuild.log\n',
      RESULT_ROOT, '*/build-xcodebuild.log\n',
      RESULT_ROOT, '*/storekit-xcodebuild.log\n',
      RESULT_ROOT, '*/account-update-xcodebuild.log\n',
      RESULT_ROOT, '*/accessibility-xcodebuild.log\n',
      RESULT_ROOT, '*/narrow-paywall-lane-xcodebuild.log\n',
      RESULT_ROOT, '*/*.first-launch-busy.log\n',
      RESULT_ROOT, '*/**/*.storekit-prime.log\n',
    ),
    'if-no-files-found': 'ignore',
  },
});

const uploadBusyRetryDiagnostics = typedStep({
  id: 'upload-ios-busy-retry-diagnostics',
  name: 'Upload iOS Busy retry diagnostics',
  doc: {
    purpose: 'Publishes the first-launch evidence that says whether a Busy retry masked a real failure.',
    recovery: 'no action here: the retain step below keeps the same evidence on the runner',
  },
  owner: 'infrastructure',
  category: 'evidence',
  unit: 'step',
  if: expr(`always() && ${SHOULD_RUN} && steps.execute-tests.outcome == 'failure'`),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('ios-test-', expr('matrix.lane'), '-busy-retry-', github('run_id'), '-', github('run_attempt')),
    'compression-level': 0,
    'retention-days': 1,
    path: concat(
      RESULT_ROOT, '*/**/*.first-launch-failure.xcresult\n',
      RESULT_ROOT, '*/**/*.first-launch-busy.log\n',
    ),
    'if-no-files-found': 'ignore',
  },
});

const retainDiagnostics = typedStep({
  name: 'Retain iOS Test diagnostics on runner',
  doc: {
    purpose: 'Keeps the diagnostics on the runner and says where, when the upload quota refused them.',
    recovery: 'read the retained path it prints and collect the evidence from that runner',
  },
  owner: 'infrastructure',
  category: 'evidence',
  unit: 'step',
  if: expr(
    "always() && (steps.upload-ios-test-diagnostics.outcome == 'failure' "
    + "|| steps.upload-ios-busy-retry-diagnostics.outcome == 'failure')",
  ),
  env: {
    EXECUTION_LANE: expr('matrix.lane'),
    IOS_RETAINED_EVIDENCE: 'diagnostics',
  },
  command: 'node ../ci/src/actions/ios/retainIosCiEvidence.ts',
});

const removeSimulators = typedStep({
  name: 'Remove provisioned iOS Simulators',
  doc: {
    purpose: 'Deletes every device this lane created so their data does not outlive it on a shared Mac.',
    recovery: 'delete the named devices by hand on that runner if the step could not',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr(`always() && ${SHOULD_RUN}`),
  env: {
    IOS_CI_LANE: expr(`${EVIDENCE_LANE} && 'evidence' || matrix.lane`),
    IOS_EVIDENCE_GROUPS: evidenceShard.outputs.evidence_groups,
    IOS_PRIMARY_SIMULATOR_UDID: primarySimulator.outputs.provisioned_udid,
    IOS_NARROW_SIMULATOR_UDID: narrowSimulator.outputs.provisioned_udid,
  },
  command: 'node ../ci/src/actions/ios/removeProvisionedSimulators.ts',
});

const boundBuildCache = typedStep({
  name: 'Bound persistent iOS build cache',
  doc: {
    purpose: 'Prunes the derived-data entry this lane claimed so the cache stays inside its bound.',
    recovery: 'read the entry-ownership error; a lane name that is not this one is the failure',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  // The only condition in this job written wrapped. GitHub reads a bare and a
  // wrapped `if` alike, and the wrapper is kept so the generated file is the
  // committed one rather than a tidied version of it.
  if: `\${{ always() && ${SHOULD_RUN} && env.IOS_CI_BUILD_CACHE_ENTRY != '' }}`,
  env: {
    // Must name the lane "Prepare native consumer build cache" prepared.
    // Pruning any other lane fails the entry-ownership assertion and fails
    // the job after its tests already passed.
    IOS_CI_CACHE_LANE: 'main',
  },
  command: 'bash ../scripts/manage-ios-build-cache.sh prune "$IOS_CI_CACHE_LANE"',
});

const removeCurrentArtifacts = typedStep({
  name: 'Remove current iOS runner artifacts',
  doc: {
    purpose: 'Returns this shard\'s disk to the shared Mac so the next lane finds the space it admits on.',
    recovery: 'read the free-space figure it prints; a runner still short of it needs a person',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr('always()'),
  command: 'bash ../scripts/reclaim-ios-runner-disk.sh current',
});

/**
 * The debt-card dispatch owns only real-backend and Release archive evidence.
 * Its focused frontend plan is retained separately and must not delay this
 * backend/archive rerun, so that scope and `e2e` are excluded here.
 */
const ADMITTED_EVENT = "( github.event_name == 'workflow_dispatch' "
  + "&& inputs.test_scope != 'debt-card-evidence' && inputs.test_scope != 'e2e' ) "
  + "|| ( needs.ios-change-gate.outputs.should_run == 'true' "
  + `&& ${ciEventCondition('sameRepositoryReviewedChange')} `
  + "&& ( needs.ios-change-gate.outputs.production_promotion == 'true' "
  + `|| ( ${ciEventCondition('changeIntoDevelop')} `
  + "&& ( needs.ios-change-gate.outputs.main_required == 'true' "
  + "|| needs.ios-change-gate.outputs.evidence_required == 'true' ) "
  + "&& needs.ios-change-gate.outputs.production_promotion != 'true' ) ) )";

export const testIosExecution = typedJob('test-ios-execution', {
  name: matrixSuffixed('Test - iOS execution', 'lane'),
  doc: {
    purpose: 'Runs one lane of the native iOS suite against the products the producer built.',
    successMeaning: 'The tests this lane owns passed on the exact head under test.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'shard',
  concurrency: laneConcurrency('native-', expr('matrix.lane')),
  needs: [iosChangeGate, confirmCurrentIosPr, buildIosNativeTestProducts],
  if: expr(
    "always() && !cancelled() && needs.confirm-current-ios-pr.outputs.current == 'true' "
    + "&& needs.ios-change-gate.outputs.native_planned == 'true' "
    + "&& needs.build-ios-native-test-products.result == 'success' "
    + "&& needs.ios-change-gate.outputs.native_execution_required == 'true' "
    // The padding inside the parentheses is the committed spelling, kept so
    // the generated file is that file rather than a tidied version of it.
    + `&& ( ${ADMITTED_EVENT} )`,
  ),
  // GitHub assigns each lane to the next eligible physical Mac.
  runsOn: evidenceScopeMacs,
  permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read' },
  // One shard per lane the gate planned. `strategy.matrix` is passed to the
  // emitter as written, and its YAML dumper has no case for an expression
  // object, so the expression is rendered here rather than handed over live.
  strategy: {
    failFast: false,
    matrix: { lane: String(fromJSON(iosGateOutput('native_execution_lanes'))) },
  },
  defaults: IOS_PROJECT_DEFAULTS,
  lane: routedNativeMacLane,
  steps: [
    exportSimulatorRunnerEnvironment(),
    resetOversizedDedicatedRunnerCheckout(),
    checkout,
    setupNodeForGuard,
    checkoutTrustedNativeControls,
    verifyExactRevision,
    selectXcode,
    verifyImagePrerequisites,
    reclaimStaleArtifacts,
    installLaneRunner,
    laneSelection,
    prepareNativeSelectorHistory(),
    affectedTests,
    evidenceShard,
    skipTests,
    resetSimulatorHost,
    primarySimulator,
    narrowSimulator,
    prepareTestEnvironment,
    restoreTestProducts,
    retryRestoreTestProducts,
    downloadProductsFallback,
    prepareNativeProducts,
    prepareConsumerCache,
    rebuildTestProducts,
    executeTests,
    summarizeFailures,
    exportScreenshots,
    validateFinancialIndependence,
    validateOnboardingCopy,
    retainWellnessEvidence,
    uploadScreenshots,
    retainScreenshotEvidence,
    uploadDiagnostics,
    uploadBusyRetryDiagnostics,
    retainDiagnostics,
    removeSimulators,
    boundBuildCache,
    removeCurrentArtifacts,
  ],
});

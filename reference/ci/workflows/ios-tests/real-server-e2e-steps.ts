import type { Permissions } from 'gagen';
import { installNodeDependencySteps } from '../lib/nodeModulesCache.ts';
import { pinnedIosSimulatorRuntimeIdentifier, pinnedIosXcodeToolchain } from '../../src/ios/toolchainPolicy.ts';
import {
  ciEventCondition, ciEventField, concat, expr, type ExpressionValue, github, secret,
  type TypedStep, typedStep,
} from '../lib/index.ts';
import {
  CACHE_RESTORE, CACHE_SAVE, CHECKOUT, DOWNLOAD_ARTIFACT, UPLOAD_ARTIFACT,
  exportSimulatorRunnerEnvironment, installTypedCiDependencies, iosGateOutput,
  resetOversizedDedicatedRunnerCheckout, setupNode, TRUSTED_VERIFIER_SHA, typedLayerCheckout,
} from './shared.ts';
import { e2eProductCacheKey } from './e2e-product-cache-key.ts';

/**
 * The one body every real-server E2E lane runs.
 *
 * Onboarding, Chat Plaid, Income and Budget are four jobs because they need
 * four Macs and four isolated backends, not because they do four different
 * things: each one checks out the exact head, proves it is still the head
 * under review, restores the products the shared producer built, starts a
 * lane-isolated development backend, runs its own XCTest, and hands the
 * evidence back. The steps that belong to one lane are selected by
 * `env.E2E_LANE`, so the body is written once here and the lane's job file
 * says only which lane it is, which port it owns and when it is allowed to
 * run. In the YAML this is the `&real-server-e2e-steps` anchor the other
 * three lanes alias.
 *
 * Nothing here is parameterised on the lane: a lane that needed its own step
 * order would be a different job, and the `env.E2E_LANE` guards are what keep
 * the four in one body instead of four copies that drift.
 */

/** `${{ env.NAME }}` — the lane's own variables, exported by its earlier steps. */
const envVar = (name: string): ExpressionValue => expr(`env.${name}`);

/** The one lane that runs on a laptop rather than a rack Mac, and what it needs. */
const air = (present: string, absent: string): ExpressionValue =>
  expr(`runner.name == 'Mitchells-MacBook-Air-ios-24gb' && '${present}' || '${absent}'`);

/** The rack Mac that keeps Xcode archives and device support nothing else does. */
const rack = (present: string, absent: string): ExpressionValue =>
  expr(`runner.name == 't-runner-2' && '${present}' || '${absent}'`);

/** A value each of the two named hosts sets differently, and no other host sets. */
const perHost = (rackValue: string, airValue: string): ExpressionValue =>
  expr(
    `runner.name == 't-runner-2' && '${rackValue}' `
    + `|| runner.name == 'Mitchells-MacBook-Air-ios-24gb' && '${airValue}' || ''`,
  );

/** The simulators a shared Mac keeps from earlier CI generations, by host. */
const LEGACY_SIMULATORS_JSON = '[{"name":"iPhone 17 Pro","runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-0",'
  + '"udid":"f39f2a52-cbe6-5719-86ee-3f9ce3a7d81d"},{"name":"iPhone 17",'
  + '"runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-0","udid":"b16072c6-7af0-5703-9dec-72596d4cddd6"},'
  + '{"name":"iPhone 17 Pro","runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-3",'
  + '"udid":"c4223962-45e0-5b77-aa31-058e756cfa1f"},{"name":"iPhone 16e",'
  + '"runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-3","udid":"69cc431a-5d70-54d7-904b-00f9a675d9ed"},'
  + '{"name":"iPhone 17 Pro Max","runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-0",'
  + '"udid":"d997d72b-cce5-5bfd-808b-284c578dfcfa"}]';

/** The head under test, which every lane checks out and every program is told. */
const EXACT_HEAD = envVar('ONBOARDING_E2E_COMMIT_SHA');

/** The one debt-card evidence dispatch, which builds and runs its own products. */
const DEBT_CARD_EVIDENCE = "github.event_name == 'workflow_dispatch' "
  + "&& inputs.test_scope == 'debt-card-evidence'";

/** Whether the cached debt-card products can be used as they were restored. */
const DEBT_CARD_REBUILD = `${DEBT_CARD_EVIDENCE} `
  + "&& steps.validate-debt-card-test-products.outputs.usable != 'true'";

/** Onboarding only: the lane the change gate selected, not merely the lane env. */
const ONBOARDING_SELECTED = "env.E2E_LANE == 'onboarding' "
  + "&& needs.ios-change-gate.outputs.onboarding_required == 'true'";

/** Video is recorded for the promotion path only; every other run skips it. */
const RECORDING_PROMOTION = `(${ciEventCondition('pullRequestIntoMain')} `
  + "|| (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')) && '1' || '0'";

/**
 * A same-repository pull request into a branch this workflow guards, or a
 * develop merge queue candidate. A fork's head never reaches the development
 * credentials these lanes hold (a queue candidate's PR origin is re-proved by
 * the gate precheck before any lane is selected).
 */
export const SAME_REPOSITORY_TARGET_BRANCH = ciEventCondition('reviewedChangeIntoTarget');

/** A manual run of one of the two guarded branches, whatever its scope. */
export const DISPATCHED_FROM_TARGET_BRANCH = "github.event_name == 'workflow_dispatch' "
  + "&& (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main')";

/**
 * The deployment environment every lane holds. It is where the development
 * credentials the lane backend runs on come from, and the approval and branch
 * protections on it are part of who may start one of these jobs.
 */
export const LANE_ENVIRONMENT = { name: 'development-e2e' } as const;

/**
 * `id-token: write` is the one permission that separates a lane from the
 * control jobs: the lane exchanges the run identity for development GCP
 * credentials through workload identity. Everything else is read.
 */
export const LANE_PERMISSIONS: Permissions = {
  actions: 'read',
  contents: 'read',
  'id-token': 'write',
  'pull-requests': 'read',
};

/** The head under test, which every lane checks out and its backend reports. */
export const LANE_COMMIT_SHA = ciEventField('headSha');

/** The prefix of every lane's admission rule: the producer and the schema both held. */
export const LANE_PREREQUISITES = "needs.build-ios-e2e-test-products.result == 'success' "
  + "&& needs.prepare-dev-e2e-schema.result == 'success' "
  + "&& needs.ios-change-gate.outputs.should_run == 'true'";

/**
 * The two evidence scopes that own no real-server journey. They are dispatched
 * to produce a focused receipt, and a lane that ran for them would spend a Mac
 * on a journey nobody asked about.
 */
export const NOT_A_FOCUSED_EVIDENCE_SCOPE = "inputs.test_scope != 'mortgage-assignment-evidence' "
  + "&& inputs.test_scope != 'debt-card-evidence'";

// ---------------------------------------------------------------------------
// Establish the revision under test.
// ---------------------------------------------------------------------------

const checkout = typedStep({
  name: 'Checkout the workflow revision',
  doc: {
    purpose: 'Materialises the exact head under review, which is the revision this lane builds and runs.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: CHECKOUT,
  with: {
    'fetch-depth': 1,
    filter: 'blob:none',
    'persist-credentials': false,
    ref: EXACT_HEAD,
  },
});

/**
 * The liveness guard, and the reason this lane may spend a Mac at all.
 *
 * It runs the gate-proven verifier's typed revision check from a separate
 * checkout, then proves the checkout really is the head the gate recorded.
 */
const checkoutTrustedRevisionGuard = typedLayerCheckout({
  name: 'Checkout typed iOS revision guard',
  path: '.ci/trusted-ios-revision-guard',
  ref: TRUSTED_VERIFIER_SHA,
});

const verifyExactRevision = typedStep({
  name: 'Verify exact iOS test revision',
  doc: {
    purpose: 'Proves the checked-out head is the tuple the gate queued and the pull request still has.',
    recovery: 'a moved or closed pull request is the expected answer; rerun only if the API call failed',
  },
  owner: 'product',
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
  // The action and its bounded GitHub retry come from the gate-proven verifier,
  // never from the exact head this step is deciding whether to execute.
  command: 'node .ci/trusted-ios-revision-guard/ci/src/actions/ios/verifyExactIosRevision.ts',
});

const selectExactXcode = typedStep({
  name: 'Select exact Xcode',
  doc: {
    purpose: 'Points the lane at the one pinned Xcode build (ci/src/ios/toolchainPolicy.ts) CI compiles with.',
    recovery: 'install the pinned Xcode build on the runner; the step prints what it found instead',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: `node ci/src/actions/ios/selectXcode.ts ${pinnedIosXcodeToolchain}`,
});

const verifyToolchain = typedStep({
  name: 'Verify exact Xcode, SDK, and simulator runtime',
  doc: {
    purpose: 'Confirms the Xcode, SDK and simulator runtime on this Mac are the ones onboarding needs.',
    recovery: 'read the mismatch the step prints and bring the runner image up to it',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: 'python3 scripts/ios-ci-image-prerequisites.py --purpose onboarding',
});

// ---------------------------------------------------------------------------
// Take delivery of the products the shared producer built.
// ---------------------------------------------------------------------------

/** Same exact-head/run key on a job-only rerun; the producer keeps its earlier attempt. */
const E2E_PRODUCTS_KEY = e2eProductCacheKey(EXACT_HEAD, github('run_id'));

/** The producer's fallback upload, named for the run it belongs to. */
const E2E_PRODUCTS_FALLBACK = concat('ios-e2e-test-products-fallback-', github('run_id'));

const restoreTestProducts = typedStep({
  id: 'restore-e2e-test-products',
  name: 'Restore exact-head E2E test products',
  doc: {
    purpose: 'Restores the compiled E2E products the shared producer built for this exact head.',
    recovery: 'a miss is handled by the artifact fallback below; a repeated miss means the producer failed',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  continueOnError: true,
  timeoutMinutes: 5,
  uses: CACHE_RESTORE,
  with: {
    path: '.example-ci/handoff/example-ios-e2e.xctestproducts.zip',
    key: E2E_PRODUCTS_KEY,
  },
});

const downloadTestProductsFallback = typedStep({
  name: 'Download exact-head E2E products fallback',
  doc: {
    purpose: 'Downloads the producer artifact when the cache handoff missed on this runner.',
    recovery: 'the next step rebuilds exact-head products locally when neither handoff arrived',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("steps.restore-e2e-test-products.outputs.cache-hit != 'true'"),
  continueOnError: true,
  uses: DOWNLOAD_ARTIFACT,
  with: {
    name: E2E_PRODUCTS_FALLBACK,
    path: '.example-ci/handoff',
  },
});

/**
 * Disk is the scarce resource on a shared Mac, and it is reclaimed before the
 * lane needs it rather than after a build has already failed. What is safe to
 * remove differs per host, so the policy is expressed as this step's
 * environment and the program decides nothing about which host it is on.
 */
const reclaimRunnerDisk = typedStep({
  name: 'Reclaim stale iOS runner artifacts',
  doc: {
    purpose: 'Frees the disk this lane needs by removing runner artifacts no open run still depends on.',
    recovery: 'read the reclaim report; a runner still short of the floor needs manual attention',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  timeoutMinutes: 10,
  env: {
    EXAMPLE_ACTIONS_READ_TOKEN: github('token'),
    // A measured cold-cache full CI run retained 6,031,964 KB. Real-server
    // lanes build fewer targets, so keep the measured 12 GB safety floor
    // without rejecting healthy runners that have less than 24 GB free.
    IOS_RUNNER_MIN_FREE_KB: '12000000',
    IOS_RUNNER_COMPACT_DURABLE_EVIDENCE: '1',
    IOS_RUNNER_PRUNE_MERGED_PR_EVIDENCE: '1',
    IOS_RUNNER_PRUNE_SUPERSEDED_EVIDENCE: '1',
    IOS_RUNNER_RECLAIM_RUNNER_DIAGNOSTICS: '1',
    IOS_RUNNER_DIAGNOSTIC_RETENTION_HOURS: air('6', '72'),
    IOS_RUNNER_RECLAIM_ACTIONS_TOOLING: air('1', ''),
    EXAMPLE_ACTIONS_RUNNER_ROOT: air('/home/example/actions-runner-example-app', ''),
    EXAMPLE_ACTIONS_RUNNER_WORKSPACE_NAME: 'example-app',
    IOS_RUNNER_ACTIVE_NODE_TOOL_VERSION: '26.5.0',
    IOS_RUNNER_ACTIVE_NODE_TOOL_ARCH: 'arm64',
    IOS_RUNNER_RECLAIM_CI_SIMULATORS: '1',
    IOS_RUNNER_PRIMARY_RUNTIME_IDENTIFIER: pinnedIosSimulatorRuntimeIdentifier,
    IOS_RUNNER_SHUTDOWN_BOOTED_LEGACY_SIMULATORS: air('1', ''),
    IOS_RUNNER_RECLAIM_XCTEST_DEVICES: '1',
    IOS_RUNNER_RECLAIM_LOCAL_IOS_ARTIFACTS: air('1', ''),
    EXAMPLE_LOCAL_IOS_ARTIFACT_ROOT: air('/private/tmp', ''),
    IOS_RUNNER_RECLAIM_XCODEBUILDMCP_EXAMPLE_ARTIFACTS: air('1', ''),
    IOS_RUNNER_XCODEBUILDMCP_EXAMPLE_WORKSPACE_NAME: air('example-app-8f1cba0234bb', ''),
    IOS_RUNNER_RECLAIM_XCODE_ARCHIVES: rack('1', ''),
    IOS_RUNNER_RECLAIM_XCODE_DEVICE_SUPPORT: rack('1', ''),
    IOS_RUNNER_RECLAIM_LEGACY_SIMULATOR_NAME: perHost('iPhone 17', 'iPhone 13 mini Test'),
    IOS_RUNNER_RECLAIM_LEGACY_SIMULATOR_RUNTIME: perHost(
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
      'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
    ),
    IOS_RUNNER_RECLAIM_LEGACY_SIMULATOR_UDID: perHost(
      '4e07f379-2a83-5804-81ae-2e043229a548',
      'e2ef0691-a80c-5318-9d17-8a017a20e1e0',
    ),
    IOS_RUNNER_RECLAIM_SECONDARY_LEGACY_SIMULATOR_NAME: air('iPhone 17 Pro Max', ''),
    IOS_RUNNER_RECLAIM_SECONDARY_LEGACY_SIMULATOR_RUNTIME: air(
      'com.apple.CoreSimulator.SimRuntime.iOS-26-3',
      '',
    ),
    IOS_RUNNER_RECLAIM_SECONDARY_LEGACY_SIMULATOR_UDID: air('44ae288e-5329-5a9a-8522-4af2c9d5c4b5', ''),
    IOS_RUNNER_RECLAIM_ADDITIONAL_LEGACY_SIMULATORS_JSON: air(LEGACY_SIMULATORS_JSON, '[]'),
  },
  command: 'bash scripts/reclaim-ios-runner-disk.sh preflight',
});

// ---------------------------------------------------------------------------
// Decide what to run the tests against: the handoff, or a local rebuild.
// ---------------------------------------------------------------------------

const preparePrecompiledProducts = typedStep({
  id: 'prepare-e2e-products',
  name: 'Prepare precompiled E2E launch paths',
  doc: {
    purpose: 'Unpacks the handoff and decides whether it is usable on this runner or must be rebuilt.',
    recovery: 'read the reason the step prints; it names the toolchain or file that made the handoff unusable',
  },
  owner: 'product',
  category: 'planning',
  unit: 'step',
  outputs: ['rebuild_required'] as const,
  env: { ONBOARDING_E2E_COMMIT_SHA: EXACT_HEAD },
  command: 'node ci/src/actions/ios/preparePrecompiledE2eProducts.ts',
});

const verifyIncomeProxyBinary = typedStep({
  name: 'Verify baked Income E2E Cloud SQL proxy',
  doc: {
    purpose: 'Confirms the Cloud SQL proxy the Income lane connects through is present on this runner.',
    recovery: 'bake the proxy into the runner image; the lane cannot reach the database without it',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("env.E2E_LANE == 'income'"),
  command: 'node ci/src/actions/ios/verifyIncomeCloudSqlProxy.ts',
});

/**
 * `scripts/ios-test-income-e2e.sh` probes the database and takes its
 * verification snapshot through psql. Runner images disagree on whether a
 * Postgres client is installed, and libpq is keg-only so it is absent from
 * PATH even where it exists.
 */
const ensureIncomePsqlClient = typedStep({
  name: 'Ensure Income E2E psql client',
  doc: {
    purpose: 'Puts a Postgres client on PATH for the Income lane, which takes its snapshot through psql.',
    recovery: 'install libpq on the runner; the step prints where it looked',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr("env.E2E_LANE == 'income'"),
  command: 'node ci/src/actions/ios/ensureIncomePsqlClient.ts',
});

const boundBuildCache = typedStep({
  name: 'Bound persistent real-server build cache',
  doc: {
    purpose: 'Claims this lane a bounded slice of the persistent derived-data cache on this Mac.',
    recovery: 'read the cache report; a full disk is cleared by the reclaim step above',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  env: {
    IOS_CI_CACHE_LANE: expr(
      "(env.E2E_LANE == 'onboarding' || env.E2E_LANE == 'chat-plaid' || env.E2E_LANE == 'income') "
      + "&& 'onboarding-e2e' || env.E2E_LANE",
    ),
    IOS_CI_PACKAGE_RESOLVED: concat(
      github('workspace'),
      '/ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    ),
  },
  command: 'bash scripts/manage-ios-build-cache.sh prepare "$IOS_CI_CACHE_LANE"',
});

const rebuildTestProducts = typedStep({
  name: 'Rebuild E2E test products for consumer Xcode',
  doc: {
    purpose: 'Rebuilds the E2E products locally when the producer handoff cannot run on this toolchain.',
    recovery: 'read the xcodebuild log; this is an ordinary compile failure at the head under review',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  if: expr("steps.prepare-e2e-products.outputs.rebuild_required == 'true'"),
  env: {
    IOS_E2E_TEST_PLAN: 'CI-E2E',
    IOS_E2E_DERIVED_DATA: envVar('IOS_CI_DERIVED_DATA'),
    IOS_SOURCE_PACKAGES_DIR: envVar('IOS_CI_SOURCE_PACKAGES'),
  },
  command: 'bash scripts/build-ios-e2e-test-products.sh',
});

const exportLaunchPaths = typedStep({
  name: 'Export exact-toolchain E2E launch paths',
  doc: {
    purpose: 'Exports the .xctestrun and product paths the lane XCTest invocations are launched from.',
    recovery: 'read the paths the step prints; a missing one means the prepare or rebuild step did not finish',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  env: { IOS_E2E_TEST_PRODUCTS: envVar('IOS_E2E_TEST_PRODUCTS') },
  command: 'node ci/src/actions/ios/exportE2eLaunchPaths.ts',
});

const prepareResultPaths = typedStep({
  id: 'onboarding-paths',
  name: 'Prepare onboarding result paths',
  doc: {
    purpose: 'Creates the run directory and names every log, result bundle and receipt this lane writes.',
    recovery: 'a failure here is a full or read-only runner disk, not a change under review',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  outputs: ['debt_card_cache_dir', 'debt_card_cache_manifest', 'debt_card_test_products'] as const,
  env: { E2E_LANE: envVar('E2E_LANE') },
  command: 'node ci/src/actions/ios/prepareRealServerE2ePaths.ts',
});

// ---------------------------------------------------------------------------
// The debt-card evidence dispatch, which builds its own focused products.
// ---------------------------------------------------------------------------

const computeDebtCardBuildKey = typedStep({
  id: 'debt-card-build-key',
  name: 'Compute exact-head debt-card build key',
  doc: {
    purpose: 'Derives the cache key and fingerprint the focused debt-card products are stored under.',
    recovery: 'retry; the key is derived from the head and the toolchain, both already proven above',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  if: expr(DEBT_CARD_EVIDENCE),
  outputs: ['build_fingerprint', 'cache_key'] as const,
  env: { EXACT_HEAD_SHA: EXACT_HEAD },
  command: 'node ci/src/actions/ios/computeDebtCardBuildKey.ts',
});

const restoreDebtCardProducts = typedStep({
  id: 'restore-debt-card-test-products',
  name: 'Restore exact-head debt-card test products',
  doc: {
    purpose: 'Restores focused debt-card products built for this head by an earlier evidence dispatch.',
    recovery: 'a miss is expected on the first dispatch; the build step below covers it',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(DEBT_CARD_EVIDENCE),
  uses: CACHE_RESTORE,
  with: {
    path: prepareResultPaths.outputs.debt_card_cache_dir,
    key: computeDebtCardBuildKey.outputs.cache_key,
  },
});

const validateDebtCardProducts = typedStep({
  id: 'validate-debt-card-test-products',
  name: 'Validate exact-head debt-card test products',
  doc: {
    purpose: 'Decides whether the restored debt-card products match this head and can be run as they are.',
    recovery: 'none; an unusable restore is answered by the rebuild below',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(DEBT_CARD_EVIDENCE),
  outputs: ['usable'] as const,
  env: {
    BUILD_FINGERPRINT: computeDebtCardBuildKey.outputs.build_fingerprint,
    CACHE_HIT: expr('steps.restore-debt-card-test-products.outputs.cache-hit'),
    EXACT_HEAD_SHA: EXACT_HEAD,
    MANIFEST_PATH: prepareResultPaths.outputs.debt_card_cache_manifest,
    TEST_PRODUCTS_PATH: prepareResultPaths.outputs.debt_card_test_products,
  },
  command: 'node ci/src/actions/ios/validateDebtCardTestProducts.ts',
});

const buildDebtCardProducts = typedStep({
  name: 'Build exact-head debt-card test products',
  doc: {
    purpose: 'Builds the focused debt-card test products when no usable cached copy exists for this head.',
    recovery: 'read the xcodebuild log; this is an ordinary compile failure at the head under review',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(DEBT_CARD_REBUILD),
  env: {
    BUILD_FINGERPRINT: computeDebtCardBuildKey.outputs.build_fingerprint,
    CACHE_DIR: prepareResultPaths.outputs.debt_card_cache_dir,
    EXACT_HEAD_SHA: EXACT_HEAD,
    MANIFEST_PATH: prepareResultPaths.outputs.debt_card_cache_manifest,
    TEST_PRODUCTS_PATH: prepareResultPaths.outputs.debt_card_test_products,
    ONBOARDING_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
  },
  command: 'node ci/src/actions/ios/buildDebtCardTestProducts.ts',
});

const saveDebtCardProducts = typedStep({
  name: 'Save exact-head debt-card test products',
  doc: {
    purpose: 'Publishes the focused debt-card products so a rerun of this dispatch does not rebuild them.',
    recovery: 'retry; a repeated failure is a GitHub cache service problem, not a change under review',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(DEBT_CARD_REBUILD),
  uses: CACHE_SAVE,
  with: {
    path: prepareResultPaths.outputs.debt_card_cache_dir,
    key: computeDebtCardBuildKey.outputs.cache_key,
  },
});

// ---------------------------------------------------------------------------
// Stand up the lane's own development backend.
// ---------------------------------------------------------------------------

const isolateCloudSdkState = typedStep({
  name: 'Isolate Google Cloud SDK state',
  doc: {
    purpose: 'Gives this lane its own gcloud configuration so parallel lanes cannot overwrite each other.',
    recovery: 'a failure here is a full or read-only runner disk, not a change under review',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: 'node .ci/trusted-ios-revision-guard/ci/src/actions/ios/isolateCloudSdkState.ts',
});

const configureCloudSdkPython = typedStep({
  name: 'Configure Cloud SDK Python',
  doc: {
    purpose: 'Points the Cloud SDK at a Python the runner actually has, rather than its bundled default.',
    recovery: 'install a supported Python on the runner; the step prints the versions it found',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: 'node ci/src/actions/ios/configureCloudSdkPython.ts',
});

const authenticateToGcp = typedStep({
  name: 'Authenticate dev E2E backend to GCP',
  doc: {
    purpose: 'Exchanges the run identity for development GCP credentials through workload identity.',
    recovery: 'check the workload identity provider still trusts this repository and the service account',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: 'google-github-actions/auth@v3',
  with: {
    project_id: 'example-app',
    workload_identity_provider:
      'projects/123456789012/locations/global/workloadIdentityPools/github-actions/providers/github',
    service_account: 'github-actions-ci@example-app.iam.gserviceaccount.com',
  },
});

const setUpCloudSdk = typedStep({
  name: 'Set up Google Cloud SDK',
  doc: {
    purpose: 'Installs the gcloud the runtime config load and the Cloud SQL proxy are driven through.',
    recovery: 'retry; a repeated failure is a download problem on the runner',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: 'google-github-actions/setup-gcloud@v3.0.1',
  with: { version: '>= 390.0.0', cache: true },
});

const loadRuntimeConfig = typedStep({
  name: 'Load dev GCP runtime config',
  doc: {
    purpose: 'Reads the development runtime configuration the lane backend is started with.',
    recovery: 'check the service account still reads the development runtime configuration',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: 'node ci/src/actions/ios/loadDevGcpRuntimeConfig.ts',
});

const verifyDeployedSchema = typedStep({
  name: 'Verify deployed development database schema',
  doc: {
    purpose: 'Confirms the deployed development schema is the one this head expects before any test runs.',
    recovery: 'apply the pending migration to the development database, then rerun this lane',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  timeoutMinutes: 10,
  command: 'npm run db:verify-plaid-scheduler',
});

const allocateBackendPort = typedStep({
  name: 'Allocate lane-isolated dev backend port',
  doc: {
    purpose: 'Reserves the port this lane owns so two lanes on one Mac cannot share a backend.',
    recovery: 'a busy port means a previous run left a backend behind; the teardown step clears it',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  env: { E2E_LANE: envVar('E2E_LANE') },
  command: 'node ci/src/actions/ios/allocateLaneBackendPort.ts',
});

const ensureLaneBackend = typedStep({
  name: 'Ensure lane-isolated dev backend (NODE_ENV=development)',
  doc: {
    purpose: 'Starts the development backend this lane tests against and waits for it to serve requests.',
    recovery: 'read the supervisor log in the diagnostics artifact; it records why the backend never came up',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  // A stalled start must not hold this Mac; XCTest never runs in this step.
  timeoutMinutes: 15,
  env: {
    E2E_LANE: envVar('E2E_LANE'),
    ONBOARDING_DEV_BACKEND_PORT: envVar('ONBOARDING_DEV_BACKEND_PORT'),
    ONBOARDING_DEV_BACKEND_LOG: envVar('ONBOARDING_DEV_BACKEND_LOG'),
    ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG: envVar('ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG'),
    ONBOARDING_DEV_BACKEND_PID_FILE: envVar('ONBOARDING_DEV_BACKEND_PID_FILE'),
    ONBOARDING_E2E_COMMIT_SHA: EXACT_HEAD,
    INCOME_E2E_PROVIDER_AUDIT_LOG: envVar('INCOME_E2E_PROVIDER_AUDIT_LOG'),
    // The only input the shell read from an expression rather than the
    // environment: the fallback dev .env for a runner without one.
    SERVER_DEV_DOTENV_B64: secret('SERVER_DEV_DOTENV_B64'),
  },
  command: 'node ci/src/actions/ios/ensureLaneDevBackend.ts',
});

const prepareChatPlaidUser = typedStep({
  name: 'Prepare fresh Chat Plaid E2E user',
  doc: {
    purpose: 'Creates the throwaway account the Chat Plaid lane signs in as, on the lane backend.',
    recovery: 'read the backend log; a failure here means the backend is up but not serving the test API',
  },
  owner: 'product',
  category: 'planning',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && success()"),
  // TEST_OTP_SECRET reaches the program through the process environment,
  // where the backend step exported it.
  env: { ONBOARDING_DEV_BACKEND_PORT: envVar('ONBOARDING_DEV_BACKEND_PORT') },
  command: 'node ci/src/actions/ios/prepareChatPlaidE2eUser.ts',
});

// ---------------------------------------------------------------------------
// Bring up a simulator and run the lane's tests.
// ---------------------------------------------------------------------------

const resetSimulatorHost = typedStep({
  name: 'Reset CoreSimulator host',
  doc: {
    purpose: 'Recovers a degraded CoreSimulator service without killing clone devices another lane owns.',
    recovery: 'a repeated failure means the Mac needs a reboot; take it out of the pool',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  timeoutMinutes: 2,
  command: 'bash "$GITHUB_WORKSPACE/scripts/ensure-ios-simulator-host.sh"',
});

/**
 * Provisioning isolates this run from simulator data retained by prior
 * StoreKit, onboarding, and Budget UI tests.
 */
const selectSimulator = typedStep({
  id: 'sim',
  name: 'Select iOS Simulator',
  doc: {
    purpose: 'Provisions the simulator this lane runs on, isolated from data earlier UI tests left behind.',
    recovery: 'read the runtimes the step lists; the runner is missing the one this lane needs',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  outputs: ['dest', 'provisioned_udid', 'storekit_runtime_fallback'] as const,
  env: { TEST_SCOPE: expr("inputs.test_scope || ''") },
  command: 'node ci/src/actions/ios/selectE2eSimulator.ts',
});

const ensureVideoReviewTooling = typedStep({
  name: 'Ensure video review tooling',
  doc: {
    purpose: 'Installs the recording tools the promotion onboarding run is reviewed from, when advisory.',
    recovery: 'none; the review video is advisory and the lane continues without it',
  },
  owner: 'review',
  category: 'coordination',
  unit: 'step',
  continueOnError: true,
  if: expr(`${ONBOARDING_SELECTED} && ${ciEventCondition('pullRequestIntoMain')}`),
  command: 'node ci/src/actions/ios/ensureVideoReviewTooling.ts',
});

const provisionOnboardingUsers = typedStep({
  id: 'provision-development-full-onboarding-users',
  name: 'Provision development FullOnboarding users',
  doc: {
    purpose: 'Creates the synthetic accounts the FullOnboarding journey signs up and signs in with.',
    recovery: 'read the backend log; the accounts are created through the lane backend test API',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(ONBOARDING_SELECTED),
  continueOnError: true,
  // TEST_OTP_SECRET reaches the program through the process environment,
  // where the backend step exported it; the program requires it and fails
  // the step when it is missing, as `${TEST_OTP_SECRET:?}` did.
  outputs: ['cleanup_required'] as const,
  env: { ONBOARDING_DEV_BACKEND_PORT: envVar('ONBOARDING_DEV_BACKEND_PORT') },
  command: 'node ci/src/actions/ios/provisionDevelopmentOnboardingUsers.ts',
});

const startDashboardOfflineProxy = typedStep({
  id: 'start-dashboard-offline-proxy',
  name: 'Start Dashboard offline E2E proxy',
  doc: {
    purpose: 'Starts the proxy the onboarding journey drops the network through to exercise offline states.',
    recovery: 'read the proxy log in the onboarding evidence artifact; it records why it never bound',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(`${ONBOARDING_SELECTED} `
    + "&& steps.provision-development-full-onboarding-users.outcome == 'success'"),
  // A stalled start must not hold this Mac; XCTest never runs in this step.
  timeoutMinutes: 5,
  env: {
    ONBOARDING_DEV_BACKEND_PORT: envVar('ONBOARDING_DEV_BACKEND_PORT'),
    ONBOARDING_E2E_COMMIT_SHA: EXACT_HEAD,
    DASHBOARD_OFFLINE_PROXY_EVENTS: envVar('DASHBOARD_OFFLINE_PROXY_EVENTS'),
    DASHBOARD_OFFLINE_PROXY_LOG: envVar('DASHBOARD_OFFLINE_PROXY_LOG'),
  },
  command: 'node ci/src/actions/ios/startDashboardOfflineProxy.ts',
});

const runOnboardingE2e = typedStep({
  id: 'onboarding-e2e',
  name: 'Run onboarding E2E',
  doc: {
    purpose: 'Runs the FullOnboarding journey end to end against the lane backend and Plaid Sandbox.',
    recovery: 'read the failure summary this job writes; it names the assertion and the screen it failed on',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(`${ONBOARDING_SELECTED} `
    + "&& steps.provision-development-full-onboarding-users.outcome == 'success' "
    + "&& steps.start-dashboard-offline-proxy.outcome == 'success'"),
  env: {
    DASHBOARD_OFFLINE_PROXY_PORT: envVar('DASHBOARD_OFFLINE_PROXY_PORT'),
    ONBOARDING_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    DESTINATION: selectSimulator.outputs.dest,
    ONBOARDING_ALLOW_STOREKIT_RUNTIME_FALLBACK: selectSimulator.outputs.storekit_runtime_fallback,
    ITERATIONS: '1',
    RESULT_BUNDLE: envVar('ONBOARDING_E2E_RESULT_BUNDLE'),
    XCODEBUILD_LOG: envVar('ONBOARDING_E2E_XCODEBUILD_LOG'),
    DERIVED_DATA: envVar('IOS_CI_DERIVED_DATA'),
    SOURCE_PACKAGES: envVar('IOS_CI_SOURCE_PACKAGES'),
    PACKAGE_CACHE: envVar('IOS_CI_PACKAGE_CACHE'),
    RECORD_VIDEO: expr(RECORDING_PROMOTION),
    RAW_VIDEO: envVar('ONBOARDING_E2E_RAW_VIDEO'),
    COMPRESSED_VIDEO: envVar('ONBOARDING_E2E_COMPRESSED_VIDEO'),
    UI_TEST_PRODUCTION_E2E: '0',
    UI_TEST_SYNTHETIC_ONBOARDING_EMAIL: envVar('UI_TEST_SYNTHETIC_ONBOARDING_EMAIL'),
    UI_TEST_SYNTHETIC_PRIVACY_EMAIL: envVar('UI_TEST_SYNTHETIC_PRIVACY_EMAIL'),
    UI_TEST_SYNTHETIC_PASSWORD: envVar('UI_TEST_SYNTHETIC_PASSWORD'),
    UI_TEST_DASHBOARD_OFFLINE_E2E: '1',
    UI_TEST_EXPECTED_SERVER_BUILD_SHA: EXACT_HEAD,
    DASHBOARD_OFFLINE_PROXY_CONTROL_TOKEN: envVar('DASHBOARD_OFFLINE_PROXY_CONTROL_TOKEN'),
  },
  command: 'node ci/src/actions/ios/runOnboardingE2e.ts',
});

const stopDashboardOfflineProxy = typedStep({
  id: 'stop-dashboard-offline-proxy',
  name: 'Stop Dashboard offline E2E proxy',
  doc: {
    purpose: 'Stops the offline proxy and waits for the exit record its own wrapper appends to the log.',
    recovery: 'none; a proxy that outlives the job is reclaimed by the next run on this Mac',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr("env.E2E_LANE == 'onboarding' && always() && env.DASHBOARD_OFFLINE_PROXY_PID != ''"),
  env: {
    SUPERVISED_PROXY: 'dashboard-offline',
    DASHBOARD_OFFLINE_PROXY_PID: envVar('DASHBOARD_OFFLINE_PROXY_PID'),
    DASHBOARD_OFFLINE_PROXY_LOG: envVar('DASHBOARD_OFFLINE_PROXY_LOG'),
  },
  // The program proves the recorded PID is still this proxy before
  // signalling it, then blocks on the exit record the proxy's own wrapper
  // appends to its log rather than polling.
  command: 'node ci/src/actions/ios/stopSupervisedProxy.ts',
});

const deleteOnboardingUsers = typedStep({
  id: 'delete-development-full-onboarding-users',
  name: 'Delete development FullOnboarding users',
  doc: {
    purpose: 'Deletes the synthetic accounts this run created, whatever the journey did with them.',
    recovery: 'inspect the cleanup warning and retained receipt; remove any remaining development identities',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr("env.E2E_LANE == 'onboarding' && always() "
    + "&& steps.provision-development-full-onboarding-users.outputs.cleanup_required == 'true'"),
  continueOnError: true,
  env: {
    DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE: envVar('DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE'),
    ONBOARDING_DEV_BACKEND_PORT: envVar('ONBOARDING_DEV_BACKEND_PORT'),
    ONBOARDING_E2E_COMMIT_SHA: EXACT_HEAD,
    UI_TEST_SYNTHETIC_ONBOARDING_EMAIL: envVar('UI_TEST_SYNTHETIC_ONBOARDING_EMAIL'),
    UI_TEST_SYNTHETIC_PRIVACY_EMAIL: envVar('UI_TEST_SYNTHETIC_PRIVACY_EMAIL'),
    UI_TEST_SYNTHETIC_PASSWORD: envVar('UI_TEST_SYNTHETIC_PASSWORD'),
  },
  // TEST_OTP_SECRET reaches the program through the process environment,
  // where the backend step exported it; the program requires it and fails
  // the step when it is missing, as `${TEST_OTP_SECRET:?}` did.
  command: 'node ci/src/actions/ios/deleteDevelopmentFullOnboardingUsers.ts',
});

const validateOnboardingLifecycle = typedStep({
  id: 'validate-onboarding-lifecycle',
  name: 'Validate development FullOnboarding evidence',
  doc: {
    purpose: 'Checks the onboarding journey and offline evidence, and warns if synthetic-user cleanup failed.',
    recovery: 'read which outcome the step names; that step is the one that actually failed',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(`env.E2E_LANE == 'onboarding' && always() `
    + "&& needs.ios-change-gate.outputs.onboarding_required == 'true'"),
  env: {
    PROVISION_OUTCOME: expr('steps.provision-development-full-onboarding-users.outcome'),
    PROXY_START_OUTCOME: expr('steps.start-dashboard-offline-proxy.outcome'),
    ONBOARDING_OUTCOME: expr('steps.onboarding-e2e.outcome'),
    PROXY_STOP_OUTCOME: expr('steps.stop-dashboard-offline-proxy.outcome'),
    CLEANUP_OUTCOME: expr('steps.delete-development-full-onboarding-users.outcome'),
    DASHBOARD_OFFLINE_PROXY_EVENTS: envVar('DASHBOARD_OFFLINE_PROXY_EVENTS'),
    DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE: envVar('DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE'),
    ONBOARDING_E2E_XCODEBUILD_LOG: envVar('ONBOARDING_E2E_XCODEBUILD_LOG'),
    ONBOARDING_E2E_RESULT_BUNDLE: envVar('ONBOARDING_E2E_RESULT_BUNDLE'),
    ONBOARDING_E2E_COMMIT_SHA: EXACT_HEAD,
    DASHBOARD_OFFLINE_EVIDENCE_JSON: envVar('DASHBOARD_OFFLINE_EVIDENCE_JSON'),
  },
  command: 'node ci/src/actions/ios/validateOnboardingLifecycle.ts',
});

const startIncomeProxy = typedStep({
  name: 'Start Income E2E Cloud SQL proxy',
  doc: {
    purpose: 'Opens the Cloud SQL connection the Income lane takes its verification snapshot through.',
    recovery: 'read the proxy log in the Income evidence artifact; it records the connection it refused',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr("env.E2E_LANE == 'income' && success()"),
  // A stalled start must not hold this Mac; XCTest never runs in this step.
  timeoutMinutes: 5,
  env: {
    INCOME_E2E_RUN_DIR: envVar('INCOME_E2E_RUN_DIR'),
    INCOME_E2E_DB_PROXY_LOG: envVar('INCOME_E2E_DB_PROXY_LOG'),
  },
  // The proxy is owned by a detached supervisor so it outlives this step;
  // the step blocks on the proxy's readiness line or the supervisor's
  // exit record, never on a timer.
  command: 'node ci/src/actions/ios/startIncomeCloudSqlProxy.ts',
});

const runIncomeE2e = typedStep({
  id: 'income-e2e',
  name: 'Run Income activation E2E',
  doc: {
    purpose: 'Runs the Income activation journey against the lane backend and checks the rows it wrote.',
    recovery: 'read the failure summary this job writes; it names the assertion that failed',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("env.E2E_LANE == 'income' && success()"),
  env: {
    DB_HOST: '127.0.0.1',
    DB_PORT: envVar('INCOME_E2E_DB_PROXY_PORT'),
    DB_USER: 'github-actions-ci@example-app.iam',
    DB_NAME: 'example',
    DESTINATION: selectSimulator.outputs.dest,
    UI_TEST_API_BASE_URL: envVar('TEST_RUNNER_UI_TEST_API_BASE_URL'),
    INCOME_E2E_SERVER_LOG: envVar('ONBOARDING_DEV_BACKEND_LOG'),
    INCOME_E2E_PROVIDER_AUDIT_LOG: envVar('INCOME_E2E_PROVIDER_AUDIT_LOG'),
    SKIP_BUILD: '1',
    XCTESTRUN_PATH: envVar('XCTESTRUN_PATH'),
    RESULT_BUNDLE: envVar('INCOME_E2E_RESULT_BUNDLE'),
    XCODEBUILD_LOG: envVar('INCOME_E2E_XCODEBUILD_LOG'),
    RAW_VIDEO: envVar('INCOME_E2E_RAW_VIDEO'),
    VIDEO_OUTPUT: envVar('INCOME_E2E_COMPRESSED_VIDEO'),
  },
  command: 'bash scripts/ios-test-income-e2e.sh',
});

const stopIncomeProxy = typedStep({
  name: 'Stop Income E2E Cloud SQL proxy',
  doc: {
    purpose: 'Closes the Cloud SQL connection the Income lane opened, whatever the test did with it.',
    recovery: 'none; a proxy that outlives the job is reclaimed by the next run on this Mac',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr("env.E2E_LANE == 'income' && always() && env.INCOME_E2E_DB_PROXY_PID != ''"),
  env: {
    SUPERVISED_PROXY: 'income-cloud-sql',
    INCOME_E2E_DB_PROXY_PID: envVar('INCOME_E2E_DB_PROXY_PID'),
    INCOME_E2E_DB_PROXY_LOG: envVar('INCOME_E2E_DB_PROXY_LOG'),
  },
  command: 'node ci/src/actions/ios/stopSupervisedProxy.ts',
});

const runChatPlaidE2e = typedStep({
  id: 'chat-plaid-e2e',
  name: 'Run Chat Plaid E2E',
  doc: {
    purpose: 'Runs the chat-driven Plaid linking journey against the lane backend and Plaid Sandbox.',
    recovery: 'read the failure summary and the exported screenshots this job writes',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && success()"),
  // The destination and the .xctestrun path reach xcodebuild as arguments,
  // so neither can be read as shell.
  env: {
    TEST_RUNNER_UI_TEST_API_BASE_URL: envVar('TEST_RUNNER_UI_TEST_API_BASE_URL'),
    TEST_RUNNER_UI_TEST_EMAIL: envVar('CHAT_PLAID_E2E_EMAIL'),
    TEST_RUNNER_UI_TEST_PASSWORD: envVar('CHAT_PLAID_E2E_PASSWORD'),
    DESTINATION: selectSimulator.outputs.dest,
    XCTESTRUN_PATH: envVar('XCTESTRUN_PATH'),
    ONBOARDING_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    CHAT_PLAID_E2E_RESULT_BUNDLE: envVar('CHAT_PLAID_E2E_RESULT_BUNDLE'),
    CHAT_PLAID_E2E_XCODEBUILD_LOG: envVar('CHAT_PLAID_E2E_XCODEBUILD_LOG'),
  },
  command: 'node ci/src/actions/ios/runChatPlaidE2e.ts',
});

const validateChatPlaidEvidence = typedStep({
  id: 'validate-chat-plaid-evidence',
  name: 'Validate Chat Plaid backend evidence',
  doc: {
    purpose: 'Proves the backend really did the linking work the passing chat journey claimed it did.',
    recovery: 'read the backend log in the diagnostics artifact; the step names the record it wanted',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && !cancelled() && steps.chat-plaid-e2e.outcome == 'success'"),
  env: {
    CHAT_PLAID_E2E_EVIDENCE_DIR: envVar('CHAT_PLAID_E2E_EVIDENCE_DIR'),
    ONBOARDING_DEV_BACKEND_LOG: envVar('ONBOARDING_DEV_BACKEND_LOG'),
  },
  command: 'node ci/src/actions/ios/validateChatPlaidEvidence.ts',
});

const deleteChatPlaidUser = typedStep({
  name: 'Delete Chat Plaid E2E user',
  doc: {
    purpose: 'Deletes the throwaway Chat Plaid account this run created, whatever the journey did.',
    recovery: 'none; the next run creates a fresh address rather than reusing this one',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && always()"),
  env: {
    ONBOARDING_DEV_BACKEND_PORT: envVar('ONBOARDING_DEV_BACKEND_PORT'),
    CHAT_PLAID_E2E_EMAIL: envVar('CHAT_PLAID_E2E_EMAIL'),
  },
  // TEST_OTP_SECRET and CHAT_PLAID_E2E_CLEANUP_TOKEN reach the program
  // through the process environment, where the earlier steps exported
  // them; each header is sent only when its secret is present.
  command: 'node ci/src/actions/ios/deleteChatPlaidE2eUser.ts',
});

const runBudgetE2e = typedStep({
  id: 'budget-e2e',
  name: 'Run Budget real-server E2E',
  doc: {
    purpose: 'Runs this shard of the Budget and debt journeys against the lane backend.',
    recovery: 'read the failure summary this job writes; it names the assertion that failed',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && success() "
    + "&& needs.ios-change-gate.outputs.budget_required == 'true' "
    + "&& inputs.test_scope != 'debt-card-evidence'"),
  env: {
    DESTINATION: selectSimulator.outputs.dest,
    IOS_SIMULATOR_DESTINATION: selectSimulator.outputs.dest,
    BUDGET_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    RESULT_BUNDLE: envVar('BUDGET_E2E_RESULT_BUNDLE'),
    XCODEBUILD_LOG: envVar('BUDGET_E2E_XCODEBUILD_LOG'),
    DERIVED_DATA: envVar('IOS_CI_DERIVED_DATA'),
    SOURCE_PACKAGES: envVar('IOS_CI_SOURCE_PACKAGES'),
    PACKAGE_CACHE: envVar('IOS_CI_PACKAGE_CACHE'),
    SKIP_BUILD: '1',
    RECORD_VIDEO: expr(RECORDING_PROMOTION),
    RAW_VIDEO: envVar('BUDGET_E2E_RAW_VIDEO'),
    COMPRESSED_VIDEO: envVar('BUDGET_E2E_COMPRESSED_VIDEO'),
    VIDEO_LOG: envVar('BUDGET_E2E_VIDEO_LOG'),
    BUDGET_E2E_CLEANUP_RECEIPT: envVar('IOS_3996_CLEANUP_RECEIPT'),
    UI_TEST_API_BASE_URL: envVar('TEST_RUNNER_UI_TEST_API_BASE_URL'),
    UI_TEST_EMAIL: concat(
      'budget-e2e-', github('run_id'), '-', github('run_attempt'), '@test.example.local',
    ),
    EXPECTED_SERVER_BUILD_SHA: EXACT_HEAD,
  },
  command: 'bash scripts/run-ios-budget-e2e-shards.sh',
});

const runDebtFreshnessEvidence = typedStep({
  id: 'debt-card-backend-evidence',
  name: 'Run Issue 3998 real-backend debt freshness evidence',
  doc: {
    purpose: 'Runs the focused debt freshness case the evidence dispatch exists to produce a receipt for.',
    recovery: 'read the receipt the step names; it records what the backend returned',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() && !cancelled() "
    + "&& inputs.test_scope == 'debt-card-evidence'"),
  env: {
    DESTINATION: selectSimulator.outputs.dest,
    BUDGET_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    BUDGET_E2E_TEST_PLAN: 'Debt-Card-Backend-Evidence',
    BUDGET_E2E_EXPECTED_TEST_COUNT: '1',
    BUDGET_E2E_EVIDENCE_ISSUE: '3998',
    BUDGET_E2E_FRESHNESS_RECEIPT: envVar('IOS_3998_FRESHNESS_RECEIPT'),
    BUDGET_E2E_CLEANUP_RECEIPT: envVar('IOS_3998_CLEANUP_RECEIPT'),
    RESULT_BUNDLE: envVar('BUDGET_E2E_RESULT_BUNDLE'),
    XCODEBUILD_LOG: envVar('BUDGET_E2E_XCODEBUILD_LOG'),
    TEST_PRODUCTS: envVar('DEBT_CARD_TEST_PRODUCTS'),
    SKIP_BUILD: '1',
    SIMULATOR_BOOT_TIMEOUT_SECONDS: '180',
    RECORD_VIDEO: expr(`${ciEventCondition('pullRequestIntoMain')} && '1' || '0'`),
    RAW_VIDEO: envVar('BUDGET_E2E_RAW_VIDEO'),
    COMPRESSED_VIDEO: envVar('BUDGET_E2E_COMPRESSED_VIDEO'),
    VIDEO_LOG: envVar('BUDGET_E2E_VIDEO_LOG'),
    UI_TEST_API_BASE_URL: envVar('TEST_RUNNER_UI_TEST_API_BASE_URL'),
    EXPECTED_SERVER_BUILD_SHA: EXACT_HEAD,
    GH_TOKEN: github('token'),
  },
  command: 'bash scripts/ios-test-budget-e2e.sh',
});

const removeDebtCardProducts = typedStep({
  name: 'Remove local debt-card test products',
  doc: {
    purpose: 'Removes the focused debt-card products from this runner now that the cache holds them.',
    recovery: 'none; a leftover copy is reclaimed by the next run on this Mac',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() && inputs.test_scope == 'debt-card-evidence'"),
  env: { CACHE_DIR: prepareResultPaths.outputs.debt_card_cache_dir },
  command: 'node ci/src/actions/ios/removeDebtCardTestProducts.ts',
});

const verifyReleaseArchiveBoundary = typedStep({
  id: 'debt-card-release-archive',
  name: 'Verify Issue 3999 Release archive boundary',
  doc: {
    purpose: 'Archives the app in Release to prove the card rewards boundary holds outside a debug build.',
    recovery: 'read the archive log; a Release-only compile or optimisation failure is an ordinary bug',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() && !cancelled() "
    + "&& inputs.test_scope == 'debt-card-evidence'"),
  timeoutMinutes: 25,
  env: {
    CARD_REWARDS_ARCHIVE_RUN_DIR: concat(envVar('ONBOARDING_E2E_RUN_DIR'), '/release-archive'),
    CARD_REWARDS_ARCHIVE_EVIDENCE: envVar('IOS_3999_ARCHIVE_EVIDENCE'),
    DERIVED_DATA: concat(envVar('ONBOARDING_E2E_RUN_DIR'), '/ArchiveDerivedData'),
    SOURCE_PACKAGES: concat(envVar('ONBOARDING_E2E_RUN_DIR'), '/SourcePackages'),
    PACKAGE_CACHE: concat(envVar('ONBOARDING_E2E_RUN_DIR'), '/PackageCache'),
    EXPECTED_HEAD_SHA: EXACT_HEAD,
  },
  command: 'bash scripts/verify-card-rewards-release-archive.sh',
});

const retainFreshnessEvidence = typedStep({
  name: 'Retain Issue 3998 freshness evidence',
  doc: {
    purpose: 'Writes the debt freshness receipts into the job summary, where the issue can cite them.',
    recovery: 'none; the receipts are already on the runner and the artifacts carry them too',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() && !cancelled() "
    + "&& inputs.test_scope == 'debt-card-evidence' "
    + "&& steps.debt-card-backend-evidence.outcome == 'success'"),
  env: {
    IOS_EVIDENCE_RETENTION: 'issue-3998-freshness',
    IOS_3998_FRESHNESS_RECEIPT: envVar('IOS_3998_FRESHNESS_RECEIPT'),
    IOS_3998_CLEANUP_RECEIPT: envVar('IOS_3998_CLEANUP_RECEIPT'),
    BUDGET_E2E_XCODEBUILD_LOG: envVar('BUDGET_E2E_XCODEBUILD_LOG'),
    BUDGET_E2E_RESULT_BUNDLE: envVar('BUDGET_E2E_RESULT_BUNDLE'),
  },
  command: 'node ci/src/actions/ios/retainIosE2eEvidence.ts',
});

const retainReleaseArchiveEvidence = typedStep({
  name: 'Retain Issue 3999 Release archive evidence',
  doc: {
    purpose: 'Writes the Release archive receipt into the job summary, where the issue can cite it.',
    recovery: 'none; the receipt is already on the runner',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() && !cancelled() "
    + "&& inputs.test_scope == 'debt-card-evidence' "
    + "&& steps.debt-card-release-archive.outcome == 'success'"),
  env: {
    IOS_EVIDENCE_RETENTION: 'issue-3999-release-archive',
    IOS_3999_ARCHIVE_EVIDENCE: envVar('IOS_3999_ARCHIVE_EVIDENCE'),
  },
  command: 'node ci/src/actions/ios/retainIosE2eEvidence.ts',
});

const validateDebtHistoryEvidence = typedStep({
  id: 'validate-ios-3996-evidence',
  name: 'Validate Issue 3996 automated debt-history acceptance',
  doc: {
    purpose: 'Checks the first Budget shard produced the debt-history acceptance evidence it is meant to.',
    recovery: 'read the evidence directory the step names; it lists what it expected and what it found',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && env.BUDGET_E2E_SHARD == 'a' && success() "
    + "&& needs.ios-change-gate.outputs.budget_required == 'true' "
    + "&& inputs.test_scope != 'debt-card-evidence'"),
  env: {
    IOS_3996_EVIDENCE_DIR: envVar('IOS_3996_EVIDENCE_DIR'),
    IOS_3996_CLEANUP_RECEIPT: envVar('IOS_3996_CLEANUP_RECEIPT'),
    IOS_3996_EVIDENCE_JSON: envVar('IOS_3996_EVIDENCE_JSON'),
    BUDGET_E2E_RESULT_BUNDLE: envVar('BUDGET_E2E_RESULT_BUNDLE'),
    BUDGET_E2E_XCODEBUILD_LOG: envVar('BUDGET_E2E_XCODEBUILD_LOG'),
    EXAMPLE_CI_EXACT_HEAD_SHA: envVar('EXAMPLE_CI_EXACT_HEAD_SHA'),
  },
  command: 'node ci/src/actions/ios/validateIssue3996Evidence.ts',
});

// ---------------------------------------------------------------------------
// Hand the evidence back, whatever the lane did with it.
// ---------------------------------------------------------------------------

const uploadOnboardingVideo = typedStep({
  name: 'Upload raw onboarding video for non-gating review',
  doc: {
    purpose: 'Publishes a failed onboarding recording for non-gating diagnosis.',
    recovery: 'none; the recording is advisory and the lane result does not depend on it',
  },
  owner: 'review',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'onboarding' && always() "
    + "&& (needs.ios-change-gate.outputs.production_promotion == 'true' "
    + "|| (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')) "
    + "&& steps.onboarding-e2e.outcome == 'failure'"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('onboarding-e2e-raw-video-', github('run_id'), '-', github('run_attempt')),
    path: concat(
      envVar('ONBOARDING_E2E_RAW_VIDEO'), '\n',
      envVar('ONBOARDING_E2E_XCODEBUILD_LOG'), '\n',
    ),
    'compression-level': 0,
    'if-no-files-found': 'warn',
    'retention-days': 7,
  },
});

const prepareBackendDiagnostics = typedStep({
  name: 'Prepare redaction-safe backend diagnostics',
  doc: {
    purpose: 'Copies the backend logs into a redacted directory the diagnostics artifacts can carry.',
    recovery: 'none; a missing log means the backend never started and the earlier step said so',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr("always() && env.ONBOARDING_E2E_RUN_DIR != ''"),
  env: {
    BACKEND_DIAGNOSTICS_DIR: envVar('BACKEND_DIAGNOSTICS_DIR'),
    ONBOARDING_DEV_BACKEND_LOG: envVar('ONBOARDING_DEV_BACKEND_LOG'),
    ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG: envVar('ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG'),
  },
  command: 'node ci/src/actions/ios/prepareBackendDiagnostics.ts',
});

const summarizeOnboardingFailures = typedStep({
  name: 'Summarize onboarding E2E failures',
  doc: {
    purpose: 'Turns the onboarding result bundle into the failure lines a person reads on a red check.',
    recovery: 'none; an empty summary means the test never produced a result bundle',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'onboarding' && always() "
    + "&& needs.ios-change-gate.outputs.onboarding_required == 'true' "
    + "&& steps.onboarding-e2e.outcome != 'skipped'"),
  env: {
    IOS_FAILURE_SUMMARY_LANE: 'onboarding',
    ONBOARDING_E2E_RESULT_BUNDLE: envVar('ONBOARDING_E2E_RESULT_BUNDLE'),
    ONBOARDING_E2E_XCODEBUILD_LOG: envVar('ONBOARDING_E2E_XCODEBUILD_LOG'),
  },
  command: 'node ci/src/actions/ios/summarizeIosE2eFailures.ts',
});

const summarizeBudgetFailures = typedStep({
  name: 'Summarize Budget E2E failures',
  doc: {
    purpose: 'Turns the Budget result bundle into the failure lines a person reads on a red check.',
    recovery: 'none; an empty summary means the test never produced a result bundle',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() "
    + "&& needs.ios-change-gate.outputs.budget_required == 'true'"),
  env: {
    IOS_FAILURE_SUMMARY_LANE: 'budget',
    BUDGET_E2E_RESULT_BUNDLE: envVar('BUDGET_E2E_RESULT_BUNDLE'),
    BUDGET_E2E_XCODEBUILD_LOG: envVar('BUDGET_E2E_XCODEBUILD_LOG'),
  },
  command: 'node ci/src/actions/ios/summarizeIosE2eFailures.ts',
});

const summarizeChatPlaidFailures = typedStep({
  name: 'Summarize Chat Plaid E2E failures',
  doc: {
    purpose: 'Turns the Chat Plaid result bundle into the failure lines a person reads on a red check.',
    recovery: 'none; an empty summary means the test never produced a result bundle',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && always()"),
  env: {
    IOS_FAILURE_SUMMARY_LANE: 'chat-plaid',
    CHAT_PLAID_E2E_RESULT_BUNDLE: envVar('CHAT_PLAID_E2E_RESULT_BUNDLE'),
    CHAT_PLAID_E2E_XCODEBUILD_LOG: envVar('CHAT_PLAID_E2E_XCODEBUILD_LOG'),
  },
  command: 'node ci/src/actions/ios/summarizeIosE2eFailures.ts',
});

const exportChatPlaidScreenshots = typedStep({
  name: 'Export Chat Plaid E2E screenshots',
  doc: {
    purpose: 'Extracts the chat journey screenshots from the result bundle so the artifact can carry them.',
    recovery: 'none; no screenshots means the journey never reached a screen worth capturing',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && always()"),
  env: {
    CHAT_PLAID_E2E_RESULT_BUNDLE: envVar('CHAT_PLAID_E2E_RESULT_BUNDLE'),
    CHAT_PLAID_E2E_EVIDENCE_DIR: envVar('CHAT_PLAID_E2E_EVIDENCE_DIR'),
  },
  command: 'node ci/src/actions/ios/exportChatPlaidScreenshots.ts',
});

const exportCompactSummaries = typedStep({
  id: 'export-compact-summaries',
  name: 'Export compact XCTest summaries',
  doc: {
    purpose: 'Reduces whichever result bundles this lane produced to the compact summaries the UI reads.',
    recovery: 'read the bundle path the step names; a corrupt bundle is a simulator or disk failure',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  if: expr("always() && env.ONBOARDING_E2E_RUN_DIR != ''"),
  env: {
    ONBOARDING_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    ONBOARDING_E2E_RESULT_BUNDLE: envVar('ONBOARDING_E2E_RESULT_BUNDLE'),
    CHAT_PLAID_E2E_RESULT_BUNDLE: envVar('CHAT_PLAID_E2E_RESULT_BUNDLE'),
    INCOME_E2E_RESULT_BUNDLE: envVar('INCOME_E2E_RESULT_BUNDLE'),
    BUDGET_E2E_RESULT_BUNDLE: envVar('BUDGET_E2E_RESULT_BUNDLE'),
  },
  command: 'node ci/src/actions/ios/exportCompactXctestSummaries.ts',
});

const uploadIncomeEvidence = typedStep({
  id: 'upload-income-evidence',
  name: 'Upload Income E2E evidence',
  doc: {
    purpose: 'Publishes the Income summary, result bundle, recording and database snapshot logs.',
    recovery: 'none; the retention step below writes the same evidence into the job summary',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'income' && always() "
    + "&& (steps.income-e2e.outcome == 'failure' "
    + "|| failure() "
    + "|| (steps.income-e2e.outcome == 'skipped' && failure()))"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('income-e2e-evidence-', github('run_id'), '-', github('run_attempt')),
    'retention-days': 3,
    path: concat(
      envVar('ONBOARDING_E2E_RUN_DIR'), '/income-e2e-summary.json\n',
      envVar('INCOME_E2E_RUN_DIR'), '/evidence-summary.json\n',
      envVar('INCOME_E2E_RESULT_BUNDLE'), '\n',
      envVar('INCOME_E2E_XCODEBUILD_LOG'), '\n',
      envVar('INCOME_E2E_COMPRESSED_VIDEO'), '\n',
      envVar('INCOME_E2E_DB_PROXY_LOG'), '\n',
      envVar('INCOME_E2E_PROVIDER_AUDIT_LOG'), '\n',
    ),
    'if-no-files-found': 'error',
  },
});

const retainIncomeEvidence = typedStep({
  name: 'Retain Income E2E evidence in job summary',
  doc: {
    purpose: 'Writes the Income evidence into the job summary when the artifact upload could not run.',
    recovery: 'none; this is already the fallback for a failed upload',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr("env.E2E_LANE == 'income' && always() "
    + "&& steps.upload-income-evidence.outcome == 'failure'"),
  env: {
    IOS_EVIDENCE_RETENTION: 'income-evidence',
    ONBOARDING_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    INCOME_E2E_RUN_DIR: envVar('INCOME_E2E_RUN_DIR'),
    INCOME_E2E_XCODEBUILD_LOG: envVar('INCOME_E2E_XCODEBUILD_LOG'),
    INCOME_E2E_COMPRESSED_VIDEO: envVar('INCOME_E2E_COMPRESSED_VIDEO'),
    INCOME_E2E_DB_PROXY_LOG: envVar('INCOME_E2E_DB_PROXY_LOG'),
    INCOME_E2E_PROVIDER_AUDIT_LOG: envVar('INCOME_E2E_PROVIDER_AUDIT_LOG'),
  },
  command: 'node ci/src/actions/ios/retainIosE2eEvidence.ts',
});

const uploadChatPlaidEvidence = typedStep({
  id: 'upload-chat-plaid-evidence',
  name: 'Upload Chat Plaid E2E evidence',
  doc: {
    purpose: 'Publishes the Chat Plaid summary, build log and the screenshots exported from the bundle.',
    recovery: 'none; the retention step below writes the same evidence into the job summary',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && always() "
    + "&& (steps.chat-plaid-e2e.outcome == 'failure' "
    + "|| failure() "
    + "|| steps.validate-chat-plaid-evidence.outcome == 'failure')"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('chat-plaid-e2e-evidence-', github('run_id'), '-', github('run_attempt')),
    'retention-days': 3,
    path: concat(
      envVar('ONBOARDING_E2E_RUN_DIR'), '/chat-plaid-summary.json\n',
      envVar('ONBOARDING_E2E_RUN_DIR'), '/chat-plaid-xcodebuild.log\n',
      envVar('ONBOARDING_E2E_RUN_DIR'), '/chat-plaid-evidence\n',
    ),
    'if-no-files-found': 'error',
  },
});

const retainChatPlaidEvidence = typedStep({
  name: 'Retain Chat Plaid E2E evidence in job summary',
  doc: {
    purpose: 'Writes the Chat Plaid evidence into the job summary when the artifact upload could not run.',
    recovery: 'none; this is already the fallback for a failed upload',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && always() "
    + "&& steps.upload-chat-plaid-evidence.outcome == 'failure'"),
  env: {
    IOS_EVIDENCE_RETENTION: 'chat-plaid-evidence',
    ONBOARDING_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    CHAT_PLAID_E2E_XCODEBUILD_LOG: envVar('CHAT_PLAID_E2E_XCODEBUILD_LOG'),
    CHAT_PLAID_E2E_EVIDENCE_DIR: envVar('CHAT_PLAID_E2E_EVIDENCE_DIR'),
  },
  command: 'node ci/src/actions/ios/retainIosE2eEvidence.ts',
});

const uploadChatPlaidDiagnostics = typedStep({
  id: 'upload-chat-plaid-diagnostics',
  name: 'Upload Chat Plaid E2E diagnostics',
  doc: {
    purpose: 'Publishes the raw bundle and backend logs when any part of the Chat Plaid lane failed.',
    recovery: 'none; the retention step below keeps the same files on the runner',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && always() "
    + "&& (steps.chat-plaid-e2e.outcome == 'failure' "
    + "|| failure() "
    + "|| steps.validate-chat-plaid-evidence.outcome == 'failure' "
    + "|| steps.export-compact-summaries.outcome == 'failure' "
    + "|| (steps.chat-plaid-e2e.outcome == 'skipped' && failure()))"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('chat-plaid-e2e-diagnostics-', github('run_id'), '-', github('run_attempt')),
    'compression-level': 0,
    'retention-days': 1,
    path: concat(
      envVar('CHAT_PLAID_E2E_RESULT_BUNDLE'), '\n',
      envVar('CHAT_PLAID_E2E_XCODEBUILD_LOG'), '\n',
      envVar('BACKEND_DIAGNOSTICS_DIR'), '/devserver.log\n',
      envVar('BACKEND_DIAGNOSTICS_DIR'), '/devserver-supervisor.log\n',
    ),
    'if-no-files-found': 'ignore',
  },
});

const retainChatPlaidDiagnostics = typedStep({
  name: 'Retain Chat Plaid E2E diagnostics on runner',
  doc: {
    purpose: 'Keeps the Chat Plaid diagnostics on this runner when the artifact upload could not run.',
    recovery: 'none; this is already the fallback for a failed upload',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr("env.E2E_LANE == 'chat-plaid' && always() "
    + "&& steps.upload-chat-plaid-diagnostics.outcome == 'failure'"),
  env: {
    IOS_EVIDENCE_RETENTION: 'chat-plaid-diagnostics',
    CHAT_PLAID_E2E_RESULT_BUNDLE: envVar('CHAT_PLAID_E2E_RESULT_BUNDLE'),
    CHAT_PLAID_E2E_XCODEBUILD_LOG: envVar('CHAT_PLAID_E2E_XCODEBUILD_LOG'),
    BACKEND_DIAGNOSTICS_DIR: envVar('BACKEND_DIAGNOSTICS_DIR'),
  },
  command: 'node ci/src/actions/ios/retainIosE2eEvidence.ts',
});

const uploadOnboardingEvidence = typedStep({
  id: 'upload-full-onboarding-evidence',
  name: 'Upload FullOnboarding E2E evidence',
  doc: {
    purpose: 'Publishes the onboarding summary, bundle, proxy events and the account cleanup receipt.',
    recovery: 'none; the retention step below writes the same evidence into the job summary',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'onboarding' && always() "
    + "&& needs.ios-change-gate.outputs.onboarding_required == 'true' "
    + "&& (steps.onboarding-e2e.outcome == 'failure' "
    + "|| failure() "
    + "|| steps.validate-onboarding-lifecycle.outcome == 'failure')"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('full-onboarding-e2e-evidence-', github('run_id'), '-', github('run_attempt')),
    'retention-days': 3,
    path: concat(
      envVar('ONBOARDING_E2E_RUN_DIR'), '/onboarding-summary.json\n',
      envVar('ONBOARDING_E2E_XCODEBUILD_LOG'), '\n',
      envVar('ONBOARDING_E2E_RESULT_BUNDLE'), '\n',
      envVar('DASHBOARD_OFFLINE_PROXY_EVENTS'), '\n',
      envVar('DASHBOARD_OFFLINE_PROXY_LOG'), '\n',
      envVar('DASHBOARD_OFFLINE_EVIDENCE_JSON'), '\n',
      envVar('DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE'), '\n',
    ),
    'if-no-files-found': 'error',
  },
});

const retainOnboardingEvidence = typedStep({
  name: 'Retain FullOnboarding E2E evidence in job summary',
  doc: {
    purpose: 'Writes the onboarding evidence into the job summary when the artifact upload could not run.',
    recovery: 'none; this is already the fallback for a failed upload',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'onboarding' && always() "
    + "&& steps.upload-full-onboarding-evidence.outcome == 'failure'"),
  env: {
    IOS_EVIDENCE_RETENTION: 'full-onboarding-evidence',
    ONBOARDING_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    ONBOARDING_E2E_XCODEBUILD_LOG: envVar('ONBOARDING_E2E_XCODEBUILD_LOG'),
    ONBOARDING_E2E_RESULT_BUNDLE: envVar('ONBOARDING_E2E_RESULT_BUNDLE'),
    DASHBOARD_OFFLINE_PROXY_EVENTS: envVar('DASHBOARD_OFFLINE_PROXY_EVENTS'),
    DASHBOARD_OFFLINE_PROXY_LOG: envVar('DASHBOARD_OFFLINE_PROXY_LOG'),
    DASHBOARD_OFFLINE_EVIDENCE_JSON: envVar('DASHBOARD_OFFLINE_EVIDENCE_JSON'),
    DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE: envVar('DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE'),
  },
  command: 'node ci/src/actions/ios/retainIosE2eEvidence.ts',
});

const uploadOnboardingDiagnostics = typedStep({
  id: 'upload-full-onboarding-diagnostics',
  name: 'Upload onboarding E2E diagnostics',
  doc: {
    purpose: 'Publishes the raw bundle, backend logs and proxy events when the onboarding lane failed.',
    recovery: 'none; the retention step below keeps the same files on the runner',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'onboarding' && always() "
    + "&& (steps.onboarding-e2e.outcome == 'failure' "
    + "|| failure() "
    + "|| steps.validate-onboarding-lifecycle.outcome == 'failure' "
    + "|| steps.export-compact-summaries.outcome == 'failure' "
    + "|| (steps.onboarding-e2e.outcome == 'skipped' && failure()))"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('onboarding-e2e-diagnostics-', github('run_id'), '-', github('run_attempt')),
    'compression-level': 0,
    'retention-days': 1,
    path: concat(
      envVar('ONBOARDING_E2E_RESULT_BUNDLE'), '\n',
      envVar('ONBOARDING_E2E_XCODEBUILD_LOG'), '\n',
      envVar('BACKEND_DIAGNOSTICS_DIR'), '/devserver.log\n',
      envVar('BACKEND_DIAGNOSTICS_DIR'), '/devserver-supervisor.log\n',
      envVar('DASHBOARD_OFFLINE_PROXY_EVENTS'), '\n',
      envVar('DASHBOARD_OFFLINE_PROXY_LOG'), '\n',
      envVar('DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE'), '\n',
    ),
    'if-no-files-found': 'ignore',
  },
});

const retainOnboardingDiagnostics = typedStep({
  name: 'Retain FullOnboarding E2E diagnostics on runner',
  doc: {
    purpose: 'Keeps the onboarding diagnostics on this runner when the artifact upload could not run.',
    recovery: 'none; this is already the fallback for a failed upload',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr("env.E2E_LANE == 'onboarding' && always() "
    + "&& steps.upload-full-onboarding-diagnostics.outcome == 'failure'"),
  env: {
    IOS_EVIDENCE_RETENTION: 'full-onboarding-diagnostics',
    ONBOARDING_E2E_RESULT_BUNDLE: envVar('ONBOARDING_E2E_RESULT_BUNDLE'),
    ONBOARDING_E2E_XCODEBUILD_LOG: envVar('ONBOARDING_E2E_XCODEBUILD_LOG'),
    BACKEND_DIAGNOSTICS_DIR: envVar('BACKEND_DIAGNOSTICS_DIR'),
    DASHBOARD_OFFLINE_PROXY_EVENTS: envVar('DASHBOARD_OFFLINE_PROXY_EVENTS'),
    DASHBOARD_OFFLINE_PROXY_LOG: envVar('DASHBOARD_OFFLINE_PROXY_LOG'),
    DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE: envVar('DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE'),
  },
  command: 'node ci/src/actions/ios/retainIosE2eEvidence.ts',
});

const uploadBudgetEvidence = typedStep({
  id: 'upload-budget-e2e-evidence',
  name: 'Upload Budget E2E evidence',
  doc: {
    purpose: 'Publishes this shard of the Budget summary, recording and debt-history acceptance evidence.',
    recovery: 'none; the retention step below writes the same evidence into the job summary',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() "
    + "&& needs.ios-change-gate.outputs.budget_required == 'true' "
    + "&& (steps.budget-e2e.outcome == 'failure' "
    + "|| failure() "
    + "|| steps.validate-ios-3996-evidence.outcome == 'failure' "
    + "|| steps.export-compact-summaries.outcome == 'failure')"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat(
      'budget-e2e-evidence-', github('run_id'), '-', github('run_attempt'),
      envVar('BUDGET_E2E_ARTIFACT_SUFFIX'),
    ),
    'retention-days': 3,
    path: concat(
      envVar('ONBOARDING_E2E_RUN_DIR'), '/budget-e2e-summary.json\n',
      envVar('BUDGET_E2E_XCODEBUILD_LOG'), '\n',
      envVar('BUDGET_E2E_COMPRESSED_VIDEO'), '\n',
      envVar('BUDGET_E2E_RAW_VIDEO'), '\n',
      envVar('BUDGET_E2E_VIDEO_LOG'), '\n',
      envVar('IOS_3996_EVIDENCE_DIR'), '\n',
      envVar('IOS_3996_CLEANUP_RECEIPT'), '\n',
    ),
    'if-no-files-found': 'error',
  },
});

const retainBudgetEvidence = typedStep({
  name: 'Retain Budget E2E evidence in job summary',
  doc: {
    purpose: 'Writes the Budget evidence into the job summary when the artifact upload could not run.',
    recovery: 'none; this is already the fallback for a failed upload',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() "
    + "&& steps.upload-budget-e2e-evidence.outcome == 'failure'"),
  env: {
    IOS_EVIDENCE_RETENTION: 'budget-evidence',
    ONBOARDING_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    BUDGET_E2E_XCODEBUILD_LOG: envVar('BUDGET_E2E_XCODEBUILD_LOG'),
    BUDGET_E2E_COMPRESSED_VIDEO: envVar('BUDGET_E2E_COMPRESSED_VIDEO'),
    BUDGET_E2E_RAW_VIDEO: envVar('BUDGET_E2E_RAW_VIDEO'),
    BUDGET_E2E_VIDEO_LOG: envVar('BUDGET_E2E_VIDEO_LOG'),
    IOS_3996_EVIDENCE_DIR: envVar('IOS_3996_EVIDENCE_DIR'),
    IOS_3996_CLEANUP_RECEIPT: envVar('IOS_3996_CLEANUP_RECEIPT'),
  },
  command: 'node ci/src/actions/ios/retainIosE2eEvidence.ts',
});

const uploadBudgetDiagnostics = typedStep({
  id: 'upload-budget-e2e-diagnostics',
  name: 'Upload Budget E2E diagnostics',
  doc: {
    purpose: 'Publishes the raw bundle, shard logs and backend logs when any part of this shard failed.',
    recovery: 'none; the retention step below keeps the same files on the runner',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() "
    + "&& (steps.budget-e2e.outcome == 'failure' "
    + "|| failure() "
    + "|| steps.validate-ios-3996-evidence.outcome == 'failure' "
    + "|| steps.export-compact-summaries.outcome == 'failure' "
    + "|| (steps.budget-e2e.outcome == 'skipped' && failure()))"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat(
      'budget-e2e-diagnostics-', github('run_id'), '-', github('run_attempt'),
      envVar('BUDGET_E2E_ARTIFACT_SUFFIX'),
    ),
    'compression-level': 0,
    'retention-days': 1,
    path: concat(
      envVar('BUDGET_E2E_RESULT_BUNDLE'), '\n',
      envVar('BUDGET_E2E_XCODEBUILD_LOG'), '\n',
      envVar('ONBOARDING_E2E_RUN_DIR'), '/shards\n',
      envVar('BACKEND_DIAGNOSTICS_DIR'), '/devserver.log\n',
      envVar('BACKEND_DIAGNOSTICS_DIR'), '/devserver-supervisor.log\n',
      envVar('BUDGET_E2E_RAW_VIDEO'), '\n',
      envVar('BUDGET_E2E_VIDEO_LOG'), '\n',
      envVar('IOS_3996_EVIDENCE_DIR'), '\n',
      envVar('IOS_3996_CLEANUP_RECEIPT'), '\n',
    ),
    'if-no-files-found': 'ignore',
  },
});

const retainBudgetDiagnostics = typedStep({
  name: 'Retain Budget E2E diagnostics on runner',
  doc: {
    purpose: 'Keeps the Budget diagnostics on this runner when the artifact upload could not run.',
    recovery: 'none; this is already the fallback for a failed upload',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr("env.E2E_LANE == 'budget' && always() "
    + "&& steps.upload-budget-e2e-diagnostics.outcome == 'failure'"),
  env: {
    IOS_EVIDENCE_RETENTION: 'budget-diagnostics',
    BUDGET_E2E_RESULT_BUNDLE: envVar('BUDGET_E2E_RESULT_BUNDLE'),
    BUDGET_E2E_XCODEBUILD_LOG: envVar('BUDGET_E2E_XCODEBUILD_LOG'),
    ONBOARDING_E2E_RUN_DIR: envVar('ONBOARDING_E2E_RUN_DIR'),
    BACKEND_DIAGNOSTICS_DIR: envVar('BACKEND_DIAGNOSTICS_DIR'),
    BUDGET_E2E_RAW_VIDEO: envVar('BUDGET_E2E_RAW_VIDEO'),
    BUDGET_E2E_VIDEO_LOG: envVar('BUDGET_E2E_VIDEO_LOG'),
    IOS_3996_EVIDENCE_DIR: envVar('IOS_3996_EVIDENCE_DIR'),
    IOS_3996_CLEANUP_RECEIPT: envVar('IOS_3996_CLEANUP_RECEIPT'),
  },
  command: 'node ci/src/actions/ios/retainIosE2eEvidence.ts',
});

// ---------------------------------------------------------------------------
// Leave the Mac as this lane found it.
// ---------------------------------------------------------------------------

const removeProvisionedSimulator = typedStep({
  name: 'Remove provisioned onboarding simulator',
  doc: {
    purpose: 'Deletes the simulator this lane provisioned so the next lane does not inherit its data.',
    recovery: 'none; an orphaned device is reclaimed by the next run on this Mac',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr("always() && steps.sim.outputs.provisioned_udid != ''"),
  env: {
    IOS_RUNNER_CURRENT_SIMULATOR_PURPOSE: expr(
      "inputs.test_scope == 'debt-card-evidence' && 'Backend Evidence' || 'Onboarding'",
    ),
    IOS_RUNNER_CURRENT_SIMULATOR_UDID: selectSimulator.outputs.provisioned_udid,
    IOS_RUNNER_RECLAIM_CI_SIMULATORS: '1',
  },
  command: 'bash scripts/reclaim-ios-runner-disk.sh simulator',
});

const stopBackendSupervisor = typedStep({
  name: 'Stop onboarding dev backend supervisor',
  doc: {
    purpose: 'Stops the lane backend and its supervisor so the port is free for the next run.',
    recovery: 'none; a surviving backend is stopped by the next run that claims this port',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr('always()'),
  env: {
    ONBOARDING_DEV_BACKEND_PORT: envVar('ONBOARDING_DEV_BACKEND_PORT'),
    ONBOARDING_DEV_BACKEND_WORKSPACE: github('workspace'),
  },
  command: 'bash scripts/stop-onboarding-dev-backend.sh',
});

const removeIsolatedCloudSdkState = typedStep({
  name: 'Remove isolated Google Cloud SDK state',
  doc: {
    purpose: 'Removes the gcloud configuration this lane created, along with the credentials in it.',
    recovery: 'none; a surviving configuration is overwritten by the next lane on this Mac',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr('always()'),
  command: 'node .ci/trusted-ios-revision-guard/ci/src/actions/ios/removeIsolatedCloudSdkState.ts',
});

const pruneBuildCache = typedStep({
  name: 'Prune bounded real-server build cache',
  doc: {
    purpose: 'Returns the persistent derived-data cache to its bound now this lane has finished with it.',
    recovery: 'none; the next run prepares the cache again and reclaims what is left',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr("always() && env.IOS_CI_BUILD_CACHE_ENTRY != ''"),
  command: 'bash scripts/manage-ios-build-cache.sh prune "$IOS_CI_CACHE_LANE"',
});

const removeCurrentRunnerArtifacts = typedStep({
  name: 'Remove current iOS runner artifacts',
  doc: {
    purpose: 'Removes the build artifacts this run made so the Mac returns to the pool with a free disk.',
    recovery: 'none; the next run reclaims whatever this one left behind',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr('always()'),
  command: 'bash scripts/reclaim-ios-runner-disk.sh current',
});

/**
 * The anchor itself, in the order the YAML declares it. Every lane runs every
 * step; `env.E2E_LANE` decides which ones do any work.
 */
export const realServerE2eSteps: readonly TypedStep<string>[] = [
  // shared.ts exports these as builders, not values: the anchored steps are
  // shared with test-ios-execution and each call site gets its own instance.
  exportSimulatorRunnerEnvironment(),
  resetOversizedDedicatedRunnerCheckout(),
  checkout,
  checkoutTrustedRevisionGuard,
  // setup-node only installs the interpreter; no exact-head program runs yet.
  setupNode('Set up the Node.js runtime'),
  verifyExactRevision,
  selectExactXcode,
  verifyToolchain,
  restoreTestProducts,
  downloadTestProductsFallback,
  reclaimRunnerDisk,
  ...installNodeDependencySteps(),
  installTypedCiDependencies('Install typed planner dependencies', 'ci'),
  // Unpacking the handoff runs after the reclaim step so the extraction has
  // the disk that step just freed, and after the typed layer is installed
  // because the decision it makes — reuse, rebuild, or fail — is a program.
  preparePrecompiledProducts,
  verifyIncomeProxyBinary,
  ensureIncomePsqlClient,
  boundBuildCache,
  rebuildTestProducts,
  exportLaunchPaths,
  prepareResultPaths,
  computeDebtCardBuildKey,
  restoreDebtCardProducts,
  validateDebtCardProducts,
  buildDebtCardProducts,
  saveDebtCardProducts,
  isolateCloudSdkState,
  configureCloudSdkPython,
  authenticateToGcp,
  setUpCloudSdk,
  loadRuntimeConfig,
  verifyDeployedSchema,
  allocateBackendPort,
  ensureLaneBackend,
  prepareChatPlaidUser,
  resetSimulatorHost,
  selectSimulator,
  ensureVideoReviewTooling,
  provisionOnboardingUsers,
  startDashboardOfflineProxy,
  runOnboardingE2e,
  stopDashboardOfflineProxy,
  deleteOnboardingUsers,
  validateOnboardingLifecycle,
  startIncomeProxy,
  runIncomeE2e,
  stopIncomeProxy,
  runChatPlaidE2e,
  validateChatPlaidEvidence,
  deleteChatPlaidUser,
  runBudgetE2e,
  runDebtFreshnessEvidence,
  removeDebtCardProducts,
  verifyReleaseArchiveBoundary,
  retainFreshnessEvidence,
  retainReleaseArchiveEvidence,
  validateDebtHistoryEvidence,
  uploadOnboardingVideo,
  prepareBackendDiagnostics,
  summarizeOnboardingFailures,
  summarizeBudgetFailures,
  summarizeChatPlaidFailures,
  exportChatPlaidScreenshots,
  exportCompactSummaries,
  uploadIncomeEvidence,
  retainIncomeEvidence,
  uploadChatPlaidEvidence,
  retainChatPlaidEvidence,
  uploadChatPlaidDiagnostics,
  retainChatPlaidDiagnostics,
  uploadOnboardingEvidence,
  retainOnboardingEvidence,
  uploadOnboardingDiagnostics,
  retainOnboardingDiagnostics,
  uploadBudgetEvidence,
  retainBudgetEvidence,
  uploadBudgetDiagnostics,
  retainBudgetDiagnostics,
  removeProvisionedSimulator,
  stopBackendSupervisor,
  removeIsolatedCloudSdkState,
  pruneBuildCache,
  removeCurrentRunnerArtifacts,
];

import {
  ciEventField, concat, expr, github, typedJob, typedStep,
} from '../lib/index.ts';
import { pinnedIosXcodeToolchain } from '../../src/ios/toolchainPolicy.ts';
import type { TransportFailurePolicy } from '../../src/ios/testProductHandoff.ts';
import { confirmCurrentIosPr } from './confirm-current-ios-pr.ts';
import { e2eProductCacheKey, legacyE2eProductCacheKey } from './e2e-product-cache-key.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { prepareDevE2eSchema } from './prepare-dev-e2e-schema.ts';
import { DISPATCHED_FROM_TARGET_BRANCH, SAME_REPOSITORY_TARGET_BRANCH } from './real-server-e2e-steps.ts';
import {
  CACHE_RESTORE, CACHE_SAVE, CHECKOUT, UPLOAD_ARTIFACT, e2eMacLane, iosGateOutput, laneConcurrency,
  reviewedPrMacs, setupNode, typedLayerCheckout, TRUSTED_VERIFIER_SHA,
} from './shared.ts';

/**
 * Compile the E2E products once, for every real-server lane.
 *
 * Four lanes test four journeys against the same application binary, and
 * compiling it four times would cost four Macs an hour each before a single
 * test ran. This job is that compile: it claims one Mac, builds the products
 * at the exact head, and publishes them through the run cache with an
 * artifact fallback. Every lane below it restores that handoff and rebuilds
 * only when both transports are unavailable or its toolchain cannot run what
 * this one produced.
 *
 * The lanes are gated on this job's result rather than merely ordered after
 * it, so a failed build fails the lanes rather than leaving each of them to
 * repeat a compile failure on their own Macs. Once compilation succeeds,
 * transport outages may still fall through to their exact-head rebuild path.
 */

/** The head this job compiles, which is the one the pull request has. */
const EXACT_HEAD = ciEventField('headSha');

/**
 * A run's producer is not rerun when only a failed consumer job is retried.
 * Keep its cache key stable across run attempts while binding it to the exact
 * head and run ID, so a rerun can restore the already-passed producer's build.
 */
const HANDOFF_ARCHIVE = '.example-ci/handoff/example-ios-e2e.xctestproducts.zip';
const HANDOFF_KEY = e2eProductCacheKey(expr('env.ONBOARDING_E2E_COMMIT_SHA'), github('run_id'));
const REUSED_HANDOFF_KEY = e2eProductCacheKey(
  iosGateOutput('reused_e2e_head_sha'),
  iosGateOutput('reused_e2e_run_id'),
);
const LEGACY_REUSED_HANDOFF_KEY = legacyE2eProductCacheKey(
  iosGateOutput('reused_e2e_head_sha'),
  iosGateOutput('reused_e2e_run_id'),
  iosGateOutput('reused_e2e_run_attempt'),
);
const REUSE_REQUESTED = "needs.ios-change-gate.outputs.reuse_e2e_products == 'true'";
const REUSED_CACHE_MISSING = "steps.restore-reused-e2e-test-products.outputs.cache-hit != 'true' "
  + "&& steps.restore-legacy-reused-e2e-test-products.outputs.cache-hit != 'true'";
const BUILD_REQUIRED = "needs.ios-change-gate.outputs.reuse_e2e_products != 'true' "
  + `|| (${REUSED_CACHE_MISSING}) `
  + "|| steps.rebind-reused-e2e-test-products.outputs.rebuild_required == 'true'";

/**
 * Any selected real-server lane needs these products, and so does any of the
 * three dispatch scopes that run one. Budget is the exception: its lane is
 * behind a repository variable, so a Budget-only change builds nothing until
 * that variable is set.
 */
const ANY_LANE_SELECTED = 'needs.ios-change-gate.outputs.onboarding_required == \'true\' '
  + "|| needs.ios-change-gate.outputs.chat_plaid_required == 'true' "
  + "|| needs.ios-change-gate.outputs.income_required == 'true' "
  + "|| (needs.ios-change-gate.outputs.budget_required == 'true' && vars.IOS_ENABLE_BUDGET_E2E == 'true') "
  + "|| (github.event_name == 'workflow_dispatch' "
  + "&& (inputs.test_scope == 'e2e' || inputs.test_scope == 'evidence' "
  + "|| inputs.test_scope == 'debt-card-evidence'))";

const checkout = typedStep({
  name: 'Checkout exact E2E revision',
  doc: {
    purpose: 'Materialises the exact head under review, which is the revision these products are built from.',
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
    ref: expr('env.ONBOARDING_E2E_COMMIT_SHA'),
  },
});

/**
 * Ahead of the liveness guard, which is itself a typed program. The action
 * only provisions an interpreter; nothing from the revision under review runs
 * until the guard has admitted it.
 */
const checkoutTrustedRevisionGuard = typedLayerCheckout({
  name: 'Checkout typed iOS revision guard',
  path: '.ci/trusted-ios-revision-guard',
  ref: TRUSTED_VERIFIER_SHA,
});

const verifyExactRevision = typedStep({
  name: 'Verify exact E2E revision',
  doc: {
    purpose: 'Proves the checked-out head is the tuple the gate queued and the pull request still has.',
    recovery: 'a moved or closed pull request is the expected answer; rerun only if the API call failed',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  env: {
    GH_TOKEN: github('token'),
    EXACT_HEAD_SHA: expr('env.ONBOARDING_E2E_COMMIT_SHA'),
    EXAMPLE_CI_PR_NUMBER: iosGateOutput('pr_number'),
    EXAMPLE_CI_EXACT_HEAD_SHA: iosGateOutput('expected_head_sha'),
    EXAMPLE_CI_TRUSTED_BASE_SHA: iosGateOutput('expected_base_sha'),
    EXAMPLE_CI_GUARD_SHA: iosGateOutput('verifier_sha'),
    EXAMPLE_CI_TRUSTED_BASE_REF: iosGateOutput('expected_base_ref'),
  },
  // The guard comes from the gate-proven verifier, not the exact head: a head
  // that predates the script must still be checked, and the tuple it
  // checks against was captured from that same base.
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
    purpose: 'Confirms the Xcode, SDK and simulator runtime on this Mac are the ones this build needs.',
    recovery: 'read the mismatch the step prints and bring the runner image up to it',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: 'python3 scripts/ios-ci-image-prerequisites.py',
});

const prepareBuildCache = typedStep({
  name: 'Prepare shared E2E build cache',
  doc: {
    purpose: 'Claims the producer a bounded slice of the persistent derived-data cache on this Mac.',
    recovery: 'read the cache report; a full disk is the usual cause and the next run reclaims it',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  if: expr(BUILD_REQUIRED),
  env: {
    IOS_CI_CACHE_LANE: 'e2e-shared',
    IOS_CI_PACKAGE_RESOLVED: concat(
      github('workspace'),
      '/ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    ),
  },
  command: 'bash scripts/manage-ios-build-cache.sh prepare "$IOS_CI_CACHE_LANE"',
});

const buildTestProducts = typedStep({
  name: 'Build exact-head E2E products once',
  doc: {
    purpose: 'Compiles the application and E2E test bundles every real-server lane then runs unchanged.',
    recovery: 'read the xcodebuild log; this is an ordinary compile failure at the head under review',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  if: expr(BUILD_REQUIRED),
  env: {
    IOS_E2E_TEST_PLAN: 'CI-E2E',
    IOS_E2E_DERIVED_DATA: expr('env.IOS_CI_DERIVED_DATA'),
    IOS_SOURCE_PACKAGES_DIR: expr('env.IOS_CI_SOURCE_PACKAGES'),
  },
  command: 'bash scripts/build-ios-e2e-test-products.sh',
});

const packTestProducts = typedStep({
  name: 'Pack executable E2E products',
  doc: {
    purpose: 'Packs the built products into the one archive the lanes unpack and launch tests from.',
    recovery: 'read the paths the step prints; a missing one means the build above did not finish',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  if: expr(BUILD_REQUIRED),
  command: 'node ci/src/actions/ios/packE2eTestProducts.ts',
});

const restoreReusedTestProducts = typedStep({
  id: 'restore-reused-e2e-test-products',
  name: 'Restore content-identical predecessor E2E products',
  doc: {
    purpose: 'Restores the predecessor archive only after the trusted gate proved every typed iOS product input identical.',
    recovery: 'a cache miss falls through to an exact-head rebuild in this same job',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  if: expr(REUSE_REQUESTED),
  continueOnError: true,
  timeoutMinutes: 5,
  uses: CACHE_RESTORE,
  with: { path: HANDOFF_ARCHIVE, key: REUSED_HANDOFF_KEY },
});

const restoreLegacyReusedTestProducts = typedStep({
  id: 'restore-legacy-reused-e2e-test-products',
  name: 'Restore predecessor E2E products from legacy attempt cache',
  doc: {
    purpose: 'Reads an existing attempt-scoped cache only when the stable predecessor key missed.',
    recovery: 'a cache miss falls through to an exact-head rebuild in this same job',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  if: expr(`${REUSE_REQUESTED} && steps.restore-reused-e2e-test-products.outputs.cache-hit != 'true'`),
  continueOnError: true,
  timeoutMinutes: 5,
  uses: CACHE_RESTORE,
  with: { path: HANDOFF_ARCHIVE, key: LEGACY_REUSED_HANDOFF_KEY },
});

const rebindReusedTestProducts = typedStep({
  id: 'rebind-reused-e2e-test-products',
  name: 'Bind content-identical E2E products to this exact head',
  doc: {
    purpose: 'Verifies the predecessor archive and toolchain, then seals the unchanged products for the content-identical current head.',
    recovery: 'a missing or mismatched predecessor receipt fails closed before any current-head cache is published',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  outputs: ['rebuild_required'] as const,
  if: expr(`${REUSE_REQUESTED} && (steps.restore-reused-e2e-test-products.outputs.cache-hit == 'true' `
    + "|| steps.restore-legacy-reused-e2e-test-products.outputs.cache-hit == 'true')"),
  env: {
    IOS_E2E_REUSED_HEAD_SHA: iosGateOutput('reused_e2e_head_sha'),
    IOS_E2E_REUSED_RUN_ID: iosGateOutput('reused_e2e_run_id'),
    IOS_E2E_REUSED_RUN_ATTEMPT: iosGateOutput('reused_e2e_run_attempt'),
    ONBOARDING_E2E_COMMIT_SHA: expr('env.ONBOARDING_E2E_COMMIT_SHA'),
  },
  command: 'node ci/src/actions/ios/rebindE2eTestProducts.ts',
});

const saveTestProducts = typedStep({
  id: 'save-e2e-test-products-cache',
  name: 'Save exact-head E2E products',
  doc: {
    purpose: 'Publishes the archive to the run cache, which is how every lane takes delivery of it.',
    recovery: 'retry; a repeated failure is a GitHub cache service problem, not a change under review',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  continueOnError: true,
  uses: CACHE_SAVE,
  with: { path: HANDOFF_ARCHIVE, key: HANDOFF_KEY },
});

const verifyCachePublication = typedStep({
  id: 'verify-e2e-test-products-cache',
  name: 'Verify exact-head E2E cache publication',
  doc: {
    purpose: 'Looks the archive up again so a silent save failure fails here, not on every lane Mac.',
    recovery: 'rerun this job; the lanes cannot start until the handoff is readable',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  continueOnError: true,
  uses: CACHE_RESTORE,
  with: { path: HANDOFF_ARCHIVE, key: HANDOFF_KEY, 'lookup-only': true },
});

const uploadFallback = typedStep({
  id: 'upload-e2e-test-products-fallback',
  name: 'Upload exact-head E2E products fallback',
  doc: {
    purpose: 'Publishes the same archive as an artifact, for a lane whose runner missed the cache.',
    recovery: 'none; the cache save above is the handoff and this is only its fallback',
  },
  owner: 'product',
  category: 'evidence',
  unit: 'step',
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('ios-e2e-test-products-fallback-', github('run_id')),
    path: HANDOFF_ARCHIVE,
    'compression-level': 0,
    'include-hidden-files': true,
    'if-no-files-found': 'error',
    overwrite: true,
    'retention-days': 1,
  },
});

const verifyHandoff = typedStep({
  name: 'Verify E2E product handoff transport',
  doc: {
    purpose: 'Accepts the readable cache or artifact and lets exact-head consumers rebuild if both transports fail.',
    recovery: 'read the four transport outcomes; each consumer rebuilds from its checked-out exact head when necessary',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr('always() && !cancelled()'),
  env: {
    TRANSPORT_FAILURE_POLICY: 'consumer-rebuild' satisfies TransportFailurePolicy,
    CACHE_SAVE_OUTCOME: expr('steps.save-e2e-test-products-cache.outcome'),
    CACHE_LOOKUP_OUTCOME: expr('steps.verify-e2e-test-products-cache.outcome'),
    CACHE_HIT: expr('steps.verify-e2e-test-products-cache.outputs.cache-hit'),
    ARTIFACT_OUTCOME: expr('steps.upload-e2e-test-products-fallback.outcome'),
  },
  command: 'node ci/src/actions/ios/verifyTestProductHandoff.ts',
});

const removeHandoffArchive = typedStep({
  name: 'Remove E2E handoff archive',
  doc: {
    purpose: 'Removes the packed archive from this runner now both handoffs have been published.',
    recovery: 'none; a leftover archive is reclaimed by the next run on this Mac',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr('always()'),
  command: `rm -f "$GITHUB_WORKSPACE/${HANDOFF_ARCHIVE}"`,
});

export const buildIosE2eTestProducts = typedJob('build-ios-e2e-test-products', {
  name: 'Build shared iOS E2E test products',
  doc: {
    purpose: 'Compiles the E2E products once so four real-server lanes do not each compile their own.',
    successMeaning: 'Every selected real-server lane can start from a compiled exact-head build.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'suite',
  concurrency: laneConcurrency('e2e-products'),
  needs: [iosChangeGate, confirmCurrentIosPr, prepareDevE2eSchema],
  runsOn: reviewedPrMacs,
  permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read' },
  if: expr(
    'always() && !cancelled() '
    + "&& needs.confirm-current-ios-pr.outputs.current == 'true' "
    + "&& needs.ios-change-gate.outputs.should_run == 'true' "
    + "&& needs.prepare-dev-e2e-schema.result == 'success' "
    + `&& (${ANY_LANE_SELECTED}) `
    + `&& ((${SAME_REPOSITORY_TARGET_BRANCH}) || (${DISPATCHED_FROM_TARGET_BRANCH}))`,
  ),
  env: {
    ONBOARDING_E2E_COMMIT_SHA: EXACT_HEAD,
    IOS_E2E_TEST_PRODUCTS: concat(
      github('workspace'), '/.example-ci/e2e-test-products/example-ios-e2e.xctestproducts',
    ),
  },
  lane: e2eMacLane,
  steps: [
    checkout,
    setupNode('Set up the Node.js runtime'),
    checkoutTrustedRevisionGuard,
    verifyExactRevision,
    selectExactXcode,
    verifyToolchain,
    restoreReusedTestProducts,
    restoreLegacyReusedTestProducts,
    rebindReusedTestProducts,
    prepareBuildCache,
    buildTestProducts,
    packTestProducts,
    saveTestProducts,
    verifyCachePublication,
    uploadFallback,
    verifyHandoff,
    removeHandoffArchive,
  ],
});

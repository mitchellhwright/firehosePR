import {
  ciEventCondition, ciEventField, concat, expr, github, typedJob, typedStep,
} from '../lib/index.ts';
import { pinnedIosSimulatorRuntimeIdentifier, pinnedIosXcodeToolchain } from '../../src/ios/toolchainPolicy.ts';
import { confirmCurrentIosPr } from './confirm-current-ios-pr.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import {
  CHECKOUT, iosGateOutput, laneConcurrency, POOL_MAC_ONLY, reviewedPrMacs,
  routedNativeMacLane, setupNode, typedLayerCheckout, TRUSTED_VERIFIER_SHA,
} from './shared.ts';

const RELEASE_ARCHIVE_LANE = 'release-archive';

/**
 * Compile the application the way the store build does, before it is too late.
 *
 * Every other Mac lane builds for the simulator in Debug. Release turns on
 * optimisation and whole-module builds, so a change can pass every test here
 * and still fail the first Xcode Cloud archive after a promotion — at which
 * point the fix is a hotfix rather than a commit on a branch. This lane pays
 * one unsigned archive on the branch to keep that failure on the branch, and
 * it runs only for a pull request into develop or main, where a promotion is
 * actually the next step.
 */

const UPLOAD_ARTIFACT = 'actions/upload-artifact@v7.0.1';

/**
 * The revision to archive, written out rather than read from the workflow
 * environment: this lane checks the head it was queued for against the tuple
 * the gate captured, and a guard that reads both from the same variable
 * cannot tell them apart.
 */
const EXACT_HEAD = ciEventField('headSha');

/** The cache lane name the prepare and prune steps address the same entry by. */
const CACHE_LANE = RELEASE_ARCHIVE_LANE;

const checkoutExactReleaseArchiveRevision = typedStep({
  name: 'Checkout exact Release archive revision',
  doc: {
    purpose: 'Materialises the exact head revision the unsigned Release archive is compiled from.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: CHECKOUT,
  with: {
    // Deep enough for the guard below to place this head against its base,
    // and blobless so the depth costs history rather than file contents.
    'fetch-depth': 64,
    filter: 'blob:none',
    'persist-credentials': false,
    ref: EXACT_HEAD,
  },
});

/**
 * The guard program runs from the gate-proven verifier checkout, not the exact
 * head: a head that predates the typed admission owner must still be
 * checked, and the tuple it checks against was captured from that same base.
 */
const checkoutTrustedRevisionGuard = typedLayerCheckout({
  name: 'Checkout typed iOS revision guard',
  path: '.ci/trusted-ios-revision-guard',
  ref: TRUSTED_VERIFIER_SHA,
});

const verifyExactReleaseArchiveRevision = typedStep({
  name: 'Verify exact Release archive revision',
  doc: {
    purpose: 'Confirms this runner holds the head the gate captured before any Xcode time is spent.',
    recovery: 'a moved tuple is the expected answer, not a failure; rerun only if the API call itself failed',
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
  command: 'node ../.ci/trusted-ios-revision-guard/ci/src/actions/ios/verifyExactReleaseArchiveRevision.ts',
});

const selectExactXcode = typedStep({
  name: 'Select exact Xcode for Release archive',
  doc: {
    purpose: 'Pins the Xcode the archive is compiled with, so the toolchain is a decision and not whatever is installed.',
    recovery: 'install the pinned Xcode build on the runner; the step prints what it found instead',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: `node ../ci/src/actions/ios/selectXcode.ts ${pinnedIosXcodeToolchain}`,
});

const verifyImagePrerequisites = typedStep({
  name: 'Verify Release archive image prerequisites',
  doc: {
    purpose: 'Checks the runner carries the pinned Xcode and its iOS device SDK; the archive boots no simulator.',
    recovery: 'read the prerequisite the step names and install it on this runner',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  command: 'python3 ../scripts/ios-ci-image-prerequisites.py --purpose archive',
});

const reclaimStaleRunnerArtifacts = typedStep({
  name: 'Reclaim stale Release archive runner artifacts',
  doc: {
    purpose: 'Frees what earlier runs left on this Mac so the archive has the disk it needs.',
    recovery: 'read the free space the step reports; a runner still under the floor needs cleaning by hand',
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

const prepareBuildCache = typedStep({
  name: 'Prepare Release archive build cache',
  doc: {
    purpose: 'Restores the persistent derived-data entry this lane compiles against.',
    recovery: 'read the cache path the step prints; a missing entry only costs a cold build',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  env: {
    IOS_CI_CACHE_LANE: CACHE_LANE,
    IOS_CI_PACKAGE_RESOLVED: concat(
      github('workspace'),
      '/ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
    ),
  },
  command: 'bash ../scripts/manage-ios-build-cache.sh prepare "$IOS_CI_CACHE_LANE"',
});

const compileUnsignedReleaseArchive = typedStep({
  id: 'compile-release-archive',
  name: 'Compile unsigned Release archive',
  doc: {
    purpose: 'Archives the application in the Release configuration the store build uses, unsigned.',
    recovery: 'read the Xcode error; a failure only Release reproduces is application code, not the runner',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  env: { EXPECTED_HEAD_SHA: EXACT_HEAD },
  command: 'bash ../scripts/verify-ios-release-archive.sh',
});

const uploadDiagnostics = typedStep({
  id: 'upload-release-archive-diagnostics',
  name: 'Upload Release archive diagnostics',
  doc: {
    purpose: 'Publishes the xcodebuild log so a failed archive can be read without the runner.',
    recovery: 'the upload is advisory; the step below keeps the log on the runner when it fails',
  },
  owner: 'automation',
  category: 'evidence',
  unit: 'step',
  if: expr("always() && steps.compile-release-archive.outcome == 'failure'"),
  continueOnError: true,
  uses: UPLOAD_ARTIFACT,
  with: {
    name: concat('ios-release-archive-results-', github('run_id'), '-', github('run_attempt')),
    // One xcodebuild log: compressing it costs more runner time than it saves,
    // and a day is longer than anyone takes to read a failed archive.
    'compression-level': 0,
    'retention-days': 1,
    'if-no-files-found': 'error',
    path: expr('env.IOS_RELEASE_ARCHIVE_XCODEBUILD_LOG'),
  },
});

const retainDiagnosticsOnRunner = typedStep({
  name: 'Retain Release archive diagnostics on runner',
  doc: {
    purpose: 'Keeps the xcodebuild log on the runner when the artifact upload did not take it.',
    recovery: 'read the retained path the step prints and collect the log from that runner',
  },
  owner: 'infrastructure',
  category: 'evidence',
  unit: 'step',
  if: expr("always() && steps.upload-release-archive-diagnostics.outcome == 'failure'"),
  command: 'node ../ci/src/actions/ios/retainReleaseArchiveDiagnostics.ts',
});

const boundBuildCache = typedStep({
  name: 'Bound persistent Release archive build cache',
  doc: {
    purpose: 'Prunes the persistent build cache so this lane cannot grow until it fills the runner disk.',
    recovery: 'read the cache size the step reports; a stuck entry is removed on the runner',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  // Written as the workflow wrote it: the entry only exists once the prepare
  // step above has run, and `env` is not readable in a job-level condition.
  if: "${{ always() && env.IOS_CI_BUILD_CACHE_ENTRY != '' }}",
  env: { IOS_CI_CACHE_LANE: CACHE_LANE },
  command: 'bash ../scripts/manage-ios-build-cache.sh prune "$IOS_CI_CACHE_LANE"',
});

const removeCurrentRunnerArtifacts = typedStep({
  name: 'Remove current Release archive runner artifacts',
  doc: {
    purpose: 'Removes what this run left on the Mac so the next lane starts from a clean disk.',
    recovery: 'read the paths the step lists; a busy simulator may need resetting by hand',
  },
  owner: 'infrastructure',
  category: 'cleanup',
  unit: 'step',
  if: expr('always()'),
  command: 'bash ../scripts/reclaim-ios-runner-disk.sh current',
});

/**
 * When a Release archive is demanded of this run at all. A Release archive is
 * only worth a Mac when a promotion could follow it, which is a
 * same-repository pull request into develop or main, a develop queue
 * candidate, or a dispatch from one of those branches.
 */
const RELEASE_ARCHIVE_DEMANDED = 'always() && !cancelled() '
  + "&& needs.confirm-current-ios-pr.outputs.current == 'true' "
  + "&& needs.ios-change-gate.outputs.native_planned == 'true' "
  + "&& needs.ios-change-gate.outputs.native_release_archive_required == 'true' "
  + `&& ( ${ciEventCondition('reviewedChangeIntoTarget')} `
  + "|| (github.event_name == 'workflow_dispatch' "
  + "&& (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main')) )";

export const verifyIosReleaseArchive = typedJob('verify-ios-release-archive', {
  name: 'Verify unsigned Release archive',
  doc: {
    purpose: 'Proves the head under test still archives in Release before a promotion can depend on it.',
    successMeaning: 'The store configuration compiles at this head, so a promotion will not fail on it.',
  },
  owner: 'product',
  category: 'release',
  unit: 'suite',
  needs: [iosChangeGate, confirmCurrentIosPr],
  if: expr(RELEASE_ARCHIVE_DEMANDED),
  // GitHub assigns the archive to an eligible physical Mac.
  runsOn: reviewedPrMacs,
  concurrency: laneConcurrency('release-archive'),
  timeoutMinutes: 30,
  permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read' },
  defaults: { run: { workingDirectory: 'ios' } },
  lane: routedNativeMacLane,
  steps: [
    checkoutExactReleaseArchiveRevision,
    setupNode('Setup Node for the typed Release archive steps'),
    checkoutTrustedRevisionGuard,
    verifyExactReleaseArchiveRevision,
    selectExactXcode,
    verifyImagePrerequisites,
    reclaimStaleRunnerArtifacts,
    prepareBuildCache,
    compileUnsignedReleaseArchive,
    uploadDiagnostics,
    retainDiagnosticsOnRunner,
    boundBuildCache,
    removeCurrentRunnerArtifacts,
  ],
});

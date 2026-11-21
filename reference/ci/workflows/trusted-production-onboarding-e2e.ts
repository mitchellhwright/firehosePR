import {
  concat, expr, github, needsOutput, secret, trustedControlLinuxRunner, typedJob, typedStep,
  typedWorkflow, type ExpressionValue,
} from './lib/index.ts';
import { pinnedIosXcodeToolchain } from '../src/ios/toolchainPolicy.ts';

/**
 * The only onboarding E2E that runs against production. It is trusted rather
 * than triggered: production-deploy-dispatch.yml dispatches it on main once
 * the production deploy reports an exact main revision serving, the ref and
 * the SHA are checked before any runner is allocated, and the same revision
 * is checked again afterwards — so a pass can only ever mean "this exact
 * commit was live for the whole run".
 *
 * The macOS lane is dedicated external capacity that must never execute pull
 * request code, and the video review that follows is advisory: it records what
 * it found and files nothing, which the separate advisory writer does.
 */

const controlRunner = trustedControlLinuxRunner;

/** `${{ env.NAME }}` — a name an earlier step of the same job appended to `$GITHUB_ENV`. */
const jobEnv = (name: string): ExpressionValue => expr(`env.${name}`);

const PRODUCTION_HEALTH_URL = 'https://www.example.invalid/health';
const PRODUCTION_API_BASE_URL = 'https://www.example.invalid/api';

/** `actions/upload-artifact` takes one path per line, with a trailing newline. */
const artifactPaths = (...paths: readonly ExpressionValue[]): string =>
  `${paths.map(String).join('\n')}\n`;

const validateRevision = typedStep({
  id: 'validate',
  name: 'Validate immutable main revision',
  doc: {
    purpose: 'Accepts only an immutable main commit that is still the head the deploy reported.',
    recovery: 'read the error: it names the ref, the event and the two SHAs that disagreed',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  outputs: ['exact_sha'] as const,
  script: 'scripts/ci/trusted-production-onboarding-e2e/validate-trusted-ref/validate-immutable-main-revision.sh',
  env: {
    EVENT_NAME: github('event_name'),
    EVENT_SHA: github('sha'),
    REF: github('ref'),
    REQUESTED_SHA: expr('inputs.exact_sha'),
  },
});

const validateTrustedRef = typedJob('validate-trusted-ref', {
  name: 'Validate trusted production E2E ref',
  doc: {
    purpose: 'Proves the revision under test is an immutable main commit that production already serves.',
    successMeaning: 'The exact main revision is live, so the macOS lane may be allocated.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'suite',
  runsOn: controlRunner,
  timeoutMinutes: 5,
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'exact-head',
    selectionOwner: 'controller',
  },
  outputs: { exact_sha: validateRevision.outputs.exact_sha },
  steps: [
    // The checks below moved from inline shell into scripts/ci, which need to
    // be on the runner; this job previously required no checkout at all. No
    // partial-clone filter here: the control runners share one persistent git
    // workspace, see ci/src/persistentWorkspace.ts.
    typedStep({
      name: 'Check out the trusted validation scripts',
      doc: {
        purpose: 'Puts the revision checks this job runs in the workspace; without it they are absent or stale.',
        recovery: 'retry; a repeated failure is a GitHub or runner network problem',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: 'actions/checkout@v7.0.1',
      with: { 'fetch-depth': 1, 'persist-credentials': false },
    }),
    validateRevision,
    typedStep({
      name: 'Require the revision to be deployed',
      doc: {
        purpose: 'Reads the production health endpoint once and refuses unless that exact revision is serving.',
        recovery: 'redeploy the revision, or rerun once the deploy reports it live; no macOS runner was spent',
      },
      owner: 'automation',
      category: 'planning',
      unit: 'step',
      script: 'scripts/ci/trusted-production-onboarding-e2e/validate-trusted-ref/require-the-revision-to-be-deployed.sh',
      env: {
        EXACT_SHA: validateRevision.outputs.exact_sha,
        PRODUCTION_HEALTH_URL,
      },
    }),
  ],
});

/** The revision the validation job approved, which is the only one either later job may use. */
const APPROVED_SHA = needsOutput(validateTrustedRef, 'exact_sha');

const simulator = typedStep({
  id: 'sim',
  name: 'Select production onboarding simulator',
  doc: {
    purpose: 'Provisions the simulator the onboarding run executes on and reports its destination.',
    recovery: 'read the provisioner output for the runtime and device it could not create',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  outputs: ['dest', 'provisioned_udid'] as const,
  command: 'python3 scripts/provision-ios-ci-simulator.py --purpose onboarding',
});

const provisionUsers = typedStep({
  id: 'provision-production-users',
  name: 'Provision scoped production FullOnboarding users',
  doc: {
    purpose: 'Creates the scoped production accounts this run signs in as, with a per-run password.',
    recovery: 'check the production admin secret is still valid; the run fails closed without users',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  continueOnError: true,
  outputs: ['cleanup_required'] as const,
  script: 'scripts/ci/trusted-production-onboarding-e2e/production-onboarding-e2e/provision-scoped-production-fullonboarding-users.sh',
  env: {
    ALLOW_PRODUCTION_E2E_USER_MUTATION: '1',
    PRODUCTION_E2E_ADMIN_SECRET: secret('PRODUCTION_E2E_ADMIN_SECRET'),
  },
});

const runOnboarding = typedStep({
  id: 'production-onboarding-e2e',
  name: 'Run production onboarding E2E',
  doc: {
    purpose: 'Drives the full onboarding journey against production and records the session.',
    recovery: 'read the failure summary and the uploaded result bundle for the step that failed',
  },
  owner: 'product',
  category: 'release',
  unit: 'step',
  if: expr("steps.provision-production-users.outcome == 'success'"),
  continueOnError: true,
  timeoutMinutes: 45,
  command: 'bash scripts/ios-test-onboarding-e2e.sh',
  env: {
    DESTINATION: simulator.outputs.dest,
    ITERATIONS: '1',
    RECORD_VIDEO: '1',
    DEFER_VIDEO_PROCESSING: '1',
    RESULT_BUNDLE: jobEnv('ONBOARDING_E2E_RESULT_BUNDLE'),
    SKIP_BUILD: '1',
    UI_TEST_API_BASE_URL: PRODUCTION_API_BASE_URL,
    UI_TEST_DASHBOARD_OFFLINE_E2E: '0',
    UI_TEST_PRODUCTION_E2E: '1',
    UI_TEST_SYNTHETIC_ONBOARDING_EMAIL: jobEnv('UI_TEST_SYNTHETIC_ONBOARDING_EMAIL'),
    UI_TEST_SYNTHETIC_PASSWORD: jobEnv('UI_TEST_SYNTHETIC_PASSWORD'),
    UI_TEST_SYNTHETIC_PRIVACY_EMAIL: jobEnv('UI_TEST_SYNTHETIC_PRIVACY_EMAIL'),
    XCODEBUILD_LOG: jobEnv('ONBOARDING_E2E_XCODEBUILD_LOG'),
  },
});

const verifyPostRevision = typedStep({
  id: 'verify-post-e2e-revision',
  name: 'Verify exact production revision after onboarding E2E',
  doc: {
    purpose: 'Confirms production never moved off the revision under test while the run was executing.',
    recovery: 'a deploy landed mid-run; rerun this workflow against the revision now serving',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("always() && steps.production-onboarding-e2e.outcome != 'skipped'"),
  continueOnError: true,
  script: 'scripts/ci/trusted-production-onboarding-e2e/production-onboarding-e2e/verify-exact-production-revision-after-onboarding-e2e.sh',
  env: { PRODUCTION_HEALTH_URL },
});

/** The run directory only exists once the paths step has written it to `$GITHUB_ENV`. */
const RUN_DIR_PREPARED = expr("always() && env.ONBOARDING_E2E_RUN_DIR != ''");

const recording = typedStep({
  id: 'recording',
  name: 'Locate production recording',
  doc: {
    purpose: 'Reports whether the run left a non-empty raw recording for the advisory review to read.',
    recovery: 'no recording is not a failure; check the onboarding step log if one was expected',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: RUN_DIR_PREPARED,
  outputs: ['available'] as const,
  script: 'scripts/ci/trusted-production-onboarding-e2e/production-onboarding-e2e/locate-production-recording.sh',
});

const uploadRawVideo = typedStep({
  id: 'upload-raw-video',
  name: 'Upload raw production video for advisory review',
  doc: {
    purpose: 'Hands the raw recording and its build log to the advisory review job as an artifact.',
    recovery: 'the recording was located but could not be uploaded; retry the run',
  },
  owner: 'review',
  category: 'evidence',
  unit: 'step',
  if: expr("always() && steps.recording.outputs.available == 'true'"),
  continueOnError: true,
  outputs: ['artifact-id'] as const,
  uses: 'actions/upload-artifact@v7.0.1',
  with: {
    name: concat('production-onboarding-raw-video-', github('run_id'), '-', github('run_attempt')),
    path: artifactPaths(
      concat(jobEnv('ONBOARDING_E2E_RUN_DIR'), '/onboarding-e2e.raw.mp4'),
      jobEnv('ONBOARDING_E2E_XCODEBUILD_LOG'),
    ),
    'compression-level': 0,
    'if-no-files-found': 'error',
    'retention-days': 7,
  },
});

const productionOnboardingE2e = typedJob('production-onboarding-e2e', {
  name: 'Production onboarding E2E execution',
  doc: {
    purpose: 'Runs the FullOnboarding journey against production on dedicated external macOS capacity.',
    successMeaning: 'A real user could complete onboarding against this exact production revision.',
  },
  owner: 'product',
  category: 'release',
  unit: 'suite',
  needs: [validateTrustedRef],
  // Dedicated external production capacity must not execute PR code.
  // If unavailable, remain queued; never fall back to a paid hosted Mac.
  runsOn: ['self-hosted', 'macOS', 'ios-production-e2e'],
  environment: { name: 'production-e2e' },
  permissions: { contents: 'read' },
  lane: {
    runnerClass: 'macos-physical',
    costClass: 'expensive',
    evidencePolicy: 'exact-head',
    selectionOwner: 'controller',
  },
  env: {
    EXACT_SHA: APPROVED_SHA,
    IOS_E2E_TEST_PRODUCTS: concat(
      github('workspace'),
      '/.example-ci/e2e-test-products/example-ios-e2e.xctestproducts',
    ),
    PRODUCTION_API_BASE_URL,
    PRODUCTION_E2E_RUN_ID: concat(github('run_id'), '-', github('run_attempt')),
  },
  outputs: { video_artifact_id: uploadRawVideo.outputs['artifact-id'] },
  steps: [
    typedStep({
      name: 'Checkout exact trusted revision',
      doc: {
        purpose: 'Puts the exact validated main revision on the macOS runner, and nothing else.',
        recovery: 'retry; a repeated failure is a GitHub or runner network problem',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: 'actions/checkout@v7.0.1',
      with: {
        'fetch-depth': 1,
        filter: 'blob:none',
        'persist-credentials': false,
        ref: jobEnv('EXACT_SHA'),
      },
    }),
    typedStep({
      name: 'Verify exact trusted revision',
      doc: {
        purpose: 'Fails unless the checked-out head is the revision the validation job approved.',
        recovery: 'the checkout resolved a different commit; rerun and check the ref it was given',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      script: 'scripts/ci/trusted-production-onboarding-e2e/production-onboarding-e2e/verify-exact-trusted-revision.sh',
    }),
    // The typed selector needs the pinned Node runtime before it runs.
    typedStep({
      name: 'Set up Node',
      doc: {
        purpose: 'Installs the Node.js version the production account tooling runs on.',
        recovery: 'retry; a repeated failure means the runner cannot reach the Node.js download',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: 'actions/setup-node@v7.0.0',
      with: { 'node-version': '26.5.0' },
    }),
    typedStep({
      name: 'Select exact Xcode',
      doc: {
        purpose: 'Points the lane at the one pinned Xcode build (ci/src/ios/toolchainPolicy.ts) CI compiles with.',
        recovery: 'install the pinned Xcode build on the runner; the step prints what it found instead',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      command: `node ci/src/actions/ios/selectXcode.ts ${pinnedIosXcodeToolchain}`,
    }),
    typedStep({
      name: 'Verify exact Xcode, SDK, and simulator runtime',
      doc: {
        purpose: 'Fails early when the runner image lacks the exact Xcode, SDK or simulator runtime.',
        recovery: 'install the missing component named in the output on this runner',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      command: 'python3 scripts/ios-ci-image-prerequisites.py --purpose onboarding',
    }),
    typedStep({
      name: 'Install production E2E tooling dependencies',
      doc: {
        purpose: 'Installs the pinned packages the account provisioning and cleanup scripts import.',
        recovery: 're-run once; a repeated failure is a registry or lockfile problem',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      command: 'npm ci',
    }),
    typedStep({
      name: 'Prepare shared E2E build cache',
      doc: {
        purpose: 'Binds this lane to its persistent derived-data and package caches before building.',
        recovery: 'read the cache script output; a corrupt entry is safe to delete and rebuild',
      },
      owner: 'product',
      category: 'artifact',
      unit: 'step',
      command: 'bash scripts/manage-ios-build-cache.sh prepare "$IOS_CI_CACHE_LANE"',
      env: {
        IOS_CI_CACHE_LANE: 'production-e2e',
        IOS_CI_PACKAGE_RESOLVED: concat(
          github('workspace'),
          '/ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
        ),
      },
    }),
    typedStep({
      name: 'Build exact-head E2E products once',
      doc: {
        purpose: 'Builds the E2E test products from the exact revision so the run never rebuilds them.',
        recovery: 'read the compile error in the build log; it is a source or dependency failure',
      },
      owner: 'product',
      category: 'artifact',
      unit: 'step',
      command: 'bash scripts/build-ios-e2e-test-products.sh',
      env: {
        IOS_E2E_DERIVED_DATA: jobEnv('IOS_CI_DERIVED_DATA'),
        IOS_E2E_TEST_PLAN: 'CI-E2E',
        IOS_SOURCE_PACKAGES_DIR: jobEnv('IOS_CI_SOURCE_PACKAGES'),
      },
    }),
    typedStep({
      name: 'Prepare production onboarding paths',
      doc: {
        purpose: 'Creates the run directory and publishes the result, log and xctestrun paths.',
        recovery: 'the built products hold no xctestrun; read the build step log',
      },
      owner: 'automation',
      category: 'planning',
      unit: 'step',
      script: 'scripts/ci/trusted-production-onboarding-e2e/production-onboarding-e2e/prepare-production-onboarding-paths.sh',
    }),
    typedStep({
      name: 'Ensure simulator host is healthy',
      doc: {
        purpose: 'Restarts the simulator services so provisioning does not fail on a wedged host.',
        recovery: 'the host needs manual attention; a stuck CoreSimulator survives this step',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      timeoutMinutes: 2,
      command: 'bash scripts/ensure-ios-simulator-host.sh',
    }),
    simulator,
    provisionUsers,
    runOnboarding,
    verifyPostRevision,
    typedStep({
      id: 'summarize-production-onboarding-failures',
      name: 'Summarize production onboarding failures',
      doc: {
        purpose: 'Turns the result bundle into the readable failure list shown in the run summary.',
        recovery: 'the result bundle is missing or unreadable; read the raw xcodebuild log instead',
      },
      owner: 'automation',
      category: 'evidence',
      unit: 'step',
      if: RUN_DIR_PREPARED,
      script: 'scripts/ci/trusted-production-onboarding-e2e/production-onboarding-e2e/summarize-production-onboarding-failures.sh',
    }),
    typedStep({
      name: 'Upload production onboarding evidence',
      doc: {
        purpose: 'Keeps the result bundle and build log so a failure can be read after the runner is gone.',
        recovery: 'the evidence could not be uploaded; the run itself is unaffected',
      },
      owner: 'automation',
      category: 'evidence',
      unit: 'step',
      if: expr("always() && env.ONBOARDING_E2E_RUN_DIR != '' "
        + "&& (steps.production-onboarding-e2e.outcome == 'failure' "
        + "|| steps.summarize-production-onboarding-failures.outcome == 'failure' "
        + "|| (steps.production-onboarding-e2e.outcome == 'skipped' && failure()))"),
      continueOnError: true,
      uses: 'actions/upload-artifact@v7.0.1',
      with: {
        name: concat('production-onboarding-e2e-', jobEnv('EXACT_SHA'), '-', github('run_attempt')),
        path: artifactPaths(
          jobEnv('ONBOARDING_E2E_RESULT_BUNDLE'),
          jobEnv('ONBOARDING_E2E_XCODEBUILD_LOG'),
        ),
        'compression-level': 0,
        'if-no-files-found': 'warn',
        'retention-days': 3,
      },
    }),
    recording,
    uploadRawVideo,
    typedStep({
      id: 'cleanup-production-users',
      name: 'Delete scoped production FullOnboarding users',
      doc: {
        purpose: 'Removes the scoped accounts this run created, so production keeps no test users.',
        recovery: 'delete the run scoped accounts by hand; the lifecycle check fails until they are gone',
      },
      owner: 'infrastructure',
      category: 'cleanup',
      unit: 'step',
      if: expr("always() && steps.provision-production-users.outputs.cleanup_required == 'true'"),
      continueOnError: true,
      script: 'scripts/ci/trusted-production-onboarding-e2e/production-onboarding-e2e/delete-scoped-production-fullonboarding-users.sh',
      env: {
        ALLOW_PRODUCTION_E2E_USER_MUTATION: '1',
        PRODUCTION_E2E_ADMIN_SECRET: secret('PRODUCTION_E2E_ADMIN_SECRET'),
      },
    }),
    // Every step above this one continues on error so cleanup always runs;
    // this is the step that decides whether the job passed.
    typedStep({
      name: 'Verify production FullOnboarding lifecycle',
      doc: {
        purpose: 'Fails the job unless provisioning, the run, the revision check and cleanup all passed.',
        recovery: 'the message names which of the four outcomes was not success; open that step',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      if: expr('always()'),
      script: 'scripts/ci/trusted-production-onboarding-e2e/production-onboarding-e2e/verify-production-fullonboarding-lifecycle.sh',
      env: {
        CLEANUP_OUTCOME: expr('steps.cleanup-production-users.outcome'),
        ONBOARDING_OUTCOME: expr('steps.production-onboarding-e2e.outcome'),
        REVISION_OUTCOME: expr('steps.verify-post-e2e-revision.outcome'),
        PROVISION_OUTCOME: expr('steps.provision-production-users.outcome'),
      },
    }),
    typedStep({
      name: 'Remove production onboarding simulator',
      doc: {
        purpose: 'Reclaims the simulator this run provisioned so the runner disk does not fill up.',
        recovery: 'delete the named simulator on the runner; a leak eventually fails later runs',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      if: expr("always() && steps.sim.outputs.provisioned_udid != ''"),
      command: 'bash scripts/reclaim-ios-runner-disk.sh simulator',
      env: {
        IOS_RUNNER_CURRENT_SIMULATOR_PURPOSE: 'Onboarding',
        IOS_RUNNER_CURRENT_SIMULATOR_UDID: simulator.outputs.provisioned_udid,
        IOS_RUNNER_RECLAIM_CI_SIMULATORS: '1',
      },
    }),
    typedStep({
      name: 'Prune bounded production E2E build cache',
      doc: {
        purpose: 'Keeps the persistent build cache for this lane within its bound after the run.',
        recovery: 'read the cache script output; the newest entry is never pruned',
      },
      owner: 'infrastructure',
      category: 'cleanup',
      unit: 'step',
      if: expr("always() && env.IOS_CI_BUILD_CACHE_ENTRY != ''"),
      command: 'bash scripts/manage-ios-build-cache.sh prune production-e2e',
    }),
  ],
});

const processVideo = typedStep({
  id: 'process-video',
  name: 'Process onboarding video',
  doc: {
    purpose: 'Compresses the raw recording to something a review model can read in one pass.',
    recovery: 'read the ffmpeg output; the review is advisory, so the producing run still stands',
  },
  owner: 'product',
  category: 'artifact',
  unit: 'step',
  continueOnError: true,
  script: 'scripts/ci/trusted-production-onboarding-e2e/production-video-review/process-onboarding-video.sh',
});

const productionVideoReview = typedJob('production-video-review', {
  name: 'Production onboarding video review (advisory)',
  doc: {
    purpose: 'Reviews the recording of a production onboarding run for UX and QA problems.',
    successMeaning: 'The recording was reviewed and the findings are saved for the advisory writer.',
  },
  owner: 'review',
  category: 'release',
  unit: 'job',
  needs: [validateTrustedRef, productionOnboardingE2e],
  if: expr(
    "always() && !cancelled() && github.ref == 'refs/heads/main' "
    + "&& needs.validate-trusted-ref.result == 'success' "
    + "&& needs.production-onboarding-e2e.outputs.video_artifact_id != ''",
  ),
  runsOn: controlRunner,
  // Advisory: a review that cannot run must never fail the production check.
  continueOnError: true,
  permissions: { actions: 'read', contents: 'read' },
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'exact-head',
    selectionOwner: 'controller',
  },
  env: {
    UI_TEST_PRODUCTION_E2E: '1',
    // This job records findings; the advisory writer workflow files them.
    ONBOARDING_VIDEO_ISSUE_FILING_ENABLED: '0',
  },
  steps: [
    typedStep({
      name: 'Checkout review tooling',
      doc: {
        purpose: 'Puts the review scripts on the runner from the same revision the run tested.',
        recovery: 'retry; a repeated failure is a GitHub or runner network problem',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: 'actions/checkout@v7.0.1',
      // No blob filter on the shared control-runner workspace; see
      // ci/src/persistentWorkspace.ts.
      with: {
        'fetch-depth': 1,
        'persist-credentials': false,
        ref: APPROVED_SHA,
      },
    }),
    typedStep({
      name: 'Set up Node',
      doc: {
        purpose: 'Installs the Node.js version the review script runs on.',
        recovery: 'retry; a repeated failure means the runner cannot reach the Node.js download',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: 'actions/setup-node@v7.0.0',
      with: { 'node-version': '26.5.0' },
    }),
    typedStep({
      name: 'Prepare isolated onboarding video workspace',
      doc: {
        purpose: 'Owns a fresh run directory and publishes the compressed video and review paths.',
        recovery: 'the runner temp directory is unwritable; a repeated failure is a runner problem',
      },
      owner: 'automation',
      category: 'planning',
      unit: 'step',
      script: 'scripts/ci/trusted-production-onboarding-e2e/production-video-review/prepare-isolated-onboarding-video-workspace.sh',
    }),
    typedStep({
      name: 'Download raw onboarding video',
      doc: {
        purpose: 'Fetches the raw recording the macOS run uploaded for this exact run and attempt.',
        recovery: 'the producing job uploaded no recording; read its upload step',
      },
      owner: 'automation',
      category: 'evidence',
      unit: 'step',
      uses: 'actions/download-artifact@v8.0.1',
      with: {
        name: concat('production-onboarding-raw-video-', github('run_id'), '-', github('run_attempt')),
        path: concat(
          expr('runner.temp'),
          '/onboarding-video-',
          github('run_id'),
          '-',
          github('run_attempt'),
          '/raw',
        ),
      },
    }),
    processVideo,
    typedStep({
      name: 'Run deferred onboarding QA and UX Codex review',
      doc: {
        purpose: 'Asks the review model what the recording shows and saves its findings.',
        recovery: 'read the review log; the findings artifact is empty when the model was unreachable',
      },
      owner: 'review',
      category: 'coordination',
      unit: 'step',
      if: expr("steps.process-video.outcome == 'success'"),
      continueOnError: true,
      command: 'node ci/src/actions/reviewOnboardingVideo.ts',
      env: { OPENAI_API_KEY: secret('OPENAI_API_KEY') },
    }),
    typedStep({
      name: 'Upload onboarding video review artifacts',
      doc: {
        purpose: 'Publishes the compressed recording and the findings the advisory writer consumes.',
        recovery: 'nothing was produced to upload; read the processing and review steps above',
      },
      owner: 'review',
      category: 'evidence',
      unit: 'step',
      if: expr('always()'),
      continueOnError: true,
      uses: 'actions/upload-artifact@v7.0.1',
      with: {
        name: concat(
          'production-onboarding-video-review-',
          github('run_id'),
          '-',
          github('run_attempt'),
        ),
        path: artifactPaths(
          jobEnv('ONBOARDING_E2E_COMPRESSED_VIDEO'),
          jobEnv('ONBOARDING_E2E_REVIEW_JSON'),
          jobEnv('ONBOARDING_E2E_REVIEW_MD'),
        ),
        'compression-level': 0,
        'if-no-files-found': 'warn',
        'retention-days': 14,
      },
    }),
    typedStep({
      name: 'Remove owned processing workspace',
      doc: {
        purpose: 'Deletes the run directory this job created, which holds a full-length recording.',
        recovery: 'delete the named directory on the runner; a leak eventually fills its disk',
      },
      owner: 'infrastructure',
      category: 'cleanup',
      unit: 'step',
      if: expr('always()'),
      command: 'rm -rf -- "$RUNNER_TEMP/onboarding-video-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"',
    }),
  ],
});

export const trustedProductionOnboardingE2e = typedWorkflow({
  path: '.github/workflows/trusted-production-onboarding-e2e.yml',
  source: 'ci/workflows/trusted-production-onboarding-e2e.ts',
  name: 'Trusted production onboarding E2E',
  doc: { purpose: 'Runs the onboarding journey against an exact main revision that production already serves.' },
  on: {
    // Dispatched on main by production-deploy-dispatch.yml when the production
    // deploy reports the exact main revision serving, or by hand. Only a main
    // dispatch satisfies the production-e2e environment's branch policy, which
    // is why deploy reports (check_run, repository_dispatch — both default-
    // branch events) are not triggers here. Nothing waits for the deployment:
    // the revision is checked once and must already be live.
    workflow_dispatch: {
      inputs: {
        exact_sha: {
          description: 'Exact main commit SHA to test in production',
          required: true,
          type: 'string',
        },
      },
    },
  },
  permissions: { contents: 'read' },
  // One run per revision, so a repeated deploy report queues behind the run
  // already verifying it; never cancelled, because a cancelled run leaves the
  // scoped accounts it created behind.
  concurrency: {
    group: concat('trusted-production-onboarding-e2e-', expr('inputs.exact_sha')),
    cancelInProgress: false,
  },
  jobs: [validateTrustedRef, productionOnboardingE2e, productionVideoReview],
});

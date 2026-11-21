import type { CloudBuildTarget } from './lib/emit.ts';
import type { CloudBuild } from './lib/types.ts';

type TestFlightFeedbackStepId = 'build-image' | 'push-image' | 'deploy-job';

export const testflightFeedbackTarget: CloudBuildTarget = {
  path: 'ci/generated/cloudbuild/testflight-feedback.yaml',
  source: 'ci/cloudbuild/testflightFeedback.ts',
};

const image = '${_REGION}-docker.pkg.dev/$PROJECT_ID/${_ARTIFACT_REPOSITORY}/${_JOB_NAME}';

/** Build and deploy the TestFlight feedback sync as a Cloud Run Job. */
export const testflightFeedbackBuild = {
  steps: [
    {
      name: 'gcr.io/cloud-builders/docker',
      id: 'build-image',
      args: [
        'build', '-f', 'Dockerfile.testflight-feedback',
        '-t', `${image}:$BUILD_ID`, '-t', `${image}:latest`, '.',
      ],
    },
    {
      name: 'gcr.io/cloud-builders/docker',
      id: 'push-image',
      waitFor: ['build-image'],
      args: ['push', '--all-tags', image],
    },
    {
      name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
      id: 'deploy-job',
      waitFor: ['push-image'],
      entrypoint: 'gcloud',
      args: [
        'run', 'jobs', 'deploy', '${_JOB_NAME}',
        '--project=$PROJECT_ID',
        `--image=${image}:$BUILD_ID`,
        '--region=${_REGION}',
        '--service-account=${_RUNTIME_SERVICE_ACCOUNT}',
        '--tasks=1',
        '--parallelism=1',
        '--task-timeout=${_TASK_TIMEOUT}',
        '--max-retries=2',
        '--cpu=1',
        '--memory=512Mi',
        '--set-env-vars=^@^NODE_ENV=production@APP_STORE_CONNECT_APP_ID=${_APP_STORE_CONNECT_APP_ID}@APP_STORE_CONNECT_KEY_ID=${_APP_STORE_CONNECT_KEY_ID}@APP_STORE_CONNECT_ISSUER_ID=${_APP_STORE_CONNECT_ISSUER_ID}@APP_STORE_CONNECT_PRIVATE_KEY_PATH=${_PRIVATE_KEY_MOUNT_PATH}@GITHUB_REPO_OWNER=${_GITHUB_REPO_OWNER}@GITHUB_REPO_NAME=${_GITHUB_REPO_NAME}@GITHUB_ISSUE_LABELS=${_GITHUB_ISSUE_LABELS}@TESTFLIGHT_FEEDBACK_LOOKBACK_HOURS=${_LOOKBACK_HOURS}@TESTFLIGHT_FEEDBACK_DOWNLOAD_DIR=${_DOWNLOAD_DIR}@TESTFLIGHT_GITHUB_MAX_SCAN_PAGES=${_GITHUB_MAX_SCAN_PAGES}',
        '--set-secrets=${_PRIVATE_KEY_MOUNT_PATH}=${_PRIVATE_KEY_SECRET}:latest,GITHUB_TOKEN=${_GITHUB_TOKEN_SECRET}:latest',
      ],
    },
  ],
  images: [`${image}:$BUILD_ID`, `${image}:latest`],
  timeout: '1800s',
  options: { logging: 'CLOUD_LOGGING_ONLY' },
  substitutions: {
    _REGION: 'us-central1',
    _ARTIFACT_REPOSITORY: 'example',
    _JOB_NAME: 'testflight-feedback-sync',
    _RUNTIME_SERVICE_ACCOUNT: 'testflight-feedback-sync@example-app.iam.gserviceaccount.com',
    _TASK_TIMEOUT: '1800s',
    _APP_STORE_CONNECT_APP_ID: '1234567890',
    _APP_STORE_CONNECT_KEY_ID: '3K9AC2NTPH',
    _APP_STORE_CONNECT_ISSUER_ID: 'dd95307e-71df-5e37-8da6-9cbcf2505fd0',
    _PRIVATE_KEY_SECRET: 'testflight-app-store-connect-private-key',
    _PRIVATE_KEY_MOUNT_PATH: '/secrets/app-store-connect/AuthKey_3K9AC2NTPH.p8',
    _GITHUB_TOKEN_SECRET: 'testflight-github-token',
    _GITHUB_REPO_OWNER: 'example-org',
    _GITHUB_REPO_NAME: 'example-app',
    _GITHUB_ISSUE_LABELS: 'testflight,bug',
    _LOOKBACK_HOURS: '2400',
    _DOWNLOAD_DIR: './tmp/testflight-feedback',
    _GITHUB_MAX_SCAN_PAGES: '100',
  },
} as const satisfies CloudBuild<TestFlightFeedbackStepId>;

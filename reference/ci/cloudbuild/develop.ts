import { primarySmokeSteps } from './lib/primaryContainerSmoke.ts';
import type { CloudBuild, CloudBuildStep } from './lib/types.ts';

// Ordered IDs define both the allowed dependency vocabulary and Cloud Build execution order.
export const developStepIds = [
  'verify-initial-deployment-ownership',
  'install-dependencies',
  'validate-generated-types',
  'validate-chat-types',
  'test-coverage',
  'pull-runtime-cache',
  'build-runtime',
  'prepare-runtime-smoke-cli',
  'test-runtime-container',
  'push-runtime',
  'migrate-plaid-scheduler-schema',
  'verify-plaid-scheduler-schema',
  'verify-runtime-deployment-ownership',
  'prepare-runtime-deployment',
  'deploy-runtime',
  'promote-runtime',
  'verify-runtime-deployment',
  'configure-push-token-cleanup-trigger',
  'configure-notification-triggers',
  'configure-plaid-webhook-recovery',
  'index-rag-docs',
] as const;
export type DevelopStepId = (typeof developStepIds)[number];

const stagingRuntimeEnvironment = [
  'GCP_PROJECT_ID=$PROJECT_ID',
  'GCP_REGION=us-central1',
  'CLOUD_RUN_SERVICE=example',
  'CLOUD_BUILD_ID=$BUILD_ID',
  'COMMIT_SHA=$COMMIT_SHA',
  'STAGING_HEALTH_URL=https://s.example.invalid/api/health',
] as const satisfies readonly `${string}=${string}`[];
const ownershipArguments = ['ci/cloudbuild/runtime/runStagingPromotion.ts', 'ownership'];

const [prepareRuntimeSmokeCli, testRuntimeContainer] = primarySmokeSteps<DevelopStepId>({
  prepare: 'prepare-runtime-smoke-cli', build: 'build-runtime', smoke: 'test-runtime-container',
  image: 'us-central1-docker.pkg.dev/$PROJECT_ID/example/example:$COMMIT_SHA',
});

const steps = {
  'verify-initial-deployment-ownership': {
    name: 'node:26.5.1-alpine',
    entrypoint: 'node',
    args: ownershipArguments,
    env: stagingRuntimeEnvironment,
    timeout: '90s',
  },
  'install-dependencies': {
    name: 'node:26.5.1-alpine',
    waitFor: ['verify-initial-deployment-ownership'],
    entrypoint: 'npm',
    args: ['ci'],
  },
  // No lint step: PR Checks' required `Lint changed code` and the develop merge
  // queue lint every change before it reaches develop, so the deploy build
  // does not repeat it. Generated-file drift is still checked here.
  'validate-generated-types': {
    name: 'node:26.5.1-alpine',
    waitFor: ['install-dependencies'],
    entrypoint: 'npm',
    // The node image has no git; the build workspace is one commit's checkout.
    args: ['run', 'validate:generated-types', '--', '--commit-checkout'],
  },
  'validate-chat-types': {
    name: 'node:26.5.1-alpine',
    waitFor: ['validate-generated-types'],
    entrypoint: 'npm',
    args: ['run', 'validate:chat-types'],
  },
  'test-coverage': {
    name: 'node:26.5.1-alpine',
    waitFor: ['validate-chat-types'],
    entrypoint: 'npm',
    args: ['run', 'test:coverage'],
  },
  'pull-runtime-cache': {
    name: 'gcr.io/cloud-builders/docker',
    waitFor: ['verify-initial-deployment-ownership'],
    args: ['pull', 'us-central1-docker.pkg.dev/$PROJECT_ID/example/example:latest'],
    allowFailure: true,
  },
  'build-runtime': {
    name: 'gcr.io/cloud-builders/docker',
    waitFor: ['install-dependencies', 'validate-generated-types', 'pull-runtime-cache'],
    args: [
      'build',
      '--cache-from',
      'us-central1-docker.pkg.dev/$PROJECT_ID/example/example:latest',
      '-t',
      'us-central1-docker.pkg.dev/$PROJECT_ID/example/example:$COMMIT_SHA',
      '-t',
      'us-central1-docker.pkg.dev/$PROJECT_ID/example/example:latest',
      '--build-arg',
      'NEXT_PUBLIC_AMPLITUDE_API_KEY=${_NEXT_PUBLIC_AMPLITUDE_API_KEY}',
      '--build-arg',
      'NEXT_PUBLIC_POSTHOG_KEY=${_NEXT_PUBLIC_POSTHOG_KEY}',
      '.',
    ],
  },
  'prepare-runtime-smoke-cli': prepareRuntimeSmokeCli,
  'test-runtime-container': testRuntimeContainer,
  'push-runtime': {
    name: 'gcr.io/cloud-builders/docker',
    waitFor: [
      'validate-generated-types',
      'validate-chat-types',
      'test-coverage',
      'test-runtime-container',
    ],
    args: ['push', '--all-tags', 'us-central1-docker.pkg.dev/$PROJECT_ID/example/example'],
  },
  'migrate-plaid-scheduler-schema': {
    name: 'node:26.5.0-alpine',
    waitFor: ['push-runtime'],
    entrypoint: 'npm',
    args: ['run', 'db:migrate'],
    env: [
      'GCP_PROJECT_ID=example-app',
      'INSTANCE_CONNECTION_NAME=example-app:us-central1:example-dev-postgres',
      'DB_USER=postgres',
      'DB_IAM_USERS=github-actions-ci@example-app.iam,cloudbuild@example-app.iam,123456789012-compute@developer',
      'DB_NAME=example',
    ],
    secretEnv: ['DB_PASSWORD'],
    timeout: '600s',
  },
  'verify-plaid-scheduler-schema': {
    name: 'node:26.5.0-alpine',
    waitFor: ['migrate-plaid-scheduler-schema'],
    entrypoint: 'npm',
    args: ['run', 'db:verify-plaid-scheduler'],
    env: [
      'GCP_PROJECT_ID=example-app',
      'INSTANCE_CONNECTION_NAME=example-app:us-central1:example-dev-postgres',
      'DB_USER=postgres',
      'DB_NAME=example',
    ],
    secretEnv: ['DB_PASSWORD'],
    timeout: '600s',
  },
  'verify-runtime-deployment-ownership': {
    name: 'node:26.5.1-alpine',
    waitFor: ['verify-plaid-scheduler-schema'],
    entrypoint: 'node',
    args: ownershipArguments,
    env: stagingRuntimeEnvironment,
    timeout: '90s',
  },
  'prepare-runtime-deployment': {
    name: 'node:26.5.1-alpine',
    waitFor: ['verify-runtime-deployment-ownership'],
    entrypoint: 'node',
    args: ['ci/cloudbuild/runtime/prepareStagingDeploy.ts'],
    env: stagingRuntimeEnvironment,
    timeout: '60s',
  },
  'deploy-runtime': {
    name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
    waitFor: ['prepare-runtime-deployment'],
    entrypoint: 'gcloud',
    args: [
      'run',
      'deploy',
      'example',
      '--flags-file=/workspace/example-runtime-deploy-flags.json',
      '--image=us-central1-docker.pkg.dev/$PROJECT_ID/example/example:$COMMIT_SHA',
      '--region=us-central1',
      '--platform=managed',
      '--allow-unauthenticated',
      '--memory=1Gi',
      '--cpu=1',
      '--port=8080',
      '--startup-probe=httpGet.path=/health,httpGet.port=8080,periodSeconds=5,timeoutSeconds=3,failureThreshold=24',
      '--liveness-probe=httpGet.path=/health,httpGet.port=8080,periodSeconds=30,timeoutSeconds=5,failureThreshold=3',
      '--service-account=123456789012-compute@developer.gserviceaccount.com',
      '--set-env-vars=NODE_ENV=production,OBSERVABILITY_USER_EMAILS=user@example.invalid,OBSERVABILITY_GCP_PROJECT=example-production,OBSERVABILITY_GCP_REGION=us-east4,OBSERVABILITY_GCP_SERVICE=example,OBSERVABILITY_SQL_INSTANCE=example-prod-postgres,OBSERVABILITY_APPLE_APP_ID=1234567890,OBSERVABILITY_APPLE_PRODUCT_ID=dabfcc70-f6f5-5f43-a7e3-9ca927af6f2e,EXAMPLE_BUILD_SHA=$COMMIT_SHA,GCP_PROJECT_ID=example-app,INSTANCE_CONNECTION_NAME=example-app:us-central1:example-dev-postgres,DB_IAM_USER=123456789012-compute@developer,DB_NAME=example,GCS_ASSET_BUCKET=example-app-public-assets,GCS_PROFILE_MEDIA_BUCKET=example-app-private-profile-media,FOUNDATION_COPY_V2=1,PLAID_WEBHOOK_URL=https://s.example.invalid/api/plaid/webhook,PLAID_SCHEDULER_ENV=development,PLAID_SWEEP_WORK_TIMEOUT_MS=3000000,ENABLE_PLAID_SYNC_CRON=false,PLAID_SYNC_VIA_JOB=true,SCHEDULER_CRON=0 7 * * *,SCHEDULER_TZ=America/New_York,ENABLE_STAGING_QA_USER_ADMIN=true,WEB_TRUSTED_ORIGINS=https://s.example.invalid,WEB_TRUST_PROXY_HOPS=1,CSP_MODE=report-only,PUSH_TOKEN_CLEANUP_SCHEDULER_AUDIENCE=${_PUSH_TOKEN_CLEANUP_BASE_URL},PUSH_TOKEN_CLEANUP_SCHEDULER_SERVICE_ACCOUNT=${_PUSH_TOKEN_CLEANUP_SCHEDULER_SERVICE_ACCOUNT},NOTIFICATION_SCHEDULER_AUDIENCE=${_NOTIFICATION_BASE_URL},NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT=${_NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT},NOTIFICATIONS_DELIVERY_ENABLED=${_NOTIFICATIONS_DELIVERY_ENABLED},APNS_BUNDLE_ID=com.examplewealth.exampleapp,APNS_ENABLED_ENVIRONMENTS=development,APP_STORE_BUNDLE_ID=com.examplewealth.exampleapp,APP_STORE_APP_APPLE_ID=1234567890,APP_STORE_ENVIRONMENT=Sandbox,APP_STORE_ALLOWED_PRODUCT_IDS=example exampleannual',
    ],
  },
  'promote-runtime': {
    name: 'node:26.5.1-alpine',
    waitFor: ['deploy-runtime'],
    entrypoint: 'node',
    args: ['ci/cloudbuild/runtime/runStagingPromotion.ts', 'promote'],
    env: stagingRuntimeEnvironment,
    timeout: '330s',
  },
  'verify-runtime-deployment': {
    name: 'node:26.5.1-alpine',
    waitFor: ['promote-runtime'],
    entrypoint: 'node',
    args: ['ci/cloudbuild/runtime/runStagingPromotion.ts', 'verify'],
    env: stagingRuntimeEnvironment,
    timeout: '150s',
  },
  'configure-push-token-cleanup-trigger': {
    name: 'node:26.5.1-alpine',
    waitFor: ['verify-runtime-deployment'],
    entrypoint: 'node',
    args: ['ci/cloudbuild/runtime/reconcilePushTokenCleanupScheduler.ts'],
    env: [
      'GCP_PROJECT_ID=$PROJECT_ID',
      'GCP_REGION=us-central1',
      'SCHEDULER_AUDIENCE=${_PUSH_TOKEN_CLEANUP_BASE_URL}',
      'SCHEDULER_SERVICE_ACCOUNT=${_PUSH_TOKEN_CLEANUP_SCHEDULER_SERVICE_ACCOUNT}',
    ],
  },
  'configure-notification-triggers': {
    name: 'node:26.5.1-alpine',
    waitFor: ['verify-runtime-deployment'],
    entrypoint: 'node',
    args: ['ci/cloudbuild/runtime/reconcileNotificationSchedulers.ts'],
    env: [
      'GCP_PROJECT_ID=$PROJECT_ID',
      'GCP_REGION=us-central1',
      'SCHEDULER_AUDIENCE=${_NOTIFICATION_BASE_URL}',
      'SCHEDULER_SERVICE_ACCOUNT=${_NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT}',
    ],
  },
  'configure-plaid-webhook-recovery': {
    name: 'node:26.5.1-alpine',
    waitFor: ['verify-runtime-deployment'],
    entrypoint: 'node',
    args: ['ci/cloudbuild/runtime/reconcilePlaidWebhookScheduler.ts'],
    env: [
      'GCP_PROJECT_ID=$PROJECT_ID',
      'GCP_REGION=us-central1',
      'SCHEDULER_AUDIENCE=${_NOTIFICATION_BASE_URL}',
      'SCHEDULER_SERVICE_ACCOUNT=${_NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT}',
    ],
  },
  'index-rag-docs': {
    name: 'node:26.5.1-alpine',
    waitFor: ['verify-runtime-deployment'],
    entrypoint: 'npm',
    args: ['run', 'docs:rag:index'],
    env: [
      'GCP_PROJECT_ID=example-app',
      'INSTANCE_CONNECTION_NAME=example-app:us-central1:example-dev-postgres',
      'DB_IAM_USER=cloudbuild@example-app.iam',
      'DB_NAME=example',
    ],
    secretEnv: ['OPENAI_API_KEY'],
    timeout: '300s',
    allowFailure: true,
  },
} satisfies Record<DevelopStepId, Omit<CloudBuildStep<DevelopStepId>, 'id'>>;

export const developBuild = {
  steps: developStepIds.map((id) => ({ id, ...steps[id] })),
  // Store images in Google Artifact Registry.
  images: [
    'us-central1-docker.pkg.dev/$PROJECT_ID/example/example:$COMMIT_SHA',
    'us-central1-docker.pkg.dev/$PROJECT_ID/example/example:latest',
  ],
  // Set timeout for the build.
  timeout: '1800s',
  // Logging configuration.
  options: {
    machineType: 'E2_HIGHCPU_8',
    logging: 'CLOUD_LOGGING_ONLY',
  },
  // Secrets available to build steps.
  availableSecrets: {
    secretManager: [
      {
        versionName: 'projects/$PROJECT_ID/secrets/OPENAI_API_KEY/versions/latest',
        env: 'OPENAI_API_KEY',
      },
      {
        versionName: 'projects/$PROJECT_ID/secrets/DATABASE_ADMIN_PASSWORD/versions/latest',
        env: 'DB_PASSWORD',
      },
    ],
  },
  // Default substitution values for frontend environment variables.
  substitutions: {
    _NEXT_PUBLIC_AMPLITUDE_API_KEY: 'example-public-analytics-key',
    _NEXT_PUBLIC_POSTHOG_KEY: 'example-public-analytics-key',
    _PUSH_TOKEN_CLEANUP_BASE_URL: 'https://s.example.invalid',
    _PUSH_TOKEN_CLEANUP_SCHEDULER_SERVICE_ACCOUNT:
      '123456789012-compute@developer.gserviceaccount.com',
    _NOTIFICATION_BASE_URL: 'https://s.example.invalid',
    _NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT: '123456789012-compute@developer.gserviceaccount.com',
    _NOTIFICATIONS_DELIVERY_ENABLED: 'false',
  },
} satisfies CloudBuild<DevelopStepId>;

// Keep deployment rationale next to the typed source and in generated review output.
export const developStepComments = {
  'verify-initial-deployment-ownership':
    'Reject a build already superseded by a newer run of this trigger before\ninstalling dependencies, running coverage, or building an image.',
  'install-dependencies': 'Install dependencies (Node 26.5.1 to match Dockerfile and engines.node)',
  'validate-generated-types':
    'Fail when a generated type file differs from its generator output. The check\nrewrites and restores generated files in place, so the Docker build, which reads\nthe workspace, waits for it.',
  'validate-chat-types': 'Validate chat type definitions match between server and iOS',
  'test-coverage':
    'Run unit tests with coverage check (excludes integration tests to avoid writing to prod)',
  'pull-runtime-cache': 'Pull previous image for Docker layer caching',
  'build-runtime': 'Build the container image with layer caching',
  'prepare-runtime-smoke-cli': 'Share the pinned Docker CLI with the typed Node security smoke step.',
  'test-runtime-container':
    'Prove the built image runs with a fixed non-root identity, a read-only root\nfilesystem, no Linux capabilities, and graceful health/shutdown behavior.',
  'push-runtime': 'Push the container image to Artifact Registry',
  'migrate-plaid-scheduler-schema':
    'Apply checked-in Cloud SQL migrations before deploying application code',
  'verify-plaid-scheduler-schema':
    'Fail closed unless both exact migration hashes and required objects exist.',
  'verify-runtime-deployment-ownership':
    'Recheck the same typed trigger-ownership rule before creating a Cloud Run\nrevision because a newer run may have started during validation.',
  'prepare-runtime-deployment':
    'Prepare native gcloud flags with bounded optional secret access probes.\nADMIN_USER_EMAILS rollback version: 1',
  'deploy-runtime':
    'Create the candidate revision without changing traffic. Develop builds can\noverlap, so traffic promotion is guarded separately after the revision is\nready.',
  'promote-runtime':
    'Recheck trigger ownership before promotion, then require this candidate to\nremain the newest Cloud Run revision. The service etag makes the final\ntraffic write conditional, so a newer candidate created after the read\ncauses the PATCH to fail instead of rolling traffic backward.',
  'verify-runtime-deployment':
    'A successful deploy command is insufficient evidence that the requested\nrevision is serving through the staging hostname.',
  'configure-push-token-cleanup-trigger':
    'Reconcile a platform-backed minute trigger so delayed durable logout work\nruns even when the request-based Cloud Run service scales to zero.',
  'configure-notification-triggers':
    'Reconcile the three independently bounded notification workers. The global\ndelivery switch and database policy remain off until N7 acceptance.',
  'configure-plaid-webhook-recovery':
    'Reconcile a minute OIDC recovery trigger for accepted Plaid webhook receipts\nso process restarts cannot lose refresh work.',
  'index-rag-docs':
    "Index RAG docs into Cloud SQL (updates embeddings for changed docs).\nNote: allowFailure=true so builds don't fail if OpenAI quota is exceeded",
} satisfies Record<DevelopStepId, string>;

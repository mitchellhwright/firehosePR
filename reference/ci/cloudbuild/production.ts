import { primarySmokeSteps } from './lib/primaryContainerSmoke.ts';
import type { CloudBuildTarget } from './lib/emit.ts';
import type { CloudBuild, CloudBuildStep } from './lib/types.ts';

export const productionCloudBuildTarget = {
  path: 'cloudbuild-prod.yaml',
  source: 'ci/cloudbuild/production.ts',
} as const satisfies CloudBuildTarget;

// Ordered IDs define the allowed dependency vocabulary and production execution order.
export const productionStepIds = [
  'install-dependencies',
  'test-coverage',
  'pull-runtime-cache',
  'build-runtime',
  'prepare-runtime-smoke-cli',
  'test-runtime-container',
  'push-runtime',
  'migrate-plaid-scheduler-schema',
  'verify-plaid-scheduler-schema',
  'deploy-runtime',
  'configure-push-token-cleanup-trigger',
  'configure-notification-triggers',
  'configure-plaid-webhook-recovery',
  'index-rag-docs',
] as const;
export type ProductionStepId = (typeof productionStepIds)[number];

export const productionStepComments = {
  'deploy-runtime': 'Deploy container image to Cloud Run. ADMIN_USER_EMAILS rollback version: 1',
} as const satisfies Readonly<Partial<Record<ProductionStepId, string>>>;

const [prepareRuntimeSmokeCli, testRuntimeContainer] = primarySmokeSteps<ProductionStepId>({
  prepare: 'prepare-runtime-smoke-cli', build: 'build-runtime', smoke: 'test-runtime-container',
  image: 'us-east4-docker.pkg.dev/$PROJECT_ID/example/example:$COMMIT_SHA',
});

const steps = {
  'install-dependencies': {
    name: 'node:26.5.1-alpine',
    entrypoint: 'npm',
    args: ['ci'],
  },
  'test-coverage': {
    name: 'node:26.5.1-alpine',
    waitFor: ['install-dependencies'],
    entrypoint: 'npm',
    args: ['run', 'test:coverage'],
  },
  'pull-runtime-cache': {
    name: 'gcr.io/cloud-builders/docker',
    waitFor: ['-'],
    args: ['pull', 'us-east4-docker.pkg.dev/$PROJECT_ID/example/example:latest'],
    allowFailure: true,
  },
  'build-runtime': {
    name: 'gcr.io/cloud-builders/docker',
    waitFor: ['install-dependencies', 'pull-runtime-cache'],
    args: [
      'build',
      '--cache-from',
      'us-east4-docker.pkg.dev/$PROJECT_ID/example/example:latest',
      '-t',
      'us-east4-docker.pkg.dev/$PROJECT_ID/example/example:$COMMIT_SHA',
      '-t',
      'us-east4-docker.pkg.dev/$PROJECT_ID/example/example:latest',
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
    waitFor: ['test-coverage', 'test-runtime-container'],
    args: ['push', '--all-tags', 'us-east4-docker.pkg.dev/$PROJECT_ID/example/example'],
  },
  'migrate-plaid-scheduler-schema': {
    name: 'node:26.5.0-alpine',
    waitFor: ['push-runtime'],
    entrypoint: 'npm',
    args: ['run', 'db:migrate'],
    env: [
      'GCP_PROJECT_ID=example-production',
      'INSTANCE_CONNECTION_NAME=example-production:us-east4:example-prod-postgres',
      'DB_USER=postgres',
      'DB_IAM_USERS=cloudbuild@example-production.iam',
      'DB_NAME=example',
    ],
    secretEnv: ['DB_PASSWORD'],
    timeout: '600s',
  },
  'verify-plaid-scheduler-schema': {
    name: 'node:26.5.0-alpine',
    entrypoint: 'npm',
    args: ['run', 'db:verify-plaid-scheduler'],
    env: [
      'GCP_PROJECT_ID=example-production',
      'INSTANCE_CONNECTION_NAME=example-production:us-east4:example-prod-postgres',
      'DB_USER=postgres',
      'DB_NAME=example',
    ],
    secretEnv: ['DB_PASSWORD'],
    waitFor: ['migrate-plaid-scheduler-schema'],
    timeout: '600s',
  },
  'deploy-runtime': {
    name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
    waitFor: ['verify-plaid-scheduler-schema'],
    entrypoint: 'gcloud',
    args: [
      'run',
      'deploy',
      'example',
      '--image=us-east4-docker.pkg.dev/$PROJECT_ID/example/example:$COMMIT_SHA',
      '--region=us-east4',
      '--platform=managed',
      '--allow-unauthenticated',
      '--memory=1Gi',
      '--cpu=1',
      '--port=8080',
      '--startup-probe=httpGet.path=/health,httpGet.port=8080,periodSeconds=5,timeoutSeconds=3,failureThreshold=24',
      '--liveness-probe=httpGet.path=/health,httpGet.port=8080,periodSeconds=30,timeoutSeconds=5,failureThreshold=3',
      '--timeout=1800s',
      '--service-account=cloudbuild@example-production.iam.gserviceaccount.com',
      '--set-env-vars=NODE_ENV=production,OBSERVABILITY_USER_EMAILS=user@example.invalid,OBSERVABILITY_GCP_PROJECT=example-production,OBSERVABILITY_GCP_REGION=us-east4,OBSERVABILITY_GCP_SERVICE=example,OBSERVABILITY_SQL_INSTANCE=example-prod-postgres,OBSERVABILITY_APPLE_APP_ID=1234567890,OBSERVABILITY_APPLE_PRODUCT_ID=dabfcc70-f6f5-5f43-a7e3-9ca927af6f2e,EXAMPLE_BUILD_SHA=$COMMIT_SHA,GCP_PROJECT_ID=example-production,INSTANCE_CONNECTION_NAME=example-production:us-east4:example-prod-postgres,DB_IAM_USER=cloudbuild@example-production.iam,DB_NAME=example,GCS_ASSET_BUCKET=example-production-public-assets,GCS_PROFILE_MEDIA_BUCKET=example-production-private-profile-media,FOUNDATION_COPY_V2=1,PLAID_WEBHOOK_URL=https://www.example.invalid/api/plaid/webhook,PLAID_SCHEDULER_ENV=production,PLAID_SWEEP_WORK_TIMEOUT_MS=3000000,PLAID_SWEEP_ACQUIRE_TIMEOUT_MS=3600000,PLAID_SCHEDULED_HTTP_WORK_TIMEOUT_MS=1200000,ENABLE_PLAID_SYNC_CRON=true,ENABLE_PRODUCTION_E2E_USER_ADMIN=true,WEB_TRUSTED_ORIGINS=https://example.invalid|https://www.example.invalid,WEB_TRUST_PROXY_HOPS=1,CSP_MODE=report-only,PUSH_TOKEN_CLEANUP_SCHEDULER_AUDIENCE=${_PUSH_TOKEN_CLEANUP_BASE_URL},PUSH_TOKEN_CLEANUP_SCHEDULER_SERVICE_ACCOUNT=${_PUSH_TOKEN_CLEANUP_SCHEDULER_SERVICE_ACCOUNT},NOTIFICATION_SCHEDULER_AUDIENCE=${_NOTIFICATION_BASE_URL},NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT=${_NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT},NOTIFICATIONS_DELIVERY_ENABLED=${_NOTIFICATIONS_DELIVERY_ENABLED},APNS_BUNDLE_ID=com.examplewealth.exampleapp,APNS_ENABLED_ENVIRONMENTS=production',
      '--set-secrets=ADMIN_USER_EMAILS=ADMIN_USER_EMAILS:2,IDENTITY_PLATFORM_API_KEY=IDENTITY_PLATFORM_SERVER_API_KEY:latest,AUTH_CODE_PEPPER=AUTH_CODE_PEPPER:latest,PRODUCTION_E2E_ADMIN_SECRET=PRODUCTION_E2E_ADMIN_SECRET:latest,GROQ_API_KEY=GROQ_API_KEY:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,PLAID_ENV=PLAID_ENV:latest,PLAID_CLIENT_ID=PLAID_CLIENT_ID:latest,PLAID_SECRET=PLAID_SECRET:latest,BREVO_SMTP_USER=BREVO_SMTP_USER:latest,BREVO_SMTP_PASS=BREVO_SMTP_PASS:latest,BRAVE_SEARCH_API_KEY=BRAVE_SEARCH_API_KEY:latest,APNS_KEY_CONTENT=APNS_KEY_CONTENT:latest,APNS_KEY_ID=APNS_KEY_ID:latest,APNS_TEAM_ID=APNS_TEAM_ID:latest${_OBSERVABILITY_SECRET_BINDINGS}${_APPLE_SIGN_IN_SECRET_BINDINGS}',
    ],
  },
  'configure-push-token-cleanup-trigger': {
    name: 'node:26.5.1-alpine',
    waitFor: ['deploy-runtime'],
    entrypoint: 'node',
    args: ['ci/cloudbuild/runtime/reconcilePushTokenCleanupScheduler.ts'],
    env: [
      'GCP_PROJECT_ID=$PROJECT_ID',
      'GCP_REGION=us-east4',
      'SCHEDULER_AUDIENCE=${_PUSH_TOKEN_CLEANUP_BASE_URL}',
      'SCHEDULER_SERVICE_ACCOUNT=${_PUSH_TOKEN_CLEANUP_SCHEDULER_SERVICE_ACCOUNT}',
    ],
  },
  'configure-notification-triggers': {
    name: 'node:26.5.1-alpine',
    waitFor: ['deploy-runtime'],
    entrypoint: 'node',
    args: ['ci/cloudbuild/runtime/reconcileNotificationSchedulers.ts'],
    env: [
      'GCP_PROJECT_ID=$PROJECT_ID',
      'GCP_REGION=us-east4',
      'SCHEDULER_AUDIENCE=${_NOTIFICATION_BASE_URL}',
      'SCHEDULER_SERVICE_ACCOUNT=${_NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT}',
    ],
  },
  'configure-plaid-webhook-recovery': {
    name: 'node:26.5.1-alpine',
    waitFor: ['deploy-runtime'],
    entrypoint: 'node',
    args: ['ci/cloudbuild/runtime/reconcilePlaidWebhookScheduler.ts'],
    env: [
      'GCP_PROJECT_ID=$PROJECT_ID',
      'GCP_REGION=us-east4',
      'SCHEDULER_AUDIENCE=${_NOTIFICATION_BASE_URL}',
      'SCHEDULER_SERVICE_ACCOUNT=${_NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT}',
    ],
  },
  'index-rag-docs': {
    name: 'node:26.5.1-alpine',
    waitFor: ['deploy-runtime'],
    entrypoint: 'npm',
    args: ['run', 'docs:rag:index'],
    env: [
      'GCP_PROJECT_ID=example-production',
      'INSTANCE_CONNECTION_NAME=example-production:us-east4:example-prod-postgres',
      'DB_IAM_USER=cloudbuild@example-production.iam',
      'DB_NAME=example',
    ],
    secretEnv: ['OPENAI_API_KEY'],
    timeout: '300s',
    allowFailure: true,
  },
} satisfies Record<ProductionStepId, Omit<CloudBuildStep<ProductionStepId>, 'id'>>;

// This typed source preserves the production build's pre-migration behavior.
export const productionBuild = {
  steps: productionStepIds.map(id => ({ id, ...steps[id] })),
  images: [
    'us-east4-docker.pkg.dev/$PROJECT_ID/example/example:$COMMIT_SHA',
    'us-east4-docker.pkg.dev/$PROJECT_ID/example/example:latest',
  ],
  timeout: '1800s',
  options: {
    machineType: 'E2_HIGHCPU_8',
    logging: 'CLOUD_LOGGING_ONLY',
  },
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
  substitutions: {
    _OBSERVABILITY_SECRET_BINDINGS: '',
    _APPLE_SIGN_IN_SECRET_BINDINGS: '',
    _NEXT_PUBLIC_AMPLITUDE_API_KEY: 'example-public-analytics-key',
    _NEXT_PUBLIC_POSTHOG_KEY: 'example-public-analytics-key',
    _PUSH_TOKEN_CLEANUP_BASE_URL: 'https://www.example.invalid',
    _PUSH_TOKEN_CLEANUP_SCHEDULER_SERVICE_ACCOUNT: 'cloudbuild@example-production.iam.gserviceaccount.com',
    _NOTIFICATION_BASE_URL: 'https://www.example.invalid',
    _NOTIFICATION_SCHEDULER_SERVICE_ACCOUNT: 'cloudbuild@example-production.iam.gserviceaccount.com',
    _NOTIFICATIONS_DELIVERY_ENABLED: 'false',
  },
} satisfies CloudBuild<ProductionStepId>;

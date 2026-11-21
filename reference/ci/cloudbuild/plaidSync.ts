import type { CloudBuildTarget } from './lib/emit.ts';
import type { CloudBuild } from './lib/types.ts';

export const plaidSyncTarget: CloudBuildTarget = {
  path: 'cloudbuild-plaid-sync.yaml',
  source: 'ci/cloudbuild/plaidSync.ts',
};

export const plaidSyncStepIds = [
  'install-dependencies',
  'build-image',
  'push-image',
  'migrate-plaid-scheduler-schema',
  'verify-plaid-scheduler-schema',
  'deploy-runtime',
  'grant-scheduler-invoker',
  'configure-trigger',
  'configure-orchestrator',
] as const;
export type PlaidSyncStepId = (typeof plaidSyncStepIds)[number];

const image = 'us-central1-docker.pkg.dev/$PROJECT_ID/example/plaid-sync';

/** The development Plaid sweep build keeps schema verification before deployment. */
export const plaidSyncBuild = {
  steps: [
    {
      name: 'node:26.5.0-alpine',
      id: 'install-dependencies',
      entrypoint: 'npm',
      args: ['ci', '--no-audit', '--no-fund'],
    },
    {
      name: 'gcr.io/cloud-builders/docker',
      id: 'build-image',
      args: [
        'build', '-f', 'Dockerfile.plaid-sync', '-t', `${image}:$COMMIT_SHA`,
        '-t', `${image}:latest`, '.',
      ],
    },
    {
      name: 'gcr.io/cloud-builders/docker',
      id: 'push-image',
      args: ['push', '--all-tags', image],
    },
    {
      name: 'node:26.5.0-alpine',
      id: 'migrate-plaid-scheduler-schema',
      entrypoint: 'npm',
      args: ['run', 'db:migrate'],
      env: [
        'GCP_PROJECT_ID=example-app',
        'INSTANCE_CONNECTION_NAME=example-app:us-central1:example-dev-postgres',
        'DB_USER=postgres',
        'DB_IAM_USERS=cloudbuild@example-app.iam,123456789012-compute@developer',
        'DB_NAME=example',
      ],
      secretEnv: ['DB_PASSWORD'],
      timeout: '600s',
    },
    {
      name: 'node:26.5.0-alpine',
      id: 'verify-plaid-scheduler-schema',
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
    {
      name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
      id: 'deploy-runtime',
      waitFor: ['verify-plaid-scheduler-schema'],
      entrypoint: 'gcloud',
      args: [
        'run', 'jobs', 'deploy', 'plaid-sync',
        `--image=${image}:$COMMIT_SHA`,
        '--region=us-central1',
        '--tasks=${_TASK_COUNT}',
        '--parallelism=${_TASK_COUNT}',
        '--task-timeout=${_JOB_TIMEOUT}',
        '--max-retries=2',
        '--cpu=${_TASK_CPU}',
        '--memory=${_TASK_MEMORY}',
        '--service-account=123456789012-compute@developer.gserviceaccount.com',
        '--set-env-vars=NODE_ENV=production,GCP_PROJECT_ID=example-app,INSTANCE_CONNECTION_NAME=example-app:us-central1:example-dev-postgres,DB_IAM_USER=123456789012-compute@developer,DB_NAME=example,GCS_ASSET_BUCKET=example-app-public-assets,PLAID_SCHEDULER_ENV=development,PLAID_SWEEP_CONCURRENCY=${_CONCURRENCY},PLAID_SWEEP_STALE_HOURS=${_STALE_HOURS},PLAID_SWEEP_ACQUIRE_TIMEOUT_MS=${_ACQUIRE_TIMEOUT_MS},PLAID_SWEEP_WORK_TIMEOUT_MS=${_WORK_TIMEOUT_MS},PLAID_SWEEP_FAIL_ON_ERRORS=false',
        '--set-secrets=IDENTITY_PLATFORM_API_KEY=IDENTITY_PLATFORM_SERVER_API_KEY:latest,AUTH_CODE_PEPPER=AUTH_CODE_PEPPER:latest,GROQ_API_KEY=GROQ_API_KEY:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest,PLAID_ENV=PLAID_ENV:latest,PLAID_CLIENT_ID=PLAID_CLIENT_ID:latest,PLAID_SECRET=PLAID_SECRET:latest',
      ],
    },
    {
      name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
      id: 'grant-scheduler-invoker',
      waitFor: ['deploy-runtime'],
      entrypoint: 'gcloud',
      args: [
        'run', 'jobs', 'add-iam-policy-binding', 'plaid-sync',
        '--project=$PROJECT_ID',
        '--region=us-central1',
        '--member=serviceAccount:${_SCHEDULER_SERVICE_ACCOUNT}',
        '--role=roles/run.invoker',
        '--quiet',
      ],
    },
    {
      name: 'node:26.5.0-alpine',
      id: 'configure-trigger',
      waitFor: ['deploy-runtime', 'grant-scheduler-invoker'],
      entrypoint: 'node',
      args: ['ci/cloudbuild/runtime/reconcilePlaidSyncScheduler.ts'],
      env: [
        'GCP_PROJECT_ID=$PROJECT_ID',
        'GCP_REGION=us-central1',
        'SCHEDULER_SERVICE_ACCOUNT=${_SCHEDULER_SERVICE_ACCOUNT}',
        'PLAID_SYNC_CRON=${_PLAID_SYNC_CRON}',
        'SCHEDULER_TIME_ZONE=${_SCHEDULER_TIME_ZONE}',
      ],
    },
    {
      name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
      id: 'configure-orchestrator',
      waitFor: ['configure-trigger'],
      entrypoint: 'gcloud',
      args: [
        'run', 'services', 'update', 'example', '--project=$PROJECT_ID',
        '--region=us-central1',
        '--update-env-vars=ENABLE_PLAID_SYNC_CRON=false,PLAID_SYNC_VIA_JOB=true,SCHEDULER_CRON=${_ORCHESTRATOR_CRON},SCHEDULER_TZ=${_SCHEDULER_TIME_ZONE}',
        '--quiet',
      ],
    },
  ],
  images: [`${image}:$COMMIT_SHA`, `${image}:latest`],
  timeout: '1800s',
  options: { logging: 'CLOUD_LOGGING_ONLY' },
  availableSecrets: {
    secretManager: [{
      versionName: 'projects/$PROJECT_ID/secrets/DATABASE_ADMIN_PASSWORD/versions/latest',
      env: 'DB_PASSWORD',
    }],
  },
  substitutions: {
    _TASK_COUNT: '4',
    _CONCURRENCY: '15',
    _STALE_HOURS: '0',
    _JOB_TIMEOUT: '4800s',
    _ACQUIRE_TIMEOUT_MS: '1200000',
    _WORK_TIMEOUT_MS: '3000000',
    _TASK_CPU: '1',
    _TASK_MEMORY: '1Gi',
    _SCHEDULER_SERVICE_ACCOUNT: '123456789012-compute@developer.gserviceaccount.com',
    _PLAID_SYNC_CRON: '0 2 * * *',
    _ORCHESTRATOR_CRON: '0 7 * * *',
    _SCHEDULER_TIME_ZONE: 'America/New_York',
  },
} as const satisfies CloudBuild<PlaidSyncStepId>;

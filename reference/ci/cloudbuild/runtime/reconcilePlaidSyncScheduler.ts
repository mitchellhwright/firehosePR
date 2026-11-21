import {
  googleSchedulerRuntime, reconcileHttpScheduler, requiredSchedulerEnvironment as required,
  validSchedulerIdentity, type OAuthHttpTarget, type SchedulerJob as SharedSchedulerJob,
  type SchedulerRuntime as SharedSchedulerRuntime,
} from './schedulerRuntime.ts';

/** Reconcile the development Plaid sweep timer after its Cloud Run Job is deployed. */
export interface PlaidSyncSchedulerInputs {
  readonly project: string;
  readonly region: string;
  readonly serviceAccount: string;
  readonly schedule: string;
  readonly timeZone: string;
}

export interface PlaidSyncSchedulerJob extends SharedSchedulerJob {
  readonly httpTarget: OAuthHttpTarget;
}
export type SchedulerRuntime = SharedSchedulerRuntime<PlaidSyncSchedulerJob>;

export function plaidSyncSchedulerJob(inputs: PlaidSyncSchedulerInputs): PlaidSyncSchedulerJob {
  if (!validSchedulerIdentity(inputs)
    || !inputs.schedule.trim() || !inputs.timeZone.trim()) {
    throw new Error('Invalid Plaid scheduler inputs');
  }
  return {
    name: `projects/${inputs.project}/locations/${inputs.region}/jobs/plaid-sync-daily`,
    schedule: inputs.schedule,
    timeZone: inputs.timeZone,
    httpTarget: {
      uri: `https://run.googleapis.com/v2/projects/${inputs.project}`
        + `/locations/${inputs.region}/jobs/plaid-sync:run`,
      httpMethod: 'POST',
      oauthToken: { serviceAccountEmail: inputs.serviceAccount },
    },
  };
}

export async function reconcilePlaidSyncScheduler(
  inputs: PlaidSyncSchedulerInputs,
  runtime: SchedulerRuntime,
): Promise<void> {
  await reconcileHttpScheduler(plaidSyncSchedulerJob(inputs), runtime);
}

async function main(): Promise<void> {
  const inputs: PlaidSyncSchedulerInputs = {
    project: required('GCP_PROJECT_ID'),
    region: required('GCP_REGION'),
    serviceAccount: required('SCHEDULER_SERVICE_ACCOUNT'),
    schedule: required('PLAID_SYNC_CRON'),
    timeZone: required('SCHEDULER_TIME_ZONE'),
  };
  plaidSyncSchedulerJob(inputs); // Validate before requesting metadata credentials.
  await reconcilePlaidSyncScheduler(inputs, await googleSchedulerRuntime<PlaidSyncSchedulerJob>());
}

if (process.argv[1]?.endsWith('/reconcilePlaidSyncScheduler.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

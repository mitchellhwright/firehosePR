import {
  cloudRunServiceUrl, googleSchedulerRuntime, reconcileHttpScheduler,
  requiredSchedulerEnvironment as required, validateSchedulerInputs,
  type HttpSchedulerJob, type SchedulerInputs, type SchedulerRuntime,
} from './schedulerRuntime.ts';

/** Reconcile the recovery timer after the corresponding Cloud Run revision is live. */
export interface PlaidWebhookSchedulerJob extends HttpSchedulerJob {
  readonly schedule: '* * * * *';
  readonly retryConfig: {
    readonly retryCount: 3; readonly minBackoffDuration: '10s'; readonly maxBackoffDuration: '60s';
  };
}

export function plaidWebhookSchedulerJob(
  project: string,
  region: string,
  serviceUrl: string,
  audience: string,
  serviceAccount: string,
): PlaidWebhookSchedulerJob {
  validateSchedulerInputs({ project, region, audience, serviceAccount }, serviceUrl);
  return {
    name: `projects/${project}/locations/${region}/jobs/example-plaid-webhook-drain`,
    schedule: '* * * * *',
    timeZone: 'UTC',
    attemptDeadline: '300s',
    retryConfig: { retryCount: 3, minBackoffDuration: '10s', maxBackoffDuration: '60s' },
    httpTarget: {
      uri: `${serviceUrl.replace(/\/$/, '')}/api/plaid/sync/webhook-drain`,
      httpMethod: 'POST',
      oidcToken: { serviceAccountEmail: serviceAccount, audience },
    },
  };
}


export async function reconcilePlaidWebhookScheduler(
  inputs: SchedulerInputs, runtime: SchedulerRuntime<PlaidWebhookSchedulerJob>,
): Promise<void> {
  validateSchedulerInputs(inputs);
  const service = await runtime.request(
    `https://run.googleapis.com/v2/projects/${inputs.project}/locations/${inputs.region}/services/example`, 'GET',
  );
  const job = plaidWebhookSchedulerJob(inputs.project, inputs.region, cloudRunServiceUrl(service),
    inputs.audience, inputs.serviceAccount);
  await reconcileHttpScheduler(job, runtime);
}
async function main(): Promise<void> {
  const inputs = {
    project: required('GCP_PROJECT_ID'), region: required('GCP_REGION'),
    serviceAccount: required('SCHEDULER_SERVICE_ACCOUNT'), audience: required('SCHEDULER_AUDIENCE'),
  };
  validateSchedulerInputs(inputs);
  await reconcilePlaidWebhookScheduler(inputs, await googleSchedulerRuntime<PlaidWebhookSchedulerJob>());
}
if (process.argv[1]?.endsWith('/reconcilePlaidWebhookScheduler.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

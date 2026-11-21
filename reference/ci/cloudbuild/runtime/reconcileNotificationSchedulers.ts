import {
  cloudRunServiceUrl, googleSchedulerRuntime, reconcileHttpScheduler,
  requiredSchedulerEnvironment as required, validateSchedulerInputs,
  type HttpSchedulerJob, type SchedulerInputs, type SchedulerRuntime,
} from './schedulerRuntime.ts';

/** Native timers preserve evaluate → dispatch → deliver offsets and bounded OIDC workers. */
const WORKERS = {
  evaluate: '*/15 * * * *',
  dispatch: '5,20,35,50 * * * *',
  deliver: '10,25,40,55 * * * *',
} as const;
type Worker = keyof typeof WORKERS;
export function notificationSchedulerJobs(inputs: SchedulerInputs, serviceUrl: string): readonly HttpSchedulerJob[] {
  validateSchedulerInputs(inputs, serviceUrl);
  return (Object.keys(WORKERS) as Worker[]).map(worker => ({
    name: `projects/${inputs.project}/locations/${inputs.region}/jobs/example-notification-${worker}`,
    schedule: WORKERS[worker], timeZone: 'UTC', attemptDeadline: '300s',
    httpTarget: {
      uri: `${serviceUrl.replace(/\/$/, '')}/api/notifications/maintenance/${worker}`,
      httpMethod: 'POST',
      oidcToken: { serviceAccountEmail: inputs.serviceAccount, audience: inputs.audience },
    },
  }));
}
export async function reconcileNotificationSchedulers(
  inputs: SchedulerInputs, runtime: SchedulerRuntime<HttpSchedulerJob>,
): Promise<void> {
  validateSchedulerInputs(inputs);
  const service = await runtime.request(
    `https://run.googleapis.com/v2/projects/${inputs.project}/locations/${inputs.region}/services/example`, 'GET',
  );
  const jobs = notificationSchedulerJobs(inputs, cloudRunServiceUrl(service));
  // Preserve deterministic worker order and stop on any unconfirmed API result.
  for (const job of jobs) await reconcileHttpScheduler(job, runtime);
}
async function main(): Promise<void> {
  const inputs = {
    project: required('GCP_PROJECT_ID'), region: required('GCP_REGION'),
    audience: required('SCHEDULER_AUDIENCE'), serviceAccount: required('SCHEDULER_SERVICE_ACCOUNT'),
  };
  validateSchedulerInputs(inputs);
  await reconcileNotificationSchedulers(inputs, await googleSchedulerRuntime<HttpSchedulerJob>());
}
if (process.argv[1]?.endsWith('/reconcileNotificationSchedulers.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

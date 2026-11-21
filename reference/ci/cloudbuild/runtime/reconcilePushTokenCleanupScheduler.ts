import { cloudRunServiceUrl, googleSchedulerRuntime, reconcileHttpScheduler, validateSchedulerInputs, requiredSchedulerEnvironment as required } from './schedulerRuntime.ts';

/** Reconcile the push-token cleanup timer after the Cloud Run service is deployed. */
export interface PushTokenSchedulerInputs {
  readonly project: string;
  readonly region: string;
  readonly serviceUrl: string;
  readonly audience: string;
  readonly serviceAccount: string;
}

export interface PushTokenSchedulerJob {
  readonly name: string;
  readonly schedule: '* * * * *';
  readonly timeZone: 'UTC';
  readonly attemptDeadline: '300s';
  readonly httpTarget: {
    readonly uri: string;
    readonly httpMethod: 'POST';
    readonly oidcToken: {
      readonly serviceAccountEmail: string;
      readonly audience: string;
    };
  };
}

export interface PushTokenSchedulerRuntime {
  readonly request: (url: string, method: 'GET' | 'POST' | 'PATCH', body?: PushTokenSchedulerJob)
    => Promise<unknown | null>;
  readonly log: (message: string) => void;
}

export function pushTokenSchedulerJob(inputs: PushTokenSchedulerInputs): PushTokenSchedulerJob {
  validateSchedulerInputs(inputs, inputs.serviceUrl);
  return {
    name: `projects/${inputs.project}/locations/${inputs.region}/jobs/example-push-token-cleanup`,
    schedule: '* * * * *',
    timeZone: 'UTC',
    attemptDeadline: '300s',
    httpTarget: {
      uri: `${inputs.serviceUrl.replace(/\/$/, '')}/api/auth/maintenance/logout-cleanup`,
      httpMethod: 'POST',
      oidcToken: {
        serviceAccountEmail: inputs.serviceAccount,
        audience: inputs.audience,
      },
    },
  };
}

export async function reconcilePushTokenCleanupScheduler(
  inputs: Omit<PushTokenSchedulerInputs, 'serviceUrl'>,
  runtime: PushTokenSchedulerRuntime,
): Promise<void> {
  validateSchedulerInputs(inputs);
  const service = await runtime.request(
    `https://run.googleapis.com/v2/projects/${inputs.project}/locations/${inputs.region}/services/example`,
    'GET',
  );
  const job = pushTokenSchedulerJob({ ...inputs, serviceUrl: cloudRunServiceUrl(service) });
  await reconcileHttpScheduler(job, runtime);
}

async function main(): Promise<void> {
  const inputs = {
    project: required('GCP_PROJECT_ID'),
    region: required('GCP_REGION'),
    audience: required('SCHEDULER_AUDIENCE'),
    serviceAccount: required('SCHEDULER_SERVICE_ACCOUNT'),
  };
  validateSchedulerInputs(inputs);
  await reconcilePushTokenCleanupScheduler(inputs, await googleSchedulerRuntime<PushTokenSchedulerJob>());
}

if (process.argv[1]?.endsWith('/reconcilePushTokenCleanupScheduler.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

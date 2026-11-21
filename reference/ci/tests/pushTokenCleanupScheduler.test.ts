import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pushTokenSchedulerJob,
  reconcilePushTokenCleanupScheduler,
  type PushTokenSchedulerRuntime,
} from '../cloudbuild/runtime/reconcilePushTokenCleanupScheduler.ts';

const inputs = {
  project: 'example-app',
  region: 'us-central1',
  audience: 'https://s.example.invalid',
  serviceAccount: '123456789012-compute@developer.gserviceaccount.com',
};
const serviceUrl = 'https://example-abc123-uc.a.run.app';

test('the cleanup job uses the deployed Cloud Run URL and configured OIDC audience', () => {
  assert.deepEqual(pushTokenSchedulerJob({ ...inputs, serviceUrl }), {
    name: 'projects/example-app/locations/us-central1/jobs/example-push-token-cleanup',
    schedule: '* * * * *',
    timeZone: 'UTC',
    attemptDeadline: '300s',
    httpTarget: {
      uri: `${serviceUrl}/api/auth/maintenance/logout-cleanup`,
      httpMethod: 'POST',
      oidcToken: {
        serviceAccountEmail: inputs.serviceAccount,
        audience: inputs.audience,
      },
    },
  });
  assert.throws(() => pushTokenSchedulerJob({ ...inputs, serviceUrl: 'http://unsafe' }),
    /Invalid scheduler inputs/);
});

test('an absent cleanup job is created with the live service URL', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const logs: string[] = [];
  const job = pushTokenSchedulerJob({ ...inputs, serviceUrl });
  const runtime: PushTokenSchedulerRuntime = {
    request: async (url, method, body) => {
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.includes('/services/example')) return { uri: serviceUrl };
      return method === 'GET' ? null : job;
    },
    log: message => { logs.push(message); },
  };
  await reconcilePushTokenCleanupScheduler(inputs, runtime);
  assert.deepEqual(calls, [
    {
      url: 'https://run.googleapis.com/v2/projects/example-app/locations/us-central1/services/example',
      method: 'GET',
    },
    { url: `https://cloudscheduler.googleapis.com/v1/${job.name}`, method: 'GET' },
    {
      url: 'https://cloudscheduler.googleapis.com/v1/projects/example-app/locations/us-central1/jobs',
      method: 'POST', body: job,
    },
  ]);
  assert.deepEqual(logs, [`Reconciled ${job.name}`]);
});

test('an existing cleanup job is patched with the complete target', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const job = pushTokenSchedulerJob({ ...inputs, serviceUrl });
  const runtime: PushTokenSchedulerRuntime = {
    request: async (url, method, body) => {
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.includes('/services/example')) return { uri: serviceUrl };
      return job;
    },
    log: () => {},
  };
  await reconcilePushTokenCleanupScheduler(inputs, runtime);
  assert.deepEqual(calls.at(-1), {
    url: `https://cloudscheduler.googleapis.com/v1/${job.name}`
      + '?updateMask=schedule,timeZone,attemptDeadline,httpTarget',
    method: 'PATCH', body: job,
  });
});

test('missing service URL and unconfirmed scheduler mutations fail closed', async () => {
  const job = pushTokenSchedulerJob({ ...inputs, serviceUrl });
  await assert.rejects(reconcilePushTokenCleanupScheduler(inputs, {
    request: async () => ({ name: job.name }),
    log: () => {},
  }), /Cloud Run service has no URL/);
  await assert.rejects(reconcilePushTokenCleanupScheduler(inputs, {
    request: async (url, method) => url.includes('/services/example')
      ? { uri: serviceUrl }
      : method === 'GET' ? null : { ...job, attemptDeadline: '60s' },
    log: () => {},
  }), /did not apply/);
});

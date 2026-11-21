import assert from 'node:assert/strict';
import test from 'node:test';

import {
  plaidSyncSchedulerJob,
  reconcilePlaidSyncScheduler,
  type PlaidSyncSchedulerInputs,
  type SchedulerRuntime,
} from '../cloudbuild/runtime/reconcilePlaidSyncScheduler.ts';

const inputs: PlaidSyncSchedulerInputs = {
  project: 'example-app',
  region: 'us-central1',
  serviceAccount: '123456789012-compute@developer.gserviceaccount.com',
  schedule: '0 2 * * *',
  timeZone: 'America/New_York',
};

test('the Plaid timer targets the Cloud Run Job with a Google API OAuth token', () => {
  assert.deepEqual(plaidSyncSchedulerJob(inputs), {
    name: 'projects/example-app/locations/us-central1/jobs/plaid-sync-daily',
    schedule: '0 2 * * *',
    timeZone: 'America/New_York',
    httpTarget: {
      uri: 'https://run.googleapis.com/v2/projects/example-app/locations/us-central1/jobs/plaid-sync:run',
      httpMethod: 'POST',
      oauthToken: { serviceAccountEmail: inputs.serviceAccount },
    },
  });
  assert.throws(() => plaidSyncSchedulerJob({ ...inputs, serviceAccount: 'invalid' }),
    /Invalid Plaid scheduler inputs/);
});

test('an absent Plaid timer is created once with the complete typed job', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const logs: string[] = [];
  const job = plaidSyncSchedulerJob(inputs);
  const runtime: SchedulerRuntime = {
    request: async (url, method, body) => {
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      return method === 'GET' ? null : job;
    },
    log: message => { logs.push(message); },
  };
  await reconcilePlaidSyncScheduler(inputs, runtime);
  assert.deepEqual(calls, [
    { url: `https://cloudscheduler.googleapis.com/v1/${job.name}`, method: 'GET' },
    {
      url: 'https://cloudscheduler.googleapis.com/v1/projects/example-app/locations/us-central1/jobs',
      method: 'POST', body: job,
    },
  ]);
  assert.deepEqual(logs, [`Reconciled ${job.name}`]);
});

test('an existing Plaid timer is patched, and an unconfirmed response fails closed', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const job = plaidSyncSchedulerJob(inputs);
  const runtime: SchedulerRuntime = {
    request: async (url, method, body) => {
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      return method === 'GET' ? { name: job.name } : job;
    },
    log: () => {},
  };
  await reconcilePlaidSyncScheduler(inputs, runtime);
  assert.deepEqual(calls, [
    { url: `https://cloudscheduler.googleapis.com/v1/${job.name}`, method: 'GET' },
    {
      url: `https://cloudscheduler.googleapis.com/v1/${job.name}`
        + '?updateMask=schedule,timeZone,httpTarget',
      method: 'PATCH', body: job,
    },
  ]);
  await assert.rejects(
    reconcilePlaidSyncScheduler(inputs, {
      request: async () => ({ name: 'projects/other/locations/us-central1/jobs/plaid-sync-daily' }),
      log: () => {},
    }),
    /did not confirm/,
  );
  await assert.rejects(
    reconcilePlaidSyncScheduler(inputs, {
      request: async (_url, method) => method === 'GET'
        ? { name: job.name }
        : { ...job, schedule: '0 3 * * *' },
      log: () => {},
    }),
    /did not apply/,
  );
});

test('the shared client verifies OAuth identity without claiming ownership of native deadline or retry defaults', async () => {
  const job = plaidSyncSchedulerJob(inputs);
  const urls: string[] = [];
  await reconcilePlaidSyncScheduler(inputs, {
    log: () => {}, request: async (url, method) => {
      urls.push(url);
      return method === 'GET' ? { name: job.name }
        : { ...job, attemptDeadline: '180s', retryConfig: { retryCount: 0 } };
    },
  });
  assert.ok(urls[1]?.endsWith('?updateMask=schedule,timeZone,httpTarget'));
  for (const httpTarget of [
    { ...job.httpTarget, oauthToken: { serviceAccountEmail: 'other@example-app.iam.gserviceaccount.com' } },
    { uri: job.httpTarget.uri, httpMethod: 'POST', oidcToken: { serviceAccountEmail: inputs.serviceAccount, audience: 'https://run.googleapis.com' } },
  ]) {
    await assert.rejects(reconcilePlaidSyncScheduler(inputs, {
      log: () => {}, request: async (_url, method) => method === 'GET'
        ? { name: job.name } : { ...job, httpTarget },
    }), /did not apply/);
  }
});

test('invalid Plaid sync environment is rejected before any API access', async () => {
  for (const invalid of [
    { ...inputs, project: '../other' }, { ...inputs, region: 'us/central1' },
    { ...inputs, serviceAccount: 'invalid' }, { ...inputs, schedule: ' ' }, { ...inputs, timeZone: ' ' },
  ]) {
    let called = false;
    await assert.rejects(reconcilePlaidSyncScheduler(invalid, {
      log: () => {}, request: async () => { called = true; return null; },
    }), /Invalid Plaid scheduler inputs/);
    assert.equal(called, false);
  }
});

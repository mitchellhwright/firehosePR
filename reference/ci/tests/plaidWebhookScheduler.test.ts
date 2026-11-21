import assert from 'node:assert/strict';
import test from 'node:test';
import {
  plaidWebhookSchedulerJob, reconcilePlaidWebhookScheduler, type PlaidWebhookSchedulerJob,
} from '../cloudbuild/runtime/reconcilePlaidWebhookScheduler.ts';
import type { SchedulerRuntime } from '../cloudbuild/runtime/schedulerRuntime.ts';

const inputs = {
  project: 'example-app', region: 'us-central1', audience: 'https://s.example.invalid',
  serviceAccount: 'worker@example-app.iam.gserviceaccount.com',
};
const serviceUrl = 'https://example-cloud.run.app/';
const job = plaidWebhookSchedulerJob(inputs.project, inputs.region, serviceUrl,
  inputs.audience, inputs.serviceAccount);
function fixture(existing: unknown, applied: unknown = job) {
  const calls: Array<{ url: string; method: string; body?: PlaidWebhookSchedulerJob }> = [];
  const logs: string[] = [];
  const runtime: SchedulerRuntime<PlaidWebhookSchedulerJob> = {
    log: message => { logs.push(message); },
    request: async (url, method, body) => {
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.includes('run.googleapis.com')) return { uri: serviceUrl };
      return method === 'GET' ? existing : applied;
    },
  };
  return { calls, logs, runtime };
}
test('webhook recovery preserves its one-minute OIDC timer, deadline and native retry policy', () => {
  assert.deepEqual(job, {
    name: 'projects/example-app/locations/us-central1/jobs/example-plaid-webhook-drain',
    schedule: '* * * * *', timeZone: 'UTC', attemptDeadline: '300s',
    retryConfig: { retryCount: 3, minBackoffDuration: '10s', maxBackoffDuration: '60s' },
    httpTarget: {
      uri: 'https://example-cloud.run.app/api/plaid/sync/webhook-drain', httpMethod: 'POST',
      oidcToken: { serviceAccountEmail: inputs.serviceAccount, audience: inputs.audience },
    },
  });
});
test('webhook create and update use the native API and confirm the owned fields before success', async () => {
  for (const existing of [null, { name: job.name, state: 'PAUSED' }]) {
    const { calls, logs, runtime } = fixture(existing);
    await reconcilePlaidWebhookScheduler(inputs, runtime);
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.method, existing === null ? 'POST' : 'PATCH');
    assert.equal(calls[2]?.url, existing === null
      ? 'https://cloudscheduler.googleapis.com/v1/projects/example-app/locations/us-central1/jobs'
      : `https://cloudscheduler.googleapis.com/v1/${job.name}?updateMask=schedule,timeZone,attemptDeadline,retryConfig,httpTarget`);
    assert.deepEqual(calls[2]?.body, job);
    assert.deepEqual(logs, [`Reconciled ${job.name}`]);
  }
});
test('a rejected or incorrectly applied retry, OIDC, target or deadline never reports success', async () => {
  for (const applied of [
    null, {}, { ...job, name: 'other' }, { ...job, schedule: '*/5 * * * *' },
    { ...job, timeZone: 'America/New_York' }, { ...job, attemptDeadline: '600s' },
    { ...job, retryConfig: { ...job.retryConfig, retryCount: 0 } },
    { ...job, retryConfig: { ...job.retryConfig, minBackoffDuration: '20s' } },
    { ...job, retryConfig: { ...job.retryConfig, maxBackoffDuration: '120s' } },
    { ...job, httpTarget: { ...job.httpTarget, oidcToken: { ...job.httpTarget.oidcToken, audience: 'https://other' } } },
    { ...job, httpTarget: { ...job.httpTarget, uri: 'https://other/worker' } },
    { ...job, httpTarget: { uri: job.httpTarget.uri, httpMethod: 'POST', oauthToken: { serviceAccountEmail: inputs.serviceAccount } } },
  ]) {
    const { runtime, logs } = fixture({ name: job.name }, applied);
    await assert.rejects(reconcilePlaidWebhookScheduler(inputs, runtime), /Cloud Scheduler did not/);
    assert.equal(logs.length, 0);
  }
  const { runtime, logs } = fixture({ name: job.name });
  await assert.rejects(reconcilePlaidWebhookScheduler(inputs, {
    ...runtime, request: async (url, method, body) => {
      if (url.includes('cloudscheduler')) throw new Error('Google API GET failed (403)');
      return runtime.request(url, method, body);
    },
  }), /failed \(403\)/);
  assert.equal(logs.length, 0);
});
test('webhook input validation precedes any service lookup or scheduler write', async () => {
  for (const invalid of [
    { ...inputs, project: '../other' }, { ...inputs, region: 'us/central1' },
    { ...inputs, audience: 'https://user:secret@example.com' }, { ...inputs, serviceAccount: 'invalid' },
  ]) {
    const { calls, runtime } = fixture(null);
    await assert.rejects(reconcilePlaidWebhookScheduler(invalid, runtime), /Invalid scheduler inputs/);
    assert.equal(calls.length, 0);
  }
  assert.throws(() => plaidWebhookSchedulerJob(inputs.project, inputs.region,
    'https://host/?token=secret', inputs.audience, inputs.serviceAccount), /Invalid scheduler inputs/);
});

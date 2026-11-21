import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationSchedulerJobs, reconcileNotificationSchedulers } from '../cloudbuild/runtime/reconcileNotificationSchedulers.ts';
import { googleSchedulerRuntime, type HttpSchedulerJob, type SchedulerRuntime } from '../cloudbuild/runtime/schedulerRuntime.ts';
const inputs = {
  project: 'example-app', region: 'us-central1', audience: 'https://s.example.invalid',
  serviceAccount: 'worker@example-app.iam.gserviceaccount.com',
};
const serviceUrl = 'https://example-cloud.run.app/';

test('notification native timers preserve bounded authenticated worker order and offsets', () => {
  const jobs = notificationSchedulerJobs(inputs, serviceUrl);
  assert.deepEqual(jobs.map(job => [job.name.split('/').at(-1), job.schedule, job.httpTarget.uri]), [
    ['example-notification-evaluate', '*/15 * * * *', 'https://example-cloud.run.app/api/notifications/maintenance/evaluate'],
    ['example-notification-dispatch', '5,20,35,50 * * * *', 'https://example-cloud.run.app/api/notifications/maintenance/dispatch'],
    ['example-notification-deliver', '10,25,40,55 * * * *', 'https://example-cloud.run.app/api/notifications/maintenance/deliver'],
  ]);
  for (const job of jobs) {
    assert.equal(job.attemptDeadline, '300s');
    assert.equal(job.timeZone, 'UTC');
    assert.equal(job.httpTarget.httpMethod, 'POST');
    assert.deepEqual(job.httpTarget.oidcToken, { audience: inputs.audience, serviceAccountEmail: inputs.serviceAccount });
  }
});
function fixture(existing: boolean, mutate?: (job: HttpSchedulerJob) => unknown) {
  const calls: Array<{ url: string; method: string; body?: HttpSchedulerJob }> = [];
  const runtime: SchedulerRuntime<HttpSchedulerJob> = {
    log: () => undefined,
    request: async (url, method, body) => {
      calls.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (url.includes('run.googleapis.com')) return { uri: serviceUrl };
      if (method === 'GET') return existing ? { name: url.split('/v1/')[1] } : null;
      if (!body) throw new Error('Missing scheduler body');
      return mutate ? mutate(body) : body;
    },
  };
  return { calls, runtime };
}
test('missing jobs are created once and existing jobs patch only owned fields', async () => {
  for (const existing of [false, true]) {
    const { calls, runtime } = fixture(existing);
    await reconcileNotificationSchedulers(inputs, runtime);
    const writes = calls.filter(call => call.method !== 'GET');
    assert.equal(writes.length, 3);
    assert.deepEqual(writes.map(call => call.method), Array(3).fill(existing ? 'PATCH' : 'POST'));
    for (const write of writes) {
      assert.ok(existing ? write.url.endsWith('?updateMask=schedule,timeZone,attemptDeadline,httpTarget')
        : write.url.endsWith('/locations/us-central1/jobs'));
    }
  }
});
test('invalid environment is rejected before any service or scheduler request', async () => {
  for (const invalid of [
    { ...inputs, project: '../other' }, { ...inputs, region: 'us/central1' },
    { ...inputs, audience: 'http://insecure.example' },
    { ...inputs, audience: 'https://user:password@example.com' },
    { ...inputs, serviceAccount: '' },
  ]) {
    const { calls, runtime } = fixture(false);
    await assert.rejects(reconcileNotificationSchedulers(invalid, runtime), /Invalid scheduler inputs/);
    assert.equal(calls.length, 0);
  }
  assert.throws(() => notificationSchedulerJobs(inputs, 'https://host/?secret=value'), /Invalid scheduler inputs/);
});
test('unconfirmed schedule, OIDC or deadline stops before later workers', async () => {
  for (const mutate of [
    (job: HttpSchedulerJob) => ({ ...job, schedule: '* * * * *' }),
    (job: HttpSchedulerJob) => ({ ...job, attemptDeadline: '600s' }),
    (job: HttpSchedulerJob) => ({ ...job, httpTarget: { ...job.httpTarget, oidcToken: { ...job.httpTarget.oidcToken, audience: 'https://other' } } }),
    (job: HttpSchedulerJob) => ({ ...job, name: 'other-job' }),
  ]) {
    const { calls, runtime } = fixture(true, mutate);
    await assert.rejects(reconcileNotificationSchedulers(inputs, runtime), /Cloud Scheduler did not/);
    assert.equal(calls.filter(call => call.method !== 'GET').length, 1);
  }
});
test('an unreadable service or denied scheduler does not become a create attempt', async () => {
  for (const result of [null, {}, { uri: 'http://insecure.example' }]) {
    const calls: string[] = [];
    await assert.rejects(reconcileNotificationSchedulers(inputs, {
      log: () => undefined, request: async url => { calls.push(url); return result; },
    }));
    assert.equal(calls.length, 1);
  }
  const { calls, runtime } = fixture(false);
  const denied = { ...runtime, request: async (url: string, method: 'GET' | 'POST' | 'PATCH', body?: HttpSchedulerJob) => {
    if (url.includes('cloudscheduler')) throw new Error('HTTP 403');
    return runtime.request(url, method, body);
  } };
  await assert.rejects(reconcileNotificationSchedulers(inputs, denied), /HTTP 403/);
  assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
});
test('shared metadata API client treats only GET 404 as absence and suppresses response secrets', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let status = 404;
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, ...(init === undefined ? {} : { init }) });
    return url.includes('metadata.google.internal')
      ? Response.json({ access_token: 'test-only-token' })
      : Response.json({ message: 'response-secret' }, { status });
  };
  try {
    const runtime = await googleSchedulerRuntime<HttpSchedulerJob>();
    assert.equal(await runtime.request('https://cloudscheduler.googleapis.com/v1/test', 'GET'), null);
    status = 403;
    await assert.rejects(runtime.request('https://cloudscheduler.googleapis.com/v1/test', 'GET'), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, 'Google API GET failed (403)'); return true;
    });
    status = 404;
    await assert.rejects(runtime.request('https://cloudscheduler.googleapis.com/v1/test', 'POST'), /Google API POST failed/);
    assert.ok(calls.every(call => call.init?.redirect === 'error' && call.init.signal instanceof AbortSignal));
    assert.equal(calls.filter(call => call.url.includes('metadata.google.internal')).length, 1);
  } finally { globalThis.fetch = original; }
});

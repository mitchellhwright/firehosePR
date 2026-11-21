import assert from 'node:assert/strict';
import test from 'node:test';
import {
  promoteStaging,
  verifyBuildOwnership,
  verifyStaging,
  operationTimeoutMs,
  healthTimeoutMs,
  ownershipTimeoutMs,
  type PromotionInputs,
  type PromotionRuntime,
} from '../cloudbuild/runtime/stagingPromotion.ts';

const inputs: PromotionInputs = {
  project: 'example-app',
  region: 'us-central1',
  service: 'example',
  buildId: '01234567-abcd',
  commitSha: 'a'.repeat(40),
  healthUrl: 'https://s.example.invalid/api/health',
};
const current = {
  id: inputs.buildId,
  buildTriggerId: 'trigger',
  createTime: '2026-09-23T01:00:00.123456789Z',
};
const operationName = 'projects/example-app/locations/us-central1/operations/traffic';
const candidate = `example-${inputs.commitSha.slice(0, 12)}-01234567`;
function harness() {
  let time = 0;
  const requests: { url: string; body?: unknown; deadline: number }[] = [];
  const state = {
    builds: [current],
    latest: candidate,
    operation: { name: operationName, done: false } as Record<string, unknown>,
    healthAfter: 0,
    healthFailure: false,
    requestDuration: 0,
    onSleep: (_time: number) => {},
  };
  const logs: string[] = [];
  const runtime: PromotionRuntime = {
    now: () => time,
    sleep: async (milliseconds) => {
      time += milliseconds;
      state.onSleep(time);
    },
    log: (message) => logs.push(message),
    health: async () => {
      time += state.requestDuration;
      if (state.healthFailure) throw new Error('temporary 503');
      return { buildSha: time >= state.healthAfter ? inputs.commitSha : 'b'.repeat(40) };
    },
    request: async (url, deadline, body) => {
      requests.push({ url, deadline, ...(body === undefined ? {} : { body }) });
      if (url.includes('/builds/')) return current;
      if (url.includes('/builds?')) return { builds: state.builds };
      if (body !== undefined || url.includes('/operations/')) return { ...state.operation };
      return { latestCreatedRevision: state.latest, etag: '"opaque/etag+="' };
    },
  };
  return { runtime, state, requests, logs, elapsed: () => time };
}

test('promotion waits for the actual long-running operation with an opaque etag', async () => {
  const h = harness();
  h.state.onSleep = (time) => {
    if (time >= 60_000) h.state.operation = { name: operationName, done: true, response: {} };
  };
  await promoteStaging(inputs, h.runtime);
  assert.equal(h.elapsed(), 60_000);
  const patch = h.requests.find((request) => request.body !== undefined);
  assert.deepEqual(patch?.body, {
    name: 'projects/example-app/locations/us-central1/services/example',
    etag: '"opaque/etag+="',
    traffic: [
      { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: candidate, percent: 100 },
    ],
  });
  assert.ok(h.requests.some((request) => request.url.endsWith('/operations/traffic')));
  assert.ok(h.logs.at(-1)?.includes('completed'));
});

test('early ownership rejects a superseded build before requesting Cloud Run', async () => {
  const h = harness();
  h.state.builds.push({
    ...current,
    id: 'newer',
    createTime: '2026-09-23T01:00:00.123456790Z',
  });
  await assert.rejects(verifyBuildOwnership(inputs, h.runtime), /Superseded by newer build newer/);
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.every(request => request.deadline === ownershipTimeoutMs));
  assert.ok(h.requests.every(request => request.url.includes('/builds')));
});

test('early ownership accepts only a current same-trigger build', async () => {
  const h = harness();
  h.state.builds.push({ ...current, id: 'other', buildTriggerId: 'other', createTime: '2026-09-23T02:00:00Z' });
  await verifyBuildOwnership(inputs, h.runtime);
  assert.ok(h.logs.at(-1)?.includes(inputs.buildId));
  const missing = harness();
  missing.state.builds = [];
  await assert.rejects(verifyBuildOwnership(inputs, missing.runtime), /visibility did not complete within 60 seconds/);
  assert.equal(missing.elapsed(), ownershipTimeoutMs);
});

test('early ownership tolerates a briefly stale build listing', async () => {
  const h = harness();
  h.state.builds = [];
  h.state.onSleep = () => { h.state.builds = [current]; };
  await verifyBuildOwnership(inputs, h.runtime);
  assert.equal(h.elapsed(), 2_000);
});

test('operation errors and malformed completion never pass promotion', async () => {
  for (const operation of [
    { name: operationName, done: true, error: { code: 13, message: 'failed' } },
    { name: operationName, done: true },
    { name: 'projects/other/locations/us-central1/operations/traffic', done: false },
    { name: operationName, done: 'true' },
  ]) {
    const h = harness();
    h.state.operation = operation;
    await assert.rejects(promoteStaging(inputs, h.runtime));
  }
});

test('operation timeout is a real 300 second deadline', async () => {
  const h = harness();
  await assert.rejects(promoteStaging(inputs, h.runtime), /within 300 seconds/);
  assert.equal(h.elapsed(), operationTimeoutMs);
  assert.ok(h.requests.every((request) => request.deadline === operationTimeoutMs));
});

test('health propagation after the old 48 second poll window is accepted', async () => {
  const h = harness();
  h.state.healthAfter = 90_000;
  await verifyStaging(inputs, h.runtime);
  assert.equal(h.elapsed(), 90_000);
  assert.ok(h.logs.at(-1)?.includes(inputs.commitSha));
});

test('wrong revision and transient health failures honor the real 120 second deadline', async () => {
  for (const healthFailure of [false, true]) {
    const h = harness();
    h.state.healthAfter = Infinity;
    h.state.healthFailure = healthFailure;
    await assert.rejects(verifyStaging(inputs, h.runtime), /within 120 seconds/);
    assert.equal(h.elapsed(), healthTimeoutMs);
  }
});

test('slow health requests cannot report success past the deadline', async () => {
  const h = harness();
  h.state.requestDuration = healthTimeoutMs + 1;
  await assert.rejects(verifyStaging(inputs, h.runtime), /within 120 seconds/);
});

test('newer same-trigger builds stop both waits, including sub-millisecond creation differences', async () => {
  for (const run of [promoteStaging, verifyStaging]) {
    const h = harness();
    h.state.healthAfter = Infinity;
    h.state.onSleep = () => {
      h.state.builds = [
        current,
        { ...current, id: 'newer', createTime: '2026-09-23T01:00:00.123456790Z' },
      ];
    };
    await assert.rejects(run(inputs, h.runtime), /Superseded by newer build newer/);
    assert.equal(h.elapsed(), 2_000);
  }
});

test('newer candidate blocks mutation and supersedes in-progress verification', async () => {
  const h = harness();
  h.state.latest = 'example-newer';
  await assert.rejects(promoteStaging(inputs, h.runtime), /Newer Cloud Run candidate/);
  assert.ok(!h.requests.some((request) => request.body !== undefined));
  await assert.rejects(verifyStaging(inputs, h.runtime), /Newer Cloud Run candidate/);
});

test('missing current build fails closed and unrelated triggers do not supersede', async () => {
  const missing = harness();
  missing.state.builds = [];
  await assert.rejects(
    promoteStaging(inputs, missing.runtime),
    /did not contain the current build/
  );
  const unrelated = harness();
  unrelated.state.builds.push({
    ...current,
    id: 'other',
    buildTriggerId: 'other',
    createTime: '2026-09-23T02:00:00Z',
  });
  unrelated.state.operation = { name: operationName, done: true, response: {} };
  await promoteStaging(inputs, unrelated.runtime);
});

test('Cloud Run canonical numeric project operation names remain valid', async () => {
  const h = harness();
  h.state.operation = {
    name: 'projects/123456789012/locations/us-central1/operations/traffic',
    done: true,
    response: {},
  };
  await promoteStaging(inputs, h.runtime);
});

test('ownership follows pagination and sends the supported create_time filter', async () => {
  const h = harness();
  const original = h.runtime.request;
  let pages = 0;
  const runtime: PromotionRuntime = {
    ...h.runtime,
    request: async (url, deadline, body) => {
      if (url.includes('/builds?')) {
        const query = new URL(url).searchParams;
        assert.equal(query.get('filter'), `create_time>="${current.createTime}"`);
        pages++;
        return query.has('pageToken')
          ? { builds: [current] }
          : { builds: [], nextPageToken: 'page-two' };
      }
      return original(url, deadline, body);
    },
  };
  await verifyStaging(inputs, runtime);
  assert.equal(pages, 4);
});

test('a newer build arriving during a successful health response prevents success', async () => {
  const h = harness();
  const runtime: PromotionRuntime = {
    ...h.runtime,
    health: async () => {
      h.state.builds.push({ ...current, id: 'newer', createTime: '2026-09-23T02:00:00Z' });
      return { buildSha: inputs.commitSha };
    },
  };
  await assert.rejects(verifyStaging(inputs, runtime), /Superseded by newer build newer/);
});

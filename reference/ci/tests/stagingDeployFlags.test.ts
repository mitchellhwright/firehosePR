import assert from 'node:assert/strict';
import test from 'node:test';
import { optionalStagingSecretGroups, requiredStagingSecrets, prepareStagingDeployFlags, probeStagingSecret,
  type OptionalStagingSecret } from '../cloudbuild/runtime/stagingDeployFlags.ts';
const inputs = { project: 'example-app', commitSha: 'a'.repeat(40), buildId: '72cd0b71-c565-5d2b-b6dd-a4ee94614cca' };

test('probes each optional secret once with four workers and preserves candidate traffic and revision identity', async () => {
  let active = 0; let peak = 0;
  const seen: OptionalStagingSecret[] = []; const logs: string[] = [];
  const flags = await prepareStagingDeployFlags(inputs, { log: value => logs.push(value), accessible: async secret => {
    seen.push(secret); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--; return true;
  } });
  assert.equal(peak, 4); assert.equal(seen.length, 13); assert.equal(new Set(seen).size, 13);
  assert.equal(flags['--no-traffic'], null);
  assert.equal(flags['--revision-suffix'], 'aaaaaaaaaaaa-12345678');
  assert.deepEqual(flags['--set-secrets'], { ...requiredStagingSecrets,
    ...Object.fromEntries(seen.map(secret => [secret, `${secret}:latest`])) });
  assert.equal(logs.length, 4);
  assert.ok(logs.every(value => JSON.parse(value).decision === 'bind'));
});
for (const group of optionalStagingSecretGroups) for (const missing of group.secrets) {
  test(`missing ${missing} omits exactly its entire optional group`, async () => {
    const logs: string[] = [];
    const flags = await prepareStagingDeployFlags(inputs, { log: value => logs.push(value), accessible: async secret => secret !== missing });
    for (const candidate of optionalStagingSecretGroups) for (const secret of candidate.secrets) {
      assert.equal(flags['--set-secrets'][secret], candidate.id === group.id ? undefined : `${secret}:latest`);
    }
    for (const [name, ref] of Object.entries(requiredStagingSecrets)) assert.equal(flags['--set-secrets'][name], ref);
    assert.equal(logs.filter(value => JSON.parse(value).decision === 'omit').length, 1);
  });
}
test('invalid source/project/build identities fail before accessing any credentials', async () => {
  for (const change of [{ project: 'example-production' }, { commitSha: 'short' }, { buildId: '../bad' }]) {
    await assert.rejects(prepareStagingDeployFlags({ ...inputs, ...change }, {
      log: () => assert.fail('invalid input logged'), accessible: async () => assert.fail('invalid input probed'),
    }), /Invalid staging deployment identity/);
  }
});
test('required secret references remain configured when all optional sources are unavailable', async () => {
  const flags = await prepareStagingDeployFlags(inputs, { log: () => {}, accessible: async () => false });
  assert.deepEqual(flags['--set-secrets'], requiredStagingSecrets);
});

test('real access probe cancels payload streams and checks only HTTP status with bounded authenticated requests', async () => {
  for (const status of [200, 403, 404, 500]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { status });
    response.json = async () => assert.fail('secret payload must never be decoded');
    response.text = async () => assert.fail('secret payload must never be read');
    const request: typeof fetch = async (url, init) => {
      assert.equal(url, 'https://secretmanager.googleapis.com/v1/projects/example-app/secrets/OBSERVABILITY_GITHUB_TOKEN/versions/latest:access');
      assert.deepEqual(init?.headers, { Authorization: 'Bearer test-only' });
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      return response;
    };
    assert.equal(await probeStagingSecret(inputs.project, 'test-only', 'OBSERVABILITY_GITHUB_TOKEN', request), status === 200);
    assert.equal(cancelled, true);
  }
  assert.equal(await probeStagingSecret(inputs.project, 'test-only', 'OBSERVABILITY_GITHUB_TOKEN', async () => {
    throw new Error('network timeout');
  }), false);
});

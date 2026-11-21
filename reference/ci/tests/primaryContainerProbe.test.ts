import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  primaryContainerProbe, requireHealthyHead, requireHealthyResponse,
  requireRuntimeIdentity, requireRuntimeStatus,
} from '../cloudbuild/runtime/primaryContainerProbe.ts';

test('container identity and Linux security status fail closed on privilege drift', () => {
  requireRuntimeIdentity(10001, 10001);
  for (const [uid, gid] of [[0, 10001], [10001, 0], [1000, 1000]]) {
    assert.ok(uid !== undefined && gid !== undefined);
    assert.throws(() => requireRuntimeIdentity(uid, gid));
  }
  requireRuntimeStatus('Name:\tnode\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n');
  for (const status of ['CapEff:\t0001\nNoNewPrivs:\t1\n',
    'CapEff:\t0000\nNoNewPrivs:\t0\n', 'NoNewPrivs:\t1\n', 'CapEff:\t0000\n']) {
    assert.throws(() => requireRuntimeStatus(status));
  }
});

test('health makes one bounded GET and validates structured status rather than matching text', async () => {
  let calls = 0;
  const request: typeof fetch = async (input, options) => {
    calls += 1;
    assert.equal(input, 'http://127.0.0.1:8080/health');
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options.method, undefined);
    return new Response('{"status":"ok"}', { status: 200 });
  };
  await requireHealthyResponse(request);
  assert.equal(calls, 1);
  for (const body of ['{"status":"bad"}', '{"message":"status:ok"}', 'null',
    '[{"status":"ok"}]', 'not json']) {
    await assert.rejects(requireHealthyResponse(async () => new Response(body)));
  }
  await assert.rejects(requireHealthyResponse(async () => new Response('{"status":"ok"}', { status: 503 })));
  await assert.rejects(requireHealthyResponse(async () => { throw new Error('connection refused'); }),
    /connection refused/);
});

test('HEAD has its own bounded request and requires exactly HTTP 200', async () => {
  await requireHealthyHead(async (input, options) => {
    assert.equal(input, 'http://127.0.0.1:8080/health');
    assert.equal(options?.method, 'HEAD');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(null, { status: 200 });
  });
  for (const status of [204, 404, 503]) {
    await assert.rejects(requireHealthyHead(async () => new Response(null, { status })));
  }
});

test('the Docker stdin interface rejects missing, unknown, or extra modes without running a probe', async () => {
  for (const args of [[], ['unknown'], ['health', 'extra']]) {
    await assert.rejects(primaryContainerProbe(args));
    const cli = spawnSync(process.execPath, ['--input-type=module-typescript', '-', ...args], {
      input: readFileSync('ci/cloudbuild/runtime/primaryContainerProbe.ts', 'utf8'), encoding: 'utf8',
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /exactly one probe mode|Unknown primary container probe/);
  }
});

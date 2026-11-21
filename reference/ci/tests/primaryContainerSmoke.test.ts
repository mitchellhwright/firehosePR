import assert from 'node:assert/strict';
import test from 'node:test';
import { primaryContainerSmoke, primaryImageId, type PrimarySmokeIo } from '../cloudbuild/runtime/primaryContainerSmoke.ts';
import type { RunOptions } from '../src/ios/shared/processRunner.ts';

const imageId = `sha256:${'a'.repeat(64)}`;
const metadata = {
  Id: imageId, Config: { User: '10001:10001', ExposedPorts: { '8080/tcp': {} },
    Healthcheck: { Test: ['CMD', 'node', '/health'] }, StopSignal: 'SIGTERM' },
};
const containerName = 'example-primary-smoke-1f9801bb-af6c-52c5-83b3-41d0a3c3070d';
function fixture(input: { fail?: string; health?: string; exit?: string; stopMs?: number; missing?: boolean } = {}) {
  let now = 1_000;
  const calls: { args: readonly string[]; options: RunOptions }[] = [];
  const logs: string[] = [];
  const io: PrimarySmokeIo = {
    now: () => now, sleep: async ms => { now += ms; }, docker: 'docker', env: {},
    probeSource: '/probe.ts', containerName, terminating: () => false, log: message => logs.push(message),
    run: async (_command, args, options = {}) => {
      calls.push({ args, options });
      if (input.fail && args.includes(input.fail)) return { status: 1, stdout: '', stderr: 'failed' };
      if (args[0] === 'image') {
        if (args.length === 3) return { status: input.missing ? 1 : 0, stdout: '', stderr: '' };
        return { status: 0, stdout: JSON.stringify(metadata), stderr: '' };
      }
      if (args[0] === 'stop') now += input.stopMs ?? 100;
      return { status: 0, stderr: '', stdout: args[0] === 'inspect'
        ? args.includes('--format') ? input.exit ?? '0'
          : JSON.stringify([{ State: { Running: true, Health: { Status: input.health ?? 'healthy' } } }])
        : '' };
    },
  };
  return { io, calls, logs };
}

test('invalid external image metadata fails before any runtime can start', () => {
  assert.equal(primaryImageId(JSON.stringify(metadata)), imageId);
  for (const config of [
    { ...metadata, Id: 'wrong' },
    { ...metadata, Config: { ...metadata.Config, User: '0:0' } },
    { ...metadata, Config: { ...metadata.Config, StopSignal: 'SIGKILL' } },
    { ...metadata, Config: { ...metadata.Config, ExposedPorts: {} } },
    { ...metadata, Config: { ...metadata.Config, Healthcheck: { Test: ['NONE'] } } },
    [], null,
  ]) assert.throws(() => primaryImageId(JSON.stringify(config)));
});

test('known images execute each security mode once with hardened flags and bounded shutdown', async () => {
  const f = fixture();
  await primaryContainerSmoke(f.io).run('test:known');
  assert.equal(f.calls.some(call => call.args[0] === 'build'), false);
  const probes = f.calls.filter(call => call.options.stdinFile);
  assert.deepEqual(probes.map(call => call.args.at(-1)),
    ['image-permissions', 'package-managers', 'health', 'runtime-permissions', 'head']);
  for (const probe of probes) {
    assert.ok(probe.args.includes('--input-type=module-typescript'));
    assert.equal(probe.options.stdinFile, '/probe.ts');
  }
  const start = f.calls.find(call => call.args.includes('--detach'));
  assert.ok(start);
  for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', containerName]) {
    assert.ok(start.args.includes(flag));
  }
  assert.deepEqual(f.calls.find(call => call.args[0] === 'stop')?.args,
    ['stop', '--time', '10', containerName]);
  assert.equal(f.calls.filter(call => call.args[0] === 'rm' && call.args.includes(containerName)).length, 1);
  assert.match(f.logs.at(-1) ?? '', /security smoke passed/);
});

test('the build fallback retains the selected image and local default builds explicitly', async () => {
  for (const image of [undefined, 'test:missing']) {
    const f = fixture({ missing: true });
    await primaryContainerSmoke(f.io).run(image);
    assert.deepEqual(f.calls.find(call => call.args[0] === 'build')?.args,
      ['build', '--tag', image ?? 'example-primary-container:test', '.']);
  }
});

test('lost start responses, failed probes, engine health and shutdown failures clean the owned container', async () => {
  for (const input of [
    { fail: '--detach' }, { fail: 'health' }, { health: 'unhealthy' },
    { health: 'starting' }, { exit: '137' }, { stopMs: 11_001 },
  ]) {
    const f = fixture(input);
    const smoke = primaryContainerSmoke(f.io);
    await assert.rejects(smoke.run('test:known'));
    await Promise.all([smoke.cleanup(), smoke.cleanup()]);
    assert.equal(f.calls.filter(call => call.args[0] === 'rm' && call.args.includes(containerName)).length, 1);
    assert.deepEqual(f.calls.find(call => call.args[0] === 'rm' && call.args.includes(containerName))?.args, ['rm', '-f', containerName]);
    assert.equal(f.logs.some(message => message.includes('security smoke passed')), false);
  }
});

test('invalid CLI images cannot become Docker options or shell code', async () => {
  for (const image of ['--privileged', 'test;echo unsafe', 'test image']) {
    const f = fixture();
    await assert.rejects(primaryContainerSmoke(f.io).run(image));
    assert.equal(f.calls.length, 0);
  }
});


test('timed out and cancelled probes remove their uniquely owned container exactly once', async () => {
  for (const mode of ['image-permissions', 'package-managers']) {
    for (const cancelled of [false, true]) {
      const f = fixture();
      let terminating = false;
      const original = f.io.run;
      const smoke = primaryContainerSmoke({ ...f.io, terminating: () => terminating,
        run: async (command, args, options) => {
          if (args[0] === 'run' && args.at(-1) === mode) {
            await original(command, args, options);
            if (cancelled) {
              terminating = true;
              await smoke.cleanup();
            }
            return { status: 124, stdout: '', stderr: 'probe timed out or cancelled' };
          }
          return original(command, args, options);
        },
      });
      await assert.rejects(smoke.run('test:known'));
      await smoke.cleanup();
      const name = `${containerName}-${mode}`;
      assert.deepEqual(f.calls.filter(call => call.args[0] === 'rm' && call.args.includes(name))
        .map(call => call.args), [['rm', '-f', name]]);
      assert.equal(f.calls.some(call => call.args.includes('--detach')), false);
    }
  }
});


test('signal cleanup waits for probe removal already started by finally', async () => {
  const f = fixture();
  const original = f.io.run;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const smoke = primaryContainerSmoke({ ...f.io, run: async (command, args, options) => {
    if (args[0] === 'run' && args.at(-1) === 'image-permissions') {
      return { status: 124, stdout: '', stderr: 'cancelled' };
    }
    if (args[0] === 'rm') { entered?.(); await pending; }
    return original(command, args, options);
  } });
  const result = assert.rejects(smoke.run('test:known'));
  await started;
  let finished = false;
  const cleanup = smoke.cleanup().then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  release?.();
  await Promise.all([result, cleanup]);
  assert.equal(finished, true);
  assert.equal(f.calls.filter(call => call.args[0] === 'rm').length, 1);
});

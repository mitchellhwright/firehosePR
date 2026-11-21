import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSetupCommand } from '../src/ios/shared/setupDeadline.ts';
import { runCommand } from '../src/ios/shared/processRunner.ts';

const environment = { ...process.env, IOS_CI_SETUP_TIMEOUT_SECONDS: undefined };

test('setup rejects malformed or extended deadlines before launching a command', async () => {
  for (const override of ['', '0', '-1', '1.5', 'no', '3', '999999999999999999999']) {
    await assert.rejects(runSetupCommand(2, ['missing-command'], {
      env: { ...environment, IOS_CI_SETUP_TIMEOUT_SECONDS: override }, capture: true,
    }), /must be positive/);
  }
  for (const requested of [0, -1, 1.5, NaN, Infinity, 2_147_484]) {
    await assert.rejects(runSetupCommand(requested, ['missing-command']), /bounded integer/);
  }
  await assert.rejects(runSetupCommand(1, []), /requires an executable/);
});

test('setup preserves ordinary command and spawn failures without inventing deadline failures', async () => {
  const result = await runSetupCommand(10, [process.execPath, '-e', 'process.exit(124)'], { env: environment, capture: true });
  assert.equal(result.status, 124);
  assert.equal(result.timedOut, undefined);
  assert.equal(result.stderr, '');
  assert.equal((await runSetupCommand(10, ['/missing-setup-executable'], { env: environment, capture: true })).status, 127);
});

test('a shortened deadline kills the owned process group and returns the setup timeout verdict', async () => {
  const source = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    console.log('descendant:' + child.pid);
    setInterval(() => {}, 1000);
  `;
  const started = Date.now();
  const result = await runSetupCommand(10, [process.execPath, '-e', source], {
    capture: true, env: { ...environment, IOS_CI_SETUP_TIMEOUT_SECONDS: '1' },
  });
  assert.equal(result.status, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /descendant:\d+/);
  assert.match(result.stderr, /exceeded 1s/);
  // The descendant inherits the captured pipe: close cannot settle until it exits too.
  assert.ok(Date.now() - started < 5_000, 'deadline must close descendant-held streams');
});

test('other process-runner callers retain their signal-derived timeout status', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100, capture: true });
  assert.equal(result.status, 137);
  assert.equal(result.timedOut, true);
});

test('the shell bootstrap uses the same typed owner and forwards literal arguments', async () => {
  const library = fileURLToPath(new URL('../../scripts/ios-ci-simulator-preparation.sh', import.meta.url));
  const result = await runCommand('bash', ['-c', 'source "$1"; shift; run_with_timeout "$@"', 'setup-test', library,
    '10', process.execPath, '-e', 'console.log(process.argv[1])', 'literal; $(false)'], { env: environment, capture: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'literal; $(false)');
});

test('the typed CLI reaps its command before reporting cancellation', async () => {
  const entry = fileURLToPath(new URL('../src/actions/ios/runSetupCommand.ts', import.meta.url));
  const child = spawn(process.execPath, [entry, '10', process.execPath, '-e',
    'console.log("ready"); setInterval(() => {}, 1000)'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  try {
    const [chunk] = await once(child.stdout, 'data');
    assert.match(String(chunk), /ready/);
    child.kill('SIGTERM');
    const [code, signal] = await closed;
    assert.equal(code, 143);
    assert.equal(signal, null);
  } finally {
    child.kill('SIGKILL');
  }
});

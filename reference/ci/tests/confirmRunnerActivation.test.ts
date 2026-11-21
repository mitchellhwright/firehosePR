import assert from 'node:assert/strict';
import { test } from 'node:test';

import { confirmRunnerActivation } from '../src/actions/confirmRunnerActivation.ts';

const context = 'runner-environment/ios-host-tg1/36241972905/1';
const logPath = '/home/example/.local/libexec/example-actions-runner/tg-1/activation.log';

function marker(state: 'success' | 'failure'): string {
  return JSON.stringify({ schema: 'example.runner-activation.v1', context, state });
}

test('a failed activation carries its host log in the error', async () => {
  const log = [
    '[2026-09-26T12:27:36Z] activating persisted runner environment for /home/example/runners/tg1',
    'Accepted activation token handoff (pid 4242)',
    'Runner service identity is missing under /home/example/runners/tg1.',
    'Activation process exiting with status 1',
  ].join('\n');
  await assert.rejects(
    confirmRunnerActivation({
      context,
      loadMarker: async () => marker('failure'),
      activationLog: { path: logPath, load: async () => `${log}\n` },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Runner activation reported failure for runner-environment\/ios-host-tg1/);
      assert.ok(error.message.includes(logPath));
      assert.match(error.message, /\| Runner service identity is missing under \/Users\/example-user\/runners\/tg1\./);
      return true;
    },
  );
});

test('log lines cannot start a workflow command in the failure output', async () => {
  await assert.rejects(
    confirmRunnerActivation({
      context,
      loadMarker: async () => marker('failure'),
      activationLog: { path: logPath, load: async () => '::add-mask::x\n::error::forged\n' },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const line of error.message.split('\n')) assert.doesNotMatch(line, /^::/);
      return true;
    },
  );
});

test('only the tail of a long activation log is reported', async () => {
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
  await assert.rejects(
    confirmRunnerActivation({
      context,
      loadMarker: async () => marker('failure'),
      activationLog: { path: logPath, load: async () => lines.join('\n') },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\| line 199$/);
      assert.doesNotMatch(error.message, /\| line 0\n/);
      assert.match(error.message, /showing the last 40 of 200 lines/);
      return true;
    },
  );
});

test('an unreadable activation log is named rather than hiding the failure', async () => {
  await assert.rejects(
    confirmRunnerActivation({
      context,
      loadMarker: async () => marker('failure'),
      activationLog: { path: logPath, load: async () => null },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Runner activation reported failure/);
      assert.ok(error.message.includes(`No activation log at ${logPath}`));
      return true;
    },
  );
});

test('a missing marker also reports the activation log', async () => {
  await assert.rejects(
    confirmRunnerActivation({
      context,
      loadMarker: async () => null,
      activationLog: { path: logPath, load: async () => 'Activation process exiting with status 1\n' },
    }),
    /left no marker[\s\S]*\| Activation process exiting with status 1/,
  );
});

test('a successful activation does not read the log', async () => {
  let read = false;
  const result = await confirmRunnerActivation({
    context,
    loadMarker: async () => marker('success'),
    activationLog: {
      path: logPath,
      load: async () => {
        read = true;
        return '';
      },
    },
  });
  assert.equal(result, 'success');
  assert.equal(read, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applySimulatorDefaults, prepareOwnedSimulator, setSimulatorContentSize,
  verifySimulatorContentSize, waitForSimulatorBoot, type SimulatorSetupIo,
} from '../src/ios/shared/simulatorPreparation.ts';
import type { CommandResult } from '../src/ios/shared/processRunner.ts';

interface Call { readonly seconds: number; readonly args: readonly string[]; readonly capture: boolean; }
const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });
function harness(respond: (call: Call) => CommandResult) {
  const calls: Call[] = [];
  const messages: string[] = [];
  let cancelled = false;
  const io: SimulatorSetupIo = {
    run: async (seconds, command, options) => {
      const call = { seconds, args: command.slice(1), capture: options?.capture === true };
      assert.equal(command[0], 'xcrun');
      calls.push(call);
      return respond(call);
    },
    report: message => { messages.push(message); },
    isCancelled: () => cancelled,
  };
  return { io, calls, messages, cancel: () => { cancelled = true; } };
}
const autofillRead = (call: Call): boolean => call.args.includes('read');

test('successful preparation verifies AutoFill before returning and keeps each command on the owned UDID', async () => {
  const h = harness(call => ok(autofillRead(call) ? '0\n' : ''));
  const udid = 'owned; $(touch /unexpected)';
  assert.equal(await prepareOwnedSimulator(udid, 'Main UI', {}, h.io), 0);
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every(call => call.args[2] === udid));
  assert.deepEqual(h.calls.map(call => call.seconds), [15, 120, 60, 15]);
  assert.ok(h.calls.at(-1)?.capture);
  assert.ok(h.messages.some(message => message.startsWith('Verified AutoFillPasswords=0')));
});

test('already booted simulator can proceed after the boot command rejects its existing state', async () => {
  const h = harness(call => call.args[1] === 'boot' ? { ...ok(), status: 149 } : ok(autofillRead(call) ? '0' : ''));
  assert.equal(await prepareOwnedSimulator('owned', 'Main UI', {}, h.io), 0);
  assert.equal(h.calls.some(call => call.args[1] === 'erase'), false);
});

test('one stalled boot triggers only owned-device shutdown and bounded erase recovery', async () => {
  let boots = 0;
  let erases = 0;
  const h = harness(call => {
    if (call.args[1] === 'bootstatus' && ++boots === 1) return { ...ok(), status: 124, timedOut: true };
    if (call.args[1] === 'erase' && ++erases === 1) return { ...ok(), status: 1 };
    return ok(autofillRead(call) ? '0' : '');
  });
  assert.equal(await prepareOwnedSimulator('owned', 'UI', {}, h.io), 0);
  assert.equal(boots, 2);
  assert.equal(erases, 2);
  assert.equal(h.calls.filter(call => call.args[1] === 'shutdown').length, 1);
  assert.ok(h.calls.every(call => call.args[2] === 'owned'));
});

test('exhausted boot and erase failures remain bounded and never apply defaults or run tests', async () => {
  const h = harness(() => ({ ...ok(), status: 1 }));
  assert.equal(await prepareOwnedSimulator('owned', 'UI', {}, h.io), 1);
  assert.equal(h.calls.filter(call => call.args[1] === 'bootstatus').length, 3);
  assert.equal(h.calls.filter(call => call.args[1] === 'erase').length, 6);
  assert.equal(h.calls.some(call => call.args[1] === 'spawn'), false);
  assert.match(h.messages.at(-1) ?? '', /failed to boot after 3 attempts/);
});

test('AutoFill failure is terminal after three write/read attempts and never erases a ready simulator', async () => {
  const h = harness(call => ok(autofillRead(call) ? '1\n' : ''));
  assert.equal(await prepareOwnedSimulator('owned', 'UI', {}, h.io), 1);
  assert.equal(h.calls.filter(autofillRead).length, 3);
  assert.equal(h.calls.some(call => call.args[1] === 'erase'), false);
});

test('AutoFill write failures retry without pretending the value was verified', async () => {
  const h = harness(() => ({ ...ok(), status: 124, timedOut: true }));
  assert.equal(await applySimulatorDefaults('owned', {}, h.io), 1);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls.some(autofillRead), false);
});

test('content size must match the observed simulator value, not just a successful write', async () => {
  let reads = 0;
  const h = harness(call => ok(call.args.length === 4 ? (++reads === 1 ? 'small\n' : 'large\n') : ''));
  assert.equal(await setSimulatorContentSize('owned', 'large', 'UI', {}, h.io), 0);
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every(call => call.seconds === 15));
  const mismatch = harness(() => ok('small'));
  assert.equal(await setSimulatorContentSize('owned', 'large', 'UI', {}, mismatch.io), 1);
  assert.equal(mismatch.calls.length, 6);
  const unreadable = harness(() => ({ ...ok(), status: 1 }));
  assert.equal(await verifySimulatorContentSize('owned', 'large', 'UI', {}, unreadable.io), 1);
});

test('cancellation at every boot recovery phase stops before further commands', async () => {
  for (const phase of ['boot', 'bootstatus', 'shutdown', 'erase']) {
    for (const status of [130, 143]) {
      const h = harness(call => ({ ...ok(), status: call.args[1] === phase ? status : 1 }));
      assert.equal(await prepareOwnedSimulator('owned', 'UI', {}, h.io), status);
      assert.equal(h.calls.at(-1)?.args[1], phase);
      assert.equal(h.calls.filter(call => call.args[1] === phase).length, 1);
    }
  }
});

test('cancellation during defaults or accessibility verification never restarts setup', async () => {
  for (const status of [130, 143]) {
    for (const readFails of [false, true]) {
      const h = harness(call => ({ ...ok(), status: autofillRead(call) === readFails ? status : 0 }));
      assert.equal(await applySimulatorDefaults('owned', {}, h.io), status);
      assert.equal(h.calls.length, readFails ? 2 : 1);
      const size = harness(call => ({ ...ok(), status: (call.args.length === 4) === readFails ? status : 0 }));
      assert.equal(await setSimulatorContentSize('owned', 'large', 'UI', {}, size.io), status);
      assert.equal(size.calls.length, readFails ? 2 : 1);
    }
  }
  const cancelled = harness(() => { throw new Error('no command may start after cancellation'); });
  cancelled.cancel();
  assert.equal(await waitForSimulatorBoot('owned', {}, cancelled.io), 143);
  assert.equal(await prepareOwnedSimulator('owned', 'UI', {}, cancelled.io), 143);
  assert.equal(await setSimulatorContentSize('owned', 'large', 'UI', {}, cancelled.io), 143);
});

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  iosShellHelperPaths,
  prepareSimulator,
  runWithTimeout,
  runXcodebuildWithBusyRetry,
  setAndVerifyContentSize,
  supplementalEvidencePhase,
} from '../src/ios/shared/iosShellHelpers.ts';
import { parseSimulatorInventory } from '../src/ios/shared/simulatorControl.ts';

/**
 * Typed setup and the remaining Busy bridge preserve executable argument vectors.
 * A value carrying shell metacharacters must therefore arrive intact and must
 * never be executed, so each test below uses a UDID that would run a command
 * if the bridge ever interpolated it into a shell string.
 */
const hostileUdid = 'UDID-1"; touch "$EXAMPLE_CANARY';

describe('iOS shell helper bridges', () => {
  let directory = '';
  let canary = '';

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'example-ios-helpers-'));
    canary = join(directory, 'canary');
    writeFileSync(join(directory, 'xcrun'), [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'require("node:fs").appendFileSync(process.env.EXAMPLE_SIMCTL_RECORD, JSON.stringify(args) + "\\n");',
      'if (args[1] === "spawn" && args[4] === "read") console.log("0");',
      'if (args[1] === "ui" && args.length === 4) console.log("large");',
      '',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(directory, 'ios-xctrunner-busy-retry.sh'), [
      '#!/usr/bin/env bash',
      'run_ios_xcodebuild_with_busy_retry() {',
      '  printf "%s\\n" "$@" > "$EXAMPLE_BUSY_RETRY_RECORD"',
      '  return 3',
      '}',
      '',
    ].join('\n'), 'utf8');
  });

  after(() => { rmSync(directory, { recursive: true, force: true }); });

  const helpers = (): ReturnType<typeof iosShellHelperPaths> => iosShellHelperPaths(directory);
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, EXAMPLE_CANARY: canary,
    PATH: `${directory}:${process.env.PATH}`, EXAMPLE_SIMCTL_RECORD: join(directory, 'simctl-record') });

  it('passes a hostile UDID to prepare_simulator as one inert argument', async () => {
    const status = await prepareSimulator(helpers(), hostileUdid, 'Account update', { env: env() });
    assert.equal(status, 0);
    const calls: unknown = JSON.parse(readFileSync(join(directory, 'simctl-record'), 'utf8').split('\n')[0] ?? 'null');
    assert.deepEqual(calls, ['simctl', 'boot', hostileUdid]);
    assert.equal(existsSync(canary), false);
  });

  it('propagates the content-size helper failure instead of masking it', async () => {
    assert.equal(
      await setAndVerifyContentSize(helpers(), 'UDID-1', 'accessibility-extra-large', 'Accessibility', { env: env() }),
      1,
    );
    assert.equal(
      await setAndVerifyContentSize(helpers(), 'UDID-1', 'large', 'Account update', { env: env() }),
      0,
    );
  });

  it('runs setup directly with an inert argument vector', async () => {
    const result = await runWithTimeout(helpers(), 15, [process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', hostileUdid], {
      capture: true,
      env: env(),
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), [hostileUdid]);
    assert.equal(existsSync(canary), false);
  });

  it('hands the busy-retry driver its phase, log and whole xcodebuild vector', async () => {
    const record = join(directory, 'busy-retry-record');
    const status = await runXcodebuildWithBusyRetry(
      helpers(),
      '/run/xcodebuild.log',
      [
        'test-without-building', '-destination', `platform=iOS Simulator,id=${hostileUdid}`,
        '-collect-test-diagnostics', 'never', '-resultBundlePath', '/run/tests.xcresult',
      ],
      { env: { ...env(), EXAMPLE_BUSY_RETRY_RECORD: record } },
    );
    assert.equal(status, 3, 'the helper status must reach the lane unchanged');
    assert.deepEqual(readFileSync(record, 'utf8').trim().split('\n'), [
      supplementalEvidencePhase,
      '/run/xcodebuild.log',
      'xcodebuild',
      'test-without-building',
      '-destination',
      `platform=iOS Simulator,id=${hostileUdid}`,
      '-collect-test-diagnostics',
      'never',
      '-resultBundlePath',
      '/run/tests.xcresult',
    ]);
    assert.equal(existsSync(canary), false);
  });

  it('resolves the remaining Busy recovery library', () => {
    const paths = iosShellHelperPaths('/repo/scripts');
    assert.equal(paths.busyRetry, '/repo/scripts/ios-xctrunner-busy-retry.sh');
  });
});

describe('parseSimulatorInventory', () => {
  const inventory = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: 'UDID-1', name: 'iPhone 17 Pro', state: 'Booted', deviceTypeIdentifier: 'com.apple.iPhone17Pro' },
        { udid: 'UDID-2', name: 'iPhone 16e', state: 'Shutdown' },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [
        { udid: 'UDID-3', name: 'iPhone 17', state: 'Shutdown', deviceTypeIdentifier: 'com.apple.iPhone17' },
      ],
    },
  });

  it('flattens every runtime and keeps each device with the runtime it belongs to', () => {
    const records = parseSimulatorInventory(inventory);
    assert.equal(records.size, 3);
    assert.equal(records.get('UDID-1')?.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-26-5');
    assert.equal(records.get('UDID-3')?.runtime, 'com.apple.CoreSimulator.SimRuntime.iOS-26-3');
    assert.equal(records.get('UDID-1')?.state, 'Booted');
  });

  it('reports an absent device model as empty rather than failing the lookup', () => {
    assert.equal(parseSimulatorInventory(inventory).get('UDID-2')?.deviceModel, '');
    assert.equal(parseSimulatorInventory(inventory).get('UDID-1')?.deviceModel, 'com.apple.iPhone17Pro');
  });

  it('returns nothing for a UDID simctl does not list', () => {
    assert.equal(parseSimulatorInventory(inventory).get('UDID-9'), undefined);
  });

  it('tolerates a runtime with no devices and rejects a payload with no devices key', () => {
    assert.equal(parseSimulatorInventory(JSON.stringify({ devices: { 'iOS-26-5': [] } })).size, 0);
    assert.throws(() => parseSimulatorInventory('{}'));
    assert.throws(() => parseSimulatorInventory('not json'));
  });
});

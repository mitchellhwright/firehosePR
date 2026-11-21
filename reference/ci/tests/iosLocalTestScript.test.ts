import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  executedTestCount,
  parseTestArguments,
  selectSimulator,
  type SimctlDevice,
  type SimulatorRequest,
} from '../../scripts/ios-test.ts';

const anyDevice: SimulatorRequest = { name: '', os: '', udid: '' };

const installed: Record<string, SimctlDevice[]> = {
  'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
    { udid: 'a-17-pro', name: 'iPhone 17 Pro' },
    { udid: 'a-17-pro-max', name: 'iPhone 17 Pro Max' },
  ],
  'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
    { udid: 'b-17e', name: 'iPhone 17e' },
    { udid: 'b-18-pro', name: 'iPhone 18 Pro' },
    { udid: 'b-se', name: 'iPhone SE (3rd generation)' },
    { udid: 'b-ipad', name: 'iPad Pro 13-inch (M5)' },
  ],
  'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
    { udid: 'w-1', name: 'Apple Watch Series 11' },
  ],
};

test('arguments become -only-testing filters and --no-build skips the build', () => {
  assert.deepEqual(parseTestArguments([]), { skipBuild: false, onlyTesting: [] });
  assert.deepEqual(
    parseTestArguments(['--no-build', 'example-iosTests/FooTests', 'example-iosTests/Bar/testBaz']),
    { skipBuild: true, onlyTesting: ['example-iosTests/FooTests', 'example-iosTests/Bar/testBaz'] },
  );
  assert.throws(() => parseTestArguments(['--parallel']), /Unknown option: --parallel/);
});

test('the newest iOS runtime wins, then the highest mainstream iPhone on it', () => {
  assert.deepEqual(selectSimulator(installed, anyDevice), {
    udid: 'b-18-pro', name: 'iPhone 18 Pro', os: '27.0',
  });
});

test('an OS request matches exactly, or by major version when bare', () => {
  assert.equal(selectSimulator(installed, { ...anyDevice, os: '26.5' })?.udid, 'a-17-pro-max');
  assert.equal(selectSimulator(installed, { ...anyDevice, os: '26' })?.udid, 'a-17-pro-max');
  assert.equal(selectSimulator(installed, { ...anyDevice, os: '26.4' }), undefined);
});

test('name and UDID requests pin one device', () => {
  assert.equal(selectSimulator(installed, { ...anyDevice, name: 'iPhone 17e' })?.udid, 'b-17e');
  assert.equal(selectSimulator(installed, { ...anyDevice, udid: 'a-17-pro' })?.name, 'iPhone 17 Pro');
  assert.equal(selectSimulator(installed, { ...anyDevice, name: 'iPhone 99' }), undefined);
});

test('unavailable devices, non-iPhones and non-iOS runtimes are never chosen', () => {
  const onlyUnavailable = {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { udid: 'gone', name: 'iPhone 18 Pro', isAvailable: false },
      { udid: 'ipad', name: 'iPad Air 11-inch (M4)' },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'w', name: 'iPhone lookalike' }],
  };
  assert.equal(selectSimulator(onlyUnavailable, anyDevice), undefined);
});

test('the executed count reads XCTest and Swift Testing summaries and is zero when nothing ran', () => {
  assert.equal(executedTestCount('\t Executed 39 tests, with 0 failures (0 unexpected)'), 39);
  assert.equal(executedTestCount('Executed 0 tests\n✔ Test run with 12 tests passed'), 12);
  assert.equal(executedTestCount('Executed 1 test, with 0 failures'), 1);
  assert.equal(executedTestCount('** TEST EXECUTE SUCCEEDED **'), 0);
});

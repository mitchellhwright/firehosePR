import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyBusySession,
  hasBusyRunnerLaunchDenial,
  logShowsTestExecution,
  summaryProvesNoTestRan,
} from '../src/ios/xctrunnerBusy.ts';
import type { BusySession } from '../src/ios/xctrunnerBusy.ts';

/*
 * Fixtures are real CI output. busy-launch-denial: job 108938746718 (run
 * 36350727685 attempt 2, native1), whose "affected UI tests" session found its
 * simulator shut down by the previous session, booted it, and had the
 * .xctrunner launch denied as Busy before SpringBoard finished booting.
 * test-failure: job 108942002557 (run 36350434642 attempt 2, native2), where a
 * UI test ran and failed an assertion.
 */
const fixtures = fileURLToPath(new URL('./fixtures/xctrunner-busy/', import.meta.url));
const read = (name: string): string => readFileSync(join(fixtures, name), 'utf8');
const readJson = (name: string): unknown => JSON.parse(read(name)) as unknown;

const busyLog = read('busy-launch-denial.xcodebuild.txt');
const busySummary = readJson('busy-launch-denial.summary.json');
const failureLog = read('test-failure.xcodebuild.txt');
const failureSummary = readJson('test-failure.summary.json');
const destination = 'platform=iOS Simulator,id=e01c7fcc-a979-5ac4-8589-0f0e5fab4a4e';

const busySession: BusySession = { status: 65, destination, log: busyLog, summary: busySummary };

function withSummary(changes: Readonly<Record<string, unknown>>): unknown {
  return { ...(busySummary as Record<string, unknown>), ...changes };
}

function assertRefused(session: BusySession, reason: RegExp): void {
  const verdict = classifyBusySession(session);
  assert.equal(verdict.retryable, false);
  if (!verdict.retryable) assert.match(verdict.reason, reason);
}

test('the recorded Busy launch denial is retryable', () => {
  assert.deepEqual(classifyBusySession(busySession), { retryable: true });
});

test('the recorded summary counts the runner launch failure as one failed test', () => {
  // This is the condition the shell rule required to be all zeros, which is
  // why the retry never fired for this failure.
  assert.equal(summaryProvesNoTestRan(busySummary), true);
  assert.equal(logShowsTestExecution(busyLog), false);
  assert.equal(hasBusyRunnerLaunchDenial(busyLog), true);
});

test('a session whose UI test ran and failed is never retried', () => {
  assertRefused(
    { status: 65, destination, log: failureLog, summary: failureSummary },
    /no Busy \.xctrunner launch denial/,
  );
  assert.equal(logShowsTestExecution(failureLog), true);
  assert.equal(summaryProvesNoTestRan(failureSummary), false);
});

test('a Busy denial after a test ran in the same session is not retried', () => {
  const log = `${failureLog}\n${busyLog}`;
  assertRefused({ status: 65, destination, log, summary: busySummary }, /test started, passed or failed/);
  assertRefused(
    { ...busySession, log: `${busyLog}\nTest suite 'LoginUITests' started on 'Clone 1 of iPhone'\n` },
    /test started/,
  );
  assertRefused(
    { ...busySession, log: `${busyLog}\n✔ Test run with 3 tests passed after 1.2 seconds.\n` },
    /test started/,
  );
  assertRefused({ ...busySession, log: `${busyLog}\nExecuted 4 tests, with 0 failures\n` }, /test started/);
});

test('the summary must record nothing but runner launch failures', () => {
  const refused = /xcresult summary/;
  assertRefused({ ...busySession, summary: withSummary({ passedTests: 1, totalTestCount: 2 }) }, refused);
  assertRefused({ ...busySession, summary: withSummary({ skippedTests: 1, totalTestCount: 2 }) }, refused);
  // A passed or skipped test refuses the retry even when the totals disagree.
  assertRefused({ ...busySession, summary: withSummary({ passedTests: 1 }) }, refused);
  assertRefused({ ...busySession, summary: withSummary({ skippedTests: 1 }) }, refused);
  assertRefused({ ...busySession, summary: withSummary({ expectedFailures: 1 }) }, refused);
  assertRefused({ ...busySession, summary: withSummary({ totalTestCount: 2 }) }, refused);
  assertRefused({ ...busySession, summary: withSummary({ failedTests: 2, totalTestCount: 2 }) }, refused);
  assertRefused({ ...busySession, summary: withSummary({ failedTests: '1' }) }, refused);
  assertRefused({ ...busySession, summary: withSummary({ totalTestCount: undefined }) }, refused);
  assertRefused({ ...busySession, summary: withSummary({ testFailures: undefined }) }, refused);
  assertRefused({ ...busySession, summary: undefined }, refused);
  assertRefused({ ...busySession, summary: [] }, refused);
});

test('a failure recorded under a real test name is not a runner launch failure', () => {
  const [recorded] = (busySummary as { testFailures: Record<string, unknown>[] }).testFailures;
  assert.ok(recorded);
  const renamed = { ...recorded, testName: 'testLinkedCard()' };
  assertRefused({ ...busySession, summary: withSummary({ testFailures: [renamed] }) }, /xcresult summary/);
  const otherError = { ...recorded, failureText: 'Failed to install or launch the test runner. (Timed out)' };
  assertRefused({ ...busySession, summary: withSummary({ testFailures: [otherError] }) }, /xcresult summary/);
  const assertion = { ...recorded, failureText: 'XCTAssertTrue failed. Application failed preflight checks' };
  assertRefused({ ...busySession, summary: withSummary({ testFailures: [assertion] }) }, /xcresult summary/);
});

test('an all-zero summary still proves that no test ran', () => {
  assert.equal(summaryProvesNoTestRan({
    totalTestCount: 0, passedTests: 0, failedTests: 0, skippedTests: 0, expectedFailures: 0,
  }), true);
});

test('status, destination and every log marker are required', () => {
  assertRefused({ ...busySession, status: 1 }, /exited 1, not 65/);
  assertRefused({ ...busySession, status: 0 }, /exited 0/);
  assertRefused({ ...busySession, destination: 'platform=iOS Simulator,name=iPhone 17 Pro' }, /simulator UDID/);
  assertRefused({ ...busySession, destination: 'platform=iOS,id=00008110' }, /simulator UDID/);
  assertRefused(
    { ...busySession, log: busyLog.replaceAll('.xctrunner', '.app') },
    /no Busy/,
  );
  assertRefused(
    { ...busySession, log: busyLog.replaceAll('Application failed preflight checks', 'Denied') },
    /no Busy/,
  );
  assertRefused(
    { ...busySession, log: busyLog.replaceAll('Busy', 'Denied') },
    /no Busy/,
  );
});

const action = fileURLToPath(new URL('../src/actions/ios/classifyXctrunnerBusyFailure.ts', import.meta.url));

function runAction(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [action, ...args], { encoding: 'utf8', env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('the action refuses a Busy log whose result bundle is missing and says why', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xctrunner-busy-'));
  try {
    const log = join(directory, 'phase.log');
    writeFileSync(log, busyLog);
    const result = runAction(['65', destination, log, join(directory, 'missing.xcresult')]);
    assert.equal(result.status, 1);
    assert.match(result.output, /::notice::The \.xctrunner Busy launch denial is not retried: the xcresult summary/);

    writeFileSync(log, failureLog);
    const quiet = runAction(['65', destination, log, join(directory, 'missing.xcresult')]);
    assert.equal(quiet.status, 1);
    assert.equal(quiet.output, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the action reads the xcresult only for a session whose log shows the Busy denial', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xctrunner-busy-'));
  try {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    const marker = join(directory, 'xcrun-called');
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(xcrun, 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` };
    const bundle = join(directory, 'phase.xcresult');
    mkdirSync(bundle);
    const log = join(directory, 'phase.log');

    writeFileSync(log, failureLog);
    assert.equal(runAction(['65', destination, log, bundle], env).status, 1);
    assert.equal(runAction(['0', destination, log, bundle], env).status, 1);
    assert.equal(existsSync(marker), false, 'a non-Busy session must not read its xcresult');

    writeFileSync(log, busyLog);
    assert.equal(runAction(['65', destination, log, bundle], env).status, 1);
    assert.equal(existsSync(marker), true, 'a Busy-looking session reads its xcresult');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the action rejects malformed arguments', () => {
  assert.equal(runAction([]).status, 2);
  assert.equal(runAction(['sixty-five', destination, 'a.log', 'b.xcresult']).status, 2);
  assert.equal(runAction(['65', destination, 'a.log', 'b.xcresult', 'extra']).status, 2);
});

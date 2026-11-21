import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { validateXcresultSummary, xcresultSummaryMatches } from '../src/ios/xcresultSummary.ts';
import type { XcresultSummaryIo } from '../src/ios/xcresultSummary.ts';

import { classifyIosChangedPaths, XCRESULT_SUMMARY_INPUTS } from '../src/ios/iosChangeClassification.ts';
import { iosFileOwner } from '../src/ios/changedFileOwnership.ts';

const passed = { totalTestCount: 5, passedTests: 5, failedTests: 0, skippedTests: 0, expectedFailures: 0, result: 'Passed' };

test('only the complete exact passing XCTest summary proves selected coverage', () => {
  assert.equal(xcresultSummaryMatches(passed, 5), true);
  for (const summary of [null, [], {}, { ...passed, result: 'Failed' },
    { ...passed, totalTestCount: 0, passedTests: 0 }, { ...passed, passedTests: 4 },
    { ...passed, failedTests: 1 }, { ...passed, skippedTests: 1 },
    { ...passed, expectedFailures: 1 }, { ...passed, totalTestCount: '5' },
    { ...passed, passedTests: true }, { ...passed, failedTests: undefined }]) {
    assert.equal(xcresultSummaryMatches(summary, 5), false, JSON.stringify(summary));
  }
  for (const expected of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(xcresultSummaryMatches(passed, expected), false);
  }
});

test('invalid requests or a missing bundle never start the evidence reader', async () => {
  let calls = 0;
  const io: XcresultSummaryIo = { isDirectory: () => false, error: () => {}, notice: () => {},
    run: async () => { calls++; return { status: 0, stdout: JSON.stringify(passed), stderr: '' }; } };
  for (const count of ['0', '-1', '1.5', '5x', '9007199254740992', ' 5', '05', 5]) {
    assert.equal(await validateXcresultSummary('/missing', count, 'Suite', {}, io), 2);
  }
  assert.equal(await validateXcresultSummary('', 5, 'Suite', {}, io), 2);
  assert.equal(await validateXcresultSummary('/missing', 5, '', {}, io), 2);
  assert.equal(calls, 0);
});

test('reader failure, cancellation and malformed JSON cannot become passing evidence', async () => {
  for (const [status, stdout, expected] of [[65, JSON.stringify(passed), 65], [143, JSON.stringify(passed), 143],
    [0, '{broken', 1], [0, JSON.stringify({ ...passed, skippedTests: 1 }), 1], [0, JSON.stringify(passed), 0]] as const) {
    const io: XcresultSummaryIo = { isDirectory: () => true, error: () => {}, notice: () => {},
      run: async (command, args, options) => {
        assert.equal(command, 'xcrun');
        assert.deepEqual(args, ['xcresulttool', 'get', 'test-results', 'summary', '--path', '/results suite.xcresult', '--format', 'json']);
        assert.equal(options?.capture, true);
        return { status, stdout, stderr: '' };
      } };
    assert.equal(await validateXcresultSummary('/results suite.xcresult', 5, 'Suite', {}, io), expected);
  }
});

test('the shell bootstrap and typed CLI read actual evidence with inert argument vectors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'example-xcresult-summary-'));
  try {
    const bundle = join(directory, 'result; touch canary.xcresult');
    mkdirSync(bundle);
    const record = join(directory, 'args.json');
    writeFileSync(join(directory, 'xcrun'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.EXAMPLE_ARGS_RECORD, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(process.env.EXAMPLE_SUMMARY);\nprocess.exitCode=Number(process.env.EXAMPLE_READER_STATUS || '0');\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, EXAMPLE_ARGS_RECORD: record, EXAMPLE_SUMMARY: JSON.stringify(passed) };
    const bootstrap = resolve('scripts/validate-xcresult-summary.sh');
    assert.match(execFileSync('bash', [bootstrap, bundle, '5', 'Suite'], { env, encoding: 'utf8' }), /5 tests passed/);
    assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundle, '--format', 'json']);
    for (const [summary, status, expected] of [[JSON.stringify({ ...passed, skippedTests: 1 }), '0', 1], ['not JSON', '0', 1], [JSON.stringify(passed), '65', 65]] as const) {
      assert.equal(spawnSync('bash', [bootstrap, bundle, '5', 'Suite'], { env: { ...env, EXAMPLE_SUMMARY: summary, EXAMPLE_READER_STATUS: status } }).status, expected);
    }
    assert.equal(spawnSync('bash', [bootstrap, bundle, '5'], { env }).status, 2);
    assert.equal(spawnSync('bash', [bootstrap, bundle, '5', 'Suite', 'extra'], { env }).status, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('all validator entry points retain the existing affected lane and native contract owners', () => {
  const prior = classifyIosChangedPaths(['scripts/validate-xcresult-summary.sh']);
  for (const path of XCRESULT_SUMMARY_INPUTS) {
    assert.deepEqual(classifyIosChangedPaths([path]), { ...prior, iosChangedFiles: [path] });
    assert.equal(iosFileOwner(path), 'workflow');
  }
});

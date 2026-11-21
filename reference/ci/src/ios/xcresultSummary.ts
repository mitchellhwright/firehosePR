import { statSync } from 'node:fs';

import { annotateError, logLine } from './shared/actionIo.ts';
import { runCommand } from './shared/processRunner.ts';
import type { RunOptions } from './shared/processRunner.ts';

export interface XcresultSummaryIo {
  readonly run: typeof runCommand;
  readonly isDirectory: (path: string) => boolean;
  readonly error: (message: string) => void;
  readonly notice: (message: string) => void;
}

const defaultIo: XcresultSummaryIo = {
  run: runCommand,
  isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
  error: annotateError,
  notice: logLine,
};

/** External XCTest evidence must contain exactly the selected passing tests. */
export function xcresultSummaryMatches(summary: unknown, expected: number): boolean {
  if (!Number.isSafeInteger(expected) || expected < 1 || typeof summary !== 'object'
    || summary === null || Array.isArray(summary)) return false;
  return 'totalTestCount' in summary && summary.totalTestCount === expected
    && 'passedTests' in summary && summary.passedTests === expected
    && 'failedTests' in summary && summary.failedTests === 0
    && 'skippedTests' in summary && summary.skippedTests === 0
    && 'expectedFailures' in summary && summary.expectedFailures === 0
    && 'result' in summary && summary.result === 'Passed';
}

/** Read the actual result bundle; command failure or malformed evidence fails closed. */
export async function validateXcresultSummary(
  resultBundle: string,
  expectedTestCount: number | string,
  label: string,
  options: RunOptions = {},
  io: XcresultSummaryIo = defaultIo,
): Promise<number> {
  const text = String(expectedTestCount);
  const expected = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(expected)
    || resultBundle.length === 0 || label.length === 0) {
    io.error('XCTest result verification requires a bundle, positive safe test count, and suite name.');
    return 2;
  }
  if (!io.isDirectory(resultBundle)) {
    io.error(`${label} result bundle does not exist: ${resultBundle}`);
    return 2;
  }
  const result = await io.run('xcrun', [
    'xcresulttool', 'get', 'test-results', 'summary', '--path', resultBundle, '--format', 'json',
  ], { ...options, capture: true });
  if (result.status !== 0) {
    io.error(`${label} xcresult summary could not be read (status ${result.status}).`);
    return result.status;
  }
  let summary: unknown;
  try { summary = JSON.parse(result.stdout) as unknown; } catch {
    io.error(`${label} xcresult summary is not valid JSON.`);
    return 1;
  }
  if (!xcresultSummaryMatches(summary, expected)) {
    io.error(`${label} xcresult summary does not prove exactly ${expected} passing tests with no failures or skips.`);
    return 1;
  }
  io.notice(`${label} xcresult verified: ${expected} tests passed`);
  return 0;
}

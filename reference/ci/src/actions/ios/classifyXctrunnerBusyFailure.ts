import { existsSync, readFileSync } from 'node:fs';

import { annotateNotice, logLine } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { busyLogRefusal, classifyBusySession, hasBusyRunnerLaunchDenial } from '../../ios/xctrunnerBusy.ts';

/**
 * `classifyXctrunnerBusyFailure.ts <status> <destination> <log> <result-bundle>`
 *
 * Called by `run_ios_xcodebuild_with_busy_retry` after a failed session.
 * Exits 0 when the session is the retryable `.xctrunner` Busy launch denial
 * with no test executed, 1 when it is not, and 2 on a usage error. When the
 * log does show the Busy denial but the session is not retryable, the reason
 * is printed so the job log says which condition refused the retry.
 */

const xcresultReadTimeoutMs = 60_000;

async function readSummary(resultBundle: string): Promise<unknown> {
  if (!existsSync(resultBundle)) return undefined;
  const result = await runCommand(
    'xcrun',
    ['xcresulttool', 'get', 'test-results', 'summary', '--path', resultBundle, '--format', 'json'],
    { capture: true, timeoutMs: xcresultReadTimeoutMs },
  );
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const [statusText, destination, logFile, resultBundle] = argv;
  if (statusText === undefined || destination === undefined || logFile === undefined
    || resultBundle === undefined || argv.length !== 4 || !/^\d+$/.test(statusText)) {
    logLine('Usage: classifyXctrunnerBusyFailure.ts <status> <destination> <log> <result-bundle>');
    return 2;
  }
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const session = { status: Number(statusText), destination, log };
  // Only a session that already looks like the Busy denial pays for an xcresult read.
  const verdict = busyLogRefusal(session)
    ?? classifyBusySession({ ...session, summary: await readSummary(resultBundle) });
  if (verdict.retryable) return 0;
  if (hasBusyRunnerLaunchDenial(log)) {
    annotateNotice(`The .xctrunner Busy launch denial is not retried: ${verdict.reason}.`);
  }
  return 1;
}

run(process.argv.slice(2)).then((status) => {
  process.exitCode = status;
}).catch((error: unknown) => {
  logLine(`Busy failure classification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});

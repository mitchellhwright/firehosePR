import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { annotateError, optionalEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { failureSummaryTargets } from '../../ios/executionPlan.ts';

/**
 * `Summarize iOS Test Failures`.
 *
 * Renders every result bundle the lane produced into the job log. Which
 * bundles exist is what decides the work, and `failureSummaryTargets` owns
 * that ordering; this file looks at the filesystem and runs the summarizer.
 *
 * The step runs after success, failure and cancellation alike, so a bundle a
 * shard never owned is simply absent rather than an error — but a summarizer
 * that itself fails still fails the step, because an unreadable result bundle
 * is a result nobody can review.
 */

const summarizer = resolve(process.cwd(), '..', 'scripts/summarize-ios-test-failures.py');

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function run(): Promise<number> {
  const targets = failureSummaryTargets({
    runnerTemp: requiredEnv('RUNNER_TEMP'),
    resultBundle: optionalEnv('IOS_TEST_RESULT_BUNDLE'),
    xcodebuildLog: optionalEnv('IOS_TEST_XCODEBUILD_LOG'),
    accountUpdateResultBundle: optionalEnv('IOS_ACCOUNT_UPDATE_RESULT_BUNDLE'),
    accountUpdateXcodebuildLog: optionalEnv('IOS_ACCOUNT_UPDATE_XCODEBUILD_LOG'),
    accessibilityResultBundle: optionalEnv('IOS_ACCESSIBILITY_TEST_RESULT_BUNDLE'),
    accessibilityXcodebuildLog: optionalEnv('IOS_ACCESSIBILITY_XCODEBUILD_LOG'),
    narrowPaywallResultBundle: optionalEnv('IOS_NARROW_PAYWALL_RESULT_BUNDLE'),
    narrowPaywallXcodebuildLog: optionalEnv('IOS_NARROW_PAYWALL_XCODEBUILD_LOG'),
  });

  for (const target of targets) {
    if (target.whenPresent && !directoryExists(target.resultBundle)) continue;
    const summarized = await runCommand(
      'python3',
      [summarizer, target.resultBundle, '--xcodebuild-log', target.xcodebuildLog],
      { cwd: process.cwd() },
    );
    if (summarized.status !== 0) return summarized.status;
  }
  return 0;
}

run().then((status) => {
  process.exitCode = status;
}).catch((error: unknown) => {
  annotateError(
    `iOS test failure summary failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

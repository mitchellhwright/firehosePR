import { mkdirSync, rmSync, statSync } from 'node:fs';
import { z } from 'zod';

import { chatPlaidBundleUnavailableMessage, chatPlaidScreenshotPaths } from '../../ios/chatPlaidLane.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';
import { xcresultExportArguments } from '../../ios/xcresultScreenshotExport.ts';

/**
 * Exports the Chat Plaid suite's attachments into the lane's evidence tree.
 *
 * A lane that never produced a result bundle warns and stays green: the step
 * runs on `always()`, so it is reached by a lane that failed before XCTest
 * started, and a missing bundle there is not a second failure to report.
 */

const environmentSchema = z.object({
  RUNNER_TEMP: z.string().min(1, 'RUNNER_TEMP is required'),
});

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

await runStep('Chat Plaid screenshot export', async () => {
  const { RUNNER_TEMP: runnerTemp } = readStepEnvironment(environmentSchema);
  const paths = chatPlaidScreenshotPaths(runnerTemp, process.env);
  if (!directoryExists(paths.resultBundle)) {
    process.stdout.write(`::warning::${chatPlaidBundleUnavailableMessage}\n`);
    return;
  }

  mkdirSync(paths.evidenceDirectory, { recursive: true });
  // A previous attempt's attachments must not be reported as this run's.
  rmSync(paths.screenshotsDirectory, { recursive: true, force: true });
  const result = await runCommand(
    'xcrun',
    xcresultExportArguments(paths.resultBundle, paths.screenshotsDirectory),
  );
  if (result.status !== 0) process.exitCode = result.status;
});

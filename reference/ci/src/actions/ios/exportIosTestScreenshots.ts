import { mkdirSync, statSync } from 'node:fs';
import { z } from 'zod';

import { runCommand } from '../../ios/shared/commandRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import {
  planScreenshotExport,
  resolveScreenshotBundlePaths,
  xcresultExportArguments,
} from '../../ios/xcresultScreenshotExport.ts';

/**
 * Exports every screenshot attachment an iOS execution lane produced.
 *
 * The lane publishes its result-bundle paths through `$GITHUB_ENV`, so they
 * arrive here as ordinary process environment exactly as the shell read them;
 * each is optional and falls back to the runner-temp default. Which bundles
 * exist decides what is exported, and `xcresultScreenshotExport.ts` owns that
 * decision — this file only reads the environment, looks at the filesystem and
 * runs `xcrun`.
 */

const environmentSchema = z.object({
  RUNNER_TEMP: z.string().min(1, 'RUNNER_TEMP is required'),
  IOS_TEST_RESULT_BUNDLE: z.string().optional(),
  IOS_ACCOUNT_UPDATE_RESULT_BUNDLE: z.string().optional(),
  IOS_ACCESSIBILITY_TEST_RESULT_BUNDLE: z.string().optional(),
  IOS_NARROW_PAYWALL_RESULT_BUNDLE: z.string().optional(),
});

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const paths = resolveScreenshotBundlePaths({
    runnerTemp: environment.RUNNER_TEMP,
    resultBundle: environment.IOS_TEST_RESULT_BUNDLE,
    accountUpdateResultBundle: environment.IOS_ACCOUNT_UPDATE_RESULT_BUNDLE,
    accessibilityResultBundle: environment.IOS_ACCESSIBILITY_TEST_RESULT_BUNDLE,
    narrowPaywallResultBundle: environment.IOS_NARROW_PAYWALL_RESULT_BUNDLE,
  });

  const plan = planScreenshotExport({ paths, directoryExists });
  for (const directory of plan.directoriesToCreate) mkdirSync(directory, { recursive: true });

  for (const action of plan.actions) {
    if (action.kind === 'warn') {
      console.log(`::warning::${action.message}`);
      continue;
    }
    const result = await runCommand('xcrun', xcresultExportArguments(action.bundlePath, action.outputPath));
    if (result.status === 0) continue;
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    console.log(`::warning::${action.failureMessage}`);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error::iOS screenshot export failed: ${message}`);
  process.exitCode = 1;
});

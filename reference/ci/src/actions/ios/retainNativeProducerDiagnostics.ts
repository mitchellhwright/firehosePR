import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { optionalEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';
import {
  nativeProducerDiagnosticCandidates,
  noLocalEvidenceMessage,
  runScopedTempPrefix,
  type RunScopedDirectory,
} from '../../ios/testProductHandoff.ts';

/**
 * `Retain native producer diagnostics on runner`.
 *
 * Runs only when the artifact upload failed — a billed quota that has stopped
 * it before. The evidence is then persisted on the runner instead, and a
 * producer with no evidence at all fails rather than reporting quietly that
 * there was nothing to keep.
 */

/** The `$RUNNER_TEMP/example-ios-tests.<run>.<attempt>.*` directories, with their entries. */
function runScopedDirectories(): readonly RunScopedDirectory[] {
  const runnerTemp = optionalEnv('RUNNER_TEMP');
  const prefix = runScopedTempPrefix(
    optionalEnv('GITHUB_RUN_ID'), optionalEnv('GITHUB_RUN_ATTEMPT'),
  );
  if (runnerTemp.length === 0) return [];
  let entries;
  try {
    entries = readdirSync(runnerTemp, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories: RunScopedDirectory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const path = join(runnerTemp, entry.name);
    try {
      directories.push({ path, entries: readdirSync(path) });
    } catch {
      // A directory removed between the two reads simply contributes nothing.
    }
  }
  return directories.sort((left, right) => left.path.localeCompare(right.path));
}

await runStep('Native producer diagnostics retention', async () => {
  const candidates = nativeProducerDiagnosticCandidates({
    resultBundle: optionalEnv('IOS_TEST_RESULT_BUNDLE'),
    xcodebuildLog: optionalEnv('IOS_TEST_XCODEBUILD_LOG'),
    storekitResultBundle: optionalEnv('IOS_STOREKIT_RESULT_BUNDLE'),
    storekitXcodebuildLog: optionalEnv('IOS_STOREKIT_XCODEBUILD_LOG'),
    runScopedDirectories: runScopedDirectories(),
  });
  const present = candidates.filter((path) => path.length > 0 && existsSync(path));
  if (present.length === 0) throw new StepFailure(`::error::${noLocalEvidenceMessage}`);

  const persisted = await runCommand(
    'bash',
    [
      resolve(process.cwd(), '..', 'scripts', 'persist-ios-ci-evidence.sh'),
      'Native iOS producer diagnostics',
      ...present,
    ],
    { cwd: process.cwd() },
  );
  if (persisted.status !== 0) throw new StepFailure('', 'stdout', persisted.status);
});

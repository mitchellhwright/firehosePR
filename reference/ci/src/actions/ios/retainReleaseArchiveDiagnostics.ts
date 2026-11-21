import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { optionalEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import {
  fail,
  pass,
  runAsyncStepProgram,
  type StepDecision,
} from '../../ios/shared/stepDecision.ts';
import { retainReleaseArchiveDiagnostics } from '../../ios/releaseArchiveDiagnostics.ts';

/**
 * "Retain Release archive diagnostics on runner": the fallback for a failed
 * artifact upload.
 *
 * The upload is `continue-on-error`, so this only runs when the artifact
 * service refused the log. `scripts/persist-ios-ci-evidence.sh` is the shared
 * retention policy every iOS lane uses and stays where it is; the log path
 * reaches it as an argument rather than through a command line, so a path with
 * a space or a quote in it is a path.
 */
await runAsyncStepProgram('Release archive diagnostics retention', async (): Promise<StepDecision> => {
  const logPath = optionalEnv('IOS_RELEASE_ARCHIVE_XCODEBUILD_LOG');
  const retention = retainReleaseArchiveDiagnostics(logPath, logPath.length > 0 && existsSync(logPath));
  if (retention.kind === 'missing') return fail(retention.message);
  const persisted = await runCommand('bash', [
    join(requiredEnv('GITHUB_WORKSPACE'), 'scripts/persist-ios-ci-evidence.sh'),
    retention.label,
    retention.logPath,
  ]);
  return persisted.status === 0 ? pass() : fail();
});

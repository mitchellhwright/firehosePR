import { appendFileSync, readFileSync } from 'node:fs';
import { z } from 'zod';

import {
  cacheRecoveryArguments,
  chatPlaidRecoveryLog,
  chatPlaidXcodebuildArguments,
  missingXctestrunMessage,
} from '../../ios/chatPlaidLane.ts';
import { errorAnnotation } from '../../ios/shared/githubStepIo.ts';
import { installSignalTraps, runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Runs the Chat Plaid link suite against the lane's real backend.
 *
 * The suite is executed from the products the E2E build job cached, so this is
 * a `test-without-building` over one identifier. The simulator destination and
 * the `.xctestrun` path used to be interpolated into a `run: |` block; here
 * they are arguments, so neither can be read as shell.
 *
 * The recovery wrapper writes its own log, which is folded into the lane's
 * `xcodebuild` log afterwards whatever the run's status — the failure log is
 * the artifact a reviewer reads, so it is kept even when the suite fails and
 * even when the job is cancelled out from under it.
 */

const environmentSchema = z.object({
  XCTESTRUN_PATH: z.string(),
  DESTINATION: z.string().min(1, 'DESTINATION is required'),
  ONBOARDING_E2E_RUN_DIR: z.string().min(1, 'ONBOARDING_E2E_RUN_DIR is required'),
  CHAT_PLAID_E2E_RESULT_BUNDLE: z.string().min(1, 'CHAT_PLAID_E2E_RESULT_BUNDLE is required'),
  CHAT_PLAID_E2E_XCODEBUILD_LOG: z.string().min(1, 'CHAT_PLAID_E2E_XCODEBUILD_LOG is required'),
});

/** `cat "$chat_test_log" >> "$CHAT_PLAID_E2E_XCODEBUILD_LOG"`, at most once. */
function recoveryLogFolder(recoveryLog: string, xcodebuildLog: string): () => void {
  let folded = false;
  return () => {
    if (folded) return;
    folded = true;
    let contents: Buffer;
    try {
      contents = readFileSync(recoveryLog);
    } catch {
      // The wrapper never got far enough to open its log; there is nothing to
      // fold into the lane log and that is not itself a failure.
      return;
    }
    appendFileSync(xcodebuildLog, contents);
  };
}

await runStep('Chat Plaid E2E', async () => {
  const environment = readStepEnvironment(environmentSchema);
  if (environment.XCTESTRUN_PATH.length === 0) {
    errorAnnotation(missingXctestrunMessage);
    process.exitCode = 1;
    return;
  }

  const recoveryLog = chatPlaidRecoveryLog(environment.ONBOARDING_E2E_RUN_DIR);
  const foldRecoveryLog = recoveryLogFolder(recoveryLog, environment.CHAT_PLAID_E2E_XCODEBUILD_LOG);
  // A cancelled job must still leave the recovery log in the lane log, and
  // xcodebuild's helper tree must go before this step does.
  installSignalTraps(foldRecoveryLog);

  const result = await runCommand('bash', cacheRecoveryArguments(
    recoveryLog,
    chatPlaidXcodebuildArguments({
      xctestrunPath: environment.XCTESTRUN_PATH,
      destination: environment.DESTINATION,
      resultBundle: environment.CHAT_PLAID_E2E_RESULT_BUNDLE,
    }),
  ));
  foldRecoveryLog();
  if (result.status !== 0) process.exitCode = result.status;
});

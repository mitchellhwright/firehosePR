import { mkdirSync, rmSync } from 'node:fs';

import { exportStepEnvBlock, logLine, requiredEnv } from '../../ios/shared/actionIo.ts';
import { pass, runStepProgram } from '../../ios/shared/stepDecision.ts';
import { budgetVideoWorkspace } from '../../ios/budgetVideoProcessing.ts';

/**
 * "Prepare isolated Budget video workspace".
 *
 * One directory per run attempt, removed and recreated so a reused self-hosted
 * runner cannot compress a previous attempt's recording. The derivation lives
 * in `ci/src/ios/budgetVideoProcessing.ts`, which refuses a run id or attempt
 * that is not a plain number — this step removes whatever that path names.
 */
runStepProgram('Budget video workspace', () => {
  const workspace = budgetVideoWorkspace(
    requiredEnv('RUNNER_TEMP'),
    requiredEnv('GITHUB_RUN_ID'),
    requiredEnv('GITHUB_RUN_ATTEMPT'),
  );
  // The upload step's `path:` reads BUDGET_E2E_COMPRESSED_VIDEO, and the
  // processing step reads both, so the names are spelled here where the
  // workflow's env contract can see which step defines them.
  exportStepEnvBlock(new Map([
    ['BUDGET_VIDEO_RUN_DIR', workspace.runDirectory],
    ['BUDGET_E2E_COMPRESSED_VIDEO', workspace.compressedVideo],
  ]));
  rmSync(workspace.runDirectory, { recursive: true, force: true });
  mkdirSync(workspace.rawDirectory, { recursive: true });
  logLine(`Prepared ${workspace.runDirectory} for this attempt's Budget E2E recording.`);
  return pass();
});

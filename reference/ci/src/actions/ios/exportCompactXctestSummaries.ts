import { z } from 'zod';

import { compactSummaryArguments, compactSummaryLane, compactSummaryTarget } from '../../ios/e2eResultArtifacts.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Writes the lane's compact XCTest summary — the small JSON a reviewer reads
 * instead of opening a multi-gigabyte `.xcresult`.
 *
 * The four lanes share one `steps:` block, so the lane is read from `$E2E_LANE`
 * and `ci/src/ios/e2eResultArtifacts.ts` maps it to the bundle, the label and
 * the output file. An unrecognised lane still writes the Budget summary, which
 * is where the shell's `else` branch sent it.
 */

const environmentSchema = z.object({
  E2E_LANE: z.string().min(1, 'E2E_LANE is required'),
  ONBOARDING_E2E_RUN_DIR: z.string().min(1, 'ONBOARDING_E2E_RUN_DIR is required'),
});

await runStep('Compact XCTest summary export', async () => {
  const environment = readStepEnvironment(environmentSchema);
  const target = compactSummaryTarget(
    compactSummaryLane(environment.E2E_LANE),
    environment.ONBOARDING_E2E_RUN_DIR,
    process.env,
  );
  const result = await runCommand('bash', compactSummaryArguments(target));
  if (result.status !== 0) process.exitCode = result.status;
});

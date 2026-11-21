import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { realServerE2ePaths } from '../../ios/realServerE2eLanes.ts';
import { exportStepEnvBlock } from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Creates the one run directory this lane owns and publishes every path the
 * later steps write into.
 *
 * The directory name carries the lane, run, attempt and job so two lanes
 * sharing a Mac never write into each other's results.
 */

const environmentSchema = z.object({
  RUNNER_TEMP: z.string().min(1),
  GITHUB_WORKSPACE: z.string().min(1),
  E2E_LANE: z.string().min(1),
  GITHUB_RUN_ID: z.string().min(1),
  GITHUB_RUN_ATTEMPT: z.string().min(1),
  GITHUB_JOB: z.string().min(1),
});

function run(): void {
  const environment = readStepEnvironment(environmentSchema);
  const prefix = join(
    environment.RUNNER_TEMP,
    [
      'onboarding-e2e',
      environment.E2E_LANE,
      environment.GITHUB_RUN_ID,
      environment.GITHUB_RUN_ATTEMPT,
      environment.GITHUB_JOB,
      '',
    ].join('.'),
  );
  const paths = realServerE2ePaths({
    runDirectory: mkdtempSync(prefix),
    workspace: environment.GITHUB_WORKSPACE,
  });
  mkdirSync(paths.backendDirectory, { recursive: true });
  exportStepEnvBlock(paths.environment);
  appendStepOutputs(paths.outputs);
}

await runStep('Prepare onboarding result paths', run);

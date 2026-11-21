import { z } from 'zod';

import {
  failureSummaryArguments,
  failureSummaryTarget,
  isE2eLane,
} from '../../ios/e2eResultArtifacts.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Prints the compact failure report for whichever suite a real-server E2E lane
 * just ran, by handing `scripts/summarize-ios-test-failures.py` the lane's
 * result bundle and `xcodebuild` log.
 *
 * One program for the three near-identical steps; `IOS_FAILURE_SUMMARY_LANE`
 * names the lane, which is the only thing that differed between them.
 */

const environmentSchema = z.object({
  IOS_FAILURE_SUMMARY_LANE: z.string().min(1, 'IOS_FAILURE_SUMMARY_LANE is required'),
  RUNNER_TEMP: z.string().min(1, 'RUNNER_TEMP is required'),
});

await runStep('iOS E2E failure summary', async () => {
  const environment = readStepEnvironment(environmentSchema);
  const lane = environment.IOS_FAILURE_SUMMARY_LANE;
  if (!isE2eLane(lane)) throw new Error(`Unknown E2E lane: ${lane}`);

  const target = failureSummaryTarget(lane, {
    runnerTemp: environment.RUNNER_TEMP,
    values: process.env,
  });
  const result = await runCommand('python3', failureSummaryArguments(target));
  if (result.status !== 0) process.exitCode = result.status;

});

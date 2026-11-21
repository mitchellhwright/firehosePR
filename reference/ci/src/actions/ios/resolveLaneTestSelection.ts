import { annotateError, logLine, optionalEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { laneSelectionMode } from '../../ios/executionPlan.ts';

/**
 * `Resolve native lane test selection`.
 *
 * Turns the run-wide prepared selection into the mode this one matrix entry
 * runs in. The decision is `laneSelectionMode`; this file only reads the
 * step's environment and writes the `mode` output the affected-test selector
 * and the execution step both read.
 */

function run(): number {
  const outcome = laneSelectionMode({
    preparedMode: requiredEnv('PREPARED_SELECTION_MODE'),
    preparedUiRequired: optionalEnv('PREPARED_UI_REQUIRED'),
    // Both arrive as an explicit 'true'/'false'; an absent value is a routing
    // defect the step refuses rather than reading as "not forced".
    forcedLane: requiredEnv('FORCED_EXECUTION_LANE') === 'true',
    forceFullLane: requiredEnv('FORCE_FULL_EXECUTION_LANE') === 'true',
    lane: requiredEnv('EXECUTION_LANE'),
  });
  if (!outcome.ok) {
    logLine(outcome.message);
    return 1;
  }
  appendStepOutputs([['mode', outcome.mode]]);
  return 0;
}

try {
  process.exitCode = run();
} catch (error: unknown) {
  annotateError(
    `Native lane test selection failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

import { resolve } from 'node:path';

import { annotateError, logLine, optionalEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { parseEvidenceGroups, simulatorCleanupPlan } from '../../ios/executionPlan.ts';

/**
 * `Remove provisioned iOS Simulators`.
 *
 * Releases every simulator this lane provisioned, under the purpose it was
 * provisioned as. The purpose is load-bearing — the reclaim script asserts
 * entry ownership before removing a device — so `simulatorCleanupPlan` decides
 * the labels and this file only runs the reclaim.
 *
 * The step runs on every outcome, so a UDID that was never provisioned is
 * simply absent from the plan rather than a failure.
 */

const reclaim = resolve(process.cwd(), '..', 'scripts/reclaim-ios-runner-disk.sh');

async function run(): Promise<number> {
  const plan = simulatorCleanupPlan(
    requiredEnv('IOS_CI_LANE'),
    parseEvidenceGroups(optionalEnv('IOS_EVIDENCE_GROUPS')),
    {
      primaryUdid: optionalEnv('IOS_PRIMARY_SIMULATOR_UDID'),
      narrowUdid: optionalEnv('IOS_NARROW_SIMULATOR_UDID'),
    },
  );
  if (!plan.ok) {
    logLine(plan.message);
    return 1;
  }
  for (const cleanup of plan.cleanups) {
    const removed = await runCommand('bash', [reclaim, 'simulator'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        IOS_RUNNER_CURRENT_SIMULATOR_PURPOSE: cleanup.purpose,
        IOS_RUNNER_CURRENT_SIMULATOR_UDID: cleanup.udid,
        IOS_RUNNER_RECLAIM_CI_SIMULATORS: '1',
      },
    });
    if (removed.status !== 0) return removed.status;
  }
  return 0;
}

run().then((status) => {
  process.exitCode = status;
}).catch((error: unknown) => {
  annotateError(
    `Provisioned iOS simulator cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

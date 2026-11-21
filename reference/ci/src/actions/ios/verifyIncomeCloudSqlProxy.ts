import { missingCloudSqlProxyMessage } from '../../ios/realServerE2eLanes.ts';
import { annotateError, logLine } from '../../ios/shared/actionIo.ts';
import { resolveExecutable } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * The Income lane tunnels to Cloud SQL through `cloud-sql-proxy`, which is
 * baked into the macOS runner image rather than installed per run. A runner
 * whose image lost it is a broken runner, so the lane refuses it here instead
 * of failing deep inside the harness.
 */

function run(): void {
  const proxy = resolveExecutable('cloud-sql-proxy');
  if (proxy === undefined) {
    annotateError(missingCloudSqlProxyMessage);
    throw new StepFailure('', 'stdout');
  }
  logLine(`cloud-sql-proxy resolved at ${proxy}`);
}

await runStep('Verify baked Income E2E Cloud SQL proxy', run);

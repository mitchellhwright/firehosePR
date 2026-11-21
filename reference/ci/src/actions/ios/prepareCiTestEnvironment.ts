import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { annotateError, requiredEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { simulatorUdidFromDestination } from '../../ios/executionPlan.ts';

/**
 * `Prepare CI Test Environment`.
 *
 * Hands the Xcode Cloud pre-build script the one simulator the lane has
 * provisioned so far, then points the Development configuration at the
 * Production values the CI app is built with.
 *
 * Only the primary simulator is named: the narrow and wide devices stay shut
 * down until the phases that own them, because a four-core runner cannot keep
 * more than one alive while XCTest allocates its workers.
 */

async function run(): Promise<number> {
  const primaryUdid = simulatorUdidFromDestination(requiredEnv('PRIMARY_DESTINATION'));
  const prepared = await runCommand('bash', [join(process.cwd(), 'ci_scripts/ci_pre_xcodebuild.sh')], {
    cwd: process.cwd(),
    env: { ...process.env, IOS_CI_SIMULATOR_UDIDS: primaryUdid },
  });
  if (prepared.status !== 0) return prepared.status;
  copyFileSync(
    join(process.cwd(), 'example-ios/Config/Config-Production.plist'),
    join(process.cwd(), 'example-ios/Config/Config-Development.plist'),
  );
  return 0;
}

run().then((status) => {
  process.exitCode = status;
}).catch((error: unknown) => {
  annotateError(
    `iOS CI test environment preparation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

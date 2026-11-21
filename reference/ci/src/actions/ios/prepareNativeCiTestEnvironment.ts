import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

import { optionalEnv } from '../../ios/shared/actionIo.ts';
import { simulatorUdidFromDestination } from '../../ios/executionPlan.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * `Prepare CI test environment`.
 *
 * Runs the Xcode Cloud pre-build hook against the one simulator this producer
 * owns, then gives the Development configuration the Production plist. The
 * producer compiles the products every lane later launches, so they must be
 * built against the same configuration the release build uses.
 */
await runStep('Native CI test environment', async () => {
  const cwd = process.cwd();
  const primaryUdid = simulatorUdidFromDestination(optionalEnv('PRIMARY_DESTINATION'));
  const prepared = await runCommand('bash', ['ci_scripts/ci_pre_xcodebuild.sh'], {
    cwd,
    env: { ...process.env, IOS_CI_SIMULATOR_UDIDS: primaryUdid },
  });
  if (prepared.status !== 0) throw new StepFailure('', 'stdout', prepared.status);

  const configuration = join(cwd, 'example-ios', 'Config');
  copyFileSync(
    join(configuration, 'Config-Production.plist'),
    join(configuration, 'Config-Development.plist'),
  );
});

import { join, resolve } from 'node:path';

import { requiredEnv } from '../../ios/shared/actionIo.ts';
import { mainTestConfiguration, simulatorUdidFromDestination } from '../../ios/executionPlan.ts';
import { iosShellHelperPaths, prepareSimulator } from '../../ios/shared/iosShellHelpers.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * `Run StoreKit purchase test`.
 *
 * Drives `scripts/run-ios-storekit-tests.sh` on the dedicated StoreKit
 * simulator. The step continues on error and its outcome is recorded
 * separately, so the only thing that matters here is that a failure to prepare
 * the simulator stops the run before xcodebuild is asked to launch on it.
 */
const label = 'StoreKit';

await runStep('StoreKit purchase test', async () => {
  const cwd = process.cwd();
  const scriptsDirectory = resolve(cwd, '..', 'scripts');
  const helpers = iosShellHelperPaths(scriptsDirectory);

  const destination = requiredEnv('STOREKIT_DESTINATION');
  const prepared = await prepareSimulator(
    helpers, simulatorUdidFromDestination(destination), label, { cwd },
  );
  if (prepared !== 0) throw new StepFailure('', 'stdout', prepared);

  // Every value reaches the runner as its own argument, so a destination or a
  // bundle path can never be read as shell syntax.
  const tested = await runCommand(
    'bash',
    [
      join(scriptsDirectory, 'run-ios-storekit-tests.sh'),
      requiredEnv('IOS_TEST_PRODUCTS'),
      requiredEnv('IOS_TEST_PLAN'),
      destination,
      requiredEnv('IOS_STOREKIT_RESULT_BUNDLE'),
      requiredEnv('IOS_STOREKIT_XCODEBUILD_LOG'),
      mainTestConfiguration,
    ],
    { cwd },
  );
  if (tested.status !== 0) throw new StepFailure('', 'stdout', tested.status);
});

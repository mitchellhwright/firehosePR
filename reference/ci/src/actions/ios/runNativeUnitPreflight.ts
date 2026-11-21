import { join, resolve } from 'node:path';

import { optionalEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { simulatorUdidFromDestination } from '../../ios/executionPlan.ts';
import {
  iosShellHelperPaths,
  prepareSimulator,
  setAndVerifyContentSize,
} from '../../ios/shared/iosShellHelpers.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * `Run native unit preflight`.
 *
 * Runs the `unit` partition of the freshly compiled products on the producer's
 * own simulator, so a build that cannot execute its own unit tests fails here
 * rather than on four consumer lanes at once. The simulator preparation and
 * content-size helpers are the shell library every iOS lane shares, bridged
 * rather than reimplemented.
 */
const label = 'Native unit preflight';

await runStep(label, async () => {
  const cwd = process.cwd();
  const scriptsDirectory = resolve(cwd, '..', 'scripts');
  const helpers = iosShellHelperPaths(scriptsDirectory);
  const scriptPath = (name: string): string => join(scriptsDirectory, name);
  // Each phase stops the step with the status the shell's `-e` propagated, so
  // the preflight never runs tests on a simulator that failed to prepare.
  const failOn = (status: number): void => {
    if (status !== 0) throw new StepFailure('', 'stdout', status);
  };

  const unitUdid = simulatorUdidFromDestination(optionalEnv('IOS_PRIMARY_DESTINATION'));
  failOn(await prepareSimulator(helpers, unitUdid, label, { cwd }));
  failOn(await setAndVerifyContentSize(helpers, unitUdid, 'large', label, { cwd }));

  const tests = await runCommand('bash', [scriptPath('run-ios-ci-main-tests.sh')], { cwd });
  failOn(tests.status);

  // Executed, not merely reported: a bundle whose tests never ran would
  // otherwise let a broken product pass the preflight.
  const validated = await runCommand(
    'bash',
    [
      scriptPath('validate-xcresult-execution.sh'),
      requiredEnv('IOS_TEST_RESULT_BUNDLE'), label, '1', '', 'true',
    ],
    { cwd },
  );
  failOn(validated.status);
});

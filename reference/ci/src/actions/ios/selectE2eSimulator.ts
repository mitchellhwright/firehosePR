import { z } from 'zod';

import { simulatorProvisionPurpose } from '../../ios/realServerE2eLanes.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Provisions the simulator this lane runs on.
 *
 * Provisioning isolates the run from simulator data retained by prior
 * StoreKit, onboarding and Budget UI tests. Every purpose provisions on the
 * pinned iOS simulator runtime and never downloads one.
 */

const environmentSchema = z.object({
  TEST_SCOPE: z.string().default(''),
});

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const provisioned = await runCommand('python3', [
    'scripts/provision-ios-ci-simulator.py',
    '--purpose',
    simulatorProvisionPurpose(environment.TEST_SCOPE),
  ]);
  if (provisioned.status !== 0) throw new StepFailure('', 'stdout', provisioned.status);
}

await runStep('Select iOS Simulator', run);

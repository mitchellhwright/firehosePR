import { join } from 'node:path';
import { z } from 'zod';

import {
  onboardingApiBaseUrl,
  onboardingRecoveryArguments,
} from '../../ios/realServerE2eLanes.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Runs the FullOnboarding regression against the lane's own backend.
 *
 * The app is pointed at the offline proxy rather than the backend directly, so
 * the lane can cut the link mid-journey. The harness itself stays in
 * `scripts/ios-test-onboarding-e2e.sh`, wrapped by the shared cache-recovery
 * runner; this program only assembles its inputs as an argument array.
 */

const environmentSchema = z.object({
  DASHBOARD_OFFLINE_PROXY_PORT: z.string().min(1),
  ONBOARDING_E2E_RUN_DIR: z.string().min(1),
});

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const executed = await runCommand(
    'bash',
    onboardingRecoveryArguments({
      recoveryLog: join(environment.ONBOARDING_E2E_RUN_DIR, 'onboarding-infra-recovery.log'),
      laneScript: 'scripts/ios-test-onboarding-e2e.sh',
    }),
    {
      env: {
        ...process.env,
        UI_TEST_API_BASE_URL: onboardingApiBaseUrl(environment.DASHBOARD_OFFLINE_PROXY_PORT),
      },
    },
  );
  if (executed.status !== 0) throw new StepFailure('', 'stdout', executed.status);
}

await runStep('Run onboarding E2E', run);

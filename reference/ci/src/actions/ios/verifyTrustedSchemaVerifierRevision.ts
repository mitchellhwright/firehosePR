import { join } from 'node:path';

import { requiredEnv } from '../../ios/shared/actionIo.ts';
import { headRevision } from '../../ios/shared/gitRevision.ts';
import { runAsyncStepProgram, type StepDecision } from '../../ios/shared/stepDecision.ts';
import { exactRevisionPlan } from '../../ios/trustedControllerPlan.ts';

/**
 * "Verify trusted schema verifier revision".
 *
 * Everything after this step runs code from the `trusted-verifier` checkout
 * against the shared development database, so the checkout must be the exact
 * verifier revision the gate proved. The replaced `test` failed without saying
 * anything; this reports both SHAs, which is the difference between a rerun
 * and an investigation.
 */
await runAsyncStepProgram('Trusted schema verifier revision', async (): Promise<StepDecision> => {
  const checkout = join(requiredEnv('GITHUB_WORKSPACE'), requiredEnv('TRUSTED_CHECKOUT_PATH'));
  const plan = exactRevisionPlan(
    {
      expectedSha: requiredEnv('TRUSTED_VERIFIER_SHA'),
      checkedOutSha: await headRevision(checkout),
    },
    'trusted verifier',
  );
  return { messages: plan.messages, exitCode: plan.exitCode };
});

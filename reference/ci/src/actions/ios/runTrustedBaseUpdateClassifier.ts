import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { requiredEnv } from '../../ios/shared/actionIo.ts';
import { headRevision } from '../../ios/shared/gitRevision.ts';
import { installSignalTraps, runCommand } from '../../ios/shared/processRunner.ts';
import {
  fail,
  pass,
  runAsyncStepProgram,
  writeStepMessages,
  type StepDecision,
} from '../../ios/shared/stepDecision.ts';
import { baseUpdateClassifierPlan } from '../../ios/trustedControllerPlan.ts';

/**
 * "Detect verified incremental head delta": runs the base-update classifier
 * from the trusted base checkout.
 *
 * Never the pull request's own classifier — it decides which iOS lanes this
 * head may inherit from its predecessor, so a head that supplied it could
 * grant itself any evidence it liked. `ci/src/ios/trustedControllerPlan.ts`
 * owns the decision; this reads the checkout, runs what the plan names, and
 * adopts the classifier's status.
 *
 * The classifier writes this step's outputs, so it inherits the environment
 * and therefore the same `$GITHUB_OUTPUT`. Its two streams go straight to the
 * step log in order, which is what the replaced shell's temporary log file
 * existed to achieve.
 */
installSignalTraps(() => {});
await runAsyncStepProgram('Trusted base-update classifier', async (): Promise<StepDecision> => {
  const trustedBase = join(requiredEnv('GITHUB_WORKSPACE'), requiredEnv('TRUSTED_CHECKOUT_PATH'));
  const classifierPath = join(trustedBase, 'ci/src/ios/controllers/baseUpdateDelta.ts');
  const plan = baseUpdateClassifierPlan({
    expectedSha: requiredEnv('BASE_SHA'),
    checkedOutSha: await headRevision(trustedBase),
    classifierPath,
    classifierExists: existsSync(classifierPath),
  });
  writeStepMessages(plan.messages);
  if (plan.run === null) return plan.exitCode === 0 ? pass() : fail();
  const classifier = await runCommand('node', [plan.run]);
  return classifier.status === 0 ? pass() : fail();
});

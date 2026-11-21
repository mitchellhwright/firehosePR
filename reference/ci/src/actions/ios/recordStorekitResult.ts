import { optionalEnv } from '../../ios/shared/actionIo.ts';
import { storekitStepResult } from '../../ios/executionPlan.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * `Record StoreKit result`.
 *
 * The StoreKit step continues on error so its diagnostics are still uploaded;
 * this step is what turns its outcome into the job output the `Test - iOS`
 * aggregate reads. It runs with `if: always()`, so both inputs may be the
 * empty string GitHub renders for a step that never ran.
 */
await runStep('StoreKit result', () => {
  const result = storekitStepResult(optionalEnv('REQUIRED') === 'true', optionalEnv('OUTCOME'));
  appendStepOutputs([['result', result]]);
});

import { optionalEnv } from '../../ios/shared/actionIo.ts';
import { runStepProgram } from '../../ios/shared/stepDecision.ts';
import { deriveStorekitPurchaseStatus } from '../../ios/storekitPurchaseStatus.ts';

/**
 * "Verify consolidated StoreKit execution result".
 *
 * Run by both jobs that publish the verdict: the required
 * `StoreKit Purchase - iOS` context and the `Test - iOS` aggregate. Each input
 * keeps the env name the replaced shell read, and an absent value stays the
 * empty string, which is what GitHub renders for a `needs.<job>.result` or an
 * output the run never produced.
 */
runStepProgram('StoreKit purchase status', () =>
  deriveStorekitPurchaseStatus({
    eventName: optionalEnv('EVENT_NAME'),
    repository: optionalEnv('REPOSITORY'),
    headRepository: optionalEnv('HEAD_REPOSITORY'),
    changeGateResult: optionalEnv('CHANGE_GATE_RESULT'),
    storekitRequired: optionalEnv('STOREKIT_REQUIRED'),
    executionResult: optionalEnv('EXECUTION_RESULT'),
    parentExecutionResult: optionalEnv('PARENT_EXECUTION_RESULT'),
  }));

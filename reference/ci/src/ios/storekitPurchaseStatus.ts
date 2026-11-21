import { orMissing } from './shared/jobResults.ts';
import { error, fail, info, notSelected, pass, type StepDecision } from './shared/stepDecision.ts';

/**
 * The "Verify consolidated StoreKit execution result" decision.
 *
 * StoreKit purchase coverage no longer has a lane of its own: it runs inside
 * `build-ios-native-test-products` and reports through that job's
 * `storekit_result` output. Two jobs publish that verdict — the required
 * `StoreKit Purchase - iOS` context and a step of the `Test - iOS` aggregate —
 * and until now each carried its own copy of the same twenty-three lines of
 * shell. They are one decision, so they are one function.
 *
 * The rules are evaluated in the order the replaced shell wrote them; the
 * first match wins.
 */

export interface StorekitPurchaseStatusInput {
  readonly eventName: string;
  readonly repository: string;
  readonly headRepository: string;
  readonly changeGateResult: string;
  readonly storekitRequired: string;
  /** `needs.build-ios-native-test-products.outputs.storekit_result`. */
  readonly executionResult: string;
  /** `needs.build-ios-native-test-products.result` — the job that produced it. */
  readonly parentExecutionResult: string;
}

export function deriveStorekitPurchaseStatus(input: StorekitPurchaseStatusInput): StepDecision {
  if (input.changeGateResult !== 'success') {
    return fail(error(`Unexpected iOS change gate result: ${orMissing(input.changeGateResult)}`));
  }

  if (input.storekitRequired !== 'true' && input.storekitRequired !== 'false') {
    return fail(error(`Unexpected StoreKit selection: ${orMissing(input.storekitRequired)}`));
  }

  // External pull request code never reaches the Mac that compiles the test
  // products, so its skipped parent is the intended outcome, not a gap.
  if (
    input.eventName === 'pull_request' &&
    input.headRepository !== input.repository &&
    input.parentExecutionResult === 'skipped'
  ) {
    return pass(info('StoreKit execution is intentionally unavailable for external pull request code.'));
  }

  if (input.storekitRequired === 'false') {
    return pass(notSelected('StoreKit purchase coverage is not required for the selected changes.'));
  }

  if (input.executionResult === 'success') {
    return pass(info('StoreKit purchase coverage passed in the consolidated iOS execution.'));
  }

  return fail(
    error(
      `Unexpected StoreKit execution result: ${orMissing(input.executionResult)} ` +
        `(parent=${input.parentExecutionResult})`,
    ),
  );
}

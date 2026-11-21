import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveStorekitPurchaseStatus,
  type StorekitPurchaseStatusInput,
} from '../src/ios/storekitPurchaseStatus.ts';
import { decisionErrors, renderStepMessage } from '../src/ios/shared/stepDecision.ts';

const repository = 'example-org/example-app';

/** A same-repository pull request whose products job ran and required StoreKit. */
function derive(overrides: Partial<StorekitPurchaseStatusInput> = {}) {
  const input: StorekitPurchaseStatusInput = {
    eventName: 'pull_request',
    repository,
    headRepository: repository,
    changeGateResult: 'success',
    storekitRequired: 'true',
    executionResult: 'success',
    parentExecutionResult: 'success',
    ...overrides,
  };
  const decision = deriveStorekitPurchaseStatus(input);
  return { decision, lines: decision.messages.map(renderStepMessage) };
}

describe('deriveStorekitPurchaseStatus', () => {
  it('passes a lane that executed', () => {
    const { decision, lines } = derive();
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines, ['StoreKit purchase coverage passed in the consolidated iOS execution.']);
  });

  it('waives coverage the change gate did not select', () => {
    const { decision, lines } = derive({ storekitRequired: 'false', executionResult: 'skipped' });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines, ['not selected: StoreKit purchase coverage is not required for the selected changes.']);
  });

  it('does not waive coverage when the gate itself never succeeded', () => {
    const { decision } = derive({
      changeGateResult: 'failure', storekitRequired: 'false', executionResult: 'skipped',
    });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Unexpected iOS change gate result: failure',
    ]);
  });

  it('does not waive missing or malformed gate output', () => {
    for (const storekitRequired of ['', 'unknown', 'invalid']) {
      const { decision } = derive({ storekitRequired, executionResult: 'skipped' });
      assert.equal(decision.exitCode, 1, storekitRequired);
      assert.deepEqual(decisionErrors(decision), [
        `Unexpected StoreKit selection: ${storekitRequired || 'missing'}`,
      ]);
    }
  });

  it('does not waive a failed gate for external pull requests', () => {
    const { decision } = derive({
      headRepository: 'someone-else/example-app',
      parentExecutionResult: 'skipped',
      executionResult: '',
      changeGateResult: 'failure',
    });
    assert.deepEqual(decisionErrors(decision), ['Unexpected iOS change gate result: failure']);
  });

  it('accepts the skip an external pull request is designed to produce', () => {
    const { decision, lines } = derive({
      headRepository: 'someone-else/example-app',
      parentExecutionResult: 'skipped',
      executionResult: '',
    });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines, [
      'StoreKit execution is intentionally unavailable for external pull request code.',
    ]);
  });

  it('refuses that skip for anything but a skipped parent on a fork pull request', () => {
    for (const narrowed of [
      { eventName: 'workflow_dispatch' },
      { headRepository: repository },
      { parentExecutionResult: 'failure' },
    ] satisfies Partial<StorekitPurchaseStatusInput>[]) {
      const { decision } = derive({
        headRepository: 'someone-else/example-app',
        parentExecutionResult: 'skipped',
        executionResult: '',
        ...narrowed,
      });
      assert.equal(decision.exitCode, 1, JSON.stringify(narrowed));
    }
  });

  it('names a missing result rather than printing a blank', () => {
    const { decision } = derive({ executionResult: '', parentExecutionResult: 'success' });
    assert.deepEqual(decisionErrors(decision), [
      'Unexpected StoreKit execution result: missing (parent=success)',
    ]);
  });

  it('reports the producing job alongside the result it never explained', () => {
    const { decision } = derive({ executionResult: 'skipped', parentExecutionResult: 'cancelled' });
    assert.deepEqual(decisionErrors(decision), [
      'Unexpected StoreKit execution result: skipped (parent=cancelled)',
    ]);
  });

  it('never reads a non-success result as a pass on a dispatch', () => {
    const { decision } = derive({ eventName: 'workflow_dispatch', executionResult: 'failure' });
    assert.equal(decision.exitCode, 1);
  });
});

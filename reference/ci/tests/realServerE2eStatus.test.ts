import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveRealServerE2eStatus,
  outOfScopeDispatchMessages,
  type LaneStatus,
  type RealServerE2eAggregate,
  type RealServerE2eStatusInput,
} from '../src/ios/realServerE2eStatus.ts';
import { decisionErrors, renderStepMessage } from '../src/ios/shared/stepDecision.ts';

const repository = 'example-org/example-app';

function lane(result: string, required = false): LaneStatus {
  return { required, result };
}

function derive(overrides: Partial<RealServerE2eStatusInput> = {}) {
  const input: RealServerE2eStatusInput = {
    aggregate: 'onboarding-e2e-status',
    eventName: 'workflow_dispatch',
    testScope: 'affected',
    dispatchRef: 'refs/heads/develop',
    changeGateResult: 'success',
    headRepository: '',
    repository,
    baseBranch: '',
    budgetE2eEnabled: false,
    onboarding: lane('skipped'),
    chatPlaid: lane('skipped'),
    income: lane('skipped'),
    budget: lane('skipped'),
    ...overrides,
  };
  return deriveRealServerE2eStatus(input);
}

/** A trusted same-repository pull request into develop, nothing selected. */
function pullRequest(overrides: Partial<RealServerE2eStatusInput> = {}) {
  return derive({
    eventName: 'pull_request',
    baseBranch: 'develop',
    headRepository: repository,
    dispatchRef: 'refs/pull/1/merge',
    ...overrides,
  });
}

const lines = (decision: ReturnType<typeof derive>): string[] =>
  decision.messages.map(renderStepMessage);

describe('deriveRealServerE2eStatus schema diagnostic', () => {
  it('rejects the schema diagnostic from an untrusted ref before reading any lane', () => {
    // Every lane is green here: the ref check must still fail, or an off-branch
    // dispatch could report a green required context without a trusted tree.
    const decision = derive({
      testScope: 'development-e2e-schema',
      dispatchRef: 'refs/heads/feature',
      onboarding: lane('success', true),
      chatPlaid: lane('success', true),
      income: lane('success', true),
      budget: lane('success', true),
    });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Development E2E schema verification requires a trusted develop or main ref.',
    ]);
  });

  it('accepts the schema diagnostic from main as well as develop', () => {
    for (const dispatchRef of ['refs/heads/develop', 'refs/heads/main']) {
      const decision = derive({ testScope: 'development-e2e-schema', dispatchRef });
      assert.equal(decision.exitCode, 0, dispatchRef);
      assert.deepEqual(lines(decision), [
        'Real-server E2E is outside the development E2E schema verification scope.',
      ]);
    }
  });

  it('ignores the schema scope on a pull request, which cannot dispatch one', () => {
    const decision = pullRequest({ testScope: 'development-e2e-schema' });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), ['not selected: no real-server E2E lane is selected for these changes.']);
  });
});

describe('deriveRealServerE2eStatus pull requests', () => {
  it('requires an actual onboarding E2E success for every main promotion', () => {
    const unselected = pullRequest({ baseBranch: 'main' });
    assert.deepEqual(decisionErrors(unselected), [
      'A production promotion must select and pass onboarding E2E.',
    ]);

    const skipped = pullRequest({ baseBranch: 'main', onboarding: lane('skipped', true) });
    assert.deepEqual(decisionErrors(skipped), ['Selected onboarding E2E did not pass: skipped']);

    const passed = pullRequest({ baseBranch: 'main', onboarding: lane('success', true) });
    assert.equal(passed.exitCode, 0);
  });

  it('excuses an untrusted head only when every lane stayed skipped', () => {
    const excused = pullRequest({ headRepository: 'outside/fork' });
    assert.equal(excused.exitCode, 0);
    assert.deepEqual(lines(excused), [
      'Real-server E2E is unavailable for this pull request source or base.',
    ]);

    const executed = pullRequest({
      headRepository: 'outside/fork',
      onboarding: lane('success'),
    });
    assert.equal(executed.exitCode, 1);
    assert.deepEqual(decisionErrors(executed), [
      'An untrusted pull request unexpectedly executed real-server E2E.',
    ]);
  });

  it('treats an untrusted base branch exactly like an untrusted head repository', () => {
    const decision = pullRequest({ baseBranch: 'release/1.5', income: lane('success') });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'An untrusted pull request unexpectedly executed real-server E2E.',
    ]);
  });

  it('names an empty lane result "missing" rather than printing nothing', () => {
    const decision = pullRequest({ onboarding: lane('', true) });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), ['Selected onboarding E2E did not pass: missing']);
  });

  it('reports every failing lane in one pass, not just the first', () => {
    const decision = pullRequest({
      budgetE2eEnabled: true,
      onboarding: lane('failure', true),
      chatPlaid: lane('success'),
      income: lane('cancelled', true),
      budget: lane('skipped', true),
    });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Selected onboarding E2E did not pass: failure',
      'Unselected chat-plaid E2E had unexpected result: success',
      'Selected income E2E did not pass: cancelled',
      'Selected budget E2E did not pass: skipped',
    ]);
  });

  it('prints the disabled-budget notice even when another lane already failed', () => {
    // The notice is written before the collected failures are acted on, so a
    // reader of a red log still learns why budget never ran.
    const decision = pullRequest({ onboarding: lane('failure', true), budget: lane('skipped') });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(lines(decision), [
      '::error::Selected onboarding E2E did not pass: failure',
      'Budget E2E is temporarily disabled while the feature is changing.',
    ]);
  });

  it('accepts a selected budget lane as skipped only while budget E2E is disabled', () => {
    const disabled = pullRequest({
      onboarding: lane('success', true),
      budget: lane('skipped', true),
    });
    assert.equal(disabled.exitCode, 0);
    assert.deepEqual(lines(disabled), [
      'Budget E2E is temporarily disabled while the feature is changing.',
      'All selected pull-request real-server E2E lanes passed.',
    ]);

    const enabled = pullRequest({
      budgetE2eEnabled: true,
      onboarding: lane('success', true),
      budget: lane('skipped', true),
    });
    assert.equal(enabled.exitCode, 1);
  });

  it('rejects a budget lane that ran while the switch says it is disabled', () => {
    const decision = pullRequest({ onboarding: lane('success', true), budget: lane('success') });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Disabled budget E2E had unexpected result: success',
    ]);
  });

  it('falls through to the fail-closed tail when the change gate did not succeed', () => {
    // Without a successful gate the "required" flags mean nothing, so the
    // pull-request branch is skipped entirely and four skips are not a pass.
    const decision = pullRequest({ changeGateResult: 'failure' });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Unexpected real-server E2E results: onboarding=skipped chat-plaid=skipped ' +
        'income=skipped budget=skipped',
    ]);
  });

  it('requires all four lanes skipped before reporting nothing selected', () => {
    const decision = pullRequest({ income: lane('success') });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Unselected income E2E had unexpected result: success',
    ]);
  });

});

describe('deriveRealServerE2eStatus dispatches', () => {
  it('defers an untrusted dispatch only when the gate succeeded and nothing ran', () => {
    const deferred = derive({ dispatchRef: 'refs/heads/feature' });
    assert.equal(deferred.exitCode, 0);
    assert.deepEqual(lines(deferred), [
      'Privileged real-server E2E requires a trusted develop or main ref; ' +
        'this dispatch is deferred, not executed.',
    ]);

    for (const overrides of [
      { changeGateResult: 'failure' },
      { onboarding: lane('failure') },
      { income: lane('success') },
    ]) {
      const decision = derive({ dispatchRef: 'refs/heads/feature', ...overrides });
      assert.equal(decision.exitCode, 1, JSON.stringify(overrides));
    }
  });

  it('never defers a trusted dispatch that quietly skipped every lane', () => {
    const decision = derive({ dispatchRef: 'refs/heads/main' });
    assert.equal(decision.exitCode, 1);
    assert.match(decisionErrors(decision)[0] ?? '', /Unexpected real-server E2E results/);
  });

  it('holds the focused e2e dispatch to the budget switch', () => {
    const base = {
      testScope: 'e2e',
      onboarding: lane('success', true),
      chatPlaid: lane('success', true),
      income: lane('success', true),
    };
    const disabled = derive({ ...base, budget: lane('skipped') });
    assert.equal(disabled.exitCode, 0);
    assert.deepEqual(lines(disabled), ['All selected manual real-server E2E lanes passed.']);

    const enabled = derive({ ...base, budgetE2eEnabled: true, budget: lane('success') });
    assert.equal(enabled.exitCode, 0);

    // Enabled but skipped falls out of the e2e rule and finds no later match.
    const mismatched = derive({ ...base, budgetE2eEnabled: true, budget: lane('skipped') });
    assert.equal(mismatched.exitCode, 1);
  });

  it('passes silently when budget ran without income, printing no line at all', () => {
    const decision = derive({
      budgetE2eEnabled: true,
      onboarding: lane('success'),
      chatPlaid: lane('success'),
      budget: lane('success'),
    });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(decision.messages, []);
  });

  it('accepts the evidence dispatch only with the exact four lane results', () => {
    const decision = derive({
      testScope: 'evidence',
      onboarding: lane('success'),
      chatPlaid: lane('success'),
    });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), [
      'Onboarding and Chat Plaid E2E passed; Budget E2E is temporarily disabled.',
    ]);

    // With budget enabled the earlier disabled-budget rule no longer applies,
    // so the evidence rule is the one that has to accept it.
    const enabled = derive({
      testScope: 'evidence',
      budgetE2eEnabled: true,
      onboarding: lane('success'),
      chatPlaid: lane('success'),
    });
    assert.equal(enabled.exitCode, 0);
    assert.deepEqual(lines(enabled), [
      'Account-update acceptance completed without allocating the Budget runner.',
    ]);
  });

  it('accepts the debt-card dispatch that allocates only the budget runner', () => {
    const decision = derive({ testScope: 'debt-card-evidence', budget: lane('success') });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), [
      'Debt-card evidence completed without allocating the onboarding or Chat Plaid runners.',
    ]);
  });

  it('leaves income unchecked in the out-of-scope rules, as the shell did', () => {
    // Only onboarding, chat-plaid and budget are tested there; an income lane
    // that ran does not disqualify an out-of-scope evidence dispatch.
    const decision = derive({
      testScope: 'mortgage-assignment-evidence',
      income: lane('success'),
    });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), [
      'Real-server E2E is outside the mortgage-assignment-evidence scope.',
    ]);
  });

  it('rejects an out-of-scope dispatch whose lanes did run', () => {
    const decision = derive({
      testScope: 'financial-independence-evidence',
      chatPlaid: lane('success'),
    });
    assert.equal(decision.exitCode, 1);
  });
});

describe('deriveRealServerE2eStatus aggregates', () => {
  const aggregates: readonly RealServerE2eAggregate[] = ['test-ios', 'onboarding-e2e-status'];

  it('agrees on every scope both aggregates declare', () => {
    for (const scope of ['mortgage-assignment-evidence', 'financial-independence-evidence']) {
      for (const aggregate of aggregates) {
        const decision = derive({ aggregate, testScope: scope });
        assert.equal(decision.exitCode, 0, `${aggregate}/${scope}`);
        assert.deepEqual(lines(decision), [`Real-server E2E is outside the ${scope} scope.`]);
      }
    }
  });

  it('keeps shared-cta evidence out of scope for the native aggregate only', () => {
    const native = derive({ aggregate: 'test-ios', testScope: 'shared-cta-evidence' });
    assert.equal(native.exitCode, 0);
    const onboarding = derive({
      aggregate: 'onboarding-e2e-status',
      testScope: 'shared-cta-evidence',
    });
    assert.equal(onboarding.exitCode, 1);
  });

  it('keeps onboarding-copy evidence out of scope for the onboarding aggregate only', () => {
    const onboarding = derive({
      aggregate: 'onboarding-e2e-status',
      testScope: 'onboarding-copy-evidence',
    });
    assert.equal(onboarding.exitCode, 0);
    assert.deepEqual(lines(onboarding), [
      'Real-server E2E is outside the onboarding-copy evidence scope.',
    ]);

    const native = derive({ aggregate: 'test-ios', testScope: 'onboarding-copy-evidence' });
    assert.equal(native.exitCode, 1);
  });

  it('declares a message for every scope in every aggregate table', () => {
    // Iterated off the tables themselves so a scope added to one aggregate is
    // exercised without anyone remembering to extend a literal list here.
    for (const aggregate of aggregates) {
      const table = outOfScopeDispatchMessages[aggregate];
      assert.ok(table.size > 0, aggregate);
      for (const [scope, message] of table) {
        assert.ok(message.length > 0, `${aggregate}/${scope}`);
        const decision = derive({ aggregate, testScope: scope });
        assert.equal(decision.exitCode, 0, `${aggregate}/${scope}`);
        assert.deepEqual(lines(decision), [message]);
      }
    }
  });

  it('decides identically for both aggregates outside the scope tables', () => {
    const shared: Partial<RealServerE2eStatusInput>[] = [
      { eventName: 'pull_request', baseBranch: 'develop', headRepository: repository },
      { dispatchRef: 'refs/heads/feature' },
      {
        testScope: 'e2e',
        onboarding: lane('success'),
        chatPlaid: lane('success'),
        income: lane('success'),
      },
      { testScope: 'debt-card-evidence', budget: lane('success') },
      { onboarding: lane('failure') },
    ];
    for (const overrides of shared) {
      const native = derive({ aggregate: 'test-ios', ...overrides });
      const onboarding = derive({ aggregate: 'onboarding-e2e-status', ...overrides });
      assert.deepEqual(native, onboarding, JSON.stringify(overrides));
    }
  });
});

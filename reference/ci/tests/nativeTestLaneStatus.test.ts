import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveNativeTestLaneStatus,
  type NativeTestLaneStatusInput,
} from '../src/ios/nativeTestLaneStatus.ts';
import { decisionErrors, renderStepMessage } from '../src/ios/shared/stepDecision.ts';

const repository = 'example-org/example-app';

/** A same-repository pull request into develop with nothing selected and nothing run. */
function derive(overrides: Partial<NativeTestLaneStatusInput> = {}) {
  const input: NativeTestLaneStatusInput = {
    eventName: 'pull_request',
    testScope: '',
    dispatchRef: 'refs/pull/4963/merge',
    repository,
    headRepository: repository,
    baseBranch: 'develop',
    baseUpdateDeferred: 'false',
    changeGateResult: 'success',
    changeGateShouldRun: 'true',
    macRunnerResolutionResult: 'skipped',
    nativePreparationResult: 'skipped',
    nativeBuildResult: 'skipped',
    nativeExecutionRequired: 'false',
    releaseArchiveRequired: 'false',
    releaseArchiveResult: 'skipped',
    mainExecutionResult: 'skipped',
    mainRequired: 'false',
    evidenceRequired: 'false',
    ...overrides,
  };
  return deriveNativeTestLaneStatus(input);
}

const lines = (decision: ReturnType<typeof derive>): string[] =>
  decision.messages.map(renderStepMessage);

describe('deriveNativeTestLaneStatus deferral and diagnostics', () => {
  it('fails a deferred head before any other rule can excuse it', () => {
    // resumeRetainedIosPredecessor.ts only reruns a context that concluded
    // failure, so a deferred head must fail even when everything else is green.
    const decision = derive({
      baseUpdateDeferred: 'true',
      mainRequired: 'true',
      macRunnerResolutionResult: 'success',
      mainExecutionResult: 'success',
    });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'The retained predecessor has not completed yet.',
    ]);
  });

  it('treats an absent deferral flag as not deferred', () => {
    const decision = derive({ baseUpdateDeferred: '' });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), [
      'not selected: no native XCTest lane is selected; real-server E2E is evaluated independently.',
    ]);
  });

  it('reports the schema diagnostic even when the change gate failed', () => {
    // The gate never runs for this scope, so its result must not mask the
    // diagnostic's own verdict either way.
    const trusted = derive({
      eventName: 'workflow_dispatch',
      testScope: 'development-e2e-schema',
      dispatchRef: 'refs/heads/develop',
      changeGateResult: 'skipped',
    });
    assert.equal(trusted.exitCode, 0);
    assert.deepEqual(lines(trusted), [
      'Native iOS tests are outside the development E2E schema verification scope.',
    ]);

    const untrusted = derive({
      eventName: 'workflow_dispatch',
      testScope: 'development-e2e-schema',
      dispatchRef: 'refs/heads/feature',
      changeGateResult: 'skipped',
    });
    assert.equal(untrusted.exitCode, 1);
    assert.deepEqual(decisionErrors(untrusted), [
      'Development E2E schema verification requires a trusted develop or main ref.',
    ]);
  });

  it('names an empty change gate result rather than claiming success', () => {
    const decision = derive({ changeGateResult: '' });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), ['iOS selection did not complete successfully: ']);
  });
});

describe('deriveNativeTestLaneStatus waived execution', () => {
  it('counts a prepared, built product with no selected execution as a success', () => {
    const decision = derive({
      mainRequired: 'true',
      macRunnerResolutionResult: 'success',
      nativePreparationResult: 'success',
      nativeBuildResult: 'success',
      nativeExecutionRequired: 'false',
      mainExecutionResult: 'skipped',
    });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), [
      'Affected iOS tests and account-update acceptance passed from one compiled product.',
    ]);
  });

  it('applies the shell defaults for absent preparation, build and requirement', () => {
    // `${NATIVE_EXECUTION_REQUIRED:-false}` makes an absent flag mean "waived",
    // while absent preparation and build results mean "skipped" and block it.
    const waived = derive({
      mainRequired: 'true',
      macRunnerResolutionResult: 'success',
      nativePreparationResult: 'success',
      nativeBuildResult: 'success',
      nativeExecutionRequired: '',
    });
    assert.equal(waived.exitCode, 0);

    const notBuilt = derive({
      mainRequired: 'true',
      macRunnerResolutionResult: 'success',
      nativePreparationResult: 'success',
      nativeBuildResult: '',
      nativeExecutionRequired: '',
    });
    assert.equal(notBuilt.exitCode, 1);
    assert.deepEqual(decisionErrors(notBuilt), [
      'Selected PR XCTest did not execute successfully: skipped',
    ]);
  });

  it('never rewrites a non-skipped execution result', () => {
    const decision = derive({
      mainRequired: 'true',
      macRunnerResolutionResult: 'success',
      nativePreparationResult: 'success',
      nativeBuildResult: 'success',
      nativeExecutionRequired: 'false',
      mainExecutionResult: 'failure',
    });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Selected PR XCTest did not execute successfully: failure',
    ]);
  });
});

describe('deriveNativeTestLaneStatus release archive', () => {
  it('demands the archive on trusted pull requests and trusted dispatches alike', () => {
    for (const surface of [
      { eventName: 'pull_request', baseBranch: 'main' },
      { eventName: 'workflow_dispatch', dispatchRef: 'refs/heads/main' },
    ]) {
      const decision = derive({
        ...surface,
        releaseArchiveRequired: 'true',
        releaseArchiveResult: 'failure',
      });
      assert.equal(decision.exitCode, 1, JSON.stringify(surface));
      assert.deepEqual(decisionErrors(decision), [
        'The required exact-head Release archive did not pass: failure',
      ]);
    }
  });

  it('names an absent archive result "missing" while still failing closed', () => {
    const decision = derive({ releaseArchiveRequired: 'true', releaseArchiveResult: '' });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'The required exact-head Release archive did not pass: missing',
    ]);
  });

  it('does not demand the archive on a fork head or an untrusted dispatch ref', () => {
    const fork = derive({
      headRepository: 'outside/fork',
      releaseArchiveRequired: 'true',
      releaseArchiveResult: 'failure',
    });
    assert.equal(fork.exitCode, 0);
    assert.deepEqual(lines(fork), [
      'iOS execution is intentionally unavailable for this pull request source or base.',
    ]);

    const untrustedDispatch = derive({
      eventName: 'workflow_dispatch',
      dispatchRef: 'refs/heads/feature',
      macRunnerResolutionResult: 'success',
      releaseArchiveRequired: 'true',
      releaseArchiveResult: 'failure',
      nativePreparationResult: 'success',
      nativeBuildResult: 'success',
    });
    assert.equal(untrustedDispatch.exitCode, 0);
  });
});

describe('deriveNativeTestLaneStatus lane selection', () => {
  it('requires an explicit successful native plan before an onboarding-only promotion dispatch passes', () => {
    const selected = {
      eventName: 'workflow_dispatch', testScope: 'promotion-evidence',
      dispatchRef: 'refs/heads/develop', macRunnerResolutionResult: 'success',
      nativePreparationResult: 'success', nativeExecutionRequired: 'false',
    };
    assert.equal(derive(selected).exitCode, 0);
    assert.match(lines(derive(selected)).join('\n'), /Typed exact-develop plan selected no native XCTest/);
    for (const invalid of [
      { nativePreparationResult: 'skipped' },
      { nativeExecutionRequired: '' },
      { mainRequired: 'true' },
      { dispatchRef: 'refs/heads/feature' },
      { macRunnerResolutionResult: 'failure' },
    ]) assert.equal(derive({ ...selected, ...invalid }).exitCode, 1);
  });
  it('reports the no-selection pass for a settled resolver in either state', () => {
    for (const macRunnerResolutionResult of ['success', 'skipped']) {
      const decision = derive({ macRunnerResolutionResult });
      assert.equal(decision.exitCode, 0, macRunnerResolutionResult);
      assert.deepEqual(lines(decision), [
        'not selected: no native XCTest lane is selected; real-server E2E is evaluated independently.',
      ]);
    }
  });

  it('cannot report no selection while the resolver failed or is unknown', () => {
    for (const macRunnerResolutionResult of ['failure', 'cancelled', '']) {
      const decision = derive({ macRunnerResolutionResult });
      assert.equal(decision.exitCode, 1, macRunnerResolutionResult);
      assert.deepEqual(decisionErrors(decision), [
        `iOS macOS runner resolution did not pass: ${macRunnerResolutionResult}`,
      ]);
    }
  });

  it('cannot report no selection when either requirement flag is unknown', () => {
    // An empty flag is neither "true" nor "false"; the shell compared against
    // "false" so an unknown selection must not be read as an absent one.
    for (const overrides of [{ mainRequired: '' }, { evidenceRequired: '' }]) {
      const decision = derive(overrides);
      assert.equal(decision.exitCode, 1, JSON.stringify(overrides));
    }
  });

  it('fails a fork pull request that did select a lane instead of excusing it', () => {
    // The selected-lane rule is evaluated before the untrusted-source excuse,
    // so a fork that somehow executed a required lane badly still fails.
    const decision = derive({
      headRepository: 'outside/fork',
      evidenceRequired: 'true',
      mainExecutionResult: 'failure',
    });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'Selected PR XCTest did not execute successfully: failure',
    ]);
  });

  it('excuses a fork pull request before it reaches the resolver check', () => {
    const decision = derive({ headRepository: 'outside/fork', macRunnerResolutionResult: '' });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), [
      'iOS execution is intentionally unavailable for this pull request source or base.',
    ]);
  });
});

describe('deriveNativeTestLaneStatus promotions and dispatches', () => {
  it('accepts a promotion whose gate selected nothing at all', () => {
    const decision = derive({ baseBranch: 'main', changeGateShouldRun: 'false' });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), [
      'No affected iOS XCTest lane is required for this production promotion.',
    ]);
  });

  it('lets an E2E-only promotion defer native XCTest to the real-server verdict', () => {
    const decision = derive({
      baseBranch: 'main',
      changeGateShouldRun: 'true',
      macRunnerResolutionResult: 'success',
    });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), [
      'not selected: no native XCTest lane is selected; real-server E2E is evaluated independently.',
    ]);
  });

  it('refuses an E2E-only promotion if runner resolution failed', () => {
    const decision = derive({ baseBranch: 'main', changeGateShouldRun: 'true' });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), ['iOS macOS runner resolution did not pass: skipped']);
  });

  it('names the evidence dispatch scope that the consolidated lane satisfied', () => {
    for (const [testScope, message] of [
      ['mortgage-assignment-evidence', 'Issue #4001 mortgage-assignment evidence passed.'],
      [
        'onboarding-copy-evidence',
        'Issue #4549 onboarding-copy accessibility evidence passed from the main XCTest lane.',
      ],
    ] as const) {
      const decision = derive({
        eventName: 'workflow_dispatch',
        dispatchRef: 'refs/heads/develop',
        testScope,
        macRunnerResolutionResult: 'success',
        mainExecutionResult: 'success',
      });
      assert.equal(decision.exitCode, 0, testScope);
      assert.deepEqual(lines(decision), [message]);
    }
  });

  it('names the dispatch scopes that allocate no consolidated native lane', () => {
    for (const [testScope, message] of [
      ['e2e', 'Real-server iOS E2E runs without the consolidated native XCTest lane.'],
      [
        'debt-card-evidence',
        'Issues #3998 and #3999 backend/archive evidence excludes the already-covered ' +
          'frontend XCTest matrices.',
      ],
    ] as const) {
      const decision = derive({
        eventName: 'workflow_dispatch',
        dispatchRef: 'refs/heads/develop',
        testScope,
        macRunnerResolutionResult: 'success',
      });
      assert.equal(decision.exitCode, 0, testScope);
      assert.deepEqual(lines(decision), [message]);
    }
  });

  it('fails an unrecognised dispatch scope whose lane never executed', () => {
    const decision = derive({
      eventName: 'workflow_dispatch',
      dispatchRef: 'refs/heads/develop',
      testScope: 'full',
      macRunnerResolutionResult: 'success',
    });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'The consolidated iOS XCTest execution did not pass: main=skipped',
    ]);
  });

  it('reports the resolved execution result in the final failure, not the raw one', () => {
    const decision = derive({
      eventName: 'workflow_dispatch',
      dispatchRef: 'refs/heads/develop',
      testScope: 'full',
      macRunnerResolutionResult: 'success',
      mainExecutionResult: 'cancelled',
    });
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decisionErrors(decision), [
      'The consolidated iOS XCTest execution did not pass: main=cancelled',
    ]);
  });

  it('accepts an executed lane on any surface once everything upstream passed', () => {
    const decision = derive({
      eventName: 'workflow_dispatch',
      dispatchRef: 'refs/heads/main',
      testScope: 'full',
      macRunnerResolutionResult: 'success',
      mainExecutionResult: 'success',
    });
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(lines(decision), [
      'Affected iOS tests and account-update acceptance passed from one compiled product.',
    ]);
  });
});

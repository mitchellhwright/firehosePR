import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  admissionFailure,
  diskFloorsFor,
  labelsAreExternalMacOs,
  resolveIosRunnerLabels,
  resolveLaneLabels,
  type RunnerAdmission,
} from '../src/ios/iosRunnerLabels.ts';
import { StepFailure } from '../src/ios/shared/stepFailure.ts';

const external = '["self-hosted","macOS","ios-xcode"]';
const reserved = '["self-hosted","macOS","ios-reserved-mitchell"]';

function admission(overrides: Partial<RunnerAdmission> = {}): RunnerAdmission {
  return {
    eventName: 'pull_request',
    headRepository: 'example-org/example-app',
    githubRepository: 'example-org/example-app',
    githubRef: 'refs/pull/1/merge',
    testScope: '',
    macRunner: 'shared',
    ...overrides,
  };
}

describe('admissionFailure', () => {
  it('keeps a fork out of the reviewed runner group', () => {
    assert.equal(
      admissionFailure(admission({ headRepository: 'contributor/example-app' })),
      '::error::Fork PRs cannot enter the reviewed iOS runner group.',
    );
  });

  it('treats an absent head repository on a pull request as a fork', () => {
    assert.match(admissionFailure(admission({ headRepository: '' })) ?? '', /^::error::Fork PRs/);
  });

  it('admits a manual dispatch only from develop, main, or a pull-request evidence scope', () => {
    for (const githubRef of ['refs/heads/develop', 'refs/heads/main']) {
      assert.equal(
        admissionFailure(admission({ eventName: 'workflow_dispatch', githubRef })),
        undefined,
      );
    }
    for (const testScope of ['financial-independence-evidence', 'shared-cta-evidence']) {
      assert.equal(
        admissionFailure(admission({
          eventName: 'workflow_dispatch', githubRef: 'refs/heads/feature/x', testScope,
        })),
        undefined,
        testScope,
      );
    }
    for (const githubRef of ['refs/heads/feature/x', 'refs/tags/main', '']) {
      assert.equal(
        admissionFailure(admission({ eventName: 'workflow_dispatch', githubRef })),
        '::error::Manual external macOS execution requires develop or main.',
        githubRef,
      );
    }
  });

  it('leaves every other event alone, so the label check is what decides it', () => {
    assert.equal(
      admissionFailure(admission({ eventName: 'push', githubRef: 'refs/heads/feature/x' })),
      undefined,
    );
  });

  it('only admits the reserved choice on a manual dispatch', () => {
    assert.equal(admissionFailure(admission({ macRunner: 'mitchell-reserved' })),
      '::error::The reserved macOS runner is only available to a manual dispatch.');
    assert.equal(admissionFailure(admission({ eventName: 'workflow_dispatch',
      githubRef: 'refs/heads/develop', macRunner: 'mitchell-reserved' })), undefined);
    assert.equal(admissionFailure(admission({ eventName: 'workflow_dispatch',
      githubRef: 'refs/heads/develop', macRunner: 'other' })),
    '::error::Unknown manual macOS runner choice.');
  });
});

describe('labelsAreExternalMacOs', () => {
  it('requires all three capability labels', () => {
    assert.equal(labelsAreExternalMacOs(external), true);
    assert.equal(labelsAreExternalMacOs('["self-hosted","macOS"]'), false);
    assert.equal(labelsAreExternalMacOs('["self-hosted","ios-xcode"]'), false);
    assert.equal(labelsAreExternalMacOs('["macOS","ios-xcode"]'), false);
  });

  it('never admits the reserved capability as the ordinary PR route', () => {
    assert.equal(labelsAreExternalMacOs(reserved), false);
    assert.equal(labelsAreExternalMacOs(reserved, 'mitchell-reserved'), true);
    assert.equal(labelsAreExternalMacOs(external, 'mitchell-reserved'), false);
    assert.equal(labelsAreExternalMacOs('["self-hosted","macOS","ios-xcode","ios-reserved-mitchell"]'), false);
  });

  it('rejects a hosted label mixed in beside the capability labels', () => {
    // A hosted runner in the group would silently accept the reviewed work on
    // GitHub's own Macs; every `macos-*` label is refused, not just macos-26.
    assert.equal(labelsAreExternalMacOs('["self-hosted","macOS","ios-xcode","macos-26"]'), false);
    assert.equal(labelsAreExternalMacOs('["self-hosted","macOS","ios-xcode","macos-15"]'), false);
    assert.equal(labelsAreExternalMacOs('["macos-26"]'), false);
  });

  it('rejects anything that is not a non-empty list of non-empty strings', () => {
    for (const raw of ['[]', 'invalid', '', 'null', '"self-hosted"', '{"labels":[]}',
      '["self-hosted","macOS","ios-xcode",""]', '["self-hosted","macOS","ios-xcode",1]']) {
      assert.equal(labelsAreExternalMacOs(raw), false, raw);
    }
  });
});

describe('resolveLaneLabels', () => {
  it('returns the configured text verbatim, because fromJson reads it back', () => {
    const spaced = '["self-hosted", "macOS", "ios-xcode"]';
    assert.equal(resolveLaneLabels('main', spaced, admission()), spaced);
  });

  it('routes a manual reserved run only to the dedicated label', () => {
    const dispatch = admission({ eventName: 'workflow_dispatch',
      githubRef: 'refs/heads/develop', macRunner: 'mitchell-reserved' });
    assert.equal(resolveLaneLabels('main', reserved, dispatch), reserved);
    assert.throws(() => resolveLaneLabels('main', external, dispatch), StepFailure);
  });

  it('names the lane in the refusal so the log says which one is misconfigured', () => {
    assert.throws(
      () => resolveLaneLabels('chat-plaid', '["macos-26"]', admission()),
      (error: unknown) => error instanceof StepFailure
        && error.message === '::error::chat-plaid requires external self-hosted macOS Xcode '
          + 'labels; hosted fallback is prohibited.'
        && error.stream === 'stderr',
    );
  });

  it('checks admission before the labels, so a fork never learns the group name', () => {
    assert.throws(
      () => resolveLaneLabels('main', '["macos-26"]', admission({ headRepository: 'fork/site' })),
      (error: unknown) => error instanceof StepFailure
        && error.message === '::error::Fork PRs cannot enter the reviewed iOS runner group.',
    );
  });
});

describe('diskFloorsFor', () => {
  it('keeps the measured headroom on a self-hosted Mac', () => {
    assert.deepEqual(diskFloorsFor(external), {
      minimumFreeKb: '12000000',
      minimumExecutionFreeKb: '8000000',
    });
  });

  it('falls back to the smaller floors for anything else, including unreadable labels', () => {
    for (const raw of ['["macos-26"]', 'invalid', '']) {
      assert.deepEqual(diskFloorsFor(raw), {
        minimumFreeKb: '7000000',
        minimumExecutionFreeKb: '4000000',
      }, raw);
    }
  });
});

describe('resolveIosRunnerLabels', () => {
  const configuration = {
    main: external,
    evidence: external,
    onboarding: external,
    chatPlaid: external,
    budget: external,
  };

  it('publishes each lane and both sets of floors, in one fixed order', () => {
    const resolution = resolveIosRunnerLabels(configuration, admission());
    assert.deepEqual(resolution.outputs.map((output) => output.key), [
      'ios_macos_runner_labels',
      'ios_evidence_macos_runner_labels',
      'ios_onboarding_macos_runner_labels',
      'ios_chat_plaid_macos_runner_labels',
      'ios_budget_macos_runner_labels',
      'ios_macos_minimum_free_kb',
      'ios_macos_minimum_execution_free_kb',
      'ios_evidence_macos_minimum_free_kb',
      'ios_evidence_macos_minimum_execution_free_kb',
    ]);
    const values = Object.fromEntries(resolution.outputs.map((o) => [o.key, o.value]));
    assert.equal(values.ios_budget_macos_runner_labels, external);
    assert.equal(values.ios_macos_minimum_free_kb, '12000000');
    assert.equal(values.ios_evidence_macos_minimum_execution_free_kb, '8000000');
  });

  it('reports the labels and both floors as notices', () => {
    const { notices } = resolveIosRunnerLabels(configuration, admission());
    assert.deepEqual(notices, [
      `::notice::Using iOS macOS runner labels: ${external}`,
      `::notice::Using iOS evidence macOS runner labels: ${external}`,
      `::notice::Using iOS onboarding macOS runner labels: ${external}`,
      '::notice::Using iOS macOS disk floors: preflight=12000000 KB execution=8000000 KB',
      '::notice::Using iOS evidence disk floors: preflight=12000000 KB execution=8000000 KB',
    ]);
  });

  it('refuses the whole step when any one lane is misconfigured', () => {
    assert.throws(
      () => resolveIosRunnerLabels({ ...configuration, budget: '["macos-26"]' }, admission()),
      (error: unknown) => error instanceof StepFailure
        && error.message.startsWith('::error::budget'),
    );
  });

  it('publishes nothing for an inadmissible run', () => {
    assert.throws(
      () => resolveIosRunnerLabels(configuration, admission({ headRepository: 'fork/site' })),
      (error: unknown) => error instanceof StepFailure && error.message.includes('Fork PRs'),
    );
  });
});

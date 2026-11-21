import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evidencePlanGroups,
  firstLaunchBusySuffix,
  firstLaunchFailureSuffix,
  nativeProducerDiagnosticCandidates,
  nativeProductBuildDecision,
  parseExecutionLanes,
  runScopedDiagnosticPaths,
  runScopedTempPrefix,
  storekitPrimeSuffix,
  testProductHandoffDecision,
  type NativeProductBuildModeInputs,
} from '../src/ios/testProductHandoff.ts';

describe('testProductHandoffDecision', () => {
  it('accepts a cache when the independent artifact upload exhausts its quota', () => {
    const decision = testProductHandoffDecision({
      transportFailurePolicy: 'fail',
      cacheSaveOutcome: 'success',
      cacheLookupOutcome: 'success',
      cacheHit: 'true',
      artifactOutcome: 'failure',
    });
    assert.equal(decision.exitCode, 0);
    assert.match(decision.messages[0]?.text ?? '', /verified Actions cache/);
  });

  it('accepts the artifact fallback after a cache miss', () => {
    const decision = testProductHandoffDecision({
      transportFailurePolicy: 'fail',
      cacheSaveOutcome: 'failure',
      cacheLookupOutcome: 'success',
      cacheHit: 'false',
      artifactOutcome: 'success',
    });
    assert.equal(decision.exitCode, 0);
    assert.match(decision.messages[0]?.text ?? '', /artifact fallback/);
  });

  it('fails closed when neither transport published the products', () => {
    const decision = testProductHandoffDecision({
      transportFailurePolicy: 'fail',
      cacheSaveOutcome: 'failure',
      cacheLookupOutcome: 'failure',
      cacheHit: '',
      artifactOutcome: 'failure',
    });
    assert.equal(decision.exitCode, 1);
    assert.match(decision.messages[0]?.text ?? '', /No iOS test-product transport succeeded/);
    assert.match(decision.messages[0]?.text ?? '', /cache save=failure/);
    assert.match(decision.messages[0]?.text ?? '', /artifact upload=failure/);
  });

  it('does not trust a cache-hit output from a failed lookup step', () => {
    const decision = testProductHandoffDecision({
      transportFailurePolicy: 'fail',
      cacheSaveOutcome: 'success',
      cacheLookupOutcome: 'failure',
      cacheHit: 'true',
      artifactOutcome: 'failure',
    });
    assert.equal(decision.exitCode, 1);
  });

  it('lets exact-head consumers rebuild when both transports fail', () => {
    const decision = testProductHandoffDecision({
      transportFailurePolicy: 'consumer-rebuild',
      cacheSaveOutcome: 'failure',
      cacheLookupOutcome: 'failure',
      cacheHit: '',
      artifactOutcome: 'failure',
    });
    assert.equal(decision.exitCode, 0);
    assert.equal(decision.messages[0]?.level, 'warning');
    assert.match(decision.messages[0]?.text ?? '', /Consumers will rebuild products from their exact head/);
  });
});

function inputs(
  overrides: Partial<NativeProductBuildModeInputs> = {},
): NativeProductBuildModeInputs {
  return {
    preparedSelectionMode: 'affected',
    preparedUiRequired: 'true',
    preparedEvidenceGroups: '',
    preparedNarrowPaywallRequired: 'false',
    forcedExecutionLanes: '[]',
    fullExecutionLanes: '[]',
    ...overrides,
  };
}

function resolved(overrides: Partial<NativeProductBuildModeInputs> = {}): {
  mode: string;
  evidencePlanRequired: boolean;
} {
  const decision = nativeProductBuildDecision(inputs(overrides));
  assert.equal(decision.kind, 'resolved', JSON.stringify(decision));
  if (decision.kind !== 'resolved') throw new Error('unreachable');
  return { mode: decision.mode, evidencePlanRequired: decision.evidencePlanRequired };
}

describe('parseExecutionLanes', () => {
  it('reads a JSON array of lane names', () => {
    assert.deepEqual(parseExecutionLanes('["native1","evidence-visual"]'), ['native1', 'evidence-visual']);
    assert.deepEqual(parseExecutionLanes('[]'), []);
  });

  it('yields no lanes for a value that is not an array of strings', () => {
    // The gate always writes an array; these are what the replaced `jq` calls
    // did with anything else, and the widening decision must not change.
    assert.deepEqual(parseExecutionLanes('not json'), []);
    assert.deepEqual(parseExecutionLanes(''), []);
    assert.deepEqual(parseExecutionLanes('null'), []);
    assert.deepEqual(parseExecutionLanes('{"native1":true}'), []);
    assert.deepEqual(parseExecutionLanes('"native1"'), []);
    assert.deepEqual(parseExecutionLanes('["native1",7,null]'), ['native1']);
  });
});

describe('nativeProductBuildDecision', () => {
  it('rejects a selection mode the selector never emits', () => {
    const decision = nativeProductBuildDecision(inputs({ preparedSelectionMode: 'partial' }));
    assert.deepEqual(decision, {
      kind: 'error',
      message: 'Unknown prepared iOS selection mode: partial',
    });
  });

  it('rejects an absent selection mode rather than guessing one', () => {
    const decision = nativeProductBuildDecision(inputs({ preparedSelectionMode: '' }));
    assert.equal(decision.kind, 'error');
  });

  it('keeps the prepared mode when nothing forces a wider build', () => {
    assert.deepEqual(resolved(), { mode: 'affected', evidencePlanRequired: false });
    assert.deepEqual(
      resolved({ preparedSelectionMode: 'skip' }),
      { mode: 'skip', evidencePlanRequired: false },
    );
  });

  it('widens to full whenever a lane is retained at full granularity', () => {
    assert.equal(resolved({ fullExecutionLanes: '["native4"]' }).mode, 'full');
    // Even a prepared skip: the retained lane will launch these products.
    assert.equal(
      resolved({ preparedSelectionMode: 'skip', fullExecutionLanes: '["native4"]' }).mode,
      'full',
    );
  });

  it('widens to full for a forced evidence lane, and only visual evidence needs the plan', () => {
    assert.deepEqual(
      resolved({ forcedExecutionLanes: '["evidence-account-update"]' }),
      { mode: 'full', evidencePlanRequired: false },
    );
    assert.deepEqual(
      resolved({ forcedExecutionLanes: '["evidence-visual"]' }),
      { mode: 'full', evidencePlanRequired: true },
    );
  });

  it('widens an affected build for a forced native lane only when no UI shard runs', () => {
    assert.equal(
      resolved({ preparedUiRequired: 'false', forcedExecutionLanes: '["native4"]' }).mode,
      'full',
    );
    assert.equal(
      resolved({ preparedUiRequired: 'true', forcedExecutionLanes: '["native4"]' }).mode,
      'affected',
    );
    assert.equal(
      resolved({ preparedUiRequired: 'false', forcedExecutionLanes: '[]' }).mode,
      'affected',
    );
  });

  it('requires the UI flag only on the path that reads it', () => {
    const missing = nativeProductBuildDecision(inputs({ preparedUiRequired: '' }));
    assert.deepEqual(missing, {
      kind: 'error',
      message: 'PREPARED_UI_REQUIRED: parameter null or not set',
    });
    // A prepared skip never reaches that condition, exactly as the shell's
    // short-circuiting `[[ … && … ]]` never expanded it.
    assert.equal(resolved({ preparedSelectionMode: 'skip', preparedUiRequired: '' }).mode, 'skip');
    assert.equal(
      resolved({ preparedUiRequired: '', fullExecutionLanes: '["native1"]' }).mode,
      'full',
    );
  });

  it('compiles the evidence plan for every group whose products only exist in it', () => {
    for (const group of evidencePlanGroups) {
      assert.equal(
        resolved({ preparedEvidenceGroups: `account-update,${group}` }).evidencePlanRequired,
        true,
        group,
      );
    }
    assert.equal(resolved({ preparedEvidenceGroups: 'account-update' }).evidencePlanRequired, false);
  });

  it('never matches an evidence group by prefix', () => {
    assert.equal(
      resolved({ preparedEvidenceGroups: 'accessibility-extra,onboarding-copyish' })
        .evidencePlanRequired,
      false,
    );
  });

  it('compiles the evidence plan for a narrow paywall run', () => {
    assert.equal(resolved({ preparedNarrowPaywallRequired: 'true' }).evidencePlanRequired, true);
    // Anything but the selector's own `true` leaves the plan out, which is what
    // the consumer's `[[ "$evidence_plan_required" == true ]]` concluded too.
    assert.equal(resolved({ preparedNarrowPaywallRequired: 'yes' }).evidencePlanRequired, false);
  });
});

describe('runScopedDiagnosticPaths', () => {
  const directories = [
    { path: '/tmp/run.2', entries: ['native2.first-launch-busy.log', 'tests.xcresult'] },
    {
      path: '/tmp/run.1',
      entries: [
        'native1.first-launch-busy.log',
        'a.first-launch-busy.log',
        '.first-launch-busy.log',
        'first-launch-busy.log',
      ],
    },
  ];

  it('matches by suffix inside each directory and sorts the whole expansion', () => {
    assert.deepEqual(runScopedDiagnosticPaths(directories, firstLaunchBusySuffix), [
      '/tmp/run.1/a.first-launch-busy.log',
      '/tmp/run.1/native1.first-launch-busy.log',
      '/tmp/run.2/native2.first-launch-busy.log',
    ]);
  });

  it('never matches a dotfile, because a leading `*` did not', () => {
    const matched = runScopedDiagnosticPaths(directories, firstLaunchBusySuffix);
    assert.ok(!matched.some((path) => path.endsWith('/.first-launch-busy.log')));
  });

  it('returns nothing when no directory holds the suffix', () => {
    assert.deepEqual(runScopedDiagnosticPaths(directories, firstLaunchFailureSuffix), []);
    assert.deepEqual(runScopedDiagnosticPaths([], firstLaunchBusySuffix), []);
  });
});

describe('nativeProducerDiagnosticCandidates', () => {
  it('keeps the order the replaced loop offered, expansions included', () => {
    const candidates = nativeProducerDiagnosticCandidates({
      resultBundle: '/tests.xcresult',
      xcodebuildLog: '/xcodebuild.log',
      storekitResultBundle: '/storekit.xcresult',
      storekitXcodebuildLog: '/storekit.log',
      runScopedDirectories: [{
        path: '/tmp/run.1',
        entries: [
          `lane${firstLaunchFailureSuffix}`,
          `lane${firstLaunchBusySuffix}`,
          `lane${storekitPrimeSuffix}`,
        ],
      }],
    });
    assert.deepEqual(candidates, [
      '/tests.xcresult',
      `/tmp/run.1/lane${firstLaunchFailureSuffix}`,
      '/xcodebuild.log',
      `/tmp/run.1/lane${firstLaunchBusySuffix}`,
      `/tmp/run.1/lane${storekitPrimeSuffix}`,
      '/storekit.xcresult',
      '/storekit.log',
    ]);
  });

  it('offers the blank paths an earlier failure left behind, for the caller to drop', () => {
    const candidates = nativeProducerDiagnosticCandidates({
      resultBundle: '',
      xcodebuildLog: '',
      storekitResultBundle: '',
      storekitXcodebuildLog: '',
      runScopedDirectories: [],
    });
    assert.deepEqual(candidates, ['', '', '', '']);
  });
});

describe('runScopedTempPrefix', () => {
  it('scopes the temp directories to one run attempt', () => {
    assert.equal(runScopedTempPrefix('42', '2'), 'example-ios-tests.42.2.');
    assert.notEqual(runScopedTempPrefix('42', '1'), runScopedTempPrefix('42', '2'));
  });
});

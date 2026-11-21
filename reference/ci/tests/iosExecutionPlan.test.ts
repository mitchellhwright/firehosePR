import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  accessibilityEvidenceConfiguration,
  accessibilityEvidenceRequired,
  accessibilityEvidenceSelection,
  accountUpdateTestIdentifiers,
  accountUpdateShardSelection,
  diskHeadroomDecision,
  evidenceGroupNames,
  evidenceGroupRequired,
  evidenceRunManifest,
  evidenceTestPlan,
  evidenceXcodebuildArguments,
  fullAccountUpdateTestIdentifiers,
  headroomVerdict,
  mainTestConfiguration,
  laneExitPrecedence,
  laneExitStatus,
  laneStatusSummary,
  narrowPaywallEvidenceSelection,
  ownsAccountUpdateIdentifier,
  parseAvailableKilobytes,
  parseEvidenceGroups,
  resolveSetupTimeoutSeconds,
  routeCiLane,
  simulatorUdidFromDestination,
  simulatorsToRelease,
  storekitResult,
  storekitStepResult,
  unrecognizedEvidenceSelection,
  verifySimulatorStopped,
  checkedOutRevisionRejection,
  diagnosticEvidencePatterns,
  evidenceShardGroups,
  evidenceValidationPlan,
  failureSummaryTargets,
  laneRunDirectoryPrefix,
  laneSelectionMode,
  nativeTestProductEnvironment,
  retainedEvidence,
  simulatorCleanupPlan,
  toolchainVerdict,
} from '../src/ios/executionPlan.ts';
import type { LaneStatuses } from '../src/ios/executionPlan.ts';

const noStatuses: LaneStatuses = {
  main: 0, storekit: 0, executedGroups: 0, narrowPaywall: 0, accountUpdate: 0,
  accessibility: 0,
};

describe('routeCiLane', () => {
  it('keeps native1 running after its shards only when it owns account-update', () => {
    assert.deepEqual(routeCiLane('native1', ['account-update']), { kind: 'main-tests-then-evidence' });
    assert.deepEqual(routeCiLane('native1', ['accessibility']), { kind: 'main-tests-then-stop' });
    assert.deepEqual(routeCiLane('native1', []), { kind: 'main-tests-then-stop' });
  });

  it('ends native2, native3 and native4 at their shards whatever groups arrive', () => {
    for (const lane of ['native2', 'native3', 'native4']) {
      assert.deepEqual(routeCiLane(lane, ['account-update']), { kind: 'main-tests-only' });
    }
  });

  it('rejects the raw matrix lane names, which are mapped before the step runs', () => {
    // `IOS_CI_LANE` is `evidence` for both evidence shards; the shard's own
    // name reaches the step as IOS_MAIN_TEST_PARTITION, never as the lane.
    for (const lane of ['evidence-visual', 'evidence-account-update', 'main', 'storekit', '']) {
      const route = routeCiLane(lane, []);
      assert.equal(route.kind, 'unknown-lane');
      assert.equal(
        route.kind === 'unknown-lane' ? route.message : '',
        `::error::Unknown iOS CI lane: ${lane}`,
      );
    }
  });

  it('routes an evidence shard straight to the groups', () => {
    assert.deepEqual(routeCiLane('evidence', ['accessibility']), { kind: 'evidence-only' });
  });
});

describe('parseEvidenceGroups', () => {
  it('drops the empty entries a trailing or doubled comma leaves behind', () => {
    assert.deepEqual(parseEvidenceGroups('accessibility,,onboarding-copy,'), ['accessibility', 'onboarding-copy']);
    assert.deepEqual(parseEvidenceGroups(''), []);
    assert.deepEqual(parseEvidenceGroups(undefined), []);
    assert.deepEqual(parseEvidenceGroups(','), []);
  });

  it('trims the whitespace a hand-edited dispatch can introduce', () => {
    assert.deepEqual(parseEvidenceGroups(' accessibility , account-update '), ['accessibility', 'account-update']);
  });
});

describe('evidenceGroupRequired', () => {
  it('matches a whole group, never a prefix or a suffix of one', () => {
    const groups = ['onboarding-copy', 'account-update'];
    assert.equal(evidenceGroupRequired(groups, 'onboarding-copy'), true);
    assert.equal(evidenceGroupRequired(groups, 'onboarding'), false);
    assert.equal(evidenceGroupRequired(groups, 'copy'), false);
    assert.equal(evidenceGroupRequired(groups, 'account'), false);
  });
});

describe('accessibilityEvidenceRequired', () => {
  it('runs for either owning group and for neither otherwise', () => {
    assert.equal(accessibilityEvidenceRequired(['accessibility']), true);
    assert.equal(accessibilityEvidenceRequired(['onboarding-copy']), true);
    assert.equal(accessibilityEvidenceRequired(['account-update']), false);
    assert.equal(accessibilityEvidenceRequired([]), false);
  });
});

describe('simulatorUdidFromDestination', () => {
  it('takes everything after the final id=, as the shell suffix trim did', () => {
    assert.equal(
      simulatorUdidFromDestination('platform=iOS Simulator,id=B60D32E9-CBBC'),
      'B60D32E9-CBBC',
    );
    assert.equal(simulatorUdidFromDestination('id=one,id=two'), 'two');
  });

  it('returns a destination with no id= unchanged rather than emptying it', () => {
    assert.equal(simulatorUdidFromDestination('platform=iOS Simulator,name=iPhone 17'), 'platform=iOS Simulator,name=iPhone 17');
    assert.equal(simulatorUdidFromDestination(''), '');
  });
});

describe('simulatorsToRelease', () => {
  it('skips the selection and every unprovisioned slot', () => {
    assert.deepEqual(simulatorsToRelease(['primary', '', 'chart'], 'primary'), ['chart']);
    assert.deepEqual(simulatorsToRelease(['', '', ''], 'narrow'), []);
  });

  it('releases nothing when the lane owns only the simulator it wants', () => {
    assert.deepEqual(simulatorsToRelease(['narrow', '', ''], 'narrow'), []);
  });

  it('releases a duplicate slot only once per entry it actually holds', () => {
    assert.deepEqual(simulatorsToRelease(['primary', 'primary', 'narrow'], 'narrow'), ['primary', 'primary']);
  });
});

describe('verifySimulatorStopped', () => {
  it('fails closed when simctl reported no such device', () => {
    const verdict = verifySimulatorStopped('UDID-1', undefined, 'Accessibility');
    assert.equal(verdict.kind, 'unverifiable');
    assert.equal(
      verdict.kind === 'unverifiable' ? verdict.message : '',
      '::error::Could not verify simulator UDID-1 stopped before Accessibility.',
    );
  });

  it('treats an empty state as unverifiable rather than as a shutdown', () => {
    assert.equal(verifySimulatorStopped('UDID-1', '', 'Accessibility').kind, 'unverifiable');
  });

  it('names the state a simulator is stuck in', () => {
    const verdict = verifySimulatorStopped('UDID-1', 'Booted', 'Standard narrow');
    assert.equal(
      verdict.kind === 'still-running' ? verdict.message : '',
      '::error::Simulator UDID-1 remained Booted before Standard narrow.',
    );
  });

  it('accepts only the exact Shutdown state', () => {
    assert.equal(verifySimulatorStopped('UDID-1', 'Shutdown', 'Chart matrix').kind, 'ready');
    assert.equal(verifySimulatorStopped('UDID-1', 'Shutting Down', 'Chart matrix').kind, 'still-running');
  });
});

describe('accountUpdateTestIdentifiers', () => {
  it('fails an affected selection that owns no account-update identifier', () => {
    const selection = accountUpdateTestIdentifiers('affected', [
      'example-iosUITests/DebtCardLayoutUITests/testDefaultAndEdgeCaseMatrix',
    ]);
    assert.equal(selection.ok, false);
    assert.equal(
      selection.ok ? '' : selection.message,
      '::error::Affected account-update evidence selected with zero owned account-update identifiers.',
    );
  });

  it('fails an affected selection with no identifiers at all', () => {
    assert.equal(accountUpdateTestIdentifiers('affected', []).ok, false);
  });

  it('keeps only the identifiers this group owns out of a mixed selection', () => {
    const selection = accountUpdateTestIdentifiers('affected', [
      'example-iosUITests/ForgotPasswordViewStateUITests',
      'example-iosUITests/CardAccountUpdateReturnIRAUITests',
      'example-iosUITests/ActivationIntroManageAccountsCancelUITests/testCancel',
      'example-iosTests/CardAccountUpdateReturnUnitTests',
    ]);
    assert.deepEqual(selection.ok ? selection.identifiers : [], [
      'example-iosUITests/CardAccountUpdateReturnIRAUITests',
      'example-iosUITests/ActivationIntroManageAccountsCancelUITests/testCancel',
    ]);
  });

  it('runs the whole suite in full mode', () => {
    const selection = accountUpdateTestIdentifiers('full', []);
    assert.deepEqual(selection.ok ? selection.identifiers : [], fullAccountUpdateTestIdentifiers);
    assert.equal(fullAccountUpdateTestIdentifiers.length, 17);
  });

  it('refuses any other selection mode by name', () => {
    const selection = accountUpdateTestIdentifiers('skip', ['example-iosUITests/CardAccountUpdateReturnIRAUITests']);
    assert.equal(
      selection.ok ? '' : selection.message,
      '::error::Unsupported account-update selection mode: skip',
    );
  });

  it('never claims an identifier from another target that shares the prefix', () => {
    assert.equal(ownsAccountUpdateIdentifier('example-iosTests/CardAccountUpdateReturnTests'), false);
    assert.equal(ownsAccountUpdateIdentifier('example-iosUITests/CardAccountUpdateReturnIRAUITests'), true);
  });
});

describe('accessibilityEvidenceSelection', () => {
  const paywallMethod =
    'example-iosUITests/SubscriptionCTACopyEvidenceUITests/testAccessibilityTextKeepsEveryBenefitReadableAboveStickyCTA';

  it('captures the full matrix when the narrow paywall group is not running', () => {
    const selection = accessibilityEvidenceSelection(['accessibility'], false);
    assert.equal(selection.expectedTestCount, 5);
    assert.equal(selection.identifiers.length, 5);
    assert.ok(selection.identifiers.includes(paywallMethod));
    assert.equal(selection.label, 'Accessibility evidence');
  });

  it('drops the paywall method the narrow paywall group already owns', () => {
    const selection = accessibilityEvidenceSelection(['accessibility'], true);
    assert.equal(selection.expectedTestCount, 4);
    assert.equal(selection.identifiers.includes(paywallMethod), false);
  });

  it('narrows to the onboarding matrix for a shard that owns onboarding-copy alone', () => {
    const selection = accessibilityEvidenceSelection(['onboarding-copy'], false);
    assert.deepEqual(selection.identifiers, [
      'example-iosUITests/OnboardingCopyAccessibilityEvidenceUITests/testCaptureOnboardingCopyAccessibilityMatrix',
    ]);
    assert.equal(selection.expectedTestCount, 1);
    assert.equal(selection.label, 'Onboarding copy accessibility evidence');
  });

  it('runs the full matrix when a shard owns both groups', () => {
    const selection = accessibilityEvidenceSelection(['accessibility', 'onboarding-copy'], false);
    assert.equal(selection.expectedTestCount, 5);
    assert.equal(selection.label, 'Accessibility evidence');
  });

  it('applies the paywall exclusion before the onboarding-copy narrowing cannot', () => {
    const selection = accessibilityEvidenceSelection(['accessibility', 'onboarding-copy'], true);
    assert.equal(selection.expectedTestCount, 4);
    assert.equal(selection.identifiers.includes(paywallMethod), false);
  });

  it('keeps every expected count equal to the number of identifiers it asks for', () => {
    for (const selection of [
      accessibilityEvidenceSelection(['accessibility'], false),
      accessibilityEvidenceSelection(['accessibility'], true),
      accessibilityEvidenceSelection(['onboarding-copy'], false),
      narrowPaywallEvidenceSelection,
    ]) {
      assert.equal(selection.expectedTestCount, selection.identifiers.length, selection.label);
    }
  });
});

describe('evidenceXcodebuildArguments', () => {
  it('never builds, never parallelizes, and names one configuration', () => {
    const args = evidenceXcodebuildArguments({
      testProducts: '/products',
      testPlan: 'CI-Evidence',
      configuration: 'Standard Evidence Configuration',
      destination: 'platform=iOS Simulator,id=UDID-1',
      resultBundle: '/run/tests.xcresult',
      identifiers: ['example-iosUITests/A/testOne'],
    });
    assert.deepEqual(args, [
      'test-without-building',
      '-testProductsPath', '/products',
      '-testPlan', 'CI-Evidence',
      '-only-test-configuration', 'Standard Evidence Configuration',
      '-destination', 'platform=iOS Simulator,id=UDID-1',
      '-parallel-testing-enabled', 'NO',
      '-collect-test-diagnostics', 'never',
      '-resultBundlePath', '/run/tests.xcresult',
      '-only-testing:example-iosUITests/A/testOne',
    ]);
  });

  it('keeps a value carrying shell metacharacters in one argument', () => {
    const args = evidenceXcodebuildArguments({
      testProducts: '/products',
      testPlan: 'CI',
      configuration: 'CI Configuration',
      destination: 'platform=iOS Simulator,id=UDID-1',
      resultBundle: '/run/a b;rm -rf .xcresult',
      identifiers: [],
    });
    assert.ok(args.includes('/run/a b;rm -rf .xcresult'));
    assert.equal(args.filter((value) => value.startsWith('-only-testing:')).length, 0);
  });

});

describe('diskHeadroomDecision', () => {
  it('refuses a minimum that is not a positive integer', () => {
    for (const minimum of ['', '0', '-1', ' 100', '1.5', '8_000_000', 'lots']) {
      const decision = diskHeadroomDecision(minimum, '9000000');
      assert.equal(decision.kind, 'invalid-minimum', minimum);
      assert.equal(
        decision.kind === 'invalid-minimum' ? decision.message : '',
        '::error::IOS_TEST_EXECUTION_MIN_FREE_KB must be a positive integer.',
      );
    }
  });

  it('refuses a free-space reading it could not parse', () => {
    const decision = diskHeadroomDecision('8000000', '');
    assert.equal(decision.kind, 'unmeasurable');
    assert.equal(
      decision.kind === 'unmeasurable' ? decision.message : '',
      '::error::Unable to determine free disk before iOS test execution.',
    );
  });

  it('wipes the cache below the minimum and preserves it at exactly the minimum', () => {
    assert.equal(diskHeadroomDecision('8000000', '7999999').kind, 'wipe-cache');
    const preserved = diskHeadroomDecision('8000000', '8000000');
    assert.equal(preserved.kind, 'preserve-cache');
    assert.equal(
      preserved.kind === 'preserve-cache' ? preserved.message : '',
      'Preserving the persistent iOS build cache with 8000000 KB free.',
    );
  });

  it('accepts a measured zero as measurable and still wipes', () => {
    assert.equal(diskHeadroomDecision('8000000', '0').kind, 'wipe-cache');
  });
});

describe('headroomVerdict', () => {
  it('reports the shell test operator status when the remeasurement is unreadable', () => {
    const verdict = headroomVerdict('', 8000000);
    assert.equal(verdict.kind, 'unreadable');
    assert.equal(verdict.kind === 'unreadable' ? verdict.status : 0, 2);
  });

  it('fails the lane with status 1 and both figures when still short', () => {
    const verdict = headroomVerdict('10', 8000000);
    assert.equal(verdict.kind === 'insufficient' ? verdict.status : 0, 1);
    assert.equal(
      verdict.kind === 'insufficient' ? verdict.message : '',
      '::error::iOS test execution has 10 KB free; 8000000 KB is required.',
    );
  });

  it('passes at exactly the minimum', () => {
    assert.equal(headroomVerdict('8000000', 8000000).kind, 'sufficient');
  });
});

describe('parseAvailableKilobytes', () => {
  it('reads the available column of the second df line', () => {
    const output = [
      'Filesystem 1024-blocks      Used Available Capacity Mounted on',
      '/dev/disk3s5  971350180 120000000  62345678      66% /System/Volumes/Data',
      '',
    ].join('\n');
    assert.equal(parseAvailableKilobytes(output), '62345678');
  });

  it('returns an empty reading when df printed only a header or nothing', () => {
    assert.equal(parseAvailableKilobytes('Filesystem 1024-blocks Used Available Capacity Mounted on\n'), '');
    assert.equal(parseAvailableKilobytes(''), '');
  });
});

describe('storekitResult', () => {
  it('distinguishes a skipped lane from a passing one', () => {
    assert.equal(storekitResult(false, 0), 'skipped');
    assert.equal(storekitResult(false, 1), 'skipped');
    assert.equal(storekitResult(true, 0), 'success');
    assert.equal(storekitResult(true, 65), 'failure');
  });

  it('reads a step outcome the same way, including the one a skipped step renders', () => {
    assert.equal(storekitStepResult(false, 'success'), 'skipped');
    assert.equal(storekitStepResult(false, ''), 'skipped');
    assert.equal(storekitStepResult(true, 'success'), 'success');
    assert.equal(storekitStepResult(true, 'failure'), 'failure');
    assert.equal(storekitStepResult(true, 'cancelled'), 'failure');
    // A required lane whose step never ran has no evidence, so it cannot pass.
    assert.equal(storekitStepResult(true, ''), 'failure');
  });
});

describe('laneStatusSummary', () => {
  it('prints every group status on the single line the job log is read for', () => {
    assert.equal(
      laneStatusSummary({ ...noStatuses, executedGroups: 3, accountUpdate: 1, accessibility: 65 }),
      'lane status: main=0 storekit=0 executed-groups=3 narrow-paywall=0 account-update=1'
      + ' accessibility=65',
    );
  });
});

describe('laneExitStatus', () => {
  it('is zero only when every group passed', () => {
    assert.equal(laneExitStatus({ ...noStatuses, executedGroups: 3 }), 0);
  });

  it('reports the earliest failing group in the pinned precedence', () => {
    assert.equal(
      laneExitStatus({ ...noStatuses, narrowPaywall: 2, accountUpdate: 1, accessibility: 65 }),
      2,
    );
    assert.equal(laneExitStatus({ ...noStatuses, accountUpdate: 1, accessibility: 65 }), 1);
    assert.equal(laneExitStatus({ ...noStatuses, accessibility: 70 }), 70);
  });

  it('never lets the executed-group count decide the exit status', () => {
    assert.equal(laneExitStatus({ ...noStatuses, executedGroups: 5 }), 0);
    assert.equal(laneExitPrecedence.includes('executedGroups'), false);
    assert.equal(laneExitPrecedence.length, 5);
  });
});

describe('unrecognizedEvidenceSelection', () => {
  it('fails a shard handed groups it executed none of', () => {
    assert.equal(
      unrecognizedEvidenceSelection('renamed-group', 0),
      '::error::Evidence lane did not recognize or execute any selected evidence group: renamed-group',
    );
  });

  it('stays silent when a group ran or when no group was selected', () => {
    assert.equal(unrecognizedEvidenceSelection('accessibility', 1), undefined);
    assert.equal(unrecognizedEvidenceSelection('', 0), undefined);
    assert.equal(unrecognizedEvidenceSelection(undefined, 0), undefined);
  });
});

describe('evidenceRunManifest', () => {
  const everyGroup = {
    groups: [...evidenceGroupNames],
    narrowPaywallRequired: true,
    selectionMode: 'full',
    onlyTestingIdentifiers: [],
    mainTestPlan: 'CI',
  };

  it('enumerates the three runs a fully loaded shard starts, in execution order', () => {
    assert.deepEqual(evidenceRunManifest(everyGroup).map((run) => run.group), [
      'narrow-paywall', 'account-update', 'accessibility',
    ]);
  });

  it('runs account-update from the main products and every other group from the evidence products', () => {
    for (const run of evidenceRunManifest(everyGroup)) {
      assert.equal(run.products, run.group === 'account-update' ? 'main' : 'evidence');
      assert.equal(run.testPlan, run.group === 'account-update' ? 'CI' : evidenceTestPlan);
    }
  });

  it('names one of exactly two configurations for every run', () => {
    const configurations = new Set(evidenceRunManifest(everyGroup).map((run) => run.configuration));
    assert.deepEqual([...configurations].sort(), [
      accessibilityEvidenceConfiguration, mainTestConfiguration,
    ].sort());
  });

  it('captures the accessibility-sized groups on the accessibility configuration', () => {
    const runs = evidenceRunManifest(everyGroup);
    for (const group of ['narrow-paywall', 'accessibility']) {
      assert.equal(
        runs.find((run) => run.group === group)?.configuration,
        accessibilityEvidenceConfiguration,
        group,
      );
    }
  });

  it('starts nothing for a shard that owns no group', () => {
    assert.deepEqual(evidenceRunManifest({ ...everyGroup, groups: [], narrowPaywallRequired: false }), []);
  });

  it('omits an account-update run the selection mode cannot resolve', () => {
    const runs = evidenceRunManifest({
      ...everyGroup,
      groups: ['account-update'],
      narrowPaywallRequired: false,
      selectionMode: 'affected',
      onlyTestingIdentifiers: ['example-iosUITests/DebtCardLayoutUITests'],
    });
    assert.deepEqual(runs, []);
  });

  it('never runs the same identifier from two groups on one shard', () => {
    const identifiers = evidenceRunManifest(everyGroup).flatMap((run) => run.selection.identifiers);
    assert.equal(new Set(identifiers).size, identifiers.length);
  });
});

describe('resolveSetupTimeoutSeconds', () => {
  it('keeps the requested deadline when nothing overrides it', () => {
    assert.equal(resolveSetupTimeoutSeconds(15, undefined), 15);
    assert.equal(resolveSetupTimeoutSeconds(15, ''), 15);
  });

  it('allows an override to shorten a deadline but never to extend one', () => {
    assert.equal(resolveSetupTimeoutSeconds(15, '5'), 5);
    assert.throws(() => resolveSetupTimeoutSeconds(15, '16'), /cannot extend setup deadlines/);
  });

  it('refuses a zero or non-numeric override', () => {
    assert.throws(() => resolveSetupTimeoutSeconds(15, '0'), /must be positive/);
    assert.throws(() => resolveSetupTimeoutSeconds(15, '-5'), /must be positive/);
    assert.throws(() => resolveSetupTimeoutSeconds(15, 'soon'), /must be positive/);
  });
});

describe('laneSelectionMode', () => {
  const base = {
    preparedMode: 'affected',
    preparedUiRequired: 'true',
    forcedLane: false,
    forceFullLane: false,
    lane: 'native1',
  };

  it('passes an unforced lane through with the prepared selection', () => {
    for (const preparedMode of ['skip', 'affected', 'full']) {
      assert.deepEqual(laneSelectionMode({ ...base, preparedMode }), { ok: true, mode: preparedMode });
    }
  });

  it('refuses a prepared mode nothing produces', () => {
    for (const preparedMode of ['', 'Skip', 'affected ', 'unknown']) {
      const outcome = laneSelectionMode({ ...base, preparedMode });
      assert.equal(outcome.ok, false);
      assert.match(
        outcome.ok ? '' : outcome.message,
        /Unknown prepared iOS selection mode/,
      );
    }
  });

  it('runs a forced retained evidence lane whole whatever the run prepared', () => {
    for (const lane of ['evidence-account-update', 'evidence-visual']) {
      for (const preparedMode of ['skip', 'affected', 'full']) {
        assert.deepEqual(
          laneSelectionMode({ ...base, lane, preparedMode, forcedLane: true }),
          { ok: true, mode: 'full' },
        );
      }
    }
  });

  it('runs a forced main shard whole only when it has no affected UI selection', () => {
    assert.deepEqual(
      laneSelectionMode({ ...base, preparedMode: 'skip', forcedLane: true }),
      { ok: true, mode: 'full' },
    );
    assert.deepEqual(
      laneSelectionMode({ ...base, preparedUiRequired: 'false', forcedLane: true }),
      { ok: true, mode: 'full' },
    );
    assert.deepEqual(
      laneSelectionMode({ ...base, forcedLane: true }),
      { ok: true, mode: 'affected' },
    );
  });

  it('refuses to force a main shard without a prepared UI selection', () => {
    const outcome = laneSelectionMode({ ...base, preparedUiRequired: '', forcedLane: true });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.message, /PREPARED_UI_REQUIRED is required/);
    // Only the forced main branch reads it; an unforced lane never needs it.
    assert.deepEqual(
      laneSelectionMode({ ...base, preparedUiRequired: '' }),
      { ok: true, mode: 'affected' },
    );
  });

  it('refuses a forced lane the matrix does not define', () => {
    const outcome = laneSelectionMode({ ...base, lane: 'native5', forcedLane: true });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.message, /Unknown iOS execution lane: native5/);
  });

  it('lets a full-execution lane override everything, including an unforced skip', () => {
    assert.deepEqual(
      laneSelectionMode({ ...base, preparedMode: 'skip', forceFullLane: true }),
      { ok: true, mode: 'full' },
    );
  });
});

describe('evidenceShardGroups', () => {
  const everyGroup = ['accessibility', 'account-update', 'onboarding-copy'];

  it('keeps account-update off native1', () => {
    assert.deepEqual(evidenceShardGroups('native1', everyGroup, true), {
      ok: true, groups: [],
    });
    assert.deepEqual(evidenceShardGroups('native1', everyGroup, false), { ok: true, groups: [] });
  });

  it('splits the evidence shards so no group is captured twice', () => {
    const accountUpdate = evidenceShardGroups('evidence-account-update', everyGroup, true);
    const accountUpdateSecond = evidenceShardGroups('evidence-account-update-2', everyGroup, true);
    const visual = evidenceShardGroups('evidence-visual', everyGroup, true);
    assert.deepEqual(accountUpdate, { ok: true, groups: ['account-update'] });
    assert.deepEqual(accountUpdateSecond, { ok: true, groups: ['account-update'] });
    assert.deepEqual(visual, {
      ok: true, groups: ['accessibility', 'onboarding-copy'],
    });
    const owned = [
      ...(accountUpdate.ok ? accountUpdate.groups : []),
      ...(visual.ok ? visual.groups : []),
    ];
    assert.equal(new Set(owned).size, owned.length);
    assert.deepEqual([...owned].sort(), [...everyGroup].sort());
  });

  it('preserves the selector order rather than its own', () => {
    assert.deepEqual(
      evidenceShardGroups('evidence-visual', ['onboarding-copy', 'accessibility'], false),
      { ok: true, groups: ['onboarding-copy', 'accessibility'] },
    );
  });

  it('fails an evidence shard that would capture nothing', () => {
    for (const [lane, groups] of [
      ['evidence-visual', ['account-update']],
      ['evidence-account-update', ['accessibility']],
      ['evidence-visual', []],
    ] as const) {
      const outcome = evidenceShardGroups(lane, groups, true);
      assert.equal(outcome.ok, false);
      assert.match(outcome.ok ? '' : outcome.message, new RegExp(`Evidence shard ${lane}`));
    }
  });

  it('leaves a main shard that owns nothing green', () => {
    assert.deepEqual(evidenceShardGroups('native3', everyGroup, true), { ok: true, groups: [] });
    assert.deepEqual(evidenceShardGroups('native1', [], true), { ok: true, groups: [] });
  });
});

describe('accountUpdateShardSelection', () => {
  it('covers all 21 account-update tests exactly once across two shards', () => {
    const first = accountUpdateShardSelection('full', [], 'evidence-account-update');
    const second = accountUpdateShardSelection('full', [], 'evidence-account-update-2');
    assert.ok(first && second);
    assert.deepEqual(new Set([...first.identifiers, ...second.identifiers]),
      new Set(fullAccountUpdateTestIdentifiers));
    assert.equal(first.expectedTestCount + second.expectedTestCount, 21);
    assert.equal(first.expectedTestCount, 11);
    assert.equal(second.expectedTestCount, 10);
  });

  it('schedules only the shard that owns a narrow affected class', () => {
    const identifier = 'example-iosUITests/CardAccountUpdateReturnProfileUITests';
    assert.equal(accountUpdateShardSelection('affected', [identifier], 'evidence-account-update'), undefined);
    assert.equal(accountUpdateShardSelection('affected', [identifier], 'evidence-account-update-2')?.expectedTestCount, 2);
  });
});

describe('nativeTestProductEnvironment', () => {
  const exported = nativeTestProductEnvironment({ runDir: '/run', stage: '/stage' });

  it('roots every result path in the lane run directory', () => {
    for (const [name, value] of exported) {
      if (name === 'IOS_TEST_PLAN') continue;
      const expectedRoot = name.endsWith('_TEST_PRODUCTS') || name === 'IOS_TEST_PRODUCTS'
        ? '/stage/'
        : '/run';
      assert.ok(value.startsWith(expectedRoot), `${name}=${value}`);
    }
    assert.equal(exported.get('IOS_TEST_RUN_DIR'), '/run');
    assert.equal(exported.get('IOS_TEST_PLAN'), 'CI');
  });

  it('exports one distinct path per name', () => {
    const paths = [...exported.entries()].filter(([name]) => name !== 'IOS_TEST_PLAN');
    assert.equal(new Set(paths.map(([, value]) => value)).size, paths.length);
  });

  it('carries every bundle the failure summary and diagnostics read back', () => {
    for (const name of [
      'IOS_TEST_RESULT_BUNDLE', 'IOS_STOREKIT_RESULT_BUNDLE',
      'IOS_ACCOUNT_UPDATE_RESULT_BUNDLE', 'IOS_ACCESSIBILITY_TEST_RESULT_BUNDLE',
      'IOS_NARROW_PAYWALL_RESULT_BUNDLE',
    ]) {
      assert.ok(exported.has(name), name);
    }
  });
});

describe('toolchainVerdict', () => {
  it('reads exit 3 as the consumer-Xcode rebuild and nothing else', () => {
    assert.deepEqual(toolchainVerdict(3), { kind: 'rebuild' });
    assert.deepEqual(toolchainVerdict(0), { kind: 'ready' });
    for (const status of [1, 2, 4, 127]) {
      assert.deepEqual(toolchainVerdict(status), { kind: 'failed', status });
    }
  });
});

describe('checkedOutRevisionRejection', () => {
  it('accepts only the exact head the run was planned for', () => {
    assert.equal(checkedOutRevisionRejection('abc', 'abc'), undefined);
    assert.match(checkedOutRevisionRejection('abc', 'def') ?? '', /Checked out abc, expected exact head def/);
    // An unreadable revision is not the expected one either.
    assert.match(checkedOutRevisionRejection('', 'def') ?? '', /::error::/);
  });
});

describe('failureSummaryTargets', () => {
  const paths = {
    runnerTemp: '/temp',
    resultBundle: '/run/tests.xcresult',
    xcodebuildLog: '/run/xcodebuild.log',
    accountUpdateResultBundle: '/run/account.xcresult',
    accountUpdateXcodebuildLog: '/run/account.log',
    accessibilityResultBundle: '/run/accessibility.xcresult',
    accessibilityXcodebuildLog: '/run/accessibility.log',
    narrowPaywallResultBundle: '/run/paywall.xcresult',
    narrowPaywallXcodebuildLog: '/run/paywall.log',
  };

  it('summarizes the main lane unconditionally and every group only when present', () => {
    const targets = failureSummaryTargets(paths);
    assert.equal(targets[0]?.whenPresent, false);
    assert.deepEqual(targets.slice(1).map((target) => target.whenPresent), [true, true, true]);
    assert.equal(targets.length, 4);
  });

  it('falls back to the runner-temp defaults when the lane never exported its paths', () => {
    const targets = failureSummaryTargets({ ...paths, resultBundle: '', xcodebuildLog: '' });
    assert.equal(targets[0]?.resultBundle, '/temp/example-ios-tests.xcresult');
    assert.equal(targets[0]?.xcodebuildLog, '/temp/example-ios-xcodebuild.log');
  });

  it('pairs every bundle with its own build log', () => {
    for (const target of failureSummaryTargets(paths)) {
      assert.notEqual(target.resultBundle, target.xcodebuildLog);
    }
  });
});

describe('evidenceValidationPlan', () => {
  const inputs = {
    resultBundle: '/run/tests.xcresult',
    xcodebuildLog: '/run/xcodebuild.log',
    exactHeadSha: 'HEADSHA',
  };

  it('derives every screenshot directory from the lane bundle, not the runner temp', () => {
    for (const kind of ['financial-independence', 'onboarding-copy'] as const) {
      const decision = evidenceValidationPlan(kind, inputs);
      assert.equal(decision.ok, true);
      const directories = decision.ok
        ? decision.plan.arguments.filter((argument) => argument.startsWith('/run/screenshots'))
        : [];
      assert.ok(directories.length > 0, kind);
    }
  });

  it('binds every validator to the exact head as its last argument', () => {
    for (const kind of ['financial-independence', 'onboarding-copy'] as const) {
      const decision = evidenceValidationPlan(kind, inputs);
      assert.equal(decision.ok ? decision.plan.arguments.at(-1) : '', 'HEADSHA');
    }
  });

  it('writes the financial independence provenance into the log the validator reads', () => {
    const decision = evidenceValidationPlan('financial-independence', inputs);
    assert.deepEqual(decision.ok ? decision.plan.provenance : undefined, {
      path: '/run/xcodebuild.log',
      line: 'FINANCIAL_INDEPENDENCE_EXACT_HEAD_SHA=HEADSHA',
    });
    assert.ok(decision.ok && decision.plan.arguments.includes('/run/xcodebuild.log'));
  });

  it('names the missing evidence when the lane never reached test products', () => {
    for (const [kind, label] of [
      ['financial-independence', 'financial independence'],
      ['onboarding-copy', 'onboarding-copy'],
    ] as const) {
      const decision = evidenceValidationPlan(kind, { ...inputs, resultBundle: '' });
      assert.equal(decision.ok, false);
      assert.ok(decision.ok || decision.message.includes(`Required ${label} evidence`), kind);
    }
  });

  it('handles a bundle at the filesystem root without producing a doubled slash', () => {
    const decision = evidenceValidationPlan('onboarding-copy', {
      ...inputs, resultBundle: '/tests.xcresult',
    });
    assert.deepEqual(decision.ok ? decision.plan.arguments[0] : '', '/screenshots/accessibility');
  });
});

describe('retained evidence', () => {
  it('labels each retention with the lane whose evidence it is', () => {
    assert.equal(retainedEvidence('screenshots', 'native1').label, 'iOS Test native1 screenshots');
    assert.equal(
      retainedEvidence('diagnostics', 'evidence-visual').label,
      'iOS Test evidence-visual diagnostics',
    );
  });

  it('fails closed with a message that names what the upload lost', () => {
    assert.match(retainedEvidence('screenshots', 'native1').emptyMessage, /screenshot artifact failed/);
    assert.match(retainedEvidence('diagnostics', 'native1').emptyMessage, /diagnostic upload failed/);
  });

  it('retains every bundle, log and recording the lane can produce', () => {
    for (const pattern of [
      'example-ios-tests.xcresult', 'narrow-paywall-lane.xcresult',
      'accessibility-xcodebuild.log', '**/*.first-launch-busy.log',
    ]) {
      assert.ok(diagnosticEvidencePatterns.includes(pattern), pattern);
    }
    assert.equal(new Set(diagnosticEvidencePatterns).size, diagnosticEvidencePatterns.length);
  });

  it('names the lane run directories by run and attempt so a rerun keeps its own', () => {
    assert.equal(laneRunDirectoryPrefix('42', '2'), 'example-ios-tests.42.2.');
    assert.notEqual(laneRunDirectoryPrefix('42', '1'), laneRunDirectoryPrefix('42', '2'));
  });
});

describe('simulatorCleanupPlan', () => {
  const all = { primaryUdid: 'PRIMARY', narrowUdid: 'NARROW' };
  const cleanupsFor = (
    lane: string,
    groups: readonly string[],
    simulators: { primaryUdid: string; narrowUdid: string },
  ): readonly { purpose: string; udid: string }[] => {
    const outcome = simulatorCleanupPlan(lane, groups, simulators);
    assert.ok(outcome.ok, `${lane} must resolve a cleanup plan`);
    return outcome.cleanups;
  };

  it('releases a main lane under the main purposes', () => {
    for (const lane of ['main', 'native1', 'native2', 'native3', 'native4']) {
      assert.deepEqual(simulatorCleanupPlan(lane, [], all), {
        ok: true,
        cleanups: [
          { purpose: 'Main', udid: 'PRIMARY' },
          { purpose: 'Main Narrow', udid: 'NARROW' },
        ],
      });
    }
  });

  it('releases the borrowed evidence device only on the shard that borrowed it', () => {
    const borrowed = simulatorCleanupPlan('native1', ['account-update'], all);
    assert.equal(borrowed.ok && borrowed.cleanups[1]?.purpose, 'Evidence Narrow');
    const other = simulatorCleanupPlan('native2', ['account-update'], all);
    assert.equal(other.ok && other.cleanups[1]?.purpose, 'Main Narrow');
    // Group membership is exact: a group whose name merely contains the label
    // must not hand a main device back as evidence.
    const similar = simulatorCleanupPlan('native1', ['account-update-extra'], all);
    assert.equal(similar.ok && similar.cleanups[1]?.purpose, 'Main Narrow');
  });

  it('releases an evidence lane under the evidence purposes', () => {
    assert.deepEqual(cleanupsFor('evidence', [], all), [
      { purpose: 'Evidence', udid: 'PRIMARY' },
      { purpose: 'Evidence Narrow', udid: 'NARROW' },
    ]);
  });

  it('skips a device the lane never provisioned', () => {
    assert.deepEqual(
      cleanupsFor('native2', [], { primaryUdid: 'PRIMARY', narrowUdid: '' }),
      [{ purpose: 'Main', udid: 'PRIMARY' }],
    );
    assert.deepEqual(
      cleanupsFor('evidence', [], { primaryUdid: '', narrowUdid: '' }),
      [],
    );
  });

  it('refuses a lane it cannot name a purpose for', () => {
    for (const lane of ['', 'evidence-visual', 'native5']) {
      const outcome = simulatorCleanupPlan(lane, [], all);
      assert.equal(outcome.ok, false);
      assert.match(outcome.ok ? '' : outcome.message, /Unknown iOS CI lane during simulator cleanup/);
    }
  });
});

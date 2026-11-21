import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { deriveMeasuredNativeShardPlan, deriveNativeExecutionPlan } from '../src/nativeExecutionPlan.ts';
import { affectedUiOwners } from '../src/ios/affectedUiOwners.ts';
import { buildIosNativeTestProducts } from '../workflows/ios-tests/build-ios-native-test-products.ts';

const baseInput = {
  selectionMode: 'affected' as const,
  selectionRequired: true,
  releaseArchiveRequired: false,
  onlyTestingIdentifiers: [] as string[],
  evidenceGroups: [] as string[],
  narrowPaywallRequired: false,
  uiMethodOwners: {} as Record<string, 'native2' | 'native3' | 'native4'>,
  forcedLanes: [] as Array<
    | 'native1'
    | 'native2'
    | 'native3'
    | 'native4'
    | 'evidence-account-update'
    | 'evidence-visual'
  >,
};

describe('deriveNativeExecutionPlan', () => {
  it('balances bare affected classes across native1 and native2 without account overlap', () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-affected-class-owners-'));
    try {
      const selection = join(root, 'selected.txt');
      const classes = [
        'example-iosUITests/MixedAssignmentReceiptUITests',
        'example-iosUITests/LevelCardsClarityUITests',
        'example-iosUITests/TourCopyReviewEvidenceUITests',
        'example-iosUITests/CardAccountUpdateReturnProfileUITests',
      ];
      writeFileSync(selection, `${classes.join('\n')}\n`);
      const owners = affectedUiOwners(selection, ['account-update']);
      assert.deepEqual(new Set(Object.keys(owners)), new Set(classes.slice(0, 3)));
      const plan = deriveNativeExecutionPlan({
        ...baseInput,
        onlyTestingIdentifiers: classes,
        evidenceGroups: ['account-update'],
        uiMethodOwners: owners,
      });
      assert.deepEqual(plan.executionLanes, [
        'native1', 'native2', 'evidence-account-update-2',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves owners from the candidate data root, not the checkout the programs run from', () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-candidate-owner-data-'));
    try {
      const testPlan = 'ios/example-ios.xcodeproj/xcshareddata/TestPlans/CI.xctestplan';
      for (const path of ['ios/example-iosUITests', 'ios/ci', testPlan]) {
        cpSync(path, join(root, path), { recursive: true });
      }
      writeFileSync(
        join(root, 'ios/example-iosUITests/QueueCandidateOnlyUITests.swift'),
        'import XCTest\n\nfinal class QueueCandidateOnlyUITests: XCTestCase {\n'
          + '    func testCandidateOnlyMethod() {}\n}\n',
      );
      const plan = z.object({
        testTargets: z.array(z.looseObject({
          target: z.looseObject({ name: z.string() }),
          selectedTests: z.array(z.string()).optional(),
        })),
      }).loose().parse(JSON.parse(readFileSync(join(root, testPlan), 'utf8')));
      const uiTarget = plan.testTargets.find((target) => target.target.name === 'example-iosUITests');
      assert.ok(uiTarget?.selectedTests);
      uiTarget.selectedTests.push('QueueCandidateOnlyUITests');
      writeFileSync(join(root, testPlan), JSON.stringify(plan));
      const selection = join(root, 'selected.txt');
      const method = 'example-iosUITests/QueueCandidateOnlyUITests/testCandidateOnlyMethod';
      writeFileSync(selection, `${method}\n`);

      assert.match(affectedUiOwners(selection, [], root)[method] ?? '', /^native[234]$/);
      assert.equal(affectedUiOwners(selection, [])[method], undefined);

      // Execution jobs run from `ios/`; the default still reads the workspace.
      const workspace = process.env['GITHUB_WORKSPACE'];
      const directory = process.cwd();
      process.env['GITHUB_WORKSPACE'] = root;
      process.chdir(join(directory, 'ios'));
      try {
        assert.match(affectedUiOwners(selection, [])[method] ?? '', /^native[234]$/);
      } finally {
        process.chdir(directory);
        if (workspace === undefined) delete process.env['GITHUB_WORKSPACE'];
        else process.env['GITHUB_WORKSPACE'] = workspace;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a bare TourCopy class on native1 so its fixture-owned FI method runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'ios-tour-class-owner-'));
    try {
      const selection = join(root, 'selected.txt');
      const classes = [
        'example-iosUITests/MixedAssignmentReceiptUITests',
        'example-iosUITests/TourCopyReviewEvidenceUITests',
      ];
      writeFileSync(selection, `${classes.join('\n')}\n`);
      const owners = affectedUiOwners(selection, []);
      assert.equal(owners[classes[1]!], 'native1');
      assert.equal(owners[classes[0]!], 'native1');
      const plan = deriveNativeExecutionPlan({
        ...baseInput,
        onlyTestingIdentifiers: classes,
        uiMethodOwners: owners,
      });
      assert.deepEqual(plan.executionLanes, ['native1']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('executes mixed unit and account-update evidence without a redundant native1 consumer', () => {
    const unit = 'example-iosTests/FormattingTests/testFormatting';
    const account = 'example-iosUITests/CardAccountUpdateReturnProfileUITests/testProfileUpdate';
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: [unit, account],
      evidenceGroups: ['account-update'],
    });
    assert.deepEqual(plan.executionLanes, ['evidence-account-update-2']);
    const preflight = buildIosNativeTestProducts.config.steps.find(
      (step) => step.config.name === 'Run native unit preflight',
    );
    const selection = buildIosNativeTestProducts.config.steps.find(
      (step) => step.config.name === 'Determine native build selection',
    );
    assert.equal(preflight?.config.env?.IOS_MAIN_TEST_PARTITION, 'unit');
    assert.equal(preflight?.config.env?.IOS_ONLY_TESTING_FILE,
      selection?.outputs.only_testing_file);
    assert.equal(preflight?.config.command,
      'node ../ci/src/actions/ios/runNativeUnitPreflight.ts');
    assert.equal(preflight?.config.if, undefined);
  });

  it('refuses account-update evidence with no owned selector', () => {
    assert.throws(() => deriveNativeExecutionPlan({
      ...baseInput,
      evidenceGroups: ['account-update'],
    }), /without owned tests/);
  });
  it('keeps skip narrow while rerunning only a failed lane', () => {
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      selectionMode: 'skip',
      selectionRequired: false,
      forcedLanes: ['native4'],
    });

    assert.equal(plan.uiRequired, false);
    assert.deepEqual(plan.executionLanes, ['native4']);
    assert.equal(plan.producerMode, 'shared-products');
    assert.equal(plan.handoffRequired, true);
  });

  it('skips the producer when neither local nor downstream execution is required', () => {
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      selectionMode: 'skip',
      selectionRequired: false,
    });

    assert.equal(plan.producerMode, 'skip');
    assert.equal(plan.releaseArchiveRequired, false);
    assert.equal(plan.handoffRequired, false);
  });

  it('selects no native lane for affected unit tests', () => {
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: ['example-iosTests/FormattingTests'],
    });

    assert.equal(plan.executionRequired, false);
    assert.deepEqual(plan.executionLanes, []);
    assert.equal(plan.producerMode, 'unit-preflight');
    assert.equal(plan.releaseArchiveRequired, false);
    assert.equal(plan.handoffRequired, false);
  });

  it('keeps the Release archive gate independent from unit-product handoff', () => {
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      releaseArchiveRequired: true,
      onlyTestingIdentifiers: ['example-iosTests/HomeOwnershipTests'],
    });

    assert.equal(plan.producerMode, 'unit-preflight');
    assert.equal(plan.releaseArchiveRequired, true);
    assert.equal(plan.handoffRequired, false);
  });

  it('retains a forced native lane for affected unit tests', () => {
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: ['example-iosTests/FormattingTests'],
      forcedLanes: ['native4'],
    });

    assert.equal(plan.executionRequired, true);
    assert.deepEqual(plan.executionLanes, ['native4']);
    assert.equal(plan.producerMode, 'shared-products');
    assert.equal(plan.handoffRequired, true);
  });

  it('selects native1 for affected UI tests', () => {
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: ['example-iosUITests/BudgetFlowUITests/testEditing'],
    });

    assert.equal(plan.uiRequired, true);
    assert.deepEqual(plan.executionLanes, ['native1']);
  });

  it('keeps an affected UI repair in its one retained failed native lane', () => {
    const identifier = 'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureNotReadySuppression';
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: [identifier],
      forcedLanes: ['native4'],
      uiMethodOwners: { [identifier]: 'native4' },
    });

    assert.equal(plan.uiRequired, true);
    assert.deepEqual(plan.executionLanes, ['native4']);
    assert.deepEqual(plan.fullExecutionLanes, ['native4']);
  });

  it('runs every owning duration shard once for a cross-shard exact repair', () => {
    const native2 = 'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureReadySpendingAnswer';
    const native4 = 'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureNotReadySuppression';
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: [native2, native4],
      forcedLanes: ['native4'],
      uiMethodOwners: { [native2]: 'native2', [native4]: 'native4' },
    });

    assert.deepEqual(plan.executionLanes, ['native2', 'native4']);
    assert.deepEqual(plan.fullExecutionLanes, ['native4']);
    assert.equal(new Set(plan.executionLanes).size, plan.executionLanes.length);
  });

  it('reruns a failed non-owning native lane at full scope', () => {
    const native2 = 'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureReadySpendingAnswer';
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: [native2],
      forcedLanes: ['native4'],
      uiMethodOwners: { [native2]: 'native2' },
    });

    assert.deepEqual(plan.executionLanes, ['native2', 'native4']);
    assert.deepEqual(plan.fullExecutionLanes, ['native4']);
  });

  it('retains native1 when a forced shard accompanies mixed or broad affected work', () => {
    for (const onlyTestingIdentifiers of [
      [
        'example-iosTests/FormattingTests/testFormatting',
        'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureReadySpendingAnswer',
      ],
      ['example-iosUITests/TourCopyReviewEvidenceUITests'],
    ]) {
      const plan = deriveNativeExecutionPlan({
        ...baseInput,
        onlyTestingIdentifiers,
        forcedLanes: ['native4'],
      });
      assert.deepEqual(plan.executionLanes, ['native1', 'native4']);
      assert.deepEqual(plan.fullExecutionLanes, ['native4']);
    }
  });

  it('selects every native lane for a full run', () => {
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      selectionMode: 'full',
    });

    assert.deepEqual(plan.executionLanes, [
      'native1',
      'native2',
      'native3',
      'native4',
    ]);
  });

  it('maps evidence groups to their dedicated lanes', () => {
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      selectionMode: 'full',
      evidenceGroups: ['account-update', 'accessibility'],
    });

    assert.deepEqual(plan.executionLanes, [
      'native1',
      'native2',
      'native3',
      'native4',
      'evidence-account-update',
      'evidence-account-update-2',
      'evidence-visual',
    ]);
  });

  it('routes pure account-update evidence only through its class owner', () => {
    const identifier =
      'example-iosUITests/CardAccountUpdateReturnProfileUITests/testProfileUpdate';
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: [identifier],
      evidenceGroups: ['account-update'],
      uiMethodOwners: { [identifier]: 'native2' },
    });

    assert.equal(plan.uiRequired, true);
    assert.deepEqual(plan.executionLanes, ['evidence-account-update-2']);
  });

  it('keeps a main-owned account-update method on its duration shard without the supplemental group', () => {
    const identifier =
      'example-iosUITests/CardAccountUpdateReturnOfflineFailureUITests/testHomeOriginOfflineFailurePreservesStagedAccountAndHiddenTabBar';
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: [identifier],
      uiMethodOwners: { [identifier]: 'native4' },
    });

    assert.equal(plan.uiRequired, true);
    assert.deepEqual(plan.executionLanes, ['native4']);
  });

  it('routes mixed account-update evidence and ordinary UI work once each', () => {
    const accountUpdate =
      'example-iosUITests/CardAccountUpdateReturnProfileUITests/testProfileUpdate';
    const ordinary =
      'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureNotReadySuppression';
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      onlyTestingIdentifiers: [accountUpdate, ordinary],
      evidenceGroups: ['account-update'],
      uiMethodOwners: {
        [accountUpdate]: 'native2',
        [ordinary]: 'native4',
      },
    });

    assert.equal(plan.uiRequired, true);
    assert.deepEqual(plan.executionLanes, ['native4', 'evidence-account-update-2']);
  });

  it('deduplicates forced lanes already selected by the change', () => {
    const plan = deriveNativeExecutionPlan({
      ...baseInput,
      selectionMode: 'full',
      forcedLanes: ['native2', 'evidence-visual'],
    });

    assert.deepEqual(plan.executionLanes, [
      'native1',
      'native2',
      'native3',
      'native4',
      'evidence-visual',
    ]);
  });

  it('rejects an unknown forced lane at the untyped boundary', () => {
    assert.throws(() =>
      deriveNativeExecutionPlan({
        ...baseInput,
        forcedLanes: ['native5' as 'native1'],
      })
    );
  });
});

describe('measured native shard planning', () => {
  const measuredInput = {
    schema: 'example.ios-native-shard-input.v1' as const,
    asOf: '2026-09-14T18:00:00-04:00',
    maximumEvidenceAgeHours: 24,
    imbalanceToleranceRatio: 0.1,
    evidence: {
      sourceRunId: '34450000000',
      recordedAt: '2026-09-14T12:00:00-04:00',
      tests: [
        { identifier: 'suite/test1', durationSeconds: 100 },
        { identifier: 'suite/test2', durationSeconds: 100 },
        { identifier: 'suite/test3a', durationSeconds: 100 },
        { identifier: 'suite/test3b', durationSeconds: 100 },
        { identifier: 'suite/test4', durationSeconds: 100 },
      ],
    },
    assignments: [
      { lane: 'native1' as const, testIdentifiers: ['suite/test1'], runner: { runnerId: 'mac-1', parallelWorkers: 1, workersUsed: 1 } },
      { lane: 'native2' as const, testIdentifiers: ['suite/test2'], runner: { runnerId: 'mac-2', parallelWorkers: 1, workersUsed: 1 } },
      { lane: 'native3' as const, testIdentifiers: ['suite/test3a', 'suite/test3b'], runner: { runnerId: 'mac-3', parallelWorkers: 2, workersUsed: 2 } },
      { lane: 'native4' as const, testIdentifiers: ['suite/test4'], runner: { runnerId: 'mac-4', parallelWorkers: 1, workersUsed: 1 } },
    ],
  };

  it('exposes measured estimates and explicit per-runner worker capacity', () => {
    const plan = deriveMeasuredNativeShardPlan(measuredInput);
    assert.equal(plan.sourceRunId, measuredInput.evidence.sourceRunId);
    assert.deepEqual(plan.laneEstimates.map((lane) => lane.estimatedDurationSeconds), [100, 100, 100, 100]);
    assert.equal(plan.laneEstimates.find((lane) => lane.lane === 'native3')?.parallelWorkers, 2);
  });

  it('clamps a lane estimate to its longest assigned test instead of averaging below it', () => {
    const uneven = {
      ...measuredInput,
      evidence: {
        ...measuredInput.evidence,
        tests: measuredInput.evidence.tests.map((test) => (
          test.identifier === 'suite/test3a' ? { ...test, durationSeconds: 180 }
            : test.identifier === 'suite/test3b' ? { ...test, durationSeconds: 20 }
              : test
        )),
      },
    };
    // Naively averaging (180 + 20) / 2 workers = 100s would hide a lane whose
    // real wall time is bounded below by its longest single test (180s).
    assert.throws(() => deriveMeasuredNativeShardPlan(uneven), /imbalance/);
    const plan = deriveMeasuredNativeShardPlan({ ...uneven, imbalanceToleranceRatio: 0.5 });
    assert.equal(plan.laneEstimates.find((lane) => lane.lane === 'native3')?.estimatedDurationSeconds, 180);
  });

  it('estimates a lane by a schedulable makespan instead of an ideal split', () => {
    const unsplittable = {
      ...measuredInput,
      evidence: {
        ...measuredInput.evidence,
        tests: [
          { identifier: 'suite/test1', durationSeconds: 200 },
          { identifier: 'suite/test2', durationSeconds: 200 },
          { identifier: 'suite/test3a', durationSeconds: 100 },
          { identifier: 'suite/test3b', durationSeconds: 100 },
          { identifier: 'suite/test3c', durationSeconds: 100 },
          { identifier: 'suite/test4', durationSeconds: 200 },
        ],
      },
      assignments: measuredInput.assignments.map((assignment) => (
        assignment.lane === 'native3'
          ? { ...assignment, testIdentifiers: ['suite/test3a', 'suite/test3b', 'suite/test3c'] }
          : assignment
      )),
    };
    // Three atomic 100s tests on two workers cannot finish in 300 / 2 = 150s.
    // One worker has to run two of them, so the lane really takes 200s, and
    // the lower bound would have hidden a 50s underestimate per rerun.
    const plan = deriveMeasuredNativeShardPlan(unsplittable);
    assert.equal(
      plan.laneEstimates.find((lane) => lane.lane === 'native3')?.estimatedDurationSeconds,
      200,
    );
    assert.deepEqual(
      plan.laneEstimates.map((lane) => lane.estimatedDurationSeconds),
      [200, 200, 200, 200],
    );
  });

  it('schedules longest tests first and resolves ties independently of input order', () => {
    const mixed = {
      ...measuredInput,
      evidence: {
        ...measuredInput.evidence,
        tests: [
          { identifier: 'suite/test1', durationSeconds: 200 },
          { identifier: 'suite/test2', durationSeconds: 200 },
          { identifier: 'suite/test3a', durationSeconds: 50 },
          { identifier: 'suite/test3b', durationSeconds: 100 },
          { identifier: 'suite/test3c', durationSeconds: 100 },
          { identifier: 'suite/test3d', durationSeconds: 150 },
          { identifier: 'suite/test4', durationSeconds: 200 },
        ],
      },
    };
    const native3Tests = ['suite/test3a', 'suite/test3b', 'suite/test3c', 'suite/test3d'];
    // Scheduling in assignment order packs 150s onto a worker already holding
    // 100s and reports 250s. Sorting by descending duration pairs 150 + 50 and
    // 100 + 100, which any runner can actually achieve, so the estimate is 200s
    // for every permutation of the same assignment.
    for (const testIdentifiers of [native3Tests, [...native3Tests].reverse()]) {
      const plan = deriveMeasuredNativeShardPlan({
        ...mixed,
        assignments: mixed.assignments.map((assignment) => (
          assignment.lane === 'native3' ? { ...assignment, testIdentifiers } : assignment
        )),
      });
      assert.equal(
        plan.laneEstimates.find((lane) => lane.lane === 'native3')?.estimatedDurationSeconds,
        200,
      );
    }
  });

  it('rejects stale historical weights such as run 34436953295', () => {
    assert.throws(() => deriveMeasuredNativeShardPlan({
      ...measuredInput,
      evidence: { ...measuredInput.evidence, sourceRunId: '34436953295', recordedAt: '2026-09-10T12:00:00-04:00' },
    }), /stale/);
  });

  it('rejects missing, unassigned, duplicate, or multiply-assigned test weights', () => {
    assert.throws(() => deriveMeasuredNativeShardPlan({
      ...measuredInput,
      evidence: { ...measuredInput.evidence, tests: measuredInput.evidence.tests.slice(1) },
    }), /Missing measured/);
    assert.throws(() => deriveMeasuredNativeShardPlan({
      ...measuredInput,
      evidence: {
        ...measuredInput.evidence,
        tests: [...measuredInput.evidence.tests, { identifier: 'suite/unassigned', durationSeconds: 100 }],
      },
    }), /unassigned/);
    assert.throws(() => deriveMeasuredNativeShardPlan({
      ...measuredInput,
      evidence: {
        ...measuredInput.evidence,
        tests: [...measuredInput.evidence.tests, measuredInput.evidence.tests[0]!],
      },
    }), /duplicate tests/);
    assert.throws(() => deriveMeasuredNativeShardPlan({
      ...measuredInput,
      assignments: measuredInput.assignments.map((assignment) => assignment.lane === 'native2'
        ? { ...assignment, testIdentifiers: ['suite/test1'] } : assignment),
    }), /multiple lanes/);
    // Assigning idle extra workers to a lane with only one 100s test does not
    // change its real wall time (a single test cannot be split further), so
    // this must not be reported as a false imbalance.
    assert.doesNotThrow(() => deriveMeasuredNativeShardPlan({
      ...measuredInput,
      assignments: measuredInput.assignments.map((assignment) => assignment.lane === 'native4'
        ? { ...assignment, runner: { ...assignment.runner, parallelWorkers: 2, workersUsed: 2 } } : assignment),
    }));
  });

  it('shares runner capacity only with consistent, non-oversubscribed declarations', () => {
    const sharedAssignments = measuredInput.assignments.map((assignment) => (
      assignment.lane === 'native1' || assignment.lane === 'native2'
        ? { ...assignment, runner: { runnerId: 'mac-shared', parallelWorkers: 2, workersUsed: 1 } }
        : assignment
    ));
    assert.doesNotThrow(() => deriveMeasuredNativeShardPlan({ ...measuredInput, assignments: sharedAssignments }));
    assert.throws(() => deriveMeasuredNativeShardPlan({
      ...measuredInput,
      assignments: sharedAssignments.map((assignment) => assignment.lane === 'native2'
        ? { ...assignment, runner: { ...assignment.runner, parallelWorkers: 3 } } : assignment),
    }), /inconsistent worker capacity/);
    assert.throws(() => deriveMeasuredNativeShardPlan({
      ...measuredInput,
      assignments: sharedAssignments.map((assignment) => (
        assignment.lane === 'native1' || assignment.lane === 'native2'
          ? { ...assignment, runner: { ...assignment.runner, workersUsed: 2 } } : assignment
      )),
    }), /oversubscribed/);
  });
});

describe('planner entry point parity', () => {
  const fixtures = [
    baseInput,
    {
      ...baseInput,
      selectionMode: 'skip' as const,
      selectionRequired: false,
      forcedLanes: ['native4' as const],
    },
    {
      ...baseInput,
      onlyTestingIdentifiers: ['example-iosTests/FormattingTests'],
    },
    {
      ...baseInput,
      onlyTestingIdentifiers: ['example-iosTests/FormattingTests'],
      forcedLanes: ['native4' as const],
    },
    {
      ...baseInput,
      onlyTestingIdentifiers: ['example-iosUITests/BudgetFlowUITests/testEditing'],
    },
    {
      ...baseInput,
      onlyTestingIdentifiers: ['example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureNotReadySuppression'],
      forcedLanes: ['native4' as const],
      uiMethodOwners: {
        'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureNotReadySuppression': 'native4' as const,
      },
    },
    {
      ...baseInput,
      onlyTestingIdentifiers: [
        'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureReadySpendingAnswer',
        'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureNotReadySuppression',
      ],
      forcedLanes: ['native4' as const],
      uiMethodOwners: {
        'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureReadySpendingAnswer': 'native2' as const,
        'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureNotReadySuppression': 'native4' as const,
      },
    },
    { ...baseInput, selectionMode: 'full' as const },
    {
      ...baseInput,
      selectionMode: 'full' as const,
      evidenceGroups: ['account-update', 'accessibility'],
    },
    {
      ...baseInput,
      narrowPaywallRequired: true,
      forcedLanes: ['native2' as const],
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    it(`matches fixture ${index + 1}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'example-typed-ci-'));
      try {
        const onlyTestingFile = join(directory, 'only-testing.txt');
        const outputFile = join(directory, 'output.txt');
        writeFileSync(
          onlyTestingFile,
          `${fixture.onlyTestingIdentifiers.join('\n')}\n`,
          'utf8',
        );
        writeFileSync(outputFile, '', 'utf8');

        const result = spawnSync(
          process.execPath,
          ['ci/src/actions/planIosNative.ts'],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              GITHUB_OUTPUT: outputFile,
              'INPUT_EVIDENCE-GROUPS': fixture.evidenceGroups.join(','),
              'INPUT_FORCED-LANES': JSON.stringify(fixture.forcedLanes),
              'INPUT_NARROW-PAYWALL-REQUIRED': String(fixture.narrowPaywallRequired),
              'INPUT_ONLY-TESTING-FILE': onlyTestingFile,
              'INPUT_SELECTION-MODE': fixture.selectionMode,
              'INPUT_SELECTION-REQUIRED': String(fixture.selectionMode !== 'skip'),
            },
          },
        );
        assert.equal(result.status, 0, result.stderr);

        const entryPoint = Object.fromEntries(
          readFileSync(outputFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
              const separator = line.indexOf('=');
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        );
        const typed = deriveNativeExecutionPlan(fixture);
        const entryPointExecutionLanes = entryPoint.execution_lanes;
        assert.ok(entryPointExecutionLanes);

        assert.equal(String(typed.uiRequired), entryPoint.ui_required);
        assert.equal(String(typed.executionRequired), entryPoint.execution_required);
        assert.deepEqual(typed.executionLanes, JSON.parse(entryPointExecutionLanes));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

describe('GitHub action adapter', () => {
  it('reads GitHub hyphenated INPUT_* environment names', () => {
    const directory = mkdtempSync(join(tmpdir(), 'example-typed-action-'));
    try {
      const onlyTestingFile = join(directory, 'only-testing.txt');
      const outputFile = join(directory, 'output.txt');
      writeFileSync(
        onlyTestingFile,
        'example-iosUITests/BudgetFlowUITests/testEditing\n',
        'utf8',
      );
      writeFileSync(outputFile, '', 'utf8');

      const result = spawnSync(
        process.execPath,
        ['ci/src/actions/planIosNative.ts'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputFile,
            'INPUT_SELECTION-MODE': 'affected',
            'INPUT_SELECTION-REQUIRED': 'true',
            'INPUT_RELEASE-ARCHIVE-REQUIRED': 'false',
            'INPUT_ONLY-TESTING-FILE': onlyTestingFile,
            'INPUT_EVIDENCE-GROUPS': '',
            'INPUT_NARROW-PAYWALL-REQUIRED': 'false',
            'INPUT_FORCED-LANES': '[]',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);

      const output = readFileSync(outputFile, 'utf8');
      assert.match(output, /^ui_required=true$/m);
      assert.match(output, /^execution_required=true$/m);
      assert.match(output, /^execution_lanes=\["native1"\]$/m);
      assert.match(output, /^producer_mode=shared-products$/m);
      assert.match(output, /^handoff_required=true$/m);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs a retained failed same-owner lane at full scope', () => {
    const directory = mkdtempSync(join(tmpdir(), 'example-typed-action-'));
    try {
      const onlyTestingFile = join(directory, 'only-testing.txt');
      const outputFile = join(directory, 'output.txt');
      writeFileSync(
        onlyTestingFile,
        'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureNotReadySuppression\n',
        'utf8',
      );
      writeFileSync(outputFile, '', 'utf8');

      const result = spawnSync(
        process.execPath,
        ['ci/src/actions/planIosNative.ts'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputFile,
            'INPUT_SELECTION-MODE': 'affected',
            'INPUT_SELECTION-REQUIRED': 'true',
            'INPUT_RELEASE-ARCHIVE-REQUIRED': 'false',
            'INPUT_ONLY-TESTING-FILE': onlyTestingFile,
            'INPUT_EVIDENCE-GROUPS': '',
            'INPUT_NARROW-PAYWALL-REQUIRED': 'false',
            'INPUT_FORCED-LANES': '["native4"]',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);

      const output = readFileSync(outputFile, 'utf8');
      assert.match(output, /^execution_required=true$/m);
      assert.match(output, /^execution_lanes=\["native4"\]$/m);
      assert.match(output, /^full_execution_lanes=\["native4"\]$/m);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

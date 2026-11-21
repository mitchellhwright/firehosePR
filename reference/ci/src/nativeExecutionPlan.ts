import { z } from 'zod';
import { validationDepthSchema } from './ciEvent.ts';
import { accountUpdateShardSelection } from './ios/executionPlan.ts';

export const selectionModeSchema = z.enum(['skip', 'affected', 'full']);
export type SelectionMode = z.infer<typeof selectionModeSchema>;

export const iosLaneSchema = z.enum([
  'native1',
  'native2',
  'native3',
  'native4',
  'evidence-account-update',
  'evidence-account-update-2',
  'evidence-visual',
]);
export type IosLane = z.infer<typeof iosLaneSchema>;

const physicalUiLaneSchema = z.enum(['native1', 'native2', 'native3', 'native4']);

const booleanInputSchema = z.union([z.boolean(), z.enum(['true', 'false'])])
  .transform((value) => value === true || value === 'true');

export const nativeExecutionInputSchema = z.object({
  selectionMode: selectionModeSchema,
  selectionRequired: booleanInputSchema.optional(),
  releaseArchiveRequired: booleanInputSchema.default(false),
  onlyTestingIdentifiers: z.array(z.string()),
  evidenceGroups: z.array(z.string()),
  narrowPaywallRequired: booleanInputSchema,
  forcedLanes: z.array(iosLaneSchema),
  uiMethodOwners: z.record(z.string(), physicalUiLaneSchema).default({}),
  // A pull request into develop leaves the full UI suite and the Release
  // archive to its merge queue candidate, which plans at complete depth.
  validationDepth: validationDepthSchema.default('complete'),
});
export type NativeExecutionInput = z.input<typeof nativeExecutionInputSchema>;

const nativeExecutionPlanBaseSchema = z.object({
  schema: z.literal('example.ios-native-plan.v2'),
  selectionMode: selectionModeSchema,
  uiRequired: z.boolean(),
  executionRequired: z.boolean(),
  executionLanes: z.array(iosLaneSchema),
  fullExecutionLanes: z.array(iosLaneSchema),
  reasons: z.array(z.string()),
});

export const nativeExecutionPlanSchema = z.discriminatedUnion('producerMode', [
  nativeExecutionPlanBaseSchema.extend({
    producerMode: z.literal('skip'),
    executionRequired: z.literal(false),
    releaseArchiveRequired: z.literal(false),
    handoffRequired: z.literal(false),
  }),
  nativeExecutionPlanBaseSchema.extend({
    producerMode: z.literal('unit-preflight'),
    executionRequired: z.literal(false),
    releaseArchiveRequired: z.boolean(),
    handoffRequired: z.literal(false),
  }),
  nativeExecutionPlanBaseSchema.extend({
    producerMode: z.literal('shared-products'),
    executionRequired: z.literal(true),
    releaseArchiveRequired: z.boolean(),
    handoffRequired: z.literal(true),
  }),
]);
export type NativeExecutionPlan = z.infer<typeof nativeExecutionPlanSchema>;

const measuredTestDurationSchema = z.object({
  identifier: z.string().min(1),
  durationSeconds: z.number().positive().max(3_600),
}).strict();

export const measuredNativeShardInputSchema = z.object({
  schema: z.literal('example.ios-native-shard-input.v1'),
  asOf: z.string().datetime({ offset: true }),
  maximumEvidenceAgeHours: z.number().positive().max(168),
  imbalanceToleranceRatio: z.number().min(0).max(0.5),
  evidence: z.object({
    sourceRunId: z.string().regex(/^\d+$/),
    recordedAt: z.string().datetime({ offset: true }),
    tests: z.array(measuredTestDurationSchema).min(1),
  }).strict(),
  assignments: z.array(z.object({
    lane: z.enum(['native1', 'native2', 'native3', 'native4']),
    testIdentifiers: z.array(z.string().min(1)).min(1),
    runner: z.object({
      runnerId: z.string().min(1),
      parallelWorkers: z.number().int().min(1).max(8),
      workersUsed: z.number().int().min(1).max(8),
    }).strict(),
  }).strict()).length(4),
}).strict();

export const measuredNativeShardPlanSchema = z.object({
  schema: z.literal('example.ios-native-shard-plan.v1'),
  sourceRunId: z.string().regex(/^\d+$/),
  evidenceRecordedAt: z.string().datetime({ offset: true }),
  laneEstimates: z.array(z.object({
    lane: z.enum(['native1', 'native2', 'native3', 'native4']),
    estimatedDurationSeconds: z.number().positive(),
    runnerId: z.string().min(1),
    parallelWorkers: z.number().int().min(1).max(8),
    workersUsed: z.number().int().min(1).max(8),
  }).strict()).length(4),
}).strict();
export type MeasuredNativeShardPlan = z.infer<typeof measuredNativeShardPlanSchema>;

/**
 * Longest-processing-time-first makespan over a fixed worker count.
 *
 * `total / workers` is only a lower bound: it assumes a test can be split
 * across workers. Tests are atomic, so a lane of three 100s tests on two
 * workers really takes 200s, not 150s. Scheduling the measured tests produces
 * a wall time some worker layout can actually achieve.
 *
 * Ordering is deterministic and independent of the assignment order: tests
 * sort by descending duration, then by ascending identifier, and equally
 * loaded workers resolve to the lowest worker index.
 */
function scheduledMakespanSeconds(
  durations: ReadonlyMap<string, number>,
  testIdentifiers: readonly string[],
  workers: number,
): number {
  const ordered = [...testIdentifiers].sort((left, right) => {
    const byDuration = (durations.get(right) ?? 0) - (durations.get(left) ?? 0);
    if (byDuration !== 0) return byDuration;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const workerLoads = new Array<number>(workers).fill(0);
  for (const identifier of ordered) {
    let leastLoaded = 0;
    for (let worker = 1; worker < workerLoads.length; worker += 1) {
      if ((workerLoads[worker] ?? 0) < (workerLoads[leastLoaded] ?? 0)) leastLoaded = worker;
    }
    workerLoads[leastLoaded] = (workerLoads[leastLoaded] ?? 0) + (durations.get(identifier) ?? 0);
  }
  return Math.max(...workerLoads);
}

export function deriveMeasuredNativeShardPlan(rawInput: unknown): MeasuredNativeShardPlan {
  const input = measuredNativeShardInputSchema.parse(rawInput);
  const evidenceAgeMs = Date.parse(input.asOf) - Date.parse(input.evidence.recordedAt);
  if (evidenceAgeMs < 0 || evidenceAgeMs > input.maximumEvidenceAgeHours * 3_600_000) {
    throw new Error('Native shard duration evidence is stale or from the future');
  }
  const weights = new Map(input.evidence.tests.map((test) => [test.identifier, test.durationSeconds]));
  if (weights.size !== input.evidence.tests.length) throw new Error('Native shard duration evidence has duplicate tests');
  const laneIds = new Set(input.assignments.map((assignment) => assignment.lane));
  if (laneIds.size !== 4) throw new Error('Native shard assignments must cover each lane exactly once');
  const assignedTests = input.assignments.flatMap((assignment) => assignment.testIdentifiers);
  if (new Set(assignedTests).size !== assignedTests.length) throw new Error('A native test cannot be assigned to multiple lanes');
  const missing = assignedTests.filter((identifier) => !weights.has(identifier));
  if (missing.length > 0) throw new Error(`Missing measured native duration evidence: ${missing.join(', ')}`);
  const unassigned = [...weights.keys()].filter((identifier) => !assignedTests.includes(identifier));
  if (unassigned.length > 0) throw new Error(`Measured native duration evidence is unassigned: ${unassigned.join(', ')}`);
  const runnerAssignments = new Map<string, typeof input.assignments>();
  for (const assignment of input.assignments) {
    const assignments = runnerAssignments.get(assignment.runner.runnerId) ?? [];
    assignments.push(assignment);
    runnerAssignments.set(assignment.runner.runnerId, assignments);
  }
  for (const [runnerId, assignments] of runnerAssignments) {
    const capacities = new Set(assignments.map((assignment) => assignment.runner.parallelWorkers));
    const workersUsed = assignments.reduce((total, assignment) => total + assignment.runner.workersUsed, 0);
    const capacity = assignments[0]?.runner.parallelWorkers ?? 0;
    if (capacities.size !== 1) throw new Error(`Shared runner ${runnerId} has inconsistent worker capacity`);
    if (workersUsed > capacity) throw new Error(`Shared runner ${runnerId} is oversubscribed`);
  }
  const laneEstimates = input.assignments.map((assignment) => ({
    lane: assignment.lane,
    estimatedDurationSeconds: scheduledMakespanSeconds(
      weights,
      assignment.testIdentifiers,
      assignment.runner.workersUsed,
    ),
    runnerId: assignment.runner.runnerId,
    parallelWorkers: assignment.runner.parallelWorkers,
    workersUsed: assignment.runner.workersUsed,
  }));
  const average = laneEstimates.reduce((sum, lane) => sum + lane.estimatedDurationSeconds, 0) / laneEstimates.length;
  if (laneEstimates.some((lane) => Math.abs(lane.estimatedDurationSeconds - average) / average > input.imbalanceToleranceRatio)) {
    throw new Error('Measured native shard plan exceeds its configured imbalance tolerance');
  }
  return measuredNativeShardPlanSchema.parse({
    schema: 'example.ios-native-shard-plan.v1',
    sourceRunId: input.evidence.sourceRunId,
    evidenceRecordedAt: input.evidence.recordedAt,
    laneEstimates,
  });
}

const uiTestPrefixes = [
  'example-iosUITests/',
  'example-iosOnboardingUITests/',
  'example-iosBudgetDebtUITests/',
] as const;

const accountUpdateUiPrefixes = [
  'example-iosUITests/ActivationIntroManageAccounts',
  'example-iosUITests/CardAccountUpdateReturn',
] as const;

function selectionRequiresUi(
  mode: SelectionMode,
  identifiers: readonly string[],
): boolean {
  switch (mode) {
    case 'full':
      return true;
    case 'affected':
      return identifiers.some((identifier) =>
        uiTestPrefixes.some((prefix) => identifier.startsWith(prefix))
      );
    case 'skip':
      return false;
  }
}

function appendLane(lanes: IosLane[], lane: IosLane): void {
  if (!lanes.includes(lane)) {
    lanes.push(lane);
  }
}

export function deriveNativeExecutionPlan(
  rawInput: NativeExecutionInput,
): NativeExecutionPlan {
  const input = nativeExecutionInputSchema.parse(rawInput);
  const executionLanes: IosLane[] = [];
  const fullExecutionLanes: IosLane[] = [];
  const reasons: string[] = [];
  const pullRequestDepth = input.validationDepth === 'pull-request';
  // The unit preflight still builds and runs the full unit partition.
  const fullUiSuiteDeferred = pullRequestDepth && input.selectionMode === 'full';
  if (fullUiSuiteDeferred) {
    reasons.push('full UI suite deferred to the merge queue candidate');
  }
  const uiRequired = !fullUiSuiteDeferred && selectionRequiresUi(
    input.selectionMode,
    input.onlyTestingIdentifiers,
  );
  const selectedUiIdentifiers = input.onlyTestingIdentifiers.filter((identifier) =>
    uiTestPrefixes.some((prefix) => identifier.startsWith(prefix))
  );
  const transferAccountUpdateToSupplemental =
    input.evidenceGroups.includes('account-update');
  const primaryUiIdentifiers = selectedUiIdentifiers.filter((identifier) =>
    !transferAccountUpdateToSupplemental ||
      !accountUpdateUiPrefixes.some((prefix) => identifier.startsWith(prefix))
  );
  const partitionedUiSelection = primaryUiIdentifiers.length > 0 &&
    primaryUiIdentifiers.every((identifier) => {
      const segments = identifier.replace(/\(\)$/, '').split('/');
      return Boolean(input.uiMethodOwners[identifier] ?? input.uiMethodOwners[identifier.replace(/\(\)$/, '')]) ||
        segments.length === 3 &&
        uiTestPrefixes.some((prefix) => identifier.startsWith(prefix));
    });

  if (uiRequired) {
    if (input.selectionMode === 'affected') {
      if (partitionedUiSelection) {
        if (input.onlyTestingIdentifiers.length > selectedUiIdentifiers.length) {
          appendLane(executionLanes, 'native1');
        }
        for (const identifier of primaryUiIdentifiers) {
          appendLane(
            executionLanes,
            input.uiMethodOwners[identifier] ??
              input.uiMethodOwners[identifier.replace(/\(\)$/, '')] ??
              'native1',
          );
        }
        reasons.push('affected UI identifiers run on their owning duration shards');
      } else if (primaryUiIdentifiers.length > 0) {
        appendLane(executionLanes, 'native1');
        reasons.push('affected UI tests require native1');
      }
    } else {
      for (const lane of ['native1', 'native2', 'native3', 'native4'] as const) {
        appendLane(executionLanes, lane);
      }
      reasons.push('full selection requires every native lane');
    }
  }

  if (input.evidenceGroups.includes('account-update')) {
    let selectedAccountUpdateShards = 0;
    for (const lane of ['evidence-account-update', 'evidence-account-update-2'] as const) {
      if (accountUpdateShardSelection(input.selectionMode, input.onlyTestingIdentifiers, lane)) {
        appendLane(executionLanes, lane);
        selectedAccountUpdateShards += 1;
      }
    }
    if (selectedAccountUpdateShards === 0) {
      throw new Error('Account-update evidence selected without owned tests');
    }
    reasons.push('account-update evidence is split across its owned shards');
  }

  if (
    input.evidenceGroups.some((group) => group !== 'account-update') ||
    input.narrowPaywallRequired
  ) {
    appendLane(executionLanes, 'evidence-visual');
    reasons.push('visual evidence selected');
  }

  let retainedForcedLane = false;
  for (const lane of input.forcedLanes) {
    appendLane(executionLanes, lane);
    appendLane(fullExecutionLanes, lane);
    retainedForcedLane = true;
  }
  if (retainedForcedLane) {
    reasons.push('prior non-successful lanes forced');
  }

  const laneOrder: readonly IosLane[] = [
    'native1',
    'native2',
    'native3',
    'native4',
    'evidence-account-update',
    'evidence-account-update-2',
    'evidence-visual',
  ];
  executionLanes.sort((left, right) => laneOrder.indexOf(left) - laneOrder.indexOf(right));
  fullExecutionLanes.sort((left, right) => laneOrder.indexOf(left) - laneOrder.indexOf(right));

  const executionRequired = executionLanes.length > 0;
  const selectionRequired = input.selectionRequired ?? (
    input.selectionMode === 'full' ||
    input.onlyTestingIdentifiers.length > 0 ||
    input.evidenceGroups.length > 0 ||
    input.narrowPaywallRequired
  );
  const producerMode = executionRequired
    ? 'shared-products'
    : selectionRequired
      ? 'unit-preflight'
      : 'skip';
  const handoffRequired = producerMode === 'shared-products';
  const releaseArchiveSelected = producerMode !== 'skip' && input.releaseArchiveRequired;
  if (releaseArchiveSelected && pullRequestDepth) {
    reasons.push('Release archive deferred to the merge queue candidate');
  }
  const releaseArchiveRequired = releaseArchiveSelected && !pullRequestDepth;

  return nativeExecutionPlanSchema.parse({
    schema: 'example.ios-native-plan.v2',
    selectionMode: input.selectionMode,
    uiRequired,
    executionRequired,
    executionLanes,
    fullExecutionLanes,
    producerMode,
    releaseArchiveRequired,
    handoffRequired,
    reasons,
  });
}

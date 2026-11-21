import { z } from 'zod';

import { prValidationPlanSchema, serverTestModeSchema } from './prValidationPlan.ts';
import {
  costClassSchema,
  planVersionSchema,
  registryDigestSchema,
  workflowContractRegistry,
} from './workflowContract.ts';

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const githubRunUrlSchema = z.string().url().refine((value) => (
  /^https:\/\/github\.com\/example-org\/example-app\/actions\/runs\/\d+(?:\/.*)?$/.test(value)
), 'Legacy decisions must identify a Example Actions run');

export const ciTupleSchema = z.object({
  pullRequest: z.number().int().positive(),
  headSha: shaSchema,
  baseSha: shaSchema,
  patchDigest: digestSchema,
  planVersion: planVersionSchema,
  registryDigest: registryDigestSchema,
}).strict();
export type CiTuple = z.infer<typeof ciTupleSchema>;

export const laneDecisionSchema = z.enum(['skip', 'execute', 'reuse']);
export type LaneDecision = z.infer<typeof laneDecisionSchema>;

export const tupleDispositionSchema = z.enum([
  'current',
  'cancel-obsolete',
  'cancel-duplicate',
  'retain-patch-equivalent-predecessor',
]);
export type TupleDisposition = z.infer<typeof tupleDispositionSchema>;

export const legacyPrValidationOutputSchema = z.object({
  docsOnly: z.boolean(),
  metadataOnly: z.boolean(),
  policyRequired: z.boolean(),
  workflowContractsRequired: z.boolean(),
  serverStaticRequired: z.boolean(),
  serverTestMode: serverTestModeSchema,
  targetedServerTests: z.array(z.string()),
  targetedIntegrationTests: z.array(z.string()),
  databaseRequired: z.boolean(),
  iosContractsRequired: z.boolean(),
}).strict();

const booleanOutputSchema = z.enum(['true', 'false']);
export const legacyPrValidationRawOutputSchema = z.object({
  docs_only: booleanOutputSchema,
  metadata_only: booleanOutputSchema,
  policy_required: booleanOutputSchema,
  workflow_contracts_required: booleanOutputSchema,
  server_static_required: booleanOutputSchema,
  server_test_mode: serverTestModeSchema,
  targeted_server_tests: z.string(),
  targeted_integration_tests: z.string(),
  database_required: booleanOutputSchema,
  ios_contracts_required: booleanOutputSchema,
}).strict();

function parseStringArray(value: string, field: string): string[] {
  try {
    return z.array(z.string()).parse(JSON.parse(value));
  } catch {
    throw new Error(`Legacy controller output ${field} must be a JSON string array`);
  }
}

export function adaptLegacyPrValidationOutput(rawOutput: unknown) {
  const raw = legacyPrValidationRawOutputSchema.parse(rawOutput);
  const flag = (value: 'true' | 'false') => value === 'true';
  return legacyPrValidationOutputSchema.parse({
    docsOnly: flag(raw.docs_only),
    metadataOnly: flag(raw.metadata_only),
    policyRequired: flag(raw.policy_required),
    workflowContractsRequired: flag(raw.workflow_contracts_required),
    serverStaticRequired: flag(raw.server_static_required),
    serverTestMode: raw.server_test_mode,
    targetedServerTests: parseStringArray(raw.targeted_server_tests, 'targeted_server_tests'),
    targetedIntegrationTests: parseStringArray(raw.targeted_integration_tests, 'targeted_integration_tests'),
    databaseRequired: flag(raw.database_required),
    iosContractsRequired: flag(raw.ios_contracts_required),
  });
}

export const prValidationComparisonSchema = z.object({
  legacy: z.object({
    adapter: z.literal('pr-validation-controller-output.v1'),
    sourceRunUrl: githubRunUrlSchema,
    sourceHeadSha: shaSchema,
    rawOutput: legacyPrValidationRawOutputSchema,
  }).strict(),
  typedPlan: prValidationPlanSchema,
}).strict();
export type PrValidationComparison = z.infer<typeof prValidationComparisonSchema>;

export const prValidationStageLaneIds = [
  'pr-checks.validation-policy',
  'pr.workflow-contracts',
  'pr.server-static',
  'pr.server-process',
  'pr.server-shards',
  'pr.targeted-server',
  'pr.ios-contracts',
  'pr.database',
] as const;
export type PrValidationStageLaneId = typeof prValidationStageLaneIds[number];

function selected(
  laneId: PrValidationStageLaneId,
  plan: z.infer<typeof legacyPrValidationOutputSchema>,
): boolean {
  switch (laneId) {
    // pr-checks.yml gates validation-policy on both metadata_only != 'true'
    // and policy_required == 'true'. Reading only policy_required would model
    // the job as executing for a metadata-only plan the workflow skips.
    case 'pr-checks.validation-policy': return !plan.metadataOnly && plan.policyRequired;
    case 'pr.workflow-contracts': return plan.workflowContractsRequired;
    case 'pr.server-static': return plan.serverStaticRequired;
    case 'pr.server-process':
    case 'pr.server-shards': return plan.serverTestMode === 'full';
    case 'pr.targeted-server': return plan.serverTestMode === 'targeted';
    case 'pr.ios-contracts': return plan.iosContractsRequired;
    case 'pr.database': return plan.databaseRequired;
  }
}

function normalizedTestSet(tests: readonly string[]): string[] {
  return [...new Set(tests)].sort();
}

function targetedTestsMatch(
  laneId: PrValidationStageLaneId,
  legacyOutput: z.infer<typeof legacyPrValidationOutputSchema>,
  typedPlan: z.infer<typeof prValidationPlanSchema>,
): boolean {
  if (laneId !== 'pr.targeted-server') return true;
  return JSON.stringify(normalizedTestSet(legacyOutput.targetedServerTests))
      === JSON.stringify(normalizedTestSet(typedPlan.targetedServerTests))
    && JSON.stringify(normalizedTestSet(legacyOutput.targetedIntegrationTests))
      === JSON.stringify(normalizedTestSet(typedPlan.targetedIntegrationTests));
}

export const ciDecisionTelemetrySchema = z.object({
  schema: z.literal('example.ci-decision-telemetry.v1'),
  recordedAt: z.string().datetime({ offset: true }),
  mode: z.enum(['shadow', 'typed', 'legacy-fallback']),
  tuple: ciTupleSchema,
  legacyAdapter: z.literal('pr-validation-controller-output.v1'),
  legacySourceRunUrl: githubRunUrlSchema,
  laneId: z.enum(prValidationStageLaneIds),
  costClass: costClassSchema,
  legacyDecision: z.enum(['skip', 'execute']),
  typedDecision: z.enum(['skip', 'execute']),
  parity: z.boolean(),
  disposition: tupleDispositionSchema,
  reasonCode: z.enum(['decisions-match', 'shadow-decision-mismatch']),
  queueSeconds: z.number().nonnegative().optional(),
  executionSeconds: z.number().nonnegative().optional(),
  estimatedRunnerMinutesAvoided: z.number().nonnegative().default(0),
}).strict().superRefine((telemetry, context) => {
  if (telemetry.legacyDecision !== telemetry.typedDecision && telemetry.parity) {
    context.addIssue({ code: 'custom', message: 'Parity requires matching legacy and typed decisions', path: ['parity'] });
  }
  const lane = workflowContractRegistry.lanes.find((entry) => entry.id === telemetry.laneId);
  if (!lane || lane.costClass !== telemetry.costClass) {
    context.addIssue({ code: 'custom', message: 'Telemetry lane and cost must match the pinned registry', path: ['laneId'] });
  }
});
export type CiDecisionTelemetry = z.infer<typeof ciDecisionTelemetrySchema>;

export function derivePrValidationDecisionTelemetry(input: {
  recordedAt: string;
  mode: 'shadow' | 'typed' | 'legacy-fallback';
  tuple: CiTuple;
  comparison: PrValidationComparison;
  disposition: TupleDisposition;
}): CiDecisionTelemetry[] {
  const tuple = ciTupleSchema.parse(input.tuple);
  const comparison = prValidationComparisonSchema.parse(input.comparison);
  if (comparison.legacy.sourceHeadSha !== tuple.headSha) {
    throw new Error('Legacy controller output must come from the compared tuple head');
  }
  const legacyOutput = adaptLegacyPrValidationOutput(comparison.legacy.rawOutput);
  return prValidationStageLaneIds.map((laneId) => {
    const lane = workflowContractRegistry.lanes.find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Migration lane is absent from the registry: ${laneId}`);
    const legacyDecision = selected(laneId, legacyOutput) ? 'execute' : 'skip';
    const typedDecision = (laneId === 'pr.server-process'
      ? comparison.typedPlan.processHeavyRequired
      : selected(laneId, comparison.typedPlan)) ? 'execute' : 'skip';
    const parity = legacyDecision === typedDecision
      && legacyOutput.docsOnly === comparison.typedPlan.docsOnly
      && legacyOutput.metadataOnly === comparison.typedPlan.metadataOnly
      && targetedTestsMatch(laneId, legacyOutput, comparison.typedPlan);
    return ciDecisionTelemetrySchema.parse({
      schema: 'example.ci-decision-telemetry.v1',
      recordedAt: input.recordedAt,
      mode: input.mode,
      tuple,
      legacyAdapter: comparison.legacy.adapter,
      legacySourceRunUrl: comparison.legacy.sourceRunUrl,
      laneId,
      costClass: lane.costClass,
      legacyDecision,
      typedDecision,
      parity,
      disposition: input.disposition,
      reasonCode: parity ? 'decisions-match' : 'shadow-decision-mismatch',
      estimatedRunnerMinutesAvoided: 0,
    });
  });
}

export const ciMigrationSlos = {
  decisionParityRatio: 1,
  obsoleteTupleCancellationP95Seconds: 60,
  controlQueueP95Seconds: 60,
  linuxQueueP95Seconds: 120,
  macosQueueP95Seconds: 300,
  pullRequestFeedbackP95Seconds: 600,
  promotionToTestFlightP95Seconds: 1800,
} as const;

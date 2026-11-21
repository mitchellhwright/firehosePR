import { z } from 'zod';

import {
  ciTupleSchema,
  derivePrValidationDecisionTelemetry,
  prValidationComparisonSchema,
} from './ciMigrationTelemetry.ts';
import { workflowContractRegistry } from './workflowContract.ts';

export const genuineEscalationSchema = z.enum([
  'product-failure',
  'security-failure',
  'iam-failure',
]);

const sourceRunUrlSchema = z.string().url().refine((value) => (
  /^https:\/\/github\.com\/example-org\/example-app\/actions\/runs\/\d+(?:\/.*)?$/.test(value)
), 'Acceptance observations must identify a Example Actions run');

const migrationOutcomeObservationObjectSchema = z.object({
  pullRequest: z.number().int().positive(),
  observedAt: z.string().datetime({ offset: true }),
  sourceRunUrl: sourceRunUrlSchema,
  eligibility: z.enum(['ordinary-eligible', 'genuine-escalation']),
  escalation: genuineEscalationSchema.optional(),
  outcome: z.enum(['merged', 'completed-unmerged', 'incomplete']),
  manualInterventions: z.number().int().nonnegative(),
  stuckPendingContexts: z.number().int().nonnegative(),
  operatorOnlyRecoveries: z.number().int().nonnegative(),
  protectionBypasses: z.number().int().nonnegative(),
  fabricatedEvidenceEvents: z.number().int().nonnegative(),
}).strict();
type MigrationOutcomeObservation = z.infer<typeof migrationOutcomeObservationObjectSchema>;

function refineMigrationOutcomeObservation(
  observation: MigrationOutcomeObservation,
  context: z.RefinementCtx,
): void {
  if ((observation.eligibility === 'genuine-escalation') !== (observation.escalation !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Genuine escalations require exactly one typed escalation reason', path: ['escalation'] });
  }
}

const migrationOutcomeObservationSchema = migrationOutcomeObservationObjectSchema
  .superRefine(refineMigrationOutcomeObservation);

const migrationCandidateObservationSchema = migrationOutcomeObservationObjectSchema.extend({
  tuple: ciTupleSchema,
  comparison: prValidationComparisonSchema,
}).strict().superRefine((observation, context) => {
  refineMigrationOutcomeObservation(observation, context);
  if (observation.tuple.pullRequest !== observation.pullRequest) {
    context.addIssue({ code: 'custom', message: 'Decision tuple must match its observed pull request', path: ['tuple', 'pullRequest'] });
  }
  if (observation.comparison.legacy.sourceHeadSha !== observation.tuple.headSha) {
    context.addIssue({ code: 'custom', message: 'Legacy output must come from the observed tuple head', path: ['comparison', 'legacy', 'sourceHeadSha'] });
  }
  if (observation.comparison.legacy.sourceRunUrl !== observation.sourceRunUrl) {
    context.addIssue({ code: 'custom', message: 'Acceptance record must identify the compared legacy run', path: ['sourceRunUrl'] });
  }
});

function distinctPullRequests(
  observations: readonly { pullRequest: number }[],
  context: z.RefinementCtx,
  path: string,
): void {
  const pullRequests = observations.map((observation) => observation.pullRequest);
  if (new Set(pullRequests).size !== pullRequests.length) {
    context.addIssue({ code: 'custom', message: 'Acceptance requires distinct pull requests', path: [path] });
  }
}

export const migrationAcceptanceSampleSchema = z.object({
  schema: z.literal('example.ci-migration-acceptance.v3'),
  stage: z.literal('pr-validation-plan'),
  baselineObservations: z.array(migrationOutcomeObservationSchema).min(20),
  observations: z.array(migrationCandidateObservationSchema).min(20),
}).strict().superRefine((sample, context) => {
  distinctPullRequests(sample.baselineObservations, context, 'baselineObservations');
  distinctPullRequests(sample.observations, context, 'observations');
  const currentRegistryIdentity = `${workflowContractRegistry.schema}:${workflowContractRegistry.registryDigest}`;
  const contractIdentities = new Set(sample.observations.map((observation) => (
    `${observation.tuple.planVersion}:${observation.tuple.registryDigest}`
  )));
  if (contractIdentities.size !== 1 || !contractIdentities.has(currentRegistryIdentity)) {
    context.addIssue({
      code: 'custom',
      message: 'Acceptance sample must be pinned to the currently loaded registry',
      path: ['observations'],
    });
  }
});
export type MigrationAcceptanceSample = z.infer<typeof migrationAcceptanceSampleSchema>;

export interface MigrationAcceptanceResult {
  accepted: boolean;
  decisionParityRatio: number;
  ordinaryEligibleCompletionRatio: number;
  baselineManualInterventionsPerMergedPullRequest: number;
  candidateManualInterventionsPerMergedPullRequest: number;
  reasons: string[];
}

function interventionsPerMergedPullRequest(
  observations: readonly z.infer<typeof migrationOutcomeObservationSchema>[],
): number {
  const merged = observations.filter((observation) => observation.outcome === 'merged');
  return merged.length === 0
    ? Number.POSITIVE_INFINITY
    : merged.reduce((sum, observation) => sum + observation.manualInterventions, 0) / merged.length;
}

export function evaluateMigrationStage(rawSample: unknown): MigrationAcceptanceResult {
  const sample = migrationAcceptanceSampleSchema.parse(rawSample);
  const decisions = sample.observations.flatMap((observation) => (
    derivePrValidationDecisionTelemetry({
      recordedAt: observation.observedAt,
      mode: 'shadow',
      tuple: observation.tuple,
      comparison: observation.comparison,
      disposition: 'current',
    })
  ));
  const ordinary = sample.observations.filter((observation) => observation.eligibility === 'ordinary-eligible');
  const decisionParityRatio = decisions.filter((decision) => decision.parity).length / decisions.length;
  const ordinaryEligibleCompletionRatio = ordinary.length === 0
    ? 0
    : ordinary.filter((observation) => observation.outcome === 'merged').length / ordinary.length;
  const baselineManualInterventionsPerMergedPullRequest = interventionsPerMergedPullRequest(sample.baselineObservations);
  const candidateManualInterventionsPerMergedPullRequest = interventionsPerMergedPullRequest(sample.observations);
  const reasons: string[] = [];
  if (decisionParityRatio !== 1) reasons.push('typed-decision-parity-below-one');
  if (ordinaryEligibleCompletionRatio !== 1) reasons.push('ordinary-eligible-completion-below-one');
  if (candidateManualInterventionsPerMergedPullRequest !== 0) reasons.push('manual-interventions-remain');
  if (candidateManualInterventionsPerMergedPullRequest > baselineManualInterventionsPerMergedPullRequest) {
    reasons.push('manual-interventions-regressed');
  }
  const safetyTotals = sample.observations.reduce((totals, observation) => ({
    stuck: totals.stuck + observation.stuckPendingContexts,
    operator: totals.operator + observation.operatorOnlyRecoveries,
    bypasses: totals.bypasses + observation.protectionBypasses,
    fabricated: totals.fabricated + observation.fabricatedEvidenceEvents,
  }), { stuck: 0, operator: 0, bypasses: 0, fabricated: 0 });
  if (safetyTotals.stuck > 0) reasons.push('stuck-pending-contexts-observed');
  if (safetyTotals.operator > 0) reasons.push('operator-only-recoveries-observed');
  if (safetyTotals.bypasses > 0) reasons.push('protection-bypasses-observed');
  if (safetyTotals.fabricated > 0) reasons.push('fabricated-evidence-observed');
  return {
    accepted: reasons.length === 0,
    decisionParityRatio,
    ordinaryEligibleCompletionRatio,
    baselineManualInterventionsPerMergedPullRequest,
    candidateManualInterventionsPerMergedPullRequest,
    reasons,
  };
}

export function canCutOverMigrationStage(rawSample: unknown): boolean {
  return evaluateMigrationStage(rawSample).accepted;
}

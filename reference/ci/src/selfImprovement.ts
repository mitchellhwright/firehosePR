import { z } from 'zod';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const safeProposalPathSchema = z.string().min(1).refine((path) => (
  !path.includes('..') && (
    path.startsWith('ci/src/')
    || path.startsWith('ci/tests/')
    || path.startsWith('ci/contracts/')
    || path === 'docs/ci-architecture.md'
  )
), 'Proposal path is outside the fixed shadow-controller allowlist');

export const ciOperationalSampleSchema = z.object({
  schema: z.literal('example.ci-operational-sample.v1'),
  recordedAt: z.string().datetime({ offset: true }),
  laneId: z.string().min(1),
  queueSeconds: z.number().nonnegative(),
  executionSeconds: z.number().nonnegative(),
  stepDurationsSeconds: z.record(z.string(), z.number().nonnegative()),
  supersededRunnerMinutes: z.number().nonnegative(),
  cache: z.enum(['hit', 'miss', 'not-applicable']),
  flakeFingerprint: digestSchema.optional(),
  runnerId: z.string().min(1),
  runnerUtilizationRatio: z.number().min(0).max(1),
  githubHostedCostUsd: z.number().nonnegative(),
  agentAiCredits: z.number().nonnegative(),
  agentCostUsd: z.number().nonnegative(),
  mergeLeadSeconds: z.number().nonnegative().optional(),
  deployment: z.enum(['not-applicable', 'success', 'failure', 'rolled-back']),
}).strict();

const ratioMetrics = new Set([
  'cache-hit-ratio',
  'flake-rate',
  'runner-utilization',
  'deploy-success-rate',
]);

const measuredOutcomeSchema = z.object({
  metric: z.enum([
    'queue-p95',
    'execution-p95',
    'superseded-minutes',
    'cache-hit-ratio',
    'flake-rate',
    'runner-utilization',
    'github-hosted-cost',
    'agent-cost-per-merged-pr',
    'manual-interventions-per-merged-pr',
    'merge-lead-p95',
    'deploy-success-rate',
  ]),
  baseline: z.number().nonnegative(),
  candidate: z.number().nonnegative(),
}).strict().superRefine((outcome, context) => {
  if (!ratioMetrics.has(outcome.metric)) return;
  if (outcome.baseline > 1) {
    context.addIssue({ code: 'custom', message: 'Ratio metric baseline must not exceed 1', path: ['baseline'] });
  }
  if (outcome.candidate > 1) {
    context.addIssue({ code: 'custom', message: 'Ratio metric candidate must not exceed 1', path: ['candidate'] });
  }
});

export const selfImprovementProposalSchema = z.object({
  schema: z.literal('example.ci-self-improvement-proposal.v1'),
  proposalId: z.string().regex(/^[a-z0-9-]+$/),
  configDigest: digestSchema,
  allowedPaths: z.array(safeProposalPathSchema).min(1).max(20),
  historicalReplayCount: z.number().int().min(50),
  historicalReplayPassed: z.literal(true),
  shadowDecisionCount: z.number().int().min(20),
  shadowParityRatio: z.literal(1),
  outcomes: z.array(measuredOutcomeSchema).min(1),
  safetyInvariants: z.object({
    requiredContextsPreserved: z.literal(true),
    selectedChecksNeverDropped: z.literal(true),
    physicalMacOnly: z.literal(true),
    noFabricatedEvidence: z.literal(true),
    noProtectionWeakening: z.literal(true),
  }).strict(),
  experiment: z.object({
    maxPullRequests: z.number().int().min(1).max(25),
    maxHours: z.number().positive().max(24),
    maxGithubHostedCostUsd: z.number().nonnegative().max(25),
    maxAgentAiCredits: z.number().nonnegative().max(250),
  }).strict(),
  rollbackRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/),
}).strict().superRefine((proposal, context) => {
  const metrics = proposal.outcomes.map((outcome) => outcome.metric);
  if (new Set(metrics).size !== metrics.length) {
    context.addIssue({ code: 'custom', message: 'Outcome metrics must not repeat', path: ['outcomes'] });
  }
});
export type SelfImprovementProposal = z.infer<typeof selfImprovementProposalSchema>;

const higherIsBetterMetrics = new Set([
  'cache-hit-ratio',
  'runner-utilization',
  'deploy-success-rate',
]);

export function deriveImprovementRatio(
  outcome: z.infer<typeof measuredOutcomeSchema>,
): number {
  if (outcome.baseline === outcome.candidate) return 0;
  if (outcome.baseline === 0) {
    return higherIsBetterMetrics.has(outcome.metric)
      ? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;
  }
  return higherIsBetterMetrics.has(outcome.metric)
    ? (outcome.candidate - outcome.baseline) / outcome.baseline
    : (outcome.baseline - outcome.candidate) / outcome.baseline;
}

export function canOpenSelfImprovementPullRequest(rawProposal: unknown): boolean {
  const proposal = selfImprovementProposalSchema.parse(rawProposal);
  const protectedMetrics = [
    'github-hosted-cost', 'agent-cost-per-merged-pr',
    'manual-interventions-per-merged-pr', 'deploy-success-rate',
  ] as const;
  const outcomes = new Map(proposal.outcomes.map((outcome) => [outcome.metric, outcome]));
  if (protectedMetrics.some((metric) => !outcomes.has(metric))) return false;
  const ratios = proposal.outcomes.map(deriveImprovementRatio);
  if (ratios.some((ratio) => ratio < 0)) return false;
  const deployment = outcomes.get('deploy-success-rate');
  if (!deployment || deployment.candidate < 0.95) return false;
  const githubCost = outcomes.get('github-hosted-cost');
  const agentCost = outcomes.get('agent-cost-per-merged-pr');
  if (!githubCost || !agentCost
      || githubCost.candidate > proposal.experiment.maxGithubHostedCostUsd) return false;
  return ratios.some((ratio) => ratio >= 0.1);
}

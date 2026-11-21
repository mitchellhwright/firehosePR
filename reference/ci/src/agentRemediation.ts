import { z } from 'zod';

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const firstNonControlCodePoint = 0x20;

function isSafeRepositoryRelativePath(value: string): boolean {
  for (const character of value) {
    // A backslash carries the Windows-style absolute and traversal forms, and a
    // control character lets a path smuggle a newline into downstream tooling.
    if (character === '\\' || (character.codePointAt(0) ?? 0) < firstNonControlCodePoint) {
      return false;
    }
  }
  // An empty segment is an absolute path, a doubled separator, or a trailing
  // separator; a dot segment is traversal or an unnormalized self-reference.
  return value.split('/').every((segment) => (
    segment.length > 0 && segment !== '.' && segment !== '..'
  ));
}

const repositoryRelativePathSchema = z.string().min(1).refine(
  isSafeRepositoryRelativePath,
  'Remediation paths must be normalized repository-relative paths without traversal',
);

const githubActionsEvidenceUrlSchema = z.string().url().superRefine((value, context) => {
  if (!URL.canParse(value)) return;
  const url = new URL(value);
  if (url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || url.port
      || url.username
      || url.password
      || url.search
      || url.hash
      || !/^\/example-org\/example-app\/actions\/runs\/\d+(?:\/artifacts\/\d+)?\/?$/.test(url.pathname)) {
    context.addIssue({
      code: 'custom',
      message: 'Remediation evidence must be a query-free HTTPS Actions run or artifact URL for example-org/example-app',
    });
  }
});

export const remediationAgentSchema = z.enum([
  'github-copilot-cloud',
  'external-claude',
  'external-codex',
]);
export type RemediationAgent = z.infer<typeof remediationAgentSchema>;

export const deterministicDiagnosisSchema = z.object({
  schema: z.literal('example.ci-diagnosis.v1'),
  fingerprint: digestSchema,
  category: z.enum([
    'compile',
    'lint',
    'contract',
    'test-assertion',
    'test-fixture',
    'runner-capability',
    'infrastructure-transient',
  ]),
  reproducible: z.boolean(),
  failingLaneId: z.string().min(1),
  failingFiles: z.array(repositoryRelativePathSchema).max(25),
  logArtifactUrl: githubActionsEvidenceUrlSchema,
}).strict();
export type DeterministicDiagnosis = z.infer<typeof deterministicDiagnosisSchema>;

export const remediationTaskSchema = z.object({
  schema: z.literal('example.agent-remediation-task.v1'),
  agent: remediationAgentSchema,
  pullRequest: z.number().int().positive(),
  issue: z.number().int().positive(),
  headSha: shaSchema,
  baseSha: shaSchema,
  diagnosis: deterministicDiagnosisSchema,
  allowedPaths: z.array(repositoryRelativePathSchema).min(1).max(25),
  maxAttempts: z.number().int().min(1).max(3),
  maxAiCredits: z.number().positive().max(100),
  maxActionsMinutes: z.number().positive().max(30),
  requireIndependentReview: z.literal(true),
  allowProtectionChanges: z.literal(false),
  allowSelfApproval: z.literal(false),
}).strict();
export type RemediationTask = z.infer<typeof remediationTaskSchema>;

export const remediationBudgetStateSchema = z.object({
  attemptsForPullRequest: z.number().int().nonnegative(),
  aiCreditsUsedToday: z.number().nonnegative(),
  aiCreditsDailyCap: z.number().positive(),
  actionsMinutesUsedToday: z.number().nonnegative(),
  actionsMinutesDailyCap: z.number().positive(),
  priorFingerprints: z.array(digestSchema),
}).strict();
export type RemediationBudgetState = z.infer<typeof remediationBudgetStateSchema>;

export type RemediationEligibility =
  | { eligible: true }
  | { eligible: false; reason: string };

export function remediationEligibility(
  rawTask: unknown,
  rawBudget: unknown,
): RemediationEligibility {
  const task = remediationTaskSchema.parse(rawTask);
  const budget = remediationBudgetStateSchema.parse(rawBudget);
  if (!task.diagnosis.reproducible) {
    return { eligible: false, reason: 'diagnosis-not-reproducible' };
  }
  if (task.diagnosis.category === 'runner-capability'
      || task.diagnosis.category === 'infrastructure-transient') {
    return { eligible: false, reason: 'deterministic-infrastructure-repair-required' };
  }
  if (budget.attemptsForPullRequest >= task.maxAttempts) {
    return { eligible: false, reason: 'per-pr-attempt-cap-reached' };
  }
  if (budget.priorFingerprints.includes(task.diagnosis.fingerprint)) {
    return { eligible: false, reason: 'diagnostic-loop-suppressed' };
  }
  if (budget.aiCreditsUsedToday + task.maxAiCredits > budget.aiCreditsDailyCap) {
    return { eligible: false, reason: 'daily-ai-credit-cap-reached' };
  }
  if (budget.actionsMinutesUsedToday + task.maxActionsMinutes > budget.actionsMinutesDailyCap) {
    return { eligible: false, reason: 'daily-actions-minute-cap-reached' };
  }
  if (!task.diagnosis.failingFiles.every((path) => task.allowedPaths.includes(path))) {
    return { eligible: false, reason: 'diagnosis-exceeds-file-scope' };
  }
  return { eligible: true };
}

export const remediationOutcomeTelemetrySchema = z.object({
  schema: z.literal('example.agent-remediation-outcome.v1'),
  agent: remediationAgentSchema,
  pullRequest: z.number().int().positive(),
  issue: z.number().int().positive(),
  diagnosisFingerprint: digestSchema,
  sessionId: z.string().min(1),
  attempt: z.number().int().min(1).max(3),
  aiCredits: z.number().nonnegative(),
  actionsMinutes: z.number().nonnegative(),
  outcome: z.enum(['no-change', 'candidate-opened', 'checks-failed', 'merged', 'stopped']),
  humanInterventionAvoided: z.boolean(),
  mergedPullRequest: z.number().int().positive().optional(),
}).strict().superRefine((telemetry, context) => {
  if (telemetry.outcome === 'merged' && telemetry.mergedPullRequest === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'mergedPullRequest is required when outcome is "merged"',
      path: ['mergedPullRequest'],
    });
  }
  if (telemetry.outcome !== 'merged' && telemetry.mergedPullRequest !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'mergedPullRequest must be omitted unless outcome is "merged"',
      path: ['mergedPullRequest'],
    });
  }
});

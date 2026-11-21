import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ciTupleSchema, laneDecisionSchema } from './ciMigrationTelemetry.ts';
import {
  costClassSchema,
  humanReadableNameSchema,
  requiredCheckContextSchema,
  planVersionSchema,
  registryDigestSchema,
  runnerClassSchema,
  workflowContractRegistry,
} from './workflowContract.ts';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const githubRunUrlSchema = z.string().url().refine((value) => (
  /^https:\/\/github\.com\/example-org\/example-app\/actions\/runs\/\d+(?:\/.*)?$/.test(value)
), 'Evidence must identify a Example Actions run');
const maximumRedactionBytes = 8_192;
const maximumDecodeIterations = 16;

function decodeUntilStable(value: string): string | undefined {
  let decoded = value;
  if (Buffer.byteLength(decoded, 'utf8') > maximumRedactionBytes) return undefined;
  for (let attempt = 0; attempt < maximumDecodeIterations; attempt += 1) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return undefined; }
    if (Buffer.byteLength(next, 'utf8') > maximumRedactionBytes) return undefined;
    if (next === decoded) return decoded;
    decoded = next;
  }
  return undefined;
}

function containsSecretLike(value: string): boolean {
  const decoded = decodeUntilStable(value);
  if (decoded === undefined) return true;
  return /(?:\bbearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|github_pat_|gh[pousr]_|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9]|\bAIza[A-Za-z0-9_-]|(?:password|secret|token|signature|credential|api[-_]?key)\s*[=:/]\s*[^\s/?#&]{8,})/i.test(decoded);
}
function redactText(schema: z.ZodString) {
  return schema.superRefine((value, context) => {
    if (containsSecretLike(value)) {
      context.addIssue({ code: 'custom', message: 'Agent status text contains secret-like material' });
    }
  });
}
const knownAgentIdentifiers = new Set([
  ...workflowContractRegistry.lanes.flatMap((lane) => [lane.id, lane.jobId]),
  ...workflowContractRegistry.workflows.flatMap((workflow) => [
    workflow.path,
    ...workflow.jobs.flatMap((job) => [
      job.id,
      `${workflow.path}:${job.id}`,
      ...job.steps.flatMap((step) => [
        step.id,
        `${workflow.path}:${job.id}:${step.id}`,
      ]),
    ]),
  ]),
]);
function redactIdentifier(schema: z.ZodString) {
  return schema.superRefine((value, context) => {
    if (!knownAgentIdentifiers.has(value) && containsSecretLike(value)) {
      context.addIssue({ code: 'custom', message: 'Agent status identifier contains secret-like material' });
    }
  });
}
const redactedIdentifierSchema = redactIdentifier(z.string().min(1));
const redactedSurfaceIdentifierSchema = redactIdentifier(z.string().min(1).max(240));
const redactedUrlSchema = z.string().url().superRefine((value, context) => {
  if (!URL.canParse(value)) {
    context.addIssue({ code: 'custom', message: 'Agent status URL is not a parsable absolute URL' });
    return;
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password
      || containsSecretLike(value)
      || containsSecretLike(`${url.hostname}${url.pathname}${url.search}${url.hash}`)
      || [...url.searchParams.entries()].some(([key, entry]) => (
        /token|secret|password|signature|credential|api[-_]?key/i.test(key) || containsSecretLike(entry)
      ))) {
    context.addIssue({ code: 'custom', message: 'Agent status URL is not safe for the redacted interface' });
  }
});
const redactedGithubRunUrlSchema = githubRunUrlSchema.and(redactedUrlSchema);

export const laneReasonCodeSchema = z.enum([
  'always-run',
  'changed-files',
  'dependency-selected',
  'ios-source-changed',
  'legacy-shadow',
  'not-selected',
  'prior-evidence-reused',
]);
export const queueReasonCodeSchema = z.enum([
  'waiting-for-dependency',
  'waiting-for-ios-xcode-runner',
  'waiting-for-linux-runner',
]);
export const transitionActionCodeSchema = z.enum([
  'continue-pipeline',
  'inspect-failure',
  'no-action',
  'retry-deterministically',
  'wait-for-dependency',
  'wait-for-runner-lease',
]);
const retryCauseCodeSchema = z.enum(['deterministic-retry', 'flake-confirmed', 'runner-replaced']);
const cancellationCauseCodeSchema = z.enum(['duplicate-tuple', 'obsolete-tuple', 'superseded-lane']);

const evidencePolicySchema = z.enum(['none', 'exact-head', 'patch-equivalent']);
const evidenceIdentitySchema = z.object({
  sourceRunUrl: redactedGithubRunUrlSchema,
  sourceHeadSha: shaSchema,
  sourceBaseSha: shaSchema,
  sourcePatchDigest: digestSchema,
  sourcePlanVersion: planVersionSchema,
  sourceRegistryDigest: registryDigestSchema,
  sourceLaneId: redactedIdentifierSchema,
  conclusion: z.literal('success'),
  resultDigest: digestSchema,
  evidenceDigest: digestSchema,
}).strict();

const noEvidenceSchema = z.object({
  policy: evidencePolicySchema,
  source: z.literal('none'),
}).strict();
const currentEvidenceSchema = evidenceIdentitySchema.extend({
  policy: evidencePolicySchema,
  source: z.literal('current-execution'),
}).strict();
const priorEvidenceSchema = evidenceIdentitySchema.extend({
  policy: z.enum(['exact-head', 'patch-equivalent']),
  source: z.literal('prior-tuple'),
}).strict();
export const ciEvidenceSchema = z.discriminatedUnion('source', [
  noEvidenceSchema,
  currentEvidenceSchema,
  priorEvidenceSchema,
]);
export type CiEvidence = z.infer<typeof ciEvidenceSchema>;

function canonicalJson(value: unknown, excludedKeys = new Set(['evidenceDigest'])): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, excludedKeys)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([key, entry]) => !excludedKeys.has(key) && entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, excludedKeys)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function computeEvidenceDigest(
  evidence: Omit<z.infer<typeof evidenceIdentitySchema>, 'evidenceDigest'> & (
    | { policy: 'none' | 'exact-head' | 'patch-equivalent'; source: 'current-execution' }
    | { policy: 'exact-head' | 'patch-equivalent'; source: 'prior-tuple' }
  ),
): string {
  return createHash('sha256').update(canonicalJson(evidence)).digest('hex');
}

export const ciLaneStateSchema = z.object({
  laneId: redactedIdentifierSchema,
  displayName: z.string().min(1).max(100).refine((name) => !name.includes('${{')),
  purpose: z.string().min(1).max(240),
  progressVocabulary: z.array(z.enum(['queued', 'running', 'retrying', 'completed'])).min(3),
  successMeaning: z.string().min(1).max(240),
  failureOwner: z.enum(['automation', 'product', 'security', 'iam', 'review', 'infrastructure']),
  nextAction: z.string().min(1).max(240),
  statusDetail: redactText(z.string().min(1).max(240)),
  decision: laneDecisionSchema,
  reasonCode: laneReasonCodeSchema,
  dependencies: z.array(redactedIdentifierSchema),
  runner: z.object({
    requirement: runnerClassSchema,
    assignedRunner: redactText(z.string().min(1)).optional(),
    queueReasonCode: queueReasonCodeSchema.optional(),
    queueReason: redactText(z.string().min(1).max(240)).optional(),
  }).strict(),
  evidence: ciEvidenceSchema,
  phase: z.enum([
    'planned', 'queued', 'running', 'passed', 'failed', 'skipped', 'reused', 'cancelled',
  ]),
  retryCauseCode: retryCauseCodeSchema.optional(),
  cancellationCauseCode: cancellationCauseCodeSchema.optional(),
  supersededByRunUrl: redactedGithubRunUrlSchema.optional(),
  blockerOwner: z.enum(['automation', 'product', 'security', 'iam', 'review', 'none']),
  expectedNextTransition: redactText(z.string().min(1).max(160)),
  costClass: costClassSchema,
  estimatedDurationSeconds: z.number().positive().max(86_400).optional(),
  budget: z.object({
    maxQueueSeconds: z.number().nonnegative(),
    maxExecutionSeconds: z.number().nonnegative(),
    maxGithubHostedCostUsd: z.number().nonnegative(),
  }).strict(),
  links: z.array(redactedUrlSchema).max(10),
}).strict();

export const ciStateDocumentSchema = z.object({
  schema: z.literal('example.ci-state.v2'),
  generatedAt: z.string().datetime({ offset: true }),
  tuple: ciTupleSchema,
  currentPhase: z.enum([
    'admission', 'validation', 'review', 'merge', 'deploy', 'continuous-verification', 'complete',
  ]),
  lanes: z.array(ciLaneStateSchema),
  nextTransition: redactText(z.string().min(1).max(160)),
  agentView: z.object({
    schema: z.literal('example.ci-agent-view.v2'),
    revision: z.number().int().nonnegative(),
    stateDigest: digestSchema,
    summary: redactText(z.string().min(1).max(500)),
    blockingLaneIds: z.array(redactedIdentifierSchema),
    nextActionCode: transitionActionCodeSchema,
  }).strict(),
  stateArtifactUrl: redactedGithubRunUrlSchema,
  pullRequestUrl: redactedUrlSchema,
}).strict().superRefine((state, context) => {
  const expectedPullRequestUrl = `https://github.com/example-org/example-app/pull/${state.tuple.pullRequest}`;
  if (state.pullRequestUrl !== expectedPullRequestUrl) {
    context.addIssue({
      code: 'custom',
      message: 'Pull request URL must identify the tuple pull request in example-org/example-app',
      path: ['pullRequestUrl'],
    });
  }
  const ids = state.lanes.map((lane) => lane.laneId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', message: 'Lane IDs must be unique', path: ['lanes'] });
  }
  const contractLanes = new Map(workflowContractRegistry.lanes.map((lane) => [lane.id, lane]));
  const expectedLaneIds = [...contractLanes.keys()].sort();
  const actualLaneIds = [...new Set(ids)].sort();
  if (JSON.stringify(actualLaneIds) !== JSON.stringify(expectedLaneIds)) {
    context.addIssue({
      code: 'custom',
      message: 'State lanes must exactly cover the pinned registry',
      path: ['lanes'],
    });
  }
  const jobs = new Map(workflowContractRegistry.workflows.flatMap((workflow) => (
    workflow.jobs.map((job) => [`${workflow.path}:${job.id}`, job] as const)
  )));
  for (const [index, lane] of state.lanes.entries()) {
    const contractLane = contractLanes.get(lane.laneId);
    const contractJob = contractLane
      ? jobs.get(`${contractLane.workflowPath}:${contractLane.jobId}`)
      : undefined;
    if (!contractLane || !contractJob) {
      context.addIssue({ code: 'custom', message: 'State lane is absent from the pinned registry', path: ['lanes', index] });
    } else {
      if (lane.displayName !== contractJob.displayName) {
        context.addIssue({ code: 'custom', message: 'Lane name differs from the pinned registry', path: ['lanes', index, 'displayName'] });
      }
      if (lane.purpose !== contractJob.purpose) {
        context.addIssue({ code: 'custom', message: 'Lane purpose differs from the pinned registry', path: ['lanes', index, 'purpose'] });
      }
      if (JSON.stringify(lane.progressVocabulary) !== JSON.stringify(contractJob.progressVocabulary)
          || lane.successMeaning !== contractJob.successMeaning
          || lane.failureOwner !== contractJob.failureOwner
          || lane.nextAction !== contractJob.nextAction) {
        context.addIssue({ code: 'custom', message: 'Lane UI semantics differ from the pinned registry', path: ['lanes', index] });
      }
      if (JSON.stringify([...lane.dependencies].sort())
          !== JSON.stringify([...contractLane.dependencies].sort())) {
        context.addIssue({ code: 'custom', message: 'Lane dependencies differ from the pinned registry', path: ['lanes', index, 'dependencies'] });
      }
      if (lane.runner.requirement !== contractLane.runnerClass) {
        context.addIssue({ code: 'custom', message: 'Lane runner requirement differs from the pinned registry', path: ['lanes', index, 'runner', 'requirement'] });
      }
      if (lane.costClass !== contractLane.costClass) {
        context.addIssue({ code: 'custom', message: 'Lane cost class differs from the pinned registry', path: ['lanes', index, 'costClass'] });
      }
      if (lane.evidence.policy !== contractLane.evidencePolicy) {
        context.addIssue({ code: 'custom', message: 'Lane evidence policy differs from the pinned registry', path: ['lanes', index, 'evidence', 'policy'] });
      }
    }
    if (lane.phase === 'queued' && (!lane.runner.queueReasonCode || !lane.runner.queueReason)) {
      context.addIssue({ code: 'custom', message: 'Queued lanes require typed and human queue reasons', path: ['lanes', index, 'runner'] });
    }
    if (lane.phase !== 'queued' && (lane.runner.queueReasonCode || lane.runner.queueReason)) {
      context.addIssue({ code: 'custom', message: 'Only queued lanes may carry queue reasons', path: ['lanes', index, 'runner'] });
    }
    const phasesByDecision = {
      execute: ['planned', 'queued', 'running', 'passed', 'failed', 'cancelled'],
      skip: ['skipped'],
      reuse: ['reused'],
    } as const;
    if (!(phasesByDecision[lane.decision] as readonly string[]).includes(lane.phase)) {
      context.addIssue({ code: 'custom', message: 'Lane decision and lifecycle phase are incompatible', path: ['lanes', index] });
    }
    const expectedSelectionReason = lane.decision === 'skip'
      ? 'not-selected' : lane.decision === 'reuse' ? 'prior-evidence-reused' : undefined;
    if ((expectedSelectionReason && lane.reasonCode !== expectedSelectionReason)
        || (!expectedSelectionReason && ['not-selected', 'prior-evidence-reused'].includes(lane.reasonCode))) {
      context.addIssue({ code: 'custom', message: 'Lane decision and selection reason are incompatible', path: ['lanes', index, 'reasonCode'] });
    }
    if (lane.decision === 'reuse' && lane.evidence.source !== 'prior-tuple') {
      context.addIssue({ code: 'custom', message: 'Reused lanes require prior-tuple provenance', path: ['lanes', index, 'evidence'] });
    }
    if (lane.decision === 'skip' && lane.evidence.source !== 'none') {
      context.addIssue({ code: 'custom', message: 'Skipped lanes cannot claim execution evidence', path: ['lanes', index, 'evidence'] });
    }
    if (lane.decision === 'execute') {
      const expectedEvidenceSource = lane.phase === 'passed' ? 'current-execution' : 'none';
      if (lane.evidence.source !== expectedEvidenceSource) {
        context.addIssue({ code: 'custom', message: 'Executed lane evidence must agree with its lifecycle phase', path: ['lanes', index, 'evidence'] });
      }
    }
    if ((lane.phase === 'passed' || lane.phase === 'reused') && lane.evidence.source === 'none') {
      context.addIssue({ code: 'custom', message: 'Successful lanes require identified evidence', path: ['lanes', index, 'evidence'] });
    }
    const blockingPhase = ['queued', 'failed', 'cancelled'].includes(lane.phase);
    const automationRetryInFlight = lane.phase === 'running' && lane.retryCauseCode !== undefined;
    if ((blockingPhase || automationRetryInFlight) === (lane.blockerOwner === 'none')) {
      context.addIssue({ code: 'custom', message: 'Lane blocker owner must agree with its blocking lifecycle phase', path: ['lanes', index, 'blockerOwner'] });
    }
    if (lane.retryCauseCode !== undefined
        && (lane.decision !== 'execute' || !['queued', 'running'].includes(lane.phase) || lane.blockerOwner !== 'automation')) {
      context.addIssue({ code: 'custom', message: 'Retry cause requires automation-owned queued or running execution', path: ['lanes', index, 'retryCauseCode'] });
    }
    if (lane.phase === 'cancelled') {
      if (!lane.cancellationCauseCode || lane.blockerOwner !== 'automation') {
        context.addIssue({ code: 'custom', message: 'Cancelled execution requires an automation-owned cancellation cause', path: ['lanes', index, 'cancellationCauseCode'] });
      }
    } else if (lane.cancellationCauseCode || lane.supersededByRunUrl) {
      context.addIssue({ code: 'custom', message: 'Only cancelled execution may carry cancellation or supersession data', path: ['lanes', index] });
    }
    if ((lane.cancellationCauseCode === 'superseded-lane') !== (lane.supersededByRunUrl !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Superseded cancellation requires its replacement run and vice versa', path: ['lanes', index] });
    }
    if (lane.evidence.source !== 'none') {
      const evidence = lane.evidence;
      if (evidence.sourceLaneId !== lane.laneId) {
        context.addIssue({ code: 'custom', message: 'Evidence lane must match the state lane', path: ['lanes', index, 'evidence', 'sourceLaneId'] });
      }
      if (evidence.sourcePlanVersion !== state.tuple.planVersion
          || evidence.sourceRegistryDigest !== state.tuple.registryDigest) {
        context.addIssue({ code: 'custom', message: 'Evidence contract must match the pinned tuple contract', path: ['lanes', index, 'evidence'] });
      }
      const exactHead = evidence.sourceHeadSha === state.tuple.headSha
        && evidence.sourceBaseSha === state.tuple.baseSha
        && evidence.sourcePatchDigest === state.tuple.patchDigest;
      if (evidence.source === 'current-execution' && !exactHead) {
        context.addIssue({ code: 'custom', message: 'Current execution evidence must match the exact tuple', path: ['lanes', index, 'evidence'] });
      }
      if (evidence.policy === 'exact-head' && !exactHead) {
        context.addIssue({ code: 'custom', message: 'Exact-head evidence must match head, base, and patch', path: ['lanes', index, 'evidence'] });
      }
      if (evidence.policy === 'patch-equivalent'
          && evidence.sourcePatchDigest !== state.tuple.patchDigest) {
        context.addIssue({ code: 'custom', message: 'Patch-equivalent evidence must match the tuple patch', path: ['lanes', index, 'evidence'] });
      }
      if (evidence.evidenceDigest !== computeEvidenceDigest(evidence)) {
        context.addIssue({ code: 'custom', message: 'Evidence digest does not match its provenance fields', path: ['lanes', index, 'evidence', 'evidenceDigest'] });
      }
    }
  }
  const laneIds = new Set(ids);
  for (const [index, laneId] of state.agentView.blockingLaneIds.entries()) {
    if (!laneIds.has(laneId)) {
      context.addIssue({ code: 'custom', message: 'Agent blockers must reference lanes in this state document', path: ['agentView', 'blockingLaneIds', index] });
    }
  }
  const expectedBlockingLaneIds = state.lanes
    .filter((lane) => ['queued', 'failed', 'cancelled'].includes(lane.phase))
    .map((lane) => lane.laneId)
    .sort();
  if (JSON.stringify([...state.agentView.blockingLaneIds].sort()) !== JSON.stringify(expectedBlockingLaneIds)) {
    context.addIssue({ code: 'custom', message: 'Agent blockers must exactly match blocking lane lifecycle state', path: ['agentView', 'blockingLaneIds'] });
  }
  const allLanesComplete = state.lanes.every((lane) => ['passed', 'skipped', 'reused'].includes(lane.phase));
  if ((state.currentPhase === 'complete') !== allLanesComplete) {
    context.addIssue({ code: 'custom', message: 'Pipeline phase is complete if and only if every lane has a nonblocking outcome', path: ['currentPhase'] });
  }
  const expectedNextActionCode = state.lanes.some((lane) => lane.phase === 'failed')
    ? 'inspect-failure'
    : state.lanes.some((lane) => lane.phase === 'cancelled')
      ? 'retry-deterministically'
      : state.lanes.some((lane) => lane.phase === 'queued'
        && ['waiting-for-ios-xcode-runner', 'waiting-for-linux-runner'].includes(lane.runner.queueReasonCode ?? ''))
        ? 'wait-for-runner-lease'
        : state.lanes.some((lane) => lane.phase === 'queued')
          ? 'wait-for-dependency'
          : state.currentPhase === 'complete' || state.lanes.some((lane) => ['planned', 'running'].includes(lane.phase))
            ? 'no-action'
            : 'continue-pipeline';
  if (state.agentView.nextActionCode !== expectedNextActionCode) {
    context.addIssue({ code: 'custom', message: 'Agent next action must agree with blocking lane state', path: ['agentView', 'nextActionCode'] });
  }
  if (state.tuple.registryDigest !== workflowContractRegistry.registryDigest) {
    context.addIssue({ code: 'custom', message: 'Tuple registry digest is not available in this controller', path: ['tuple', 'registryDigest'] });
  }
  if (state.agentView.stateDigest !== computeStateDigest(state)) {
    context.addIssue({ code: 'custom', message: 'Agent state digest does not match canonical state content', path: ['agentView', 'stateDigest'] });
  }
});
export type CiStateDocument = z.infer<typeof ciStateDocumentSchema>;

export function computeStateDigest(state: unknown): string {
  return createHash('sha256').update(canonicalJson(state, new Set(['stateDigest']))).digest('hex');
}

export const agentSurfaceStateSchema = z.enum([
  'queued', 'running', 'skipped', 'failed', 'cancelled', 'superseded', 'successful',
]);
export type AgentSurfaceState = z.infer<typeof agentSurfaceStateSchema>;

const permittedAgentActionSchema = z.enum([
  'wait-for-dependency',
  'wait-for-runner-lease',
  'inspect-failure',
  'retry-deterministically',
  'continue-pipeline',
  'cancel-obsolete-work',
  'no-action',
]);

const agentStatusReasonCodeSchema = z.enum([
  'waiting-for-dependency',
  'waiting-for-runner',
  'work-in-progress',
  'not-selected',
  'check-failed',
  'cancelled-duplicate',
  'cancelled-obsolete',
  'cancelled-superseded',
  'superseded-by-current',
  'completed-successfully',
]);

type PermittedAgentAction = z.infer<typeof permittedAgentActionSchema>;
type AgentStatusReasonCode = z.infer<typeof agentStatusReasonCodeSchema>;
type CancellationCauseCode = z.infer<typeof cancellationCauseCodeSchema>;

const permittedActionsByState: Record<AgentSurfaceState, readonly PermittedAgentAction[]> = {
  queued: ['wait-for-dependency', 'wait-for-runner-lease', 'cancel-obsolete-work'],
  running: ['no-action', 'cancel-obsolete-work'],
  skipped: ['continue-pipeline', 'no-action'],
  failed: ['inspect-failure', 'retry-deterministically'],
  cancelled: ['retry-deterministically', 'no-action'],
  superseded: ['no-action'],
  successful: ['continue-pipeline', 'no-action'],
};
const reasonCodesByState: Record<AgentSurfaceState, readonly AgentStatusReasonCode[]> = {
  queued: ['waiting-for-dependency', 'waiting-for-runner'],
  running: ['work-in-progress'],
  skipped: ['not-selected'],
  failed: ['check-failed'],
  cancelled: ['cancelled-duplicate', 'cancelled-obsolete', 'cancelled-superseded'],
  superseded: ['superseded-by-current'],
  successful: ['completed-successfully'],
};
const permittedActionsByReason: Record<AgentStatusReasonCode, readonly PermittedAgentAction[]> = {
  'waiting-for-dependency': ['wait-for-dependency', 'cancel-obsolete-work'],
  'waiting-for-runner': ['wait-for-runner-lease', 'cancel-obsolete-work'],
  'work-in-progress': ['no-action', 'cancel-obsolete-work'],
  'not-selected': ['continue-pipeline', 'no-action'],
  'check-failed': ['inspect-failure', 'retry-deterministically'],
  'cancelled-duplicate': ['retry-deterministically', 'no-action'],
  'cancelled-obsolete': ['retry-deterministically', 'no-action'],
  'cancelled-superseded': ['retry-deterministically', 'no-action'],
  'superseded-by-current': ['no-action'],
  'completed-successfully': ['continue-pipeline', 'no-action'],
};
const cancellationCauseByReason: Partial<Record<AgentStatusReasonCode, CancellationCauseCode>> = {
  'cancelled-duplicate': 'duplicate-tuple',
  'cancelled-obsolete': 'obsolete-tuple',
  'cancelled-superseded': 'superseded-lane',
};

const timestampSchema = z.string().datetime({ offset: true });
const surfaceIdentitySchema = z.object({
  surfaceId: redactedSurfaceIdentifierSchema,
  kind: z.enum(['workflow', 'job', 'step']),
  workflowPath: z.string().regex(/^\.github\/workflows\/[^/]+\.ya?ml$/),
  jobId: redactedIdentifierSchema.optional(),
  stepId: redactedIdentifierSchema.optional(),
}).strict();

export const ciAgentSurfaceStatusSchema = z.object({
  identity: surfaceIdentitySchema,
  displayName: z.union([humanReadableNameSchema, requiredCheckContextSchema]),
  purpose: z.string().min(10).max(240),
  progressVocabulary: z.array(z.enum(['queued', 'running', 'retrying', 'completed'])).min(3),
  successMeaning: z.string().min(10).max(240),
  failureOwner: z.enum(['automation', 'product', 'security', 'iam', 'review', 'infrastructure']),
  nextAction: z.string().min(10).max(240),
  state: agentSurfaceStateSchema,
  reasonCode: agentStatusReasonCodeSchema,
  currentAction: redactText(z.string().min(1).max(160)).optional(),
  waitReason: redactText(z.string().min(1).max(160)).optional(),
  outcome: z.enum(['passed', 'failed', 'skipped', 'cancelled', 'superseded']).optional(),
  timestamps: z.object({
    observedAt: timestampSchema,
    queuedAt: timestampSchema.optional(),
    startedAt: timestampSchema.optional(),
    finishedAt: timestampSchema.optional(),
    durationSeconds: z.number().nonnegative().optional(),
  }).strict(),
  runnerClass: runnerClassSchema,
  costClass: costClassSchema,
  estimatedDurationSeconds: z.number().positive().max(86_400).optional(),
  assignedRunner: redactText(z.string().min(1).max(120)).optional(),
  dependencies: z.array(z.object({
    surfaceId: redactedSurfaceIdentifierSchema,
    state: agentSurfaceStateSchema,
  }).strict()).max(50),
  evidence: z.array(z.object({
    kind: z.enum(['artifact', 'check', 'log', 'state']),
    identifier: redactText(z.string().min(1).max(160)),
    url: redactedUrlSchema.optional(),
    digest: digestSchema.optional(),
  }).strict()).max(10),
  retry: z.object({
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive().max(3),
    causeCode: retryCauseCodeSchema.optional(),
  }).strict(),
  cancellationCauseCode: cancellationCauseCodeSchema.optional(),
  supersession: z.object({
    supersededBySurfaceId: redactedSurfaceIdentifierSchema.optional(),
    supersededByRunUrl: redactedGithubRunUrlSchema.optional(),
  }).strict(),
  permittedNextActions: z.array(permittedAgentActionSchema).min(1).max(4),
  humanSummary: redactText(z.string().min(10).max(240)),
}).strict().superRefine((status, context) => {
  const workflow = workflowContractRegistry.workflows.find((entry) => entry.path === status.identity.workflowPath);
  const job = workflow?.jobs.find((entry) => entry.id === status.identity.jobId);
  const step = job?.steps.find((entry) => entry.id === status.identity.stepId);
  const contract = status.identity.kind === 'workflow' ? workflow : status.identity.kind === 'job' ? job : step;
  if (!contract) {
    context.addIssue({ code: 'custom', message: 'Agent status identity is absent from the pinned registry', path: ['identity'] });
    return;
  }
  if ((status.identity.kind === 'workflow' && (status.identity.jobId || status.identity.stepId))
      || (status.identity.kind === 'job' && (!status.identity.jobId || status.identity.stepId))
      || (status.identity.kind === 'step' && (!status.identity.jobId || !status.identity.stepId))) {
    context.addIssue({ code: 'custom', message: 'Agent status identity fields do not match its surface kind', path: ['identity'] });
  }
  const expectedSurfaceId = status.identity.kind === 'workflow'
    ? status.identity.workflowPath
    : status.identity.kind === 'job'
      ? `${status.identity.workflowPath}:${status.identity.jobId}`
      : `${status.identity.workflowPath}:${status.identity.jobId}:${status.identity.stepId}`;
  if (status.identity.surfaceId !== expectedSurfaceId) {
    context.addIssue({ code: 'custom', message: 'Agent status surface ID is not canonical for its registry identity', path: ['identity', 'surfaceId'] });
  }
  if (status.displayName !== contract.displayName
      || status.purpose !== contract.purpose
      || JSON.stringify(status.progressVocabulary) !== JSON.stringify(contract.progressVocabulary)
      || status.successMeaning !== contract.successMeaning
      || status.failureOwner !== contract.failureOwner
      || status.nextAction !== contract.nextAction) {
    context.addIssue({ code: 'custom', message: 'Agent status UI semantics differ from the pinned registry', path: ['displayName'] });
  }
  const lane = status.identity.jobId
    ? workflowContractRegistry.lanes.find((entry) => (
      entry.workflowPath === status.identity.workflowPath && entry.jobId === status.identity.jobId
    ))
    : undefined;
  if (lane && (status.runnerClass !== lane.runnerClass || status.costClass !== lane.costClass)) {
    context.addIssue({ code: 'custom', message: 'Agent status runner or cost differs from the pinned registry', path: ['runnerClass'] });
  }
  if (lane?.id === 'ios.native-shards' && status.estimatedDurationSeconds === undefined) {
    context.addIssue({ code: 'custom', message: 'Native shard status requires a measured duration estimate', path: ['estimatedDurationSeconds'] });
  }
  if (lane) {
    const expectedDependencies = lane.dependencies.map((dependency) => `${lane.workflowPath}:${dependency}`).sort();
    const actualDependencies = status.dependencies.map((dependency) => dependency.surfaceId).sort();
    if (JSON.stringify(expectedDependencies) !== JSON.stringify(actualDependencies)) {
      context.addIssue({ code: 'custom', message: 'Agent status dependencies differ from the pinned registry', path: ['dependencies'] });
    }
  } else if (status.dependencies.length > 0) {
    context.addIssue({ code: 'custom', message: 'Workflow status cannot invent job-level dependencies', path: ['dependencies'] });
  }
  if (status.state === 'queued' && (!status.timestamps.queuedAt || !status.waitReason)) {
    context.addIssue({ code: 'custom', message: 'Queued status requires a timestamp and wait reason', path: ['timestamps'] });
  }
  if (status.state === 'running' && (!status.timestamps.startedAt || !status.currentAction)) {
    context.addIssue({ code: 'custom', message: 'Running status requires a start timestamp and current action', path: ['timestamps'] });
  }
  if (status.state !== 'queued' && status.waitReason !== undefined) {
    context.addIssue({ code: 'custom', message: 'Only queued status may carry a wait reason', path: ['waitReason'] });
  }
  if (status.state !== 'running' && status.currentAction !== undefined) {
    context.addIssue({ code: 'custom', message: 'Only running status may carry a current action', path: ['currentAction'] });
  }
  const terminal = ['skipped', 'failed', 'cancelled', 'superseded', 'successful'].includes(status.state);
  if (terminal && (!status.timestamps.finishedAt || status.timestamps.durationSeconds === undefined || !status.outcome)) {
    context.addIssue({ code: 'custom', message: 'Terminal status requires outcome, finish time, and duration', path: ['timestamps'] });
  }
  const expectedOutcome = {
    skipped: 'skipped', failed: 'failed', cancelled: 'cancelled',
    superseded: 'superseded', successful: 'passed',
  } as const;
  if (terminal && status.outcome !== expectedOutcome[status.state as keyof typeof expectedOutcome]) {
    context.addIssue({ code: 'custom', message: 'Terminal outcome is inconsistent with surface state', path: ['outcome'] });
  }
  if (!terminal && (status.outcome || status.timestamps.finishedAt || status.timestamps.durationSeconds !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Nonterminal status cannot claim a terminal outcome or duration', path: ['timestamps'] });
  }
  const observed = Date.parse(status.timestamps.observedAt);
  const queued = status.timestamps.queuedAt ? Date.parse(status.timestamps.queuedAt) : undefined;
  const started = status.timestamps.startedAt ? Date.parse(status.timestamps.startedAt) : undefined;
  const finished = status.timestamps.finishedAt ? Date.parse(status.timestamps.finishedAt) : undefined;
  if ((queued !== undefined && queued > observed) || (started !== undefined && started > observed)
      || (finished !== undefined && finished > observed) || (queued !== undefined && started !== undefined && queued > started)
      || (queued !== undefined && finished !== undefined && queued > finished)
      || (started !== undefined && finished !== undefined && started > finished)) {
    context.addIssue({ code: 'custom', message: 'Status timestamps are not chronological', path: ['timestamps'] });
  }
  if (status.timestamps.durationSeconds !== undefined) {
    if (status.timestamps.durationSeconds > 86_400) {
      context.addIssue({ code: 'custom', message: 'Status duration exceeds the one-day contract bound', path: ['timestamps', 'durationSeconds'] });
    }
    if (started === undefined) {
      if (finished === undefined || status.timestamps.durationSeconds !== 0) {
        context.addIssue({ code: 'custom', message: 'Duration for a step that never started must be zero', path: ['timestamps', 'durationSeconds'] });
      }
    } else if (finished === undefined
        || Math.abs((finished - started) / 1000 - status.timestamps.durationSeconds) > 1) {
      context.addIssue({ code: 'custom', message: 'Status duration must match start and finish timestamps', path: ['timestamps', 'durationSeconds'] });
    }
  }
  const hasSupersession = status.supersession.supersededBySurfaceId !== undefined
    || status.supersession.supersededByRunUrl !== undefined;
  if (status.state === 'superseded') {
    if (!status.supersession.supersededBySurfaceId || !status.supersession.supersededByRunUrl) {
      context.addIssue({ code: 'custom', message: 'Superseded status requires replacement identity and run', path: ['supersession'] });
    }
  } else if (hasSupersession) {
    context.addIssue({ code: 'custom', message: 'Only superseded status may carry replacement identity or run', path: ['supersession'] });
  }
  if ((status.state === 'successful' || status.state === 'failed') && status.evidence.length === 0) {
    context.addIssue({ code: 'custom', message: 'Successful and failed status requires bounded evidence', path: ['evidence'] });
  }
  if (status.retry.attempt > status.retry.maxAttempts) {
    context.addIssue({ code: 'custom', message: 'Retry attempt exceeds its declared bound', path: ['retry', 'attempt'] });
  }
  if ((status.retry.attempt === 1) === (status.retry.causeCode !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Retry cause is required after the first attempt and forbidden on the first attempt', path: ['retry', 'causeCode'] });
  }
  if ((status.state === 'cancelled') !== (status.cancellationCauseCode !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Cancellation cause is required only for cancelled status', path: ['cancellationCauseCode'] });
  }
  const expectedCancellationCause = cancellationCauseByReason[status.reasonCode];
  if (expectedCancellationCause !== undefined && status.cancellationCauseCode !== expectedCancellationCause) {
    context.addIssue({
      code: 'custom',
      message: 'Cancellation reason and cause are inconsistent',
      path: ['cancellationCauseCode'],
    });
  }
  if (status.permittedNextActions.some((action) => !permittedActionsByState[status.state].includes(action))) {
    context.addIssue({ code: 'custom', message: 'Next action is not permitted for the current state', path: ['permittedNextActions'] });
  }
  if (status.permittedNextActions.some((action) => !permittedActionsByReason[status.reasonCode].includes(action))) {
    context.addIssue({
      code: 'custom',
      message: 'Next action is not permitted for the current reason',
      path: ['permittedNextActions'],
    });
  }
  if (!reasonCodesByState[status.state].includes(status.reasonCode)) {
    context.addIssue({ code: 'custom', message: 'Reason code is inconsistent with the current state', path: ['reasonCode'] });
  }
  if (status.humanSummary !== renderAgentHumanSummary(status)) {
    context.addIssue({ code: 'custom', message: 'Human summary must be generated from typed status fields', path: ['humanSummary'] });
  }
});
export type CiAgentSurfaceStatus = z.infer<typeof ciAgentSurfaceStatusSchema>;

export function renderAgentHumanSummary(status: {
  displayName: string;
  state: AgentSurfaceState;
  currentAction?: string;
  waitReason?: string;
  outcome?: string;
  failureOwner: 'automation' | 'product' | 'security' | 'iam' | 'review' | 'infrastructure';
  estimatedDurationSeconds?: number;
  permittedNextActions: readonly PermittedAgentAction[];
}): string {
  const ownerNames = {
    automation: 'Automation',
    product: 'Product',
    security: 'Security',
    iam: 'IAM',
    review: 'Review',
    infrastructure: 'Infrastructure',
  } as const;
  const actionDescriptions: Record<PermittedAgentAction, string> = {
    'wait-for-dependency': 'wait for the declared dependency',
    'wait-for-runner-lease': 'wait for an eligible runner lease',
    'inspect-failure': 'inspect the failure evidence',
    'retry-deterministically': 'retry the bounded operation deterministically',
    'continue-pipeline': 'continue the pipeline',
    'cancel-obsolete-work': 'cancel obsolete work',
    'no-action': 'take no action',
  };
  const next = actionDescriptions[status.permittedNextActions[0] ?? 'no-action'];
  const prefix = status.state === 'queued'
    ? `${status.displayName} is queued: `
    : status.state === 'running'
      ? `${status.displayName} is running: `
      : `${status.displayName} finished: `;
  const detail = status.state === 'queued'
    ? status.waitReason ?? 'waiting reason unavailable'
    : status.state === 'running'
      ? status.currentAction ?? 'current action unavailable'
      : `outcome ${status.outcome ?? status.state}`;
  const estimate = status.estimatedDurationSeconds === undefined
    ? '' : ` Estimate: ${Math.round(status.estimatedDurationSeconds)}s.`;
  const suffix = `${estimate} Owner: ${ownerNames[status.failureOwner]}. Next: ${next}.`;
  return `${prefix}${detail.slice(0, Math.max(0, 240 - prefix.length - suffix.length))}${suffix}`;
}

export const ciAgentStatusDocumentSchema = z.object({
  schema: z.literal('example.ci-agent-status.v3'),
  tuple: ciTupleSchema,
  registryDigest: registryDigestSchema,
  revision: z.number().int().nonnegative(),
  generatedAt: timestampSchema,
  redaction: z.literal('secrets-removed'),
  statuses: z.array(ciAgentSurfaceStatusSchema).min(1).max(100),
  statusDigest: digestSchema,
}).strict().superRefine((document, context) => {
  if (document.registryDigest !== document.tuple.registryDigest
      || document.registryDigest !== workflowContractRegistry.registryDigest) {
    context.addIssue({ code: 'custom', message: 'Agent status registry identity is unavailable', path: ['registryDigest'] });
  }
  if (document.statusDigest !== computeAgentStatusDigest(document)) {
    context.addIssue({ code: 'custom', message: 'Agent status digest does not match canonical content', path: ['statusDigest'] });
  }
  const surfaceIds = document.statuses.map((status) => status.identity.surfaceId);
  if (new Set(surfaceIds).size !== surfaceIds.length) {
    context.addIssue({ code: 'custom', message: 'Agent status surface identities must be unique', path: ['statuses'] });
  }
  const statusBySurfaceId = new Map(document.statuses.map((status) => [status.identity.surfaceId, status]));
  for (const [statusIndex, status] of document.statuses.entries()) {
    for (const [dependencyIndex, dependency] of status.dependencies.entries()) {
      const dependencyStatus = statusBySurfaceId.get(dependency.surfaceId);
      if (dependencyStatus && dependencyStatus.state !== dependency.state) {
        context.addIssue({
          code: 'custom',
          message: 'Embedded dependency state does not match its surface status',
          path: ['statuses', statusIndex, 'dependencies', dependencyIndex, 'state'],
        });
      }
    }
  }
});
export type CiAgentStatusDocument = z.infer<typeof ciAgentStatusDocumentSchema>;

export function computeAgentStatusDigest(document: unknown): string {
  return createHash('sha256').update(canonicalJson(document, new Set(['statusDigest']))).digest('hex');
}

export const ciFleetStatusPageSchema = z.object({
  schema: z.literal('example.ci-fleet-status-page.v1'),
  generatedAt: timestampSchema,
  redaction: z.literal('secrets-removed'),
  pageSize: z.number().int().min(1).max(100),
  nextCursor: redactText(z.string().min(1).max(256)).optional(),
  items: z.array(z.object({
    tuple: ciTupleSchema,
    revision: z.number().int().nonnegative(),
    statusDigest: digestSchema,
    aggregate: z.record(agentSurfaceStateSchema, z.number().int().nonnegative()),
  }).strict()).max(100),
}).strict().superRefine((page, context) => {
  if (page.items.length > page.pageSize) {
    context.addIssue({ code: 'custom', message: 'Fleet page exceeds its declared page size', path: ['items'] });
  }
  for (const [index, item] of page.items.entries()) {
    const count = Object.values(item.aggregate).reduce((sum, value) => sum + (value ?? 0), 0);
    if (count === 0) context.addIssue({ code: 'custom', message: 'Fleet aggregate must describe at least one surface', path: ['items', index, 'aggregate'] });
  }
});

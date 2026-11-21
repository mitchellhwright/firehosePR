import { normalizeReview } from '../actions/reviewOnboardingVideo.ts';

const REPOSITORY = 'example-org/example-app';
const WORKFLOW = '.github/workflows/trusted-production-onboarding-e2e.yml';
const MAX_BYTES = 2_000_000;

interface GitHubVideoRun {
  readonly id: number;
  readonly run_attempt: number;
  readonly repository: { readonly full_name: string };
  readonly head_repository: { readonly full_name: string };
  readonly path: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly status: string;
  readonly event: string;
}

interface GitHubVideoArtifact {
  readonly id: number;
  readonly expired: boolean;
  readonly name: string;
  readonly digest: string;
  readonly workflow_run: { readonly id: number; readonly head_sha: string };
}

interface ProtectedMainRevision {
  readonly ref: string;
  readonly sha: string;
}

export interface VideoProducerMetadataInput {
  readonly run: unknown;
  readonly artifact: unknown;
  readonly mainRevision: unknown;
}

export interface VideoReviewArtifactInput extends VideoProducerMetadataInput {
  readonly json: unknown;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function nestedRecord(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  return record(value?.[key]);
}

function parseRun(value: unknown): GitHubVideoRun | undefined {
  const run = record(value);
  const repository = nestedRecord(run, 'repository');
  const headRepository = nestedRecord(run, 'head_repository');
  if (run === undefined || repository === undefined || headRepository === undefined) return undefined;
  const id = run['id'];
  const runAttempt = run['run_attempt'];
  const repositoryName = repository['full_name'];
  const headRepositoryName = headRepository['full_name'];
  const path = run['path'];
  const headBranch = run['head_branch'];
  const headSha = run['head_sha'];
  const status = run['status'];
  const event = run['event'];
  if (!Number.isSafeInteger(id) || typeof id !== 'number' || id <= 0
    || !Number.isSafeInteger(runAttempt) || typeof runAttempt !== 'number' || runAttempt <= 0
    || typeof repositoryName !== 'string' || typeof headRepositoryName !== 'string'
    || typeof path !== 'string' || typeof headBranch !== 'string' || typeof headSha !== 'string'
    || typeof status !== 'string' || typeof event !== 'string') return undefined;
  return {
    id,
    run_attempt: runAttempt,
    repository: { full_name: repositoryName },
    head_repository: { full_name: headRepositoryName },
    path,
    head_branch: headBranch,
    head_sha: headSha,
    status,
    event,
  };
}

function parseArtifact(value: unknown): GitHubVideoArtifact | undefined {
  const artifact = record(value);
  const workflowRun = nestedRecord(artifact, 'workflow_run');
  if (artifact === undefined || workflowRun === undefined) return undefined;
  const id = artifact['id'];
  const expired = artifact['expired'];
  const name = artifact['name'];
  const digest = artifact['digest'];
  const workflowRunId = workflowRun['id'];
  const headSha = workflowRun['head_sha'];
  if (!Number.isSafeInteger(id) || typeof id !== 'number' || id <= 0
    || typeof expired !== 'boolean' || typeof name !== 'string' || typeof digest !== 'string'
    || !Number.isSafeInteger(workflowRunId) || typeof workflowRunId !== 'number'
    || typeof headSha !== 'string') return undefined;
  return {
    id,
    expired,
    name,
    digest,
    workflow_run: { id: workflowRunId, head_sha: headSha },
  };
}

function parseMainRevision(value: unknown): ProtectedMainRevision | undefined {
  const revision = record(value);
  const ref = revision?.['ref'];
  const sha = revision?.['sha'];
  return typeof ref === 'string' && typeof sha === 'string' ? { ref, sha } : undefined;
}

export function validateVideoProducerMetadata(input: VideoProducerMetadataInput): {
  readonly run: GitHubVideoRun;
  readonly artifact: GitHubVideoArtifact;
  readonly mainRevision: ProtectedMainRevision;
} {
  const rawRun = record(input.run);
  const rawHeadSha = rawRun?.['head_sha'];
  const run = parseRun(input.run);
  const artifact = parseArtifact(input.artifact);
  const mainRevision = parseMainRevision(input.mainRevision);
  if (mainRevision === undefined || mainRevision.ref !== 'refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(mainRevision.sha) || mainRevision.sha !== rawHeadSha) {
    throw new Error('Verified protected main revision required');
  }
  if (run === undefined || run.repository.full_name !== REPOSITORY
    || run.head_repository.full_name !== REPOSITORY || run.path !== WORKFLOW
    || run.head_branch !== 'main' || run.status !== 'completed'
    || !['push', 'workflow_dispatch'].includes(run.event)
    || !/^[a-f0-9]{40}$/.test(run.head_sha)) {
    throw new Error('Untrusted video producer run');
  }
  if (artifact === undefined || artifact.expired !== false
    || artifact.name !== `production-onboarding-video-review-${run.id}-${run.run_attempt}`
    || artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
    throw new Error('Untrusted video review artifact metadata');
  }
  return { run, artifact, mainRevision };
}

export function validateVideoReviewArtifact(input: VideoReviewArtifactInput): {
  readonly runId: string;
  readonly runAttempt: string;
  readonly commitSha: string;
  readonly artifactId: number;
  readonly artifactDigest: string;
  readonly context: {
    readonly selectedFrameCount: number;
    readonly xcodebuildEvidenceTimeline: string;
  };
  readonly reviews: readonly ReturnType<typeof normalizeReview>[];
} {
  const { run, artifact } = validateVideoProducerMetadata(input);
  if (typeof input.json !== 'string' || Buffer.byteLength(input.json, 'utf8') > MAX_BYTES) {
    throw new Error('Invalid video review artifact size');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.json);
  } catch {
    throw new Error('Invalid video review artifact JSON');
  }
  const payloadRecord = record(payload);
  const context = nestedRecord(payloadRecord, 'context');
  const reviews = payloadRecord?.['reviews'];
  const selectedFrameCount = context?.['selectedFrameCount'];
  const timeline = context?.['xcodebuildEvidenceTimeline'];
  if (context === undefined || context['repository'] !== REPOSITORY
    || context['commitSha'] !== run.head_sha || context['ref'] !== 'refs/heads/main'
    || context['eventName'] !== run.event || context['isProductionE2E'] !== true
    || context['runId'] !== String(run.id) || context['runAttempt'] !== String(run.run_attempt)
    || context['runUrl'] !== `https://github.com/${REPOSITORY}/actions/runs/${run.id}`
    || !Number.isSafeInteger(selectedFrameCount) || typeof selectedFrameCount !== 'number'
    || selectedFrameCount < 1 || selectedFrameCount > 180
    || typeof timeline !== 'string' || timeline.length > 24_000
    || !Array.isArray(reviews) || reviews.length !== 2
    || record(reviews[0])?.['agent'] !== 'QA' || record(reviews[1])?.['agent'] !== 'UX') {
    throw new Error('Video review artifact does not match its producer');
  }
  const evidence = {
    selectedFrameCount,
    xcodebuildEvidenceTimeline: timeline,
  };
  return {
    runId: String(run.id),
    runAttempt: String(run.run_attempt),
    commitSha: run.head_sha,
    artifactId: artifact.id,
    artifactDigest: artifact.digest,
    context: evidence,
    reviews: reviews.map((review, index) => normalizeReview(index === 0 ? 'QA' : 'UX', review, evidence)),
  };
}

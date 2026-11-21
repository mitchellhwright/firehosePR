import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  MERGE_QUEUE_BASE_BRANCH, MERGE_QUEUE_BASE_REF, MERGE_QUEUE_REF_PATTERN,
} from './mergeQueueRef.ts';

/**
 * The events a required validation workflow runs on, and what each of them
 * means as a (head, trusted base) tuple.
 *
 * The workflow expressions in `ci/workflows/lib/ciEvent.ts` and the programs
 * that read the event payload at runtime both take their event list from
 * here and the merge queue branch and queue ref shape from
 * `mergeQueueRef.ts`, so the two layers cannot disagree about which events
 * exist or what a queue candidate looks like.
 */

export const SUPPORTED_CI_EVENTS = ['pull_request', 'merge_group', 'workflow_dispatch'] as const;
export type SupportedCiEvent = typeof SUPPORTED_CI_EVENTS[number];

/**
 * How much of the suites an event must prove. A pull request into the merge
 * queue branch is `pull-request`: its queue candidate runs the complete suites
 * before anything lands, so the head runs the light lanes. Every other event
 * (the queue candidate, a promotion into main, a dispatch) is `complete`.
 */
export const validationDepthSchema = z.enum(['pull-request', 'complete']);
export type ValidationDepth = z.infer<typeof validationDepthSchema>;

/** Unknown or missing event data resolves to `complete`, so a gap never skips a lane. */
export function validationDepth(eventName: string, baseBranch: string): ValidationDepth {
  return eventName === 'pull_request' && baseBranch === MERGE_QUEUE_BASE_BRANCH
    ? 'pull-request'
    : 'complete';
}

const commitSha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character lowercase commit SHA');
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

const mergeGroupPayloadSchema = z.object({
  merge_group: z.object({
    head_sha: commitSha,
    base_sha: commitSha,
    head_ref: z.string().regex(
      MERGE_QUEUE_REF_PATTERN,
      'must be refs/heads/gh-readonly-queue/develop/pr-<number>-<base-sha>',
    ),
    base_ref: z.literal(MERGE_QUEUE_BASE_REF),
  }),
  repository: z.object({ full_name: repositoryName }),
});

const pullRequestPayloadSchema = z.object({
  pull_request: z.object({
    number: z.number().int().positive(),
    draft: z.boolean(),
    head: z.object({
      sha: commitSha,
      ref: z.string().min(1),
      repo: z.object({ full_name: repositoryName }).nullable(),
    }),
    base: z.object({ sha: commitSha, ref: z.string().min(1) }),
  }),
  repository: z.object({ full_name: repositoryName }),
});

export interface PullRequestEventTuple {
  readonly kind: 'pull_request';
  readonly prNumber: string;
  /** The PR head, which is the code a Mac lane builds. */
  readonly headSha: string;
  /** The PR base commit, which reviewed verifier code is checked out from. */
  readonly trustedBaseSha: string;
  readonly baseBranch: string;
  readonly headRepository: string;
  readonly draft: boolean;
}

export interface MergeGroupEventTuple {
  readonly kind: 'merge_group';
  readonly prNumber: string;
  /** `merge_group.head_sha`: the queue candidate under test. */
  readonly headSha: string;
  /** `merge_group.base_sha`: the queue base. Never the candidate. */
  readonly trustedBaseSha: string;
  readonly baseBranch: typeof MERGE_QUEUE_BASE_BRANCH;
  /** The full queue ref, which points at `headSha` while the candidate is live. */
  readonly queueRef: string;
  readonly repository: string;
}

export interface DispatchEventTuple {
  readonly kind: 'workflow_dispatch';
  readonly headSha: string;
}

export type CiEventTuple = PullRequestEventTuple | MergeGroupEventTuple | DispatchEventTuple;

export class CiEventError extends Error {}

function assertNever(value: never): never {
  throw new CiEventError(`Unsupported CI event: ${String(value)}`);
}

export function isSupportedCiEvent(eventName: string): eventName is SupportedCiEvent {
  return (SUPPORTED_CI_EVENTS as readonly string[]).includes(eventName);
}

function parsed<T>(schema: z.ZodType<T>, payload: unknown, eventName: string): T {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(payload)'} ${issue.message}`)
    .join('; ');
  throw new CiEventError(`Invalid ${eventName} payload: ${issues}`);
}

/** The PR number a queue ref names, or an error for any other ref shape. */
export function mergeQueuePullRequestNumber(queueRef: string): string {
  const match = MERGE_QUEUE_REF_PATTERN.exec(queueRef);
  if (match?.[1] === undefined) {
    throw new CiEventError(`Not a develop merge queue ref: ${JSON.stringify(queueRef)}`);
  }
  return match[1];
}

/**
 * The event as a tuple. Every supported event maps explicitly; a new event
 * name fails here until it is given a projection of its own.
 */
export function projectCiEvent(eventName: string, payload: unknown, eventSha: string): CiEventTuple {
  if (!isSupportedCiEvent(eventName)) throw new CiEventError(`Unsupported CI event: ${eventName}`);
  switch (eventName) {
    case 'pull_request': {
      const event = parsed(pullRequestPayloadSchema, payload, eventName);
      const pull = event.pull_request;
      return {
        kind: 'pull_request',
        prNumber: String(pull.number),
        headSha: pull.head.sha,
        trustedBaseSha: pull.base.sha,
        baseBranch: pull.base.ref,
        headRepository: pull.head.repo?.full_name ?? '',
        draft: pull.draft,
      };
    }
    case 'merge_group': {
      const event = parsed(mergeGroupPayloadSchema, payload, eventName);
      const group = event.merge_group;
      if (group.head_sha === group.base_sha) {
        throw new CiEventError('Invalid merge_group payload: head_sha equals base_sha.');
      }
      if (commitSha.safeParse(eventSha).success && eventSha !== group.head_sha) {
        throw new CiEventError(
          `merge_group event commit ${eventSha} is not the payload candidate ${group.head_sha}.`,
        );
      }
      return {
        kind: 'merge_group',
        prNumber: mergeQueuePullRequestNumber(group.head_ref),
        headSha: group.head_sha,
        trustedBaseSha: group.base_sha,
        baseBranch: MERGE_QUEUE_BASE_BRANCH,
        queueRef: group.head_ref,
        repository: event.repository.full_name,
      };
    }
    case 'workflow_dispatch':
      return { kind: 'workflow_dispatch', headSha: eventSha };
    default:
      return assertNever(eventName);
  }
}

/** Reads the running job's event from `GITHUB_EVENT_NAME` and `GITHUB_EVENT_PATH`. */
export function readCiEvent(environment: NodeJS.ProcessEnv = process.env): CiEventTuple {
  const eventName = environment['GITHUB_EVENT_NAME'] ?? '';
  const eventPath = environment['GITHUB_EVENT_PATH'] ?? '';
  if (eventPath.length === 0) throw new CiEventError('GITHUB_EVENT_PATH is required to read the event.');
  const payload: unknown = JSON.parse(readFileSync(eventPath, 'utf8'));
  return projectCiEvent(eventName, payload, environment['GITHUB_SHA'] ?? '');
}

/** Reads the event only when the job runs for a merge queue candidate. */
export function readMergeGroupEvent(
  environment: NodeJS.ProcessEnv = process.env,
): MergeGroupEventTuple | undefined {
  if (environment['GITHUB_EVENT_NAME'] !== 'merge_group') return undefined;
  const event = readCiEvent(environment);
  if (event.kind !== 'merge_group') throw new CiEventError('merge_group event projected to another kind.');
  return event;
}

/**
 * Where an exact reviewed head can be fetched and re-verified: the PR's head
 * ref for a pull request, the live queue ref for a merge queue candidate.
 */
export type ReviewedHeadSource =
  | { readonly kind: 'pull-request'; readonly prNumber: string }
  | { readonly kind: 'merge-group'; readonly queueRef: string };

/** Exactly one of a PR number and a queue ref names the reviewed head. */
export function reviewedHeadSource(prNumber: string, queueRef: string): ReviewedHeadSource {
  if (prNumber.length > 0 && queueRef.length > 0) {
    throw new CiEventError('A reviewed head is named by a PR number or a merge queue ref, not both.');
  }
  if (queueRef.length > 0) {
    mergeQueuePullRequestNumber(queueRef);
    return { kind: 'merge-group', queueRef };
  }
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new CiEventError('A reviewed head needs a positive PR number or a merge queue ref.');
  }
  return { kind: 'pull-request', prNumber };
}

/** The Git ref to fetch the reviewed head from. */
export function reviewedHeadGitRef(source: ReviewedHeadSource): string {
  switch (source.kind) {
    case 'pull-request':
      return `refs/pull/${source.prNumber}/head`;
    case 'merge-group':
      return source.queueRef;
    default:
      return assertNever(source);
  }
}

/** The REST path, under `/repos/<owner>/<repo>`, whose answer names the live head SHA. */
export function reviewedHeadApiPath(source: ReviewedHeadSource): string {
  switch (source.kind) {
    case 'pull-request':
      return `/pulls/${source.prNumber}`;
    case 'merge-group':
      return `/git/ref/${source.queueRef.slice('refs/'.length)}`;
    default:
      return assertNever(source);
  }
}

const pullHeadSchema = z.object({ head: z.object({ sha: z.string() }) });
const gitRefSchema = z.object({ object: z.object({ sha: z.string() }) });

/** The head SHA the live API answer names for this source. */
export function reviewedHeadShaFromApi(source: ReviewedHeadSource, body: unknown): string {
  switch (source.kind) {
    case 'pull-request':
      return pullHeadSchema.parse(body).head.sha;
    case 'merge-group':
      return gitRefSchema.parse(body).object.sha;
    default:
      return assertNever(source);
  }
}

/** How messages name the reviewed head, so a PR's wording is unchanged. */
export function reviewedHeadLabel(source: ReviewedHeadSource): string {
  switch (source.kind) {
    case 'pull-request':
      return 'Pull request head';
    case 'merge-group':
      return 'Merge queue candidate';
    default:
      return assertNever(source);
  }
}

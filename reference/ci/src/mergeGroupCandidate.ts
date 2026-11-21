import { z } from 'zod';
import { type MergeGroupEventTuple } from './ciEvent.ts';
import { MERGE_QUEUE_BASE_BRANCH } from './mergeQueueRef.ts';
import { GithubTransportError, type GithubReader } from './ios/shared/githubRest.ts';

/**
 * Proves which pull requests a merge queue candidate integrates.
 *
 * A candidate is cumulative: entry k is a merge commit whose first parent is
 * entry k-1's candidate (the queue base for k = 1) and whose last parent is
 * PR k's head. Every entry's code runs in this candidate's trusted jobs, so
 * the whole first-parent chain is walked from the candidate down to
 * `merge_group.base_sha`: each step must be a merge commit that GitHub
 * labelled with a PR, and that PR must be open, not a draft, based on develop,
 * from this repository (a fork fails closed), and headed exactly at the
 * commit's last parent. The chain must end exactly at the queue base; any
 * other shape is rejected. The top entry must be the PR its queue ref names.
 */

export type MergeGroupRejection =
  | 'pull-request-unreadable'
  | 'pull-request-not-open'
  | 'pull-request-draft'
  | 'pull-request-wrong-base'
  | 'fork-head'
  | 'candidate-unreadable'
  | 'candidate-entry-not-a-queue-merge'
  | 'candidate-top-entry-not-queued-pr'
  | 'candidate-last-parent-not-pr-head'
  | 'candidate-chain-does-not-reach-base';

/** One queued pull request inside the candidate, oldest first. */
export interface QueuedEntry {
  readonly prNumber: string;
  readonly prHeadSha: string;
  readonly entrySha: string;
}

export interface VerifiedMergeGroupCandidate {
  readonly prNumber: string;
  readonly prHeadSha: string;
  readonly queueBaseSha: string;
  readonly candidateSha: string;
  readonly queueRef: string;
  readonly entries: readonly QueuedEntry[];
}

export interface RejectedMergeGroupCandidate {
  readonly kind: 'rejected';
  readonly reason: MergeGroupRejection;
  readonly message: string;
}

export type MergeGroupVerification =
  | { readonly kind: 'verified'; readonly candidate: VerifiedMergeGroupCandidate }
  | RejectedMergeGroupCandidate;

/** GitHub's `max_entries_to_build` ceiling; a longer chain is not a queue candidate. */
export const MAX_QUEUE_ENTRIES = 100;

const livePullRequestSchema = z.object({
  state: z.string(),
  draft: z.boolean(),
  head: z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ ref: z.string() }),
});

const entryCommitSchema = z.object({
  commit: z.object({ message: z.string() }),
  parents: z.array(z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) })),
});

/** The queue's MERGE method writes this first line for every entry. */
export const QUEUE_MERGE_SUBJECT = /^Merge pull request #([1-9][0-9]*) from \S+/;

function rejected(reason: MergeGroupRejection, message: string): RejectedMergeGroupCandidate {
  return { kind: 'rejected', reason, message: `${reason}: ${message}` };
}

async function verifyQueuedPullRequest(
  prNumber: string,
  expectedHeadSha: string,
  context: { readonly repository: string; readonly apiRoot: string; readonly read: GithubReader },
): Promise<RejectedMergeGroupCandidate | undefined> {
  const response = await context.read(`${context.apiRoot}/pulls/${prNumber}`);
  const pull = response.status === 200 ? livePullRequestSchema.safeParse(response.body) : undefined;
  if (pull === undefined || !pull.success) {
    return rejected('pull-request-unreadable',
      `could not read pull request #${prNumber} (HTTP ${response.statusLabel}).`);
  }
  const live = pull.data;
  if (live.state !== 'open') return rejected('pull-request-not-open', `pull request #${prNumber} is ${live.state}.`);
  if (live.draft) return rejected('pull-request-draft', `pull request #${prNumber} is a draft.`);
  if (live.base.ref !== MERGE_QUEUE_BASE_BRANCH) {
    return rejected('pull-request-wrong-base',
      `pull request #${prNumber} targets ${live.base.ref}, not ${MERGE_QUEUE_BASE_BRANCH}.`);
  }
  if (live.head.repo?.full_name !== context.repository) {
    return rejected('fork-head',
      `pull request #${prNumber} head is not in ${context.repository}; queue candidates never run fork code.`);
  }
  if (live.head.sha !== expectedHeadSha) {
    return rejected('candidate-last-parent-not-pr-head',
      `queue entry for pull request #${prNumber} merges ${expectedHeadSha}, not its live head ${live.head.sha}.`);
  }
  return undefined;
}

type EntryRead =
  | { readonly kind: 'entry'; readonly prNumber: string; readonly prHeadSha: string; readonly firstParent: string }
  | RejectedMergeGroupCandidate;

async function readEntry(sha: string, apiRoot: string, read: GithubReader): Promise<EntryRead> {
  const response = await read(`${apiRoot}/commits/${sha}`);
  const commit = response.status === 200 ? entryCommitSchema.safeParse(response.body) : undefined;
  if (commit === undefined || !commit.success) {
    return rejected('candidate-unreadable', `could not read queue entry ${sha} (HTTP ${response.statusLabel}).`);
  }
  const parents = commit.data.parents.map((parent) => parent.sha);
  const subject = QUEUE_MERGE_SUBJECT.exec(commit.data.commit.message.split('\n', 1)[0] ?? '');
  const [firstParent] = parents;
  const lastParent = parents.at(-1);
  if (parents.length < 2 || subject?.[1] === undefined || firstParent === undefined || lastParent === undefined) {
    return rejected('candidate-entry-not-a-queue-merge',
      `queue entry ${sha} is not a merge-queue merge commit (${parents.length} parent(s)); `
      + 'the queue must use merge_method MERGE.');
  }
  return { kind: 'entry', prNumber: subject[1], prHeadSha: lastParent, firstParent };
}

/** Rejections that mean GitHub did not answer usably, not that the candidate is invalid. */
const UNREADABLE_REJECTIONS: ReadonlySet<MergeGroupRejection> = new Set([
  'pull-request-unreadable',
  'candidate-unreadable',
]);

export type MergeGroupReverification =
  | MergeGroupVerification
  | { readonly kind: 'unreadable'; readonly detail: string };

/**
 * `verifyMergeGroupCandidate` for a step that runs after the gate's precheck
 * already proved the candidate. A transport failure or an unusable GitHub
 * answer (non-200, or a body that does not parse) is `unreadable`, so the
 * caller can fall back instead of failing; only an answer that proves the
 * candidate invalid stays `rejected`. Any other exception is a defect and
 * propagates.
 */
export async function reverifyMergeGroupCandidate(
  event: MergeGroupEventTuple,
  apiUrl: string,
  read: GithubReader,
): Promise<MergeGroupReverification> {
  let verification: MergeGroupVerification;
  try {
    verification = await verifyMergeGroupCandidate(event, apiUrl, read);
  } catch (cause: unknown) {
    if (!(cause instanceof GithubTransportError)) throw cause;
    return { kind: 'unreadable', detail: cause.message };
  }
  if (verification.kind === 'rejected' && UNREADABLE_REJECTIONS.has(verification.reason)) {
    return { kind: 'unreadable', detail: verification.message };
  }
  return verification;
}

export async function verifyMergeGroupCandidate(
  event: MergeGroupEventTuple,
  apiUrl: string,
  read: GithubReader,
): Promise<MergeGroupVerification> {
  const apiRoot = `${apiUrl}/repos/${event.repository}`;
  const context = { repository: event.repository, apiRoot, read };
  const entries: QueuedEntry[] = [];
  let current = event.headSha;
  while (current !== event.trustedBaseSha) {
    if (entries.length >= MAX_QUEUE_ENTRIES) {
      return rejected('candidate-chain-does-not-reach-base',
        `no queue base ${event.trustedBaseSha} within ${MAX_QUEUE_ENTRIES} first-parent entries of ${event.headSha}.`);
    }
    const entry = await readEntry(current, apiRoot, read);
    if (entry.kind === 'rejected') {
      // Below the top entry, a non-merge commit means the walk left the queue before reaching its base.
      return entries.length > 0 && entry.reason === 'candidate-entry-not-a-queue-merge'
        ? rejected('candidate-chain-does-not-reach-base',
          `first-parent chain of ${event.headSha} reached ${current}, not queue base ${event.trustedBaseSha}.`)
        : entry;
    }
    if (entries.length === 0 && entry.prNumber !== event.prNumber) {
      return rejected('candidate-top-entry-not-queued-pr',
        `candidate ${event.headSha} merges pull request #${entry.prNumber}, but ${event.queueRef} names #${event.prNumber}.`);
    }
    const refused = await verifyQueuedPullRequest(entry.prNumber, entry.prHeadSha, context);
    if (refused !== undefined) return refused;
    entries.unshift({ prNumber: entry.prNumber, prHeadSha: entry.prHeadSha, entrySha: current });
    current = entry.firstParent;
  }
  const top = entries.at(-1);
  if (top === undefined) {
    return rejected('candidate-entry-not-a-queue-merge', `candidate ${event.headSha} is the queue base itself.`);
  }
  return {
    kind: 'verified',
    candidate: {
      prNumber: event.prNumber,
      prHeadSha: top.prHeadSha,
      queueBaseSha: event.trustedBaseSha,
      candidateSha: event.headSha,
      queueRef: event.queueRef,
      entries,
    },
  };
}

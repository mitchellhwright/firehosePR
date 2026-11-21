import { GithubTransportError, type GithubReader } from './shared/githubRest.ts';
import { error, info, notice, type StepMessage } from './shared/stepDecision.ts';

/**
 * "Compare the queued tuple with the live pull request": the guard every Mac
 * lane waits on before a Mac is allocated to it.
 *
 * The change gate captured a (head, base, base branch) tuple when the event
 * arrived. By the time a Mac is free the pull request may have moved, closed
 * or gone back to draft, and running the lane would spend a scarce Mac on a
 * revision nobody is waiting for. This decides, from the live pull request,
 * whether the queued tuple is still the current one.
 *
 * It is deliberately stricter than `pullRequestStillMatchesEvent` in
 * `iosGatePrecheck.ts`, which re-checks an event against the pull request that
 * raised it: that one also pins the head branch and repository and tolerates a
 * draft, because a draft never reaches the gate. This one runs later, when a
 * pull request may have been converted back to draft, so it refuses a draft
 * and compares only the tuple the gate published.
 *
 * The pure predicate accepts a decoded body. The shared read boundary below
 * lets Linux pre-allocation and late Mac admission use that same decision.
 */

export interface QueuedTuple {
  readonly prNumber: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseRef: string;
}

export interface TupleDecision {
  readonly messages: readonly StepMessage[];
  /** The step's `current` output, as the shell wrote it. */
  readonly current: 'true' | 'false';
  readonly exitCode: 0 | 1;
}

interface LivePullRequest {
  readonly state: unknown;
  readonly draft: unknown;
  readonly head: { readonly sha?: unknown } | undefined;
  readonly base: { readonly sha?: unknown; readonly ref?: unknown } | undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function livePullRequest(body: unknown): LivePullRequest | undefined {
  const record = asRecord(body);
  if (record === undefined) return undefined;
  return {
    state: record['state'],
    draft: record['draft'],
    head: asRecord(record['head']),
    base: asRecord(record['base']),
  };
}

/** The jq predicate the shell evaluated, as a function over the decoded body. */
export function tupleIsCurrent(body: unknown, expected: QueuedTuple): boolean {
  const pull = livePullRequest(body);
  if (pull === undefined) return false;
  return (
    pull.state === 'open' &&
    pull.draft === false &&
    pull.head?.sha === expected.headSha &&
    pull.base?.sha === expected.baseSha &&
    pull.base?.ref === expected.baseRef
  );
}

/**
 * A dispatch carries no pull request number at all. It has no tuple to
 * supersede, so it is current by definition and never reaches the read.
 */
export function eventHasNoPullRequest(expected: QueuedTuple): boolean {
  return expected.prNumber.length === 0;
}

/** The `${VAR:?}` reads the shell made once it knew a pull request was named. */
export function missingTupleField(expected: QueuedTuple): string | null {
  if (expected.headSha.length === 0) return 'Expected PR head is required';
  if (expected.baseSha.length === 0) return 'Expected PR base is required';
  if (expected.baseRef.length === 0) return 'Expected PR base branch is required';
  return null;
}

/** A read that could not be completed; the step fails rather than guessing. */
export function unreadableTupleDecision(reason: string): TupleDecision {
  return { messages: [error(reason)], current: 'false', exitCode: 1 };
}

export function tupleDecision(body: unknown, expected: QueuedTuple): TupleDecision {
  if (tupleIsCurrent(body, expected)) {
    return { messages: [], current: 'true', exitCode: 0 };
  }
  return {
    messages: [
      notice(
        `Skipping superseded iOS tuple ${expected.headSha}/${expected.baseSha} ` +
          'before Mac allocation.',
      ),
    ],
    current: 'false',
    exitCode: 0,
  };
}

export function dispatchTupleDecision(): TupleDecision {
  return {
    messages: [info('No pull request tuple to revalidate for this event.')],
    current: 'true',
    exitCode: 0,
  };
}

/**
 * A merge queue candidate is current while its queue ref still points at it.
 * GitHub deletes or moves the ref when the entry leaves the queue or the
 * candidate is rebuilt, so a missing ref (HTTP 404) or a different SHA means
 * the candidate is stale and no Mac is allocated to it.
 */
export function queueRefDecision(
  queueRef: string,
  candidateSha: string,
  liveSha: string | undefined,
): TupleDecision {
  if (liveSha === candidateSha) return { messages: [], current: 'true', exitCode: 0 };
  return {
    messages: [
      notice(
        `Skipping stale merge queue candidate ${candidateSha}: ${queueRef} `
          + `${liveSha === undefined ? 'no longer exists' : `now points at ${liveSha}`}.`,
      ),
    ],
    current: 'false',
    exitCode: 0,
  };
}

/** One read/validation owner for both pre-allocation and late execution admission. */
export async function readCurrentPullRequestTuple(options: {
  readonly expected: QueuedTuple;
  readonly apiUrl: string;
  readonly repository: string;
  readonly read: GithubReader;
}): Promise<TupleDecision> {
  const { expected, apiUrl, repository, read } = options;
  if (eventHasNoPullRequest(expected)) return dispatchTupleDecision();
  const missing = missingTupleField(expected);
  if (missing !== null) return unreadableTupleDecision(missing);
  if (!/^[1-9][0-9]*$/.test(expected.prNumber)) {
    return unreadableTupleDecision('Invalid pull request number for iOS admission.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) {
    return unreadableTupleDecision('Invalid repository for iOS admission.');
  }
  let response;
  try {
    response = await read(`${apiUrl}/repos/${repository}/pulls/${expected.prNumber}`);
  } catch (cause: unknown) {
    if (!(cause instanceof GithubTransportError)) throw cause;
    return unreadableTupleDecision(
      `Could not reach pull request #${expected.prNumber} to revalidate the queued iOS tuple.`,
    );
  }
  if (response.statusLabel !== '200') {
    return unreadableTupleDecision(
      `Unexpected GitHub response while revalidating pull request #${expected.prNumber}: `
        + `HTTP ${response.statusLabel}.`,
    );
  }
  return tupleDecision(response.body, expected);
}

/** A stale tuple skips allocation; after allocation it must stop execution. */
export function executionTupleDecision(decision: TupleDecision): TupleDecision {
  if (decision.current === 'true' || decision.exitCode === 1) return decision;
  return { current: 'false', exitCode: 1,
    messages: [error('The queued iOS tuple is no longer current; refusing Mac execution.')] };
}

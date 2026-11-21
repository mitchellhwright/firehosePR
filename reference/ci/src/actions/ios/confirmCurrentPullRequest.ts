import { optionalEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import {
  createGithubReader,
  credentialTokens,
  GithubTransportError,
} from '../../ios/shared/githubRest.ts';
import {
  runAsyncStepProgram,
  type StepDecision,
} from '../../ios/shared/stepDecision.ts';
import {
  dispatchTupleDecision,
  eventHasNoPullRequest,
  queueRefDecision,
  readCurrentPullRequestTuple,
  unreadableTupleDecision,
  type QueuedTuple,
  type TupleDecision,
} from '../../ios/currentPullRequestTuple.ts';
import {
  readMergeGroupEvent,
  reviewedHeadApiPath,
  reviewedHeadShaFromApi,
  type MergeGroupEventTuple,
} from '../../ciEvent.ts';

/**
 * "Compare the queued tuple with the live pull request": the guard every Mac
 * lane waits on.
 *
 * The decision is `ci/src/ios/currentPullRequestTuple.ts`; this reads the live
 * pull request through the shared token-falling-back GitHub reader — the same
 * one the gate precheck uses — and writes the `current` output the lanes read.
 * A read that cannot be completed fails the step rather than reporting a stale
 * tuple as current, because that verdict releases a Mac.
 */
await runAsyncStepProgram('Current pull request tuple', async (): Promise<StepDecision> => {
  const expected: QueuedTuple = {
    prNumber: optionalEnv('PR_NUMBER'),
    headSha: optionalEnv('EXPECTED_HEAD'),
    baseSha: optionalEnv('EXPECTED_BASE'),
    baseRef: optionalEnv('EXPECTED_BASE_REF'),
  };
  const decision = await decide(expected);
  appendStepOutputs([['current', decision.current]]);
  return { messages: decision.messages, exitCode: decision.exitCode };
});

/** A queue candidate has no PR tuple of its own; its liveness is its queue ref. */
async function decideMergeGroup(event: MergeGroupEventTuple, expected: QueuedTuple): Promise<TupleDecision> {
  if (expected.headSha !== event.headSha || expected.baseSha !== event.trustedBaseSha) {
    throw new Error('The gate tuple does not match the merge_group payload tuple.');
  }
  const read = createGithubReader({ tokens: credentialTokens(requiredEnv('GH_TOKEN'), '') });
  const source = { kind: 'merge-group', queueRef: event.queueRef } as const;
  const url = `${requiredEnv('GITHUB_API_URL')}/repos/${requiredEnv('GITHUB_REPOSITORY')}`
    + reviewedHeadApiPath(source);
  let response;
  try {
    response = await read(url);
  } catch (cause: unknown) {
    if (!(cause instanceof GithubTransportError)) throw cause;
    return unreadableTupleDecision(`Could not reach ${event.queueRef} to revalidate the queue candidate.`);
  }
  if (response.status === 404) return queueRefDecision(event.queueRef, event.headSha, undefined);
  if (response.statusLabel !== '200') {
    return unreadableTupleDecision(
      `Unexpected GitHub response while revalidating ${event.queueRef}: HTTP ${response.statusLabel}.`,
    );
  }
  return queueRefDecision(event.queueRef, event.headSha, reviewedHeadShaFromApi(source, response.body));
}

async function decide(expected: QueuedTuple): Promise<TupleDecision> {
  const mergeGroup = readMergeGroupEvent();
  if (mergeGroup !== undefined) return decideMergeGroup(mergeGroup, expected);
  if (eventHasNoPullRequest(expected)) return dispatchTupleDecision();
  return readCurrentPullRequestTuple({
    expected,
    apiUrl: requiredEnv('GITHUB_API_URL'),
    repository: requiredEnv('GITHUB_REPOSITORY'),
    read: createGithubReader({ tokens: credentialTokens(requiredEnv('GH_TOKEN'), '') }),
  });
}

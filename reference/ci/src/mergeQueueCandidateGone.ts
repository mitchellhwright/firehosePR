import type { GithubRequester } from './ios/shared/githubRest.ts';

/**
 * A merge queue candidate whose `gh-readonly-queue/...` branch GitHub deleted
 * before this run reached it. GitHub deletes the branch when it invalidates
 * the candidate (an entry ahead failed, the PR left the queue, or the queue
 * was rebuilt), so nothing can merge through it any more and there is nothing
 * left to validate. Runs that start late on a busy runner pool meet this
 * routinely; they should end cancelled, not red.
 */
export class MergeQueueCandidateGone extends Error {
  readonly queueRef: string;

  constructor(queueRef: string) {
    super(`Merge queue candidate branch ${queueRef} no longer exists.`);
    this.name = 'MergeQueueCandidateGone';
    this.queueRef = queueRef;
  }
}

/** Git's answer when a fetched ref does not exist on the remote. */
export function isMissingRemoteRef(stderr: string, queueRef: string): boolean {
  return stderr.includes(`couldn't find remote ref ${queueRef}`);
}

export interface QueueRefLookup {
  readonly apiUrl: string;
  readonly repository: string;
  readonly queueRef: string;
  readonly request: GithubRequester;
}

/**
 * Git's "couldn't find remote ref" is confirmed against the REST API before
 * anything is skipped: only a 404 for the queue branch proves the candidate is
 * gone. A branch the API still has answers `false`, and the caller keeps its
 * original failure. Needs only read access.
 */
export async function queueCandidateGone(lookup: QueueRefLookup): Promise<boolean> {
  const ref = await lookup.request('GET',
    `${lookup.apiUrl}/repos/${lookup.repository}/git/ref/${lookup.queueRef.replace(/^refs\//, '')}`);
  if (ref.status === 200) return false;
  if (ref.status === 404) return true;
  throw new Error(`Could not confirm whether ${lookup.queueRef} exists: GitHub answered HTTP ${ref.statusLabel}.`);
}

/**
 * Cancels a workflow run, so a run whose candidate is gone ends cancelled
 * (never green, never red). Needs `actions: write`; call it only from a job
 * that runs trusted code.
 */
export async function cancelWorkflowRun(lookup: QueueRefLookup & { readonly runId: string }): Promise<void> {
  const cancel = await lookup.request('POST',
    `${lookup.apiUrl}/repos/${lookup.repository}/actions/runs/${lookup.runId}/cancel`);
  // 409: the run is already completing or cancelled, which is the same outcome.
  if (cancel.status !== 202 && cancel.status !== 409) {
    throw new Error(`Could not cancel run ${lookup.runId} for the deleted candidate ${lookup.queueRef}: `
      + `GitHub answered HTTP ${cancel.statusLabel}; check the job grants actions: write.`);
  }
}

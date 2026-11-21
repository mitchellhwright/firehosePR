/**
 * The merge queue branch and queue ref shape. Dependency-free, so programs
 * that run from a sparse `ci/src` checkout without `npm ci` can import it.
 */

/** The only branch the merge queue is planned for (merge-queue plan S1–S3). */
export const MERGE_QUEUE_BASE_BRANCH = 'develop';
export const MERGE_QUEUE_BASE_REF = `refs/heads/${MERGE_QUEUE_BASE_BRANCH}`;

/**
 * `refs/heads/gh-readonly-queue/develop/pr-<number>-<base-sha>`: the number is the queued PR and
 * the SHA is the candidate's base (develop or the previous entry's candidate), never the candidate.
 */
export const MERGE_QUEUE_REF_PATTERN =
  /^refs\/heads\/gh-readonly-queue\/develop\/pr-([1-9][0-9]*)-[0-9a-f]{40}$/;

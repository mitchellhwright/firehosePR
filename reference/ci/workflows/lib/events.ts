/**
 * Required validation workflows subscribe only to events that can change the
 * reviewed head or reopen its verdict. GitHub does not filter `edited` by the
 * field that changed: subscribing to it creates skipped required check runs
 * for title/body edits and makes a previously green PR appear pending.
 * Base retargets instead use the trusted continuity workflow, which updates
 * the branch and lets the resulting `synchronize` event run validation.
 */
export type ValidationPullRequestEvent =
  | 'opened' | 'synchronize' | 'reopened' | 'ready_for_review';

export const VALIDATION_PULL_REQUEST_EVENTS = [
  'opened', 'synchronize', 'reopened', 'ready_for_review',
] as const satisfies readonly ValidationPullRequestEvent[];

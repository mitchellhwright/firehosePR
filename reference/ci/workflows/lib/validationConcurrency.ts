import { concat, expr, github, type ExpressionValue } from './expressions.ts';

/** One owner for the groups shared by validation and terminal PR signals. */
const PR_CHECKS_PREFIX = 'pr-checks-';
const IOS_VALIDATION_PREFIX = 'ios-run-';
export const prChecksGroup = (key: ExpressionValue): ExpressionValue => concat(PR_CHECKS_PREFIX, key);
export const iosValidationGroup = (key: ExpressionValue): ExpressionValue => concat(IOS_VALIDATION_PREFIX, key);
export const terminalPrKey = (): ExpressionValue => concat('pr-', github('event.pull_request.number'));

/**
 * A delayed unmerged-close event must never cancel validation of a reopened PR.
 * Only a merged close is terminal; all other close events get a run-unique
 * group, and the state-checking API controller owns their cleanup.
 */
export const mergedTerminalGroup = (kind: 'pr-checks' | 'ios'): ExpressionValue => {
  const prefix = kind === 'pr-checks' ? PR_CHECKS_PREFIX : `${IOS_VALIDATION_PREFIX}pr-`;
  return expr(`github.event.action == 'closed' && github.event.pull_request.merged == true `
    + `&& format('${prefix}{0}', github.event.pull_request.number) `
    + `|| format('terminal-${kind}-{0}', github.run_id)`);
};

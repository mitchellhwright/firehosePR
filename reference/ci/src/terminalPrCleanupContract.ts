/** Terminal cleanup reports automation health; GitHub owns merge policy. */
export const PR_TERMINAL_CLEANUP_JOB_NAME = 'Cancel abandoned PR work' as const;

/** Pull-request validation workflows whose runs terminal cleanup may cancel. */
export const PR_VALIDATION_WORKFLOW_NAMES = 'PR Checks,Test - iOS' as const;

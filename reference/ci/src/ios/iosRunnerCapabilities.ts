/** The only Mac capabilities that typed iOS jobs may request. */
export const sharedMacLabels = ['self-hosted', 'macOS', 'ios-xcode'] as const;
export const reservedMacLabels = ['self-hosted', 'macOS', 'ios-reserved-mitchell'] as const;
/**
 * The one physical Mac held back for develop merge queue candidates. It
 * carries this label instead of `ios-xcode`, so no pull request job can land
 * on it; this label is currently outside the shared PR pool.
 */
export const mergeQueueMacLabels = ['self-hosted', 'macOS', 'ios-merge-queue'] as const;
export const manualMacRunnerChoices = ['shared', 'mitchell-reserved'] as const;

export type ManualMacRunner = typeof manualMacRunnerChoices[number];

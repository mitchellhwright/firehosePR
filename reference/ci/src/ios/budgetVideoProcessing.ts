/**
 * Where the Budget E2E video lands and which file is compressed.
 *
 * The lane uploads one raw recording per run attempt and this job compresses
 * it. Both halves used to derive the same directory by pasting `$RUNNER_TEMP`,
 * `$GITHUB_RUN_ID` and `$GITHUB_RUN_ATTEMPT` together in shell, once in the
 * step that creates it and again in the artifact download's `path:`; the
 * derivation lives here now so the two cannot drift.
 */

export interface BudgetVideoWorkspace {
  readonly runDirectory: string;
  readonly rawDirectory: string;
  readonly compressedVideo: string;
}

/**
 * A run id or attempt that is not a plain number would escape the run's own
 * directory, and the step then removes whatever it names.
 */
const runIdentifierPattern = /^[0-9]+$/;

export function budgetVideoWorkspace(
  runnerTemp: string,
  runId: string,
  runAttempt: string,
): BudgetVideoWorkspace {
  for (const [label, value] of [['run id', runId], ['run attempt', runAttempt]] as const) {
    if (!runIdentifierPattern.test(value)) {
      throw new Error(`Refusing to prepare a Budget video workspace for a non-numeric ${label}.`);
    }
  }
  if (runnerTemp.length === 0) throw new Error('RUNNER_TEMP is required');
  const runDirectory = `${runnerTemp}/budget-video-${runId}-${runAttempt}`;
  return {
    runDirectory,
    rawDirectory: `${runDirectory}/raw`,
    compressedVideo: `${runDirectory}/budget-e2e.compressed.mp4`,
  };
}

/**
 * The recording the lane uploaded, chosen the way `find -print -quit` chose
 * it: the first `*.raw.mp4` in the downloaded tree. Sorting makes the choice
 * deterministic where `find`'s directory order was not.
 */
export function selectRawVideo(candidates: readonly string[]): string {
  const raw = candidates.filter((path) => path.endsWith('.raw.mp4')).toSorted();
  const [first] = raw;
  if (first === undefined) {
    throw new Error('The downloaded Budget E2E evidence contains no raw recording.');
  }
  return first;
}

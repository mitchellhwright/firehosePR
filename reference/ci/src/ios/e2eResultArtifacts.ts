/**
 * Which `.xcresult` bundle and `xcodebuild` log a real-server E2E lane reads
 * after its tests have run, and what each post-run reader is called.
 *
 * The four lanes share one `steps:` block, so every reader step selected its
 * lane's paths with the same `"${VAR:-$RUNNER_TEMP/<lane>.…}"` shape and, for
 * the compact summaries, with an `if/elif` chain over `$E2E_LANE`. Both are
 * lane tables here so a new lane adds a row instead of another branch, and so
 * a test can assert the defaults without a runner temp directory.
 *
 * Pure: no filesystem, no spawning.
 */

export type E2eLane = 'onboarding' | 'chat-plaid' | 'income' | 'budget';

export const e2eLanes: readonly E2eLane[] = ['onboarding', 'chat-plaid', 'income', 'budget'];

export function isE2eLane(value: string): value is E2eLane {
  return (e2eLanes as readonly string[]).includes(value);
}

/**
 * The compact-summary step's `if/elif/else` chain: three lanes were named and
 * everything else fell through to Budget. Keeping the fallback means a lane
 * whose `$E2E_LANE` was never exported still writes a summary instead of
 * failing the cleanup tail of the job.
 */
export function compactSummaryLane(value: string): E2eLane {
  return isE2eLane(value) ? value : 'budget';
}

interface LaneArtifactRow {
  /** Env var the lane's result bundle is published under. */
  readonly resultBundleVariable: string;
  /** Env var the lane's xcodebuild log is published under. */
  readonly xcodebuildLogVariable: string;
  /** Basenames the shell fell back to under `$RUNNER_TEMP`. */
  readonly resultBundleFallback: string;
  readonly xcodebuildLogFallback: string;
  /** How the compact summary names this lane for a reviewer. */
  readonly summaryLabel: string;
  /** Basename of the compact summary inside the lane's run directory. */
  readonly summaryFile: string;
}

const laneArtifacts: Readonly<Record<E2eLane, LaneArtifactRow>> = {
  onboarding: {
    resultBundleVariable: 'ONBOARDING_E2E_RESULT_BUNDLE',
    xcodebuildLogVariable: 'ONBOARDING_E2E_XCODEBUILD_LOG',
    resultBundleFallback: 'onboarding-e2e.xcresult',
    xcodebuildLogFallback: 'onboarding-e2e-xcodebuild.log',
    summaryLabel: 'FullOnboarding E2E',
    summaryFile: 'onboarding-summary.json',
  },
  'chat-plaid': {
    resultBundleVariable: 'CHAT_PLAID_E2E_RESULT_BUNDLE',
    xcodebuildLogVariable: 'CHAT_PLAID_E2E_XCODEBUILD_LOG',
    resultBundleFallback: 'chat-plaid-e2e.xcresult',
    xcodebuildLogFallback: 'chat-plaid-e2e-xcodebuild.log',
    summaryLabel: 'Chat Plaid E2E',
    summaryFile: 'chat-plaid-summary.json',
  },
  income: {
    resultBundleVariable: 'INCOME_E2E_RESULT_BUNDLE',
    xcodebuildLogVariable: 'INCOME_E2E_XCODEBUILD_LOG',
    resultBundleFallback: 'income-e2e.xcresult',
    xcodebuildLogFallback: 'income-e2e-xcodebuild.log',
    summaryLabel: 'Income activation E2E',
    summaryFile: 'income-e2e-summary.json',
  },
  budget: {
    resultBundleVariable: 'BUDGET_E2E_RESULT_BUNDLE',
    xcodebuildLogVariable: 'BUDGET_E2E_XCODEBUILD_LOG',
    resultBundleFallback: 'budget-e2e.xcresult',
    xcodebuildLogFallback: 'budget-e2e-xcodebuild.log',
    summaryLabel: 'Budget E2E',
    summaryFile: 'budget-e2e-summary.json',
  },
};

export interface LaneArtifactEnvironment {
  readonly runnerTemp: string;
  readonly values: Readonly<Record<string, string | undefined>>;
}

function orFallback(value: string | undefined, fallback: string): string {
  return value === undefined || value.length === 0 ? fallback : value;
}

export interface FailureSummaryTarget {
  readonly resultBundle: string;
  readonly xcodebuildLog: string;
}

/**
 * The two paths `scripts/summarize-ios-test-failures.py` is given. Both keep
 * the runner-temp default the shell used, so a lane whose run directory was
 * never published still points the summariser somewhere it can report "no
 * bundle" rather than being handed an empty argument.
 */
export function failureSummaryTarget(
  lane: E2eLane,
  environment: LaneArtifactEnvironment,
): FailureSummaryTarget {
  const row = laneArtifacts[lane];
  return {
    resultBundle: orFallback(
      environment.values[row.resultBundleVariable],
      `${environment.runnerTemp}/${row.resultBundleFallback}`,
    ),
    xcodebuildLog: orFallback(
      environment.values[row.xcodebuildLogVariable],
      `${environment.runnerTemp}/${row.xcodebuildLogFallback}`,
    ),
  };
}

/** The argument array for the failure summariser, in the shell's order. */
export function failureSummaryArguments(target: FailureSummaryTarget): readonly string[] {
  return [
    'scripts/summarize-ios-test-failures.py',
    target.resultBundle,
    '--xcodebuild-log',
    target.xcodebuildLog,
  ];
}

export interface CompactSummaryTarget {
  readonly label: string;
  /** Empty when the lane produced no bundle; the exporter reports that itself. */
  readonly resultBundle: string;
  readonly outputPath: string;
}

/**
 * What `scripts/export-ios-xcresult-summaries.sh` is called with. The bundle
 * is passed through unset-as-empty exactly as `"${VAR:-}"` did, because the
 * exporter distinguishes "no bundle" from "bundle missing" itself.
 */
export function compactSummaryTarget(
  lane: E2eLane,
  runDirectory: string,
  values: Readonly<Record<string, string | undefined>>,
): CompactSummaryTarget {
  const row = laneArtifacts[lane];
  return {
    label: row.summaryLabel,
    resultBundle: values[row.resultBundleVariable] ?? '',
    outputPath: `${runDirectory}/${row.summaryFile}`,
  };
}

export function compactSummaryArguments(target: CompactSummaryTarget): readonly string[] {
  return [
    'scripts/export-ios-xcresult-summaries.sh',
    target.label,
    target.resultBundle,
    target.outputPath,
  ];
}

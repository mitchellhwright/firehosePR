import { evidenceGroupRequired, parseEvidenceGroups } from './executionPlan.ts';
import { error, fail, notice, pass, warning, type StepDecision } from './shared/stepDecision.ts';

export type TransportFailurePolicy = 'fail' | 'consumer-rebuild';

export interface TestProductHandoffInputs {
  /** Consumers with an exact-head local rebuild path can recover from transport outages. */
  readonly transportFailurePolicy: TransportFailurePolicy;
  /** Outcome of `actions/cache/save`; diagnostic only because the read-back is authoritative. */
  readonly cacheSaveOutcome: string;
  /** Outcome of the cache read-back step. */
  readonly cacheLookupOutcome: string;
  /** The read-back action's `cache-hit` output. */
  readonly cacheHit: string;
  /** Outcome of the independent artifact fallback upload. */
  readonly artifactOutcome: string;
}

/**
 * One successful transport is sufficient to release the producer's products.
 *
 * The cache read-back is the authority for cache publication: a save action
 * may report success before a cross-runner read is possible. E2E products also
 * have an independent artifact in case a consumer later misses the cache;
 * native and E2E consumers can rebuild at their exact head. This verdict
 * keeps the job green when either transport succeeded, or when the producer
 * compiled successfully and consumers can recover locally from an outage.
 */
export function testProductHandoffDecision(inputs: TestProductHandoffInputs): StepDecision {
  if (inputs.cacheLookupOutcome === 'success' && inputs.cacheHit === 'true') {
    return pass(notice('Published iOS test products through the verified Actions cache.'));
  }

  if (inputs.artifactOutcome === 'success') {
    return pass(notice('Published iOS test products through the artifact fallback.'));
  }

  const detail = 'No iOS test-product transport succeeded: '
      + `cache save=${inputs.cacheSaveOutcome || 'missing'}, `
      + `cache lookup=${inputs.cacheLookupOutcome || 'missing'}, `
      + `cache hit=${inputs.cacheHit || 'missing'}, `
      + `artifact upload=${inputs.artifactOutcome || 'missing'}.`;
  if (inputs.transportFailurePolicy === 'consumer-rebuild') {
    return pass(warning(`${detail} Consumers will rebuild products from their exact head.`));
  }
  return fail(error(detail));
}

/**
 * Decisions for the two jobs that compile the shared iOS test products:
 * `build-ios-native-test-products` and `build-ios-e2e-test-products`.
 *
 * Everything here is pure: which selection mode the native products are built
 * at, whether the evidence test plan has to be compiled alongside them, and
 * which diagnostic paths a failed artifact upload should fall back to on the
 * runner. The side effects — xcodebuild, `ditto`, `cp -R`, the GitHub step
 * outputs — live in the thin programs under `ci/src/actions/ios/`.
 */

/** The three selection modes `scripts/select-ios-affected-tests.ts` emits. */
export const nativeProductBuildModes = ['skip', 'affected', 'full'] as const;
export type NativeProductBuildMode = (typeof nativeProductBuildModes)[number];

export interface NativeProductBuildModeInputs {
  /** `steps.affected-tests.outputs.mode`. */
  readonly preparedSelectionMode: string;
  /** `needs.ios-change-gate.outputs.native_ui_required`; only read on the affected path. */
  readonly preparedUiRequired: string;
  /** `steps.affected-tests.outputs.evidence_groups`, comma separated. */
  readonly preparedEvidenceGroups: string;
  /** `steps.affected-tests.outputs.narrow_paywall_required`. */
  readonly preparedNarrowPaywallRequired: string;
  /** `needs.ios-change-gate.outputs.rerun_ios_lanes`, a JSON array. */
  readonly forcedExecutionLanes: string;
  /** `needs.ios-change-gate.outputs.native_full_execution_lanes`, a JSON array. */
  readonly fullExecutionLanes: string;
}

export type NativeProductBuildDecision =
  | {
    readonly kind: 'resolved';
    readonly mode: NativeProductBuildMode;
    readonly evidencePlanRequired: boolean;
  }
  | { readonly kind: 'error'; readonly message: string };

/**
 * The lanes named by a `needs.<job>.outputs.*_lanes` JSON array.
 *
 * A value that is not an array of strings yields no lanes, which is what the
 * replaced `jq -r '.[]'` (in a process substitution whose status nothing read)
 * and `jq -e 'length > 0'` (inside an `if`) both did with one. The gate always
 * writes a JSON array, so this only decides what an impossible value means.
 */
export function parseExecutionLanes(raw: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((lane): lane is string => typeof lane === 'string');
}

/** The four main-shard lanes a retained predecessor can force back on. */
export const forcedNativeLanes = ['native1', 'native2', 'native3', 'native4'] as const;

/**
 * The evidence groups whose compiled products only exist in the `CI-Evidence`
 * test plan. `account-update` is deliberately absent: it rides on the main
 * plan's products, so forcing it must not widen the build.
 */
export const evidencePlanGroups: readonly string[] = [
  'accessibility',
  'onboarding-copy',
];

interface ForcedLaneSummary {
  readonly nativeLane: boolean;
  readonly evidenceLane: boolean;
  readonly visualEvidenceLane: boolean;
}

function summarizeForcedLanes(lanes: readonly string[]): ForcedLaneSummary {
  let nativeLane = false;
  let evidenceLane = false;
  let visualEvidenceLane = false;
  for (const lane of lanes) {
    if ((forcedNativeLanes as readonly string[]).includes(lane)) nativeLane = true;
    if (lane === 'evidence-account-update' || lane === 'evidence-account-update-2') evidenceLane = true;
    if (lane === 'evidence-visual') {
      evidenceLane = true;
      visualEvidenceLane = true;
    }
  }
  return { nativeLane, evidenceLane, visualEvidenceLane };
}

function isNativeProductBuildMode(value: string): value is NativeProductBuildMode {
  return (nativeProductBuildModes as readonly string[]).includes(value);
}

/**
 * The mode the shared native products are compiled at, and whether the
 * evidence test plan must be compiled with them.
 *
 * A retained predecessor hands back evidence at lane granularity, so any
 * forced evidence lane widens the build to `full`: that is the narrowest scope
 * whose products are trustworthy for the whole retained lane.
 */
export function nativeProductBuildDecision(
  inputs: NativeProductBuildModeInputs,
): NativeProductBuildDecision {
  const preparedMode = inputs.preparedSelectionMode;
  if (!isNativeProductBuildMode(preparedMode)) {
    return { kind: 'error', message: `Unknown prepared iOS selection mode: ${preparedMode}` };
  }
  const forced = summarizeForcedLanes(parseExecutionLanes(inputs.forcedExecutionLanes));

  let mode: NativeProductBuildMode = preparedMode;
  if (parseExecutionLanes(inputs.fullExecutionLanes).length > 0) {
    mode = 'full';
  } else if (forced.evidenceLane) {
    mode = 'full';
  } else if (preparedMode === 'affected') {
    // The replaced `[[ … ]]` short-circuited, so this input is only required
    // once the affected path is actually reached.
    if (inputs.preparedUiRequired.length === 0) {
      return { kind: 'error', message: 'PREPARED_UI_REQUIRED: parameter null or not set' };
    }
    if (inputs.preparedUiRequired === 'false' && forced.nativeLane) mode = 'full';
  }

  const groups = parseEvidenceGroups(inputs.preparedEvidenceGroups);
  const evidencePlanRequired =
    inputs.preparedNarrowPaywallRequired === 'true' ||
    evidencePlanGroups.some((group) => evidenceGroupRequired(groups, group)) ||
    forced.visualEvidenceLane;

  return { kind: 'resolved', mode, evidencePlanRequired };
}

/** One `$RUNNER_TEMP/example-ios-tests.<run>.<attempt>.*` directory and its entries. */
export interface RunScopedDirectory {
  readonly path: string;
  readonly entries: readonly string[];
}

/** The prefix every temp directory one run attempt owns is named with. */
export function runScopedTempPrefix(runId: string, runAttempt: string): string {
  return `example-ios-tests.${runId}.${runAttempt}.`;
}

export const firstLaunchFailureSuffix = '.first-launch-failure.xcresult';
export const firstLaunchBusySuffix = '.first-launch-busy.log';
export const storekitPrimeSuffix = '.storekit-prime.log';

/**
 * `<directory>/*<suffix>` for each run-scoped directory, as pathname expansion
 * produced it: sorted, and never matching an entry whose name starts with a
 * dot, because a leading `*` does not.
 */
export function runScopedDiagnosticPaths(
  directories: readonly RunScopedDirectory[],
  suffix: string,
): readonly string[] {
  const matched: string[] = [];
  for (const directory of directories) {
    for (const entry of directory.entries) {
      if (entry.startsWith('.') || !entry.endsWith(suffix)) continue;
      matched.push(`${directory.path}/${entry}`);
    }
  }
  return matched.sort();
}

export interface NativeDiagnosticInputs {
  readonly resultBundle: string;
  readonly xcodebuildLog: string;
  readonly storekitResultBundle: string;
  readonly storekitXcodebuildLog: string;
  readonly runScopedDirectories: readonly RunScopedDirectory[];
}

/**
 * Every diagnostic the native producer would retain on the runner, in the
 * order the replaced `for` loop offered them. A blank path stands for a
 * variable an earlier failure left unset; the caller drops it along with any
 * path that does not exist, exactly as `[ -e "$path" ]` did.
 */
export function nativeProducerDiagnosticCandidates(
  inputs: NativeDiagnosticInputs,
): readonly string[] {
  return [
    inputs.resultBundle,
    ...runScopedDiagnosticPaths(inputs.runScopedDirectories, firstLaunchFailureSuffix),
    inputs.xcodebuildLog,
    ...runScopedDiagnosticPaths(inputs.runScopedDirectories, firstLaunchBusySuffix),
    ...runScopedDiagnosticPaths(inputs.runScopedDirectories, storekitPrimeSuffix),
    inputs.storekitResultBundle,
    inputs.storekitXcodebuildLog,
  ];
}

export const noLocalEvidenceMessage =
  'The native diagnostics upload failed and no local evidence exists.';

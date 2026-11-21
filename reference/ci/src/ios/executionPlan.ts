/**
 * Every decision the `test-ios-execution` job used to make in shell, as pure
 * functions over plain values.
 *
 * The job selects a lane's tests, shards the evidence groups, restores the
 * precompiled products, orchestrates simctl and xcodebuild across one main
 * lane and its supplemental evidence groups, then summarizes, validates and
 * hands its simulators back. The orchestration is unavoidably impure, but the
 * *decisions* — which selection mode a forced lane implies, which evidence
 * group a shard owns, which paths the restored products export, which
 * `-only-testing` identifiers a selection mode implies, how many results each
 * group must produce, which evidence a validator is handed, and which non-zero
 * status the step exits with — are not. They live here so they can be tested
 * without a Mac, a simulator or a compiled test product.
 *
 * The programs under `ci/src/actions/ios/` are the only callers that perform
 * I/O; every other consumer should import these functions directly.
 */

/** What the lane prologue does before the evidence groups are considered. */
export type LaneRoute =
  /** native2/3/4: run the main shards and exit with their status. */
  | { readonly kind: 'main-tests-only' }
  /** native1 without the account-update group: run the main shards, then exit 0. */
  | { readonly kind: 'main-tests-then-stop' }
  /** native1 owning account-update: run the main shards, then fall through as an evidence lane. */
  | { readonly kind: 'main-tests-then-evidence' }
  /** evidence-*: no main shards, straight to the evidence groups. */
  | { readonly kind: 'evidence-only' }
  /** Anything else fails closed with the shell's own annotation. */
  | { readonly kind: 'unknown-lane'; readonly message: string };

/**
 * Splits `IOS_EVIDENCE_GROUPS` the way the shell's `case ",$groups,"` did.
 * Empty entries are dropped so a trailing comma cannot own a group.
 */
export function parseEvidenceGroups(raw: string | undefined): readonly string[] {
  return (raw ?? '').split(',').map((group) => group.trim()).filter((group) => group.length > 0);
}

/** The shell's `evidence_group_required`: exact membership, never a substring. */
export function evidenceGroupRequired(groups: readonly string[], group: string): boolean {
  return groups.includes(group);
}

export function routeCiLane(lane: string, groups: readonly string[]): LaneRoute {
  switch (lane) {
    case 'native1':
      return evidenceGroupRequired(groups, 'account-update')
        ? { kind: 'main-tests-then-evidence' }
        : { kind: 'main-tests-then-stop' };
    case 'native2':
    case 'native3':
    case 'native4':
      return { kind: 'main-tests-only' };
    case 'evidence':
      return { kind: 'evidence-only' };
    default:
      return { kind: 'unknown-lane', message: `::error::Unknown iOS CI lane: ${lane}` };
  }
}

/** `${destination##*id=}`: everything after the final `id=`, or the whole value. */
export function simulatorUdidFromDestination(destination: string): string {
  const marker = destination.lastIndexOf('id=');
  return marker === -1 ? destination : destination.slice(marker + 'id='.length);
}

export interface EvidenceXcodebuildRequest {
  readonly testProducts: string;
  readonly testPlan: string;
  readonly configuration: string;
  readonly destination: string;
  readonly resultBundle: string;
  readonly identifiers: readonly string[];
}

/**
 * The argument vector every supplemental evidence run shares. The step used to
 * repeat these flags per group, so a group that drifted on
 * `-parallel-testing-enabled` or `-only-test-configuration` produced evidence
 * nobody could compare; there is one vector now and the groups vary only in
 * their products, plan, configuration, destination, bundle and identifiers.
 * XCTest still writes test results and attachments to `-resultBundlePath` and
 * the caller still records xcodebuild output. Suppressing automatic verbose
 * failure diagnostics (including sysdiagnose) avoids Xcode waiting ten minutes
 * after tests finish when its diagnostic process stops responding.
 */
export function evidenceXcodebuildArguments(
  request: EvidenceXcodebuildRequest,
): readonly string[] {
  return [
    'test-without-building',
    '-testProductsPath', request.testProducts,
    '-testPlan', request.testPlan,
    '-only-test-configuration', request.configuration,
    '-destination', request.destination,
    '-parallel-testing-enabled', 'NO',
    '-collect-test-diagnostics', 'never',
    '-resultBundlePath', request.resultBundle,
    ...request.identifiers.map((identifier) => `-only-testing:${identifier}`),
  ];
}

/**
 * Owned simulators that must be shut down before `selected` is prepared.
 * Empty entries and the selection itself are skipped, exactly as the shell's
 * `[ -n ... ] || continue` and `[ "$owned" = "$selected" ] && continue` did.
 */
export function simulatorsToRelease(owned: readonly string[], selected: string): readonly string[] {
  return owned.filter((udid) => udid.length > 0 && udid !== selected);
}

export type SimulatorStateVerdict =
  | { readonly kind: 'ready' }
  | { readonly kind: 'unverifiable'; readonly message: string }
  | { readonly kind: 'still-running'; readonly message: string };

/** The shell's post-shutdown state check, with `jq -e`'s null-is-failure semantics. */
export function verifySimulatorStopped(
  udid: string,
  state: string | undefined,
  label: string,
): SimulatorStateVerdict {
  if (state === undefined || state.length === 0) {
    return {
      kind: 'unverifiable',
      message: `::error::Could not verify simulator ${udid} stopped before ${label}.`,
    };
  }
  if (state !== 'Shutdown') {
    return {
      kind: 'still-running',
      message: `::error::Simulator ${udid} remained ${state} before ${label}.`,
    };
  }
  return { kind: 'ready' };
}

/** Account-update identifiers this lane owns in `affected` mode. */
export function ownsAccountUpdateIdentifier(identifier: string): boolean {
  return identifier.startsWith('example-iosUITests/ActivationIntroManageAccounts')
    || identifier.startsWith('example-iosUITests/CardAccountUpdateReturn');
}

/** The complete account-update suite a `full` selection runs. */
export const fullAccountUpdateTestIdentifiers: readonly string[] = [
  'example-iosUITests/ActivationIntroManageAccountsCancelUITests',
  'example-iosUITests/ActivationIntroManageAccountsFailureUITests',
  'example-iosUITests/ActivationIntroManageAccountsFinishUpdateUITests',
  'example-iosUITests/ActivationIntroManageAccountsRapidTapUITests',
  'example-iosUITests/CardAccountUpdateReturnCashSavingsUITests',
  'example-iosUITests/CardAccountUpdateReturnDebtUITests',
  'example-iosUITests/CardAccountUpdateReturnEmptyStateUITests',
  'example-iosUITests/CardAccountUpdateReturnEmployerRetirementUITests',
  'example-iosUITests/CardAccountUpdateReturnIncomeUITests',
  'example-iosUITests/CardAccountUpdateReturnProfileUITests',
  'example-iosUITests/CardAccountUpdateReturnHomeOwnershipUITests',
  'example-iosUITests/CardAccountUpdateReturnInvestmentRateUITests',
  'example-iosUITests/CardAccountUpdateReturnIRAUITests',
  'example-iosUITests/CardAccountUpdateReturnNonRetirementUITests',
  'example-iosUITests/CardAccountUpdateReturnOfflineFailureUITests',
  'example-iosUITests/CardAccountUpdateReturnPersonalPropertyUITests',
  'example-iosUITests/CardAccountUpdateReturnWealthGoalsUITests',
];

export type TestIdentifierSelection =
  | { readonly ok: true; readonly identifiers: readonly string[] }
  | { readonly ok: false; readonly message: string };

const affectedAccountUpdateFailure =
  '::error::Affected account-update evidence selected with zero owned account-update identifiers.';

/**
 * Account-update identifiers for the selection mode. `affected` fails closed
 * when the lane owns none, so a shard never reports a green empty run.
 */
export function accountUpdateTestIdentifiers(
  selectionMode: string,
  onlyTestingIdentifiers: readonly string[],
): TestIdentifierSelection {
  if (selectionMode === 'affected') {
    const owned = onlyTestingIdentifiers.filter(ownsAccountUpdateIdentifier);
    if (owned.length === 0) return { ok: false, message: affectedAccountUpdateFailure };
    return { ok: true, identifiers: owned };
  }
  if (selectionMode === 'full') return { ok: true, identifiers: fullAccountUpdateTestIdentifiers };
  return {
    ok: false,
    message: `::error::Unsupported account-update selection mode: ${selectionMode}`,
  };
}

// Measured from successful run 35848851956. Keeping whole classes on one
// runner preserves their shared fixture and makes both halves about 12 minutes.
const accountUpdateFirstShard = new Set([
  'ActivationIntroManageAccountsCancelUITests',
  'ActivationIntroManageAccountsFailureUITests',
  'ActivationIntroManageAccountsFinishUpdateUITests',
  'CardAccountUpdateReturnCashSavingsUITests',
  'CardAccountUpdateReturnEmployerRetirementUITests',
  'CardAccountUpdateReturnHomeOwnershipUITests',
  'CardAccountUpdateReturnIncomeUITests',
  'CardAccountUpdateReturnOfflineFailureUITests',
]);
const accountUpdateSecondShard = new Set([
  'ActivationIntroManageAccountsRapidTapUITests',
  'CardAccountUpdateReturnDebtUITests',
  'CardAccountUpdateReturnEmptyStateUITests',
  'CardAccountUpdateReturnIRAUITests',
  'CardAccountUpdateReturnInvestmentRateUITests',
  'CardAccountUpdateReturnNonRetirementUITests',
  'CardAccountUpdateReturnPersonalPropertyUITests',
  'CardAccountUpdateReturnProfileUITests',
  'CardAccountUpdateReturnWealthGoalsUITests',
]);
const accountUpdateClassCounts: Readonly<Record<string, number>> = {
  CardAccountUpdateReturnEmployerRetirementUITests: 4,
  CardAccountUpdateReturnProfileUITests: 2,
};

export type AccountUpdateShard = 'evidence-account-update' | 'evidence-account-update-2';

export function accountUpdateShardSelection(
  selectionMode: string,
  onlyTestingIdentifiers: readonly string[],
  lane: AccountUpdateShard,
): EvidenceRunSelection | undefined {
  const selection = accountUpdateTestIdentifiers(selectionMode, onlyTestingIdentifiers);
  if (!selection.ok) return undefined;
  const classes = lane === 'evidence-account-update'
    ? accountUpdateFirstShard : accountUpdateSecondShard;
  const identifiers = selection.identifiers.filter((identifier) =>
    classes.has(identifier.split('/')[1] ?? '')
  );
  const unknown = selection.identifiers.filter((identifier) =>
    !accountUpdateFirstShard.has(identifier.split('/')[1] ?? '') &&
    !accountUpdateSecondShard.has(identifier.split('/')[1] ?? '')
  );
  if (unknown.length > 0) {
    throw new Error(`Unassigned account-update tests: ${unknown.join(', ')}`);
  }
  if (identifiers.length === 0) return undefined;
  return {
    identifiers,
    expectedTestCount: identifiers.reduce((count, identifier) =>
      count + (identifier.split('/').length === 2
        ? accountUpdateClassCounts[identifier.split('/')[1] ?? ''] ?? 1 : 1), 0,
    ),
    label: 'Account update acceptance',
  };
}

export interface EvidenceRunSelection {
  readonly identifiers: readonly string[];
  readonly expectedTestCount: number;
  readonly label: string;
}

const accessibilityMatrixIdentifier =
  'example-iosUITests/OnboardingCopyAccessibilityEvidenceUITests/testCaptureOnboardingCopyAccessibilityMatrix';
const narrowPaywallIdentifier =
  'example-iosUITests/SubscriptionCTACopyEvidenceUITests/testAccessibilityTextKeepsEveryBenefitReadableAboveStickyCTA';

/**
 * The accessibility evidence run. The narrow-paywall group owns the paywall
 * method on its own dedicated bundle, so when that group runs this one drops
 * the method rather than capturing it twice; an onboarding-copy shard that
 * does not also own `accessibility` runs only the onboarding matrix.
 */
export function accessibilityEvidenceSelection(
  groups: readonly string[],
  narrowPaywallRequired: boolean,
): EvidenceRunSelection {
  const onboardingCopyOnly = evidenceGroupRequired(groups, 'onboarding-copy')
    && !evidenceGroupRequired(groups, 'accessibility');
  if (onboardingCopyOnly) {
    return {
      identifiers: [accessibilityMatrixIdentifier],
      expectedTestCount: 1,
      label: 'Onboarding copy accessibility evidence',
    };
  }
  const identifiers = [
    'example-iosTests/ExampleInsightFoundationIncompleteTests/testCaptureAccessibilityVisualEvidence',
    accessibilityMatrixIdentifier,
    'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureChangedCoachMarksAndCanonicalReadyResponse',
    ...(narrowPaywallRequired ? [] : [narrowPaywallIdentifier]),
    'example-iosUITests/SharedCTAAccessibilityEvidenceUITests/testCaptureSharedCTAAccessibilityEvidence',
  ];
  return { identifiers, expectedTestCount: identifiers.length, label: 'Accessibility evidence' };
}

/** True when the accessibility group runs at all on this shard. */
export function accessibilityEvidenceRequired(groups: readonly string[]): boolean {
  return evidenceGroupRequired(groups, 'accessibility')
    || evidenceGroupRequired(groups, 'onboarding-copy');
}

export const narrowPaywallEvidenceSelection: EvidenceRunSelection = {
  identifiers: [narrowPaywallIdentifier],
  expectedTestCount: 1,
  label: 'Narrow paywall accessibility',
};

/**
 * The three names xcodebuild is given. Single-sourced because an evidence run
 * that drifts onto another configuration or plan captures screenshots at the
 * wrong content size and the mismatch only shows up in a reviewed screenshot.
 */
export const mainTestConfiguration = 'CI Configuration';
export const accessibilityEvidenceConfiguration = 'Accessibility Evidence Configuration';
export const evidenceTestPlan = 'CI-Evidence';

/** Which compiled product bundle a run executes from. */
export type EvidenceProducts = 'main' | 'evidence';

export interface EvidenceGroupRun {
  readonly group: string;
  readonly products: EvidenceProducts;
  readonly testPlan: string;
  readonly configuration: string;
  readonly selection: EvidenceRunSelection;
}

export interface EvidenceManifestInput {
  readonly groups: readonly string[];
  readonly narrowPaywallRequired: boolean;
  readonly selectionMode: string;
  readonly onlyTestingIdentifiers: readonly string[];
  /** `IOS_TEST_PLAN`, which only the account-update run executes against. */
  readonly mainTestPlan: string;
  readonly lane?: AccountUpdateShard;
}

/**
 * Every XCTest run a shard would start, in execution order. The lane program
 * drives the runs itself because each one also decides a status; this manifest
 * is the same set of runs as data, so a reviewer, a test or a later step can
 * ask what a shard will execute without starting a simulator.
 */
export function evidenceRunManifest(input: EvidenceManifestInput): readonly EvidenceGroupRun[] {
  const runs: EvidenceGroupRun[] = [];
  const evidenceRun = (
    group: string,
    configuration: string,
    selection: EvidenceRunSelection,
  ): EvidenceGroupRun => ({
    group, products: 'evidence', testPlan: evidenceTestPlan, configuration, selection,
  });

  if (input.narrowPaywallRequired) {
    runs.push(evidenceRun(
      'narrow-paywall', accessibilityEvidenceConfiguration, narrowPaywallEvidenceSelection,
    ));
  }
  if (evidenceGroupRequired(input.groups, 'account-update')) {
    const fullSelection = accountUpdateTestIdentifiers(input.selectionMode, input.onlyTestingIdentifiers);
    const selection = input.lane
      ? accountUpdateShardSelection(input.selectionMode, input.onlyTestingIdentifiers, input.lane)
      : fullSelection.ok ? {
        identifiers: fullSelection.identifiers,
        expectedTestCount: fullSelection.identifiers.length,
        label: 'Account update acceptance',
      } : undefined;
    if (selection) {
      runs.push({
        group: 'account-update',
        products: 'main',
        testPlan: input.mainTestPlan,
        configuration: mainTestConfiguration,
        selection,
      });
    }
  }
  if (accessibilityEvidenceRequired(input.groups)) {
    runs.push(evidenceRun(
      'accessibility',
      accessibilityEvidenceConfiguration,
      accessibilityEvidenceSelection(input.groups, input.narrowPaywallRequired),
    ));
  }
  return runs;
}

/** Every evidence group a shard can be handed, in the order they execute. */
export const evidenceGroupNames: readonly string[] = [
  'account-update',
  'accessibility',
  'onboarding-copy',
];

export type DiskHeadroomDecision =
  | { readonly kind: 'invalid-minimum'; readonly message: string }
  | { readonly kind: 'unmeasurable'; readonly message: string }
  | { readonly kind: 'wipe-cache'; readonly message: string; readonly minimumKb: number }
  | {
    readonly kind: 'preserve-cache';
    readonly message: string;
    readonly availableKb: number;
    readonly minimumKb: number;
  };

const positiveInteger = /^[1-9][0-9]*$/;
const nonNegativeInteger = /^[0-9]+$/;

/**
 * Whether the persistent build cache must be discarded before XCTest starts.
 * The minimum is validated with the shell's own regexes so a blank or padded
 * value fails closed instead of comparing as zero.
 */
export function diskHeadroomDecision(
  rawMinimumKb: string,
  rawAvailableKb: string,
): DiskHeadroomDecision {
  if (!positiveInteger.test(rawMinimumKb)) {
    return {
      kind: 'invalid-minimum',
      message: '::error::IOS_TEST_EXECUTION_MIN_FREE_KB must be a positive integer.',
    };
  }
  const minimumKb = Number(rawMinimumKb);
  if (!nonNegativeInteger.test(rawAvailableKb)) {
    return {
      kind: 'unmeasurable',
      message: '::error::Unable to determine free disk before iOS test execution.',
    };
  }
  const availableKb = Number(rawAvailableKb);
  if (availableKb < minimumKb) {
    return {
      kind: 'wipe-cache',
      message: 'Low disk before XCTest; discarding the current persistent build cache once.',
      minimumKb,
    };
  }
  return {
    kind: 'preserve-cache',
    message: `Preserving the persistent iOS build cache with ${availableKb} KB free.`,
    availableKb,
    minimumKb,
  };
}

export type HeadroomVerdict =
  | { readonly kind: 'sufficient' }
  | { readonly kind: 'insufficient'; readonly message: string; readonly status: number }
  | { readonly kind: 'unreadable'; readonly message: string; readonly status: number };

/**
 * The post-cleanup headroom check. A re-measurement the shell could not parse
 * reproduced `[`'s own exit status 2 rather than a clean failure, so the
 * status is reported here instead of being collapsed into 1.
 */
export function headroomVerdict(rawAvailableKb: string, minimumKb: number): HeadroomVerdict {
  if (!nonNegativeInteger.test(rawAvailableKb)) {
    return {
      kind: 'unreadable',
      message: `::error::iOS test execution free disk was unreadable: '${rawAvailableKb}'.`,
      status: 2,
    };
  }
  const availableKb = Number(rawAvailableKb);
  if (availableKb < minimumKb) {
    return {
      kind: 'insufficient',
      message:
        `::error::iOS test execution has ${availableKb} KB free; ${minimumKb} KB is required.`,
      status: 1,
    };
  }
  return { kind: 'sufficient' };
}

/** `df -Pk <path>`'s available-kilobytes column, or undefined when absent. */
export function parseAvailableKilobytes(dfOutput: string): string {
  const secondLine = dfOutput.split('\n')[1] ?? '';
  return secondLine.trim().split(/\s+/)[3] ?? '';
}

/** The StoreKit lane outcome recorded as a step output. */
export function storekitResult(
  required: boolean,
  status: number,
): 'skipped' | 'success' | 'failure' {
  if (!required) return 'skipped';
  return status === 0 ? 'success' : 'failure';
}

/**
 * The same verdict from a GitHub step `outcome`, which is how the producer job
 * records a StoreKit run it let continue on error. Anything but `success` —
 * `failure`, `cancelled`, or the empty string a skipped step renders — is a
 * failure once the lane was required.
 */
export function storekitStepResult(
  required: boolean,
  outcome: string,
): 'skipped' | 'success' | 'failure' {
  return storekitResult(required, outcome === 'success' ? 0 : 1);
}

export interface LaneStatuses {
  readonly main: number;
  readonly storekit: number;
  readonly executedGroups: number;
  readonly narrowPaywall: number;
  readonly accountUpdate: number;
  readonly accessibility: number;
}

/** The single summary line the job log is grepped for. */
export function laneStatusSummary(statuses: LaneStatuses): string {
  return `lane status: main=${statuses.main} storekit=${statuses.storekit}`
    + ` executed-groups=${statuses.executedGroups}`
    + ` narrow-paywall=${statuses.narrowPaywall}`
    + ` account-update=${statuses.accountUpdate}`
    + ` accessibility=${statuses.accessibility}`;
}

/**
 * The order the shell exited in. Every group runs before any of them can end
 * the step, so one failing group never hides another group's diagnostics.
 */
export const laneExitPrecedence: readonly (keyof LaneStatuses)[] = [
  'main',
  'storekit',
  'narrowPaywall',
  'accountUpdate',
  'accessibility',
];

export function laneExitStatus(statuses: LaneStatuses): number {
  for (const key of laneExitPrecedence) {
    const status = statuses[key];
    if (status !== 0) return status;
  }
  return 0;
}

/**
 * Fails an evidence lane that was handed groups but recognized none of them,
 * so a renamed group is a red lane rather than a silent green one.
 */
export function unrecognizedEvidenceSelection(
  rawGroups: string | undefined,
  executedGroups: number,
): string | undefined {
  if ((rawGroups ?? '').length === 0 || executedGroups !== 0) return undefined;
  return '::error::Evidence lane did not recognize or execute any selected evidence'
    + ` group: ${rawGroups ?? '<empty>'}`;
}

const setupTimeoutRejection =
  'IOS_CI_SETUP_TIMEOUT_SECONDS must be positive and cannot extend setup deadlines';

/** `IOS_CI_SETUP_TIMEOUT_SECONDS` may only shorten a setup deadline. */
export function resolveSetupTimeoutSeconds(
  requested: number,
  override: string | undefined,
): number {
  if (override === undefined || override.length === 0) return requested;
  if (!nonNegativeInteger.test(override)) {
    throw new Error(setupTimeoutRejection);
  }
  const seconds = Number(override);
  if (seconds <= 0 || seconds > requested) {
    throw new Error(setupTimeoutRejection);
  }
  return seconds;
}

/* ── The lane's prologue: which tests this matrix entry runs ────────────── */

export type NativeSelectionMode = 'skip' | 'affected' | 'full';

export type LaneSelectionOutcome =
  | { readonly ok: true; readonly mode: NativeSelectionMode }
  | { readonly ok: false; readonly message: string };

/** The four main shards; anything else forced into a main lane is a defect. */
const nativeExecutionLanes: readonly string[] = ['native1', 'native2', 'native3', 'native4'];

/** Evidence is retained per lane, so a forced evidence lane reruns whole. */
const retainedEvidenceLanes: readonly string[] = [
  'evidence-account-update', 'evidence-account-update-2', 'evidence-visual',
];

export interface LaneSelectionInput {
  /** `native_mode` from the gate: the selection the whole run prepared. */
  readonly preparedMode: string;
  /** `native_ui_required`; only consulted when a main lane is forced. */
  readonly preparedUiRequired: string;
  /** This lane appears in `rerun_ios_lanes`: retained evidence must rerun. */
  readonly forcedLane: boolean;
  /** This lane appears in `native_full_execution_lanes`. */
  readonly forceFullLane: boolean;
  readonly lane: string;
}

/**
 * The selection mode one matrix entry runs in.
 *
 * A forced lane may not degrade into a skip: retained evidence is kept at lane
 * granularity, so an unrelated affected-UI delta must not turn a rerun of that
 * lane into a no-op, and a main shard forced without a prepared UI selection
 * has nothing affected to run and therefore runs whole.
 */
export function laneSelectionMode(input: LaneSelectionInput): LaneSelectionOutcome {
  if (!['skip', 'affected', 'full'].includes(input.preparedMode)) {
    return {
      ok: false,
      message: `::error::Unknown prepared iOS selection mode: ${input.preparedMode}`,
    };
  }
  let mode = input.preparedMode as NativeSelectionMode;
  if (input.forcedLane) {
    if (retainedEvidenceLanes.includes(input.lane)) {
      mode = 'full';
    } else if (nativeExecutionLanes.includes(input.lane)) {
      if (input.preparedUiRequired.length === 0) {
        return {
          ok: false,
          message: '::error::PREPARED_UI_REQUIRED is required to force a native lane.',
        };
      }
      if (mode === 'skip' || input.preparedUiRequired === 'false') mode = 'full';
    } else {
      return { ok: false, message: `::error::Unknown iOS execution lane: ${input.lane}` };
    }
  }
  if (input.forceFullLane) mode = 'full';
  return { ok: true, mode };
}

export type EvidenceShardOutcome =
  | { readonly ok: true; readonly groups: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * The evidence groups one shard owns, in the order the selector listed them.
 *
 * The two account-update lanes carry their disjoint selections; `evidence-visual`
 * carries everything but account-update. Every other lane owns no evidence,
 * and an evidence shard left with nothing fails closed rather than reporting a
 * green run that captured no evidence at all.
 */
export function evidenceShardGroups(
  lane: string,
  allGroups: readonly string[],
  accountUpdateRequired: boolean,
): EvidenceShardOutcome {
  const selected: string[] = [];
  for (const group of allGroups) {
    if ((lane === 'evidence-account-update' || lane === 'evidence-account-update-2') &&
      group === 'account-update' && accountUpdateRequired) selected.push(group);
    if (lane === 'evidence-visual' && group !== 'account-update') selected.push(group);
  }
  if (lane.startsWith('evidence-') && selected.length === 0) {
    return { ok: false, message: `::error::Evidence shard ${lane} has no selected group.` };
  }
  return { ok: true, groups: selected };
}

/* ── Restoring the exact-head native test products ──────────────────────── */

export type ToolchainVerdict =
  /** The producer's Xcode matches; the restored products are usable as they are. */
  | { readonly kind: 'ready' }
  /** Exit 3: the consumer's Xcode differs and the lane rebuilds instead. */
  | { readonly kind: 'rebuild' }
  | { readonly kind: 'failed'; readonly status: number };

/** `verifyTestProductToolchainReceipt` result, as a decision. */
export function toolchainVerdict(status: number): ToolchainVerdict {
  if (status === 3) return { kind: 'rebuild' };
  if (status === 0) return { kind: 'ready' };
  return { kind: 'failed', status };
}

export interface NativeProductPathsInput {
  /** The lane's private result directory under `$RUNNER_TEMP`. */
  readonly runDir: string;
  /** The unpacked `example-ios-native-products` stage directory. */
  readonly stage: string;
}

/**
 * Every path the restored products export into `$GITHUB_ENV`, in the order the
 * step has always written them.
 *
 * `scripts/build-ios-ci-test-products.sh` exports this same set when a
 * consumer's Xcode forces a rebuild; a path present in one and missing from
 * the other only fails on a runner whose Xcode differs from the producer's,
 * which is why the set is data both sides can be compared against.
 */
export function nativeTestProductEnvironment(
  input: NativeProductPathsInput,
): ReadonlyMap<string, string> {
  const { runDir, stage } = input;
  return new Map([
    ['IOS_TEST_RUN_DIR', runDir],
    ['IOS_TEST_PRODUCTS', `${stage}/example-ios-tests.xctestproducts`],
    ['IOS_EVIDENCE_TEST_PRODUCTS', `${stage}/example-ios-evidence-tests.xctestproducts`],
    ['IOS_TEST_PLAN', 'CI'],
    ['IOS_TEST_RESULT_BUNDLE', `${runDir}/example-ios-tests.xcresult`],
    ['IOS_TEST_XCODEBUILD_LOG', `${runDir}/xcodebuild.log`],
    ['IOS_STOREKIT_RESULT_BUNDLE', `${runDir}/example-ios-storekit-results`],
    ['IOS_STOREKIT_XCODEBUILD_LOG', `${runDir}/storekit-xcodebuild.log`],
    ['IOS_ACCOUNT_UPDATE_RESULT_BUNDLE', `${runDir}/example-ios-account-update-tests.xcresult`],
    ['IOS_ACCESSIBILITY_TEST_RESULT_BUNDLE', `${runDir}/example-ios-accessibility-tests.xcresult`],
    ['IOS_NARROW_PAYWALL_RESULT_BUNDLE', `${runDir}/narrow-paywall-lane.xcresult`],
    ['IOS_ACCOUNT_UPDATE_XCODEBUILD_LOG', `${runDir}/account-update-xcodebuild.log`],
    ['IOS_ACCESSIBILITY_XCODEBUILD_LOG', `${runDir}/accessibility-xcodebuild.log`],
    ['IOS_NARROW_PAYWALL_XCODEBUILD_LOG', `${runDir}/narrow-paywall-lane-xcodebuild.log`],
  ]);
}

/** `$(git rev-parse HEAD)` against the head the whole run was planned for. */
export function checkedOutRevisionRejection(
  checkedOutSha: string,
  expectedHeadSha: string,
): string | undefined {
  if (checkedOutSha === expectedHeadSha) return undefined;
  return `::error::Checked out ${checkedOutSha}, expected exact head ${expectedHeadSha}.`;
}

/* ── Reporting what the lane produced ───────────────────────────────────── */

export interface FailureSummaryTarget {
  readonly resultBundle: string;
  readonly xcodebuildLog: string;
  /** Only summarized when the bundle exists; the main lane's is unconditional. */
  readonly whenPresent: boolean;
}

export interface FailureSummaryInput {
  readonly runnerTemp: string;
  readonly resultBundle: string;
  readonly xcodebuildLog: string;
  readonly accountUpdateResultBundle: string;
  readonly accountUpdateXcodebuildLog: string;
  readonly accessibilityResultBundle: string;
  readonly accessibilityXcodebuildLog: string;
  readonly narrowPaywallResultBundle: string;
  readonly narrowPaywallXcodebuildLog: string;
}

/**
 * Which result bundles the failure summarizer is pointed at, in order.
 *
 * The main lane's bundle is summarized unconditionally and falls back to the
 * default paths, so a lane that failed before it reached test products still
 * produces a summary; every supplemental group is summarized only when its own
 * bundle exists, because a shard that did not own the group never wrote one.
 */
export function failureSummaryTargets(
  input: FailureSummaryInput,
): readonly FailureSummaryTarget[] {
  const present = (resultBundle: string, xcodebuildLog: string): FailureSummaryTarget => ({
    resultBundle, xcodebuildLog, whenPresent: true,
  });
  return [
    {
      resultBundle: input.resultBundle.length > 0
        ? input.resultBundle
        : `${input.runnerTemp}/example-ios-tests.xcresult`,
      xcodebuildLog: input.xcodebuildLog.length > 0
        ? input.xcodebuildLog
        : `${input.runnerTemp}/example-ios-xcodebuild.log`,
      whenPresent: false,
    },
    present(input.accountUpdateResultBundle, input.accountUpdateXcodebuildLog),
    present(input.accessibilityResultBundle, input.accessibilityXcodebuildLog),
    present(input.narrowPaywallResultBundle, input.narrowPaywallXcodebuildLog),
  ];
}

/* ── Validating the evidence a shard captured ───────────────────────────── */

export type EvidenceValidation = 'financial-independence' | 'onboarding-copy';

export interface EvidenceValidationInputs {
  readonly resultBundle: string;
  readonly xcodebuildLog: string;
  readonly exactHeadSha: string;
}

export interface EvidenceValidationPlan {
  /** The validator's path, relative to the repository root. */
  readonly validator: string;
  readonly arguments: readonly string[];
  /** A provenance line appended to an xcodebuild log before validation. */
  readonly provenance?: { readonly path: string; readonly line: string };
}

export type EvidenceValidationDecision =
  | { readonly ok: true; readonly plan: EvidenceValidationPlan }
  | { readonly ok: false; readonly message: string };

/**
 * The directory beside `path`, with the POSIX semantics the step's
 * `$(dirname …)` had — except that a bundle directly under `/` yields
 * `/screenshots` rather than the `//screenshots` the shell's plain
 * concatenation produced.
 */
function siblingDirectory(path: string, name: string): string {
  const marker = path.lastIndexOf('/');
  if (marker === -1) return `./${name}`;
  return `${path.slice(0, marker)}/${name}`;
}

const evidenceLabels: Readonly<Record<EvidenceValidation, string>> = {
  'financial-independence': 'financial independence',
  'onboarding-copy': 'onboarding-copy',
};

/**
 * A lane that never reached test products has no result bundle to derive its
 * screenshot directory from. Naming the evidence in the annotation is what
 * distinguishes "setup failed" from "the evidence is wrong", which read
 * identically when the validator was handed an empty directory instead.
 */
function missingEvidenceRejection(kind: EvidenceValidation): string {
  return `::error::Required ${evidenceLabels[kind]} evidence is unavailable because iOS setup`
    + ' did not reach test-product preparation.';
}

/**
 * Which validator a shard runs and exactly which evidence it is handed.
 *
 * Each validator reads the screenshots beside the lane's own result bundle, so
 * the directory is derived once here rather than restated per step; a lane
 * that reached no test products has no bundle to derive it from and is a
 * missing-evidence failure rather than a validation of an empty directory.
 */
export function evidenceValidationPlan(
  kind: EvidenceValidation,
  inputs: EvidenceValidationInputs,
): EvidenceValidationDecision {
  if (inputs.resultBundle.length === 0) {
    return { ok: false, message: missingEvidenceRejection(kind) };
  }
  const screenshots = siblingDirectory(inputs.resultBundle, 'screenshots');
  if (kind === 'financial-independence') {
    return {
      ok: true,
      plan: {
        validator: 'ci/src/actions/ios/validateFinancialIndependenceEvidence.ts',
        arguments: [
          inputs.resultBundle,
          inputs.xcodebuildLog,
          screenshots,
          `${screenshots}/financial-independence-evidence.json`,
          inputs.exactHeadSha,
        ],
        provenance: {
          path: inputs.xcodebuildLog,
          line: `FINANCIAL_INDEPENDENCE_EXACT_HEAD_SHA=${inputs.exactHeadSha}`,
        },
      },
    };
  }
  const accessibility = `${screenshots}/accessibility`;
  return {
    ok: true,
    plan: {
      validator: 'ci/src/actions/ios/validateOnboardingCopyEvidence.ts',
      arguments: [
        accessibility,
        `${accessibility}/issue-4549-evidence.json`,
        inputs.exactHeadSha,
      ],
    },
  };
}

/* ── Retaining evidence on the runner when an upload fails ──────────────── */

/** The lane's own result directories under `$RUNNER_TEMP`, as a name prefix. */
export function laneRunDirectoryPrefix(runId: string, runAttempt: string): string {
  return `example-ios-tests.${runId}.${runAttempt}.`;
}

/**
 * Every diagnostic a failed upload must still leave on the runner, relative to
 * one of the lane's run directories. A `**` entry is matched at any depth, as
 * the step's `globstar` glob did; everything else is an exact child.
 *
 * This is the same inventory the `Upload iOS Test Diagnostics` step lists, so
 * a diagnostic added to one and not the other is retained by neither.
 */
export const diagnosticEvidencePatterns: readonly string[] = [
  'example-ios-tests.xcresult',
  'example-ios-storekit-tests.xcresult',
  'example-ios-account-update-tests.xcresult',
  'example-ios-accessibility-tests.xcresult',
  '**/*.first-launch-failure.xcresult',
  'narrow-paywall-lane.xcresult',
  'xcodebuild.log',
  'build-xcodebuild.log',
  'storekit-xcodebuild.log',
  'account-update-xcodebuild.log',
  'accessibility-xcodebuild.log',
  'narrow-paywall-lane-xcodebuild.log',
  '**/*.first-launch-busy.log',
  '**/*.storekit-prime.log',
];

/** The screenshot directory a failed screenshot upload falls back to. */
export const screenshotEvidencePatterns: readonly string[] = ['screenshots'];

export type RetainedEvidenceKind = 'screenshots' | 'diagnostics';

export interface RetainedEvidence {
  readonly patterns: readonly string[];
  readonly label: string;
  readonly emptyMessage: string;
}

/** What the retention step looks for, and how it reports finding nothing. */
export function retainedEvidence(kind: RetainedEvidenceKind, lane: string): RetainedEvidence {
  if (kind === 'screenshots') {
    return {
      patterns: screenshotEvidencePatterns,
      label: `iOS Test ${lane} screenshots`,
      emptyMessage:
        '::error::The iOS screenshot artifact failed and no local evidence directory exists.',
    };
  }
  return {
    patterns: diagnosticEvidencePatterns,
    label: `iOS Test ${lane} diagnostics`,
    emptyMessage: '::error::The iOS diagnostic upload failed and no local diagnostics exist.',
  };
}

/* ── Handing the lane's simulators back ─────────────────────────────────── */

export interface SimulatorCleanup {
  /** The reclaim script's purpose label, which asserts entry ownership. */
  readonly purpose: string;
  readonly udid: string;
}

export type SimulatorCleanupOutcome =
  | { readonly ok: true; readonly cleanups: readonly SimulatorCleanup[] }
  | { readonly ok: false; readonly message: string };

export interface ProvisionedSimulators {
  readonly primaryUdid: string;
  readonly narrowUdid: string;
}

/**
 * The purpose label each provisioned simulator is released under.
 *
 * The label is not cosmetic: `reclaim-ios-runner-disk.sh simulator` asserts
 * that the entry it removes was provisioned for that purpose, so a `native1`
 * shard that borrowed the evidence narrow device must release it as evidence
 * or the cleanup refuses and fails a lane whose tests already passed.
 */
export function simulatorCleanupPlan(
  lane: string,
  groups: readonly string[],
  simulators: ProvisionedSimulators,
): SimulatorCleanupOutcome {
  let primaryPurpose: string;
  let narrowPurpose: string;
  if (lane === 'main' || nativeExecutionLanes.includes(lane)) {
    primaryPurpose = 'Main';
    narrowPurpose = lane === 'native1' && evidenceGroupRequired(groups, 'account-update')
      ? 'Evidence Narrow'
      : 'Main Narrow';
  } else if (lane === 'evidence') {
    primaryPurpose = 'Evidence';
    narrowPurpose = 'Evidence Narrow';
  } else {
    return { ok: false, message: `::error::Unknown iOS CI lane during simulator cleanup: ${lane}` };
  }
  const cleanups = [
    { purpose: primaryPurpose, udid: simulators.primaryUdid },
    { purpose: narrowPurpose, udid: simulators.narrowUdid },
  ].filter((cleanup) => cleanup.udid.length > 0);
  return { ok: true, cleanups };
}

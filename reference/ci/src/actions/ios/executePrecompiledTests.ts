import { readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { validateXcresultSummary } from '../../ios/xcresultSummary.ts';

import {
  booleanEnv,
  exportStepEnvBlock,
  logLine,
  optionalEnv,
  requiredEnv,
} from '../../ios/shared/actionIo.ts';
import {
  installSignalTraps,
  runCommand,
  terminateActiveProcesses,
} from '../../ios/shared/processRunner.ts';
import {
  iosShellHelperPaths,
  runXcodebuildWithBusyRetry,
  setAndVerifyContentSize,
} from '../../ios/shared/iosShellHelpers.ts';
import type { IosShellHelperPaths } from '../../ios/shared/iosShellHelpers.ts';
import {
  activateOnlySimulator,
  readSimulatorIdentity,
  restoreContentSize,
  restoreContentSizeSync,
} from '../../ios/shared/simulatorControl.ts';
import type { SimulatorControl } from '../../ios/shared/simulatorControl.ts';
import {
  accessibilityEvidenceConfiguration,
  accessibilityEvidenceRequired,
  accessibilityEvidenceSelection,
  accountUpdateShardSelection,
  diskHeadroomDecision,
  evidenceGroupRequired,
  evidenceTestPlan,
  evidenceXcodebuildArguments,
  headroomVerdict,
  mainTestConfiguration,
  laneExitStatus,
  laneStatusSummary,
  narrowPaywallEvidenceSelection,
  parseAvailableKilobytes,
  parseEvidenceGroups,
  routeCiLane,
  simulatorUdidFromDestination,
  unrecognizedEvidenceSelection,
} from '../../ios/executionPlan.ts';
import type {
  EvidenceXcodebuildRequest,
  LaneStatuses,
} from '../../ios/executionPlan.ts';

/**
 * `Execute Precompiled iOS Tests`.
 *
 * Runs the compiled XCTest products for one matrix lane: the main shards on
 * native1-4, and the supplemental evidence groups this shard owns. Every
 * decision comes from `ci/src/ios/executionPlan.ts`; this file performs the
 * I/O — process spawning, result-bundle housekeeping and the step's own
 * signal handling — and nothing else.
 */

const scriptsDirectory = resolve(process.cwd(), '..', 'scripts');
const helpers: IosShellHelperPaths = iosShellHelperPaths(scriptsDirectory);
const scriptPath = (name: string): string => join(scriptsDirectory, name);

interface LanePaths {
  readonly testPlan: string;
  readonly testRunDir: string;
  readonly resultBundle: string;
  readonly storekitResultBundle: string;
  readonly accountUpdateResultBundle: string;
  readonly accessibilityResultBundle: string;
  readonly narrowPaywallResultBundle: string;
  readonly testProducts: string;
  readonly evidenceTestProducts: string;
  readonly xcodebuildLog: string;
  readonly storekitXcodebuildLog: string;
  readonly accountUpdateXcodebuildLog: string;
  readonly accessibilityXcodebuildLog: string;
  readonly narrowPaywallXcodebuildLog: string;
}

function readLanePaths(): LanePaths {
  return {
    testPlan: optionalEnv('IOS_TEST_PLAN', 'CI'),
    testRunDir: requiredEnv('IOS_TEST_RUN_DIR'),
    resultBundle: requiredEnv('IOS_TEST_RESULT_BUNDLE'),
    storekitResultBundle: requiredEnv('IOS_STOREKIT_RESULT_BUNDLE'),
    accountUpdateResultBundle: requiredEnv('IOS_ACCOUNT_UPDATE_RESULT_BUNDLE'),
    accessibilityResultBundle: requiredEnv('IOS_ACCESSIBILITY_TEST_RESULT_BUNDLE'),
    narrowPaywallResultBundle: requiredEnv('IOS_NARROW_PAYWALL_RESULT_BUNDLE'),
    testProducts: requiredEnv('IOS_TEST_PRODUCTS'),
    evidenceTestProducts: requiredEnv('IOS_EVIDENCE_TEST_PRODUCTS'),
    xcodebuildLog: requiredEnv('IOS_TEST_XCODEBUILD_LOG'),
    storekitXcodebuildLog: requiredEnv('IOS_STOREKIT_XCODEBUILD_LOG'),
    accountUpdateXcodebuildLog: requiredEnv('IOS_ACCOUNT_UPDATE_XCODEBUILD_LOG'),
    accessibilityXcodebuildLog: requiredEnv('IOS_ACCESSIBILITY_XCODEBUILD_LOG'),
    narrowPaywallXcodebuildLog: requiredEnv('IOS_NARROW_PAYWALL_XCODEBUILD_LOG'),
  };
}

/**
 * Re-exports the lane's result paths so the diagnostic steps that follow read
 * the same bundles this step wrote, whichever branch produced them.
 */
function exportResultPaths(paths: LanePaths): void {
  exportStepEnvBlock(new Map([
    ['IOS_TEST_RESULT_BUNDLE', paths.resultBundle],
    ['IOS_STOREKIT_RESULT_BUNDLE', paths.storekitResultBundle],
    ['IOS_ACCOUNT_UPDATE_RESULT_BUNDLE', paths.accountUpdateResultBundle],
    ['IOS_ACCESSIBILITY_TEST_RESULT_BUNDLE', paths.accessibilityResultBundle],
    ['IOS_NARROW_PAYWALL_RESULT_BUNDLE', paths.narrowPaywallResultBundle],
    ['IOS_TEST_XCODEBUILD_LOG', paths.xcodebuildLog],
    ['IOS_STOREKIT_XCODEBUILD_LOG', paths.storekitXcodebuildLog],
    ['IOS_ACCOUNT_UPDATE_XCODEBUILD_LOG', paths.accountUpdateXcodebuildLog],
    ['IOS_ACCESSIBILITY_XCODEBUILD_LOG', paths.accessibilityXcodebuildLog],
  ]));
}

const removeAll = (...paths: readonly string[]): void => {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
};

interface EvidenceRun extends EvidenceXcodebuildRequest {
  readonly logFile: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The one XCTest invocation every evidence group shares. The groups differ
 * only in these fields.
 */
async function runEvidenceTests(run: EvidenceRun): Promise<number> {
  const xcodebuildArguments = evidenceXcodebuildArguments(run);
  return runXcodebuildWithBusyRetry(helpers, run.logFile, xcodebuildArguments, {
    cwd: process.cwd(),
    env: run.env ?? process.env,
  });
}

/** `validate-xcresult-summary.sh`: the bundle must hold exactly this many results. */
async function validateResultSummary(
  resultBundle: string,
  expectedTestCount: number | string,
  label: string,
): Promise<number> {
  return validateXcresultSummary(resultBundle, expectedTestCount, label, { cwd: process.cwd() });
}

async function measureAvailableKilobytes(path: string): Promise<string> {
  const result = await runCommand('df', ['-Pk', path], { cwd: process.cwd(), capture: true });
  return result.status === 0 ? parseAvailableKilobytes(result.stdout) : '';
}

/**
 * Frees the persistent build cache when the runner cannot hold both it and a
 * full XCTest run, then refuses to start XCTest below the required headroom.
 */
async function releaseBuildScratch(paths: LanePaths): Promise<number> {
  const rawMinimum = requiredEnv('IOS_TEST_EXECUTION_MIN_FREE_KB');
  const availableAtEntry = await measureAvailableKilobytes(paths.testRunDir);
  const decision = diskHeadroomDecision(rawMinimum, availableAtEntry);
  if (decision.kind === 'invalid-minimum' || decision.kind === 'unmeasurable') {
    logLine(decision.message);
    return 1;
  }
  let availableKb = decision.kind === 'preserve-cache' ? String(decision.availableKb) : '';
  logLine(decision.message);
  if (decision.kind === 'wipe-cache') {
    // A failing wipe is not fatal on its own; the headroom check below is what
    // decides whether the lane may start, exactly as the shell ordered it.
    await runCommand(
      'bash',
      [scriptPath('manage-ios-build-cache.sh'), 'wipe-current', requiredEnv('IOS_CI_CACHE_LANE')],
      { cwd: process.cwd() },
    );
    availableKb = await measureAvailableKilobytes(paths.testRunDir);
  }
  logLine('iOS test execution disk after build scratch cleanup:');
  await runCommand('df', ['-h', paths.testRunDir], { cwd: process.cwd() });
  const verdict = headroomVerdict(availableKb, decision.minimumKb);
  if (verdict.kind === 'sufficient') return 0;
  logLine(verdict.message);
  return verdict.status;
}

interface EvidenceContext {
  readonly paths: LanePaths;
  readonly control: SimulatorControl;
  readonly narrowUdid: string;
  readonly narrowDestination: () => string;
  readonly groups: readonly string[];
  readonly narrowPaywallRequired: boolean;
}

/**
 * Activates the single simulator a group owns and sets its content size.
 * Returns the first non-zero status, so a group never runs on a device that
 * failed to reach the size its evidence is supposed to demonstrate.
 */
async function activateForGroup(
  context: EvidenceContext,
  contentSize: string,
  label: string,
): Promise<number> {
  const activation = await activateOnlySimulator(context.control, context.narrowUdid, label);
  if (activation !== 0) return activation;
  return setAndVerifyContentSize(context.control.helpers, context.narrowUdid, contentSize, label, {
    cwd: process.cwd(),
  });
}

async function runNarrowPaywallEvidence(context: EvidenceContext): Promise<number> {
  const { paths } = context;
  let status = await activateForGroup(context, 'accessibility-extra-large', 'Narrow paywall');
  if (status !== 0) return status;
  // This group owns a dedicated bundle rather than the main lane's result
  // bundle: on native1 the affected-UI partition has already written that
  // bundle, and xcodebuild refuses an existing -resultBundlePath.
  removeAll(paths.narrowPaywallResultBundle, paths.narrowPaywallXcodebuildLog);
  status = await runEvidenceTests({
    logFile: paths.narrowPaywallXcodebuildLog,
    resultBundle: paths.narrowPaywallResultBundle,
    testProducts: paths.evidenceTestProducts,
    testPlan: evidenceTestPlan,
    configuration: accessibilityEvidenceConfiguration,
    destination: context.narrowDestination(),
    identifiers: narrowPaywallEvidenceSelection.identifiers,
  });
  if (status !== 0) return status;
  return validateResultSummary(
    paths.narrowPaywallResultBundle,
    narrowPaywallEvidenceSelection.expectedTestCount,
    narrowPaywallEvidenceSelection.label,
  );
}

/** Test identifiers the lane owns, one per line, as the selector wrote them. */
function readOnlyTestingIdentifiers(): readonly string[] {
  const file = optionalEnv('IOS_ONLY_TESTING_FILE');
  if (file.length === 0) return [];
  try {
    if (statSync(file).size === 0) return [];
  } catch {
    return [];
  }
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);
}

async function runAccountUpdateEvidence(context: EvidenceContext): Promise<number> {
  const { paths } = context;
  let status = await activateForGroup(context, 'large', 'Account update');
  if (status !== 0) return status;
  removeAll(paths.accountUpdateResultBundle);
  const lane = requiredEnv('IOS_MAIN_TEST_PARTITION');
  if (lane !== 'evidence-account-update' && lane !== 'evidence-account-update-2') {
    process.stderr.write(`::error::Account-update evidence has unexpected lane ${lane}.\n`);
    return 1;
  }
  const selection = accountUpdateShardSelection(
    requiredEnv('IOS_TEST_SELECTION_MODE'),
    readOnlyTestingIdentifiers(),
    lane,
  );
  if (!selection) {
    process.stderr.write('::error::Account-update shard has no owned tests.\n');
    return 1;
  }
  status = await runEvidenceTests({
    logFile: paths.accountUpdateXcodebuildLog,
    resultBundle: paths.accountUpdateResultBundle,
    testProducts: paths.testProducts,
    testPlan: paths.testPlan,
    configuration: mainTestConfiguration,
    destination: context.narrowDestination(),
    identifiers: selection.identifiers,
  });
  if (status !== 0) return status;
  return validateResultSummary(
    paths.accountUpdateResultBundle,
    selection.expectedTestCount,
    'Account update acceptance',
  );
}

async function runAccessibilityEvidence(context: EvidenceContext): Promise<number> {
  const { paths } = context;
  const selection = accessibilityEvidenceSelection(context.groups, context.narrowPaywallRequired);
  // The evidence records the device it was captured on, so a screenshot can be
  // read back against a known geometry; an unreadable identity fails the group.
  const identity = await readSimulatorIdentity(context.control, context.narrowUdid);
  let status = identity === undefined ? 1 : 0;
  const activation =
    await activateOnlySimulator(context.control, context.narrowUdid, 'Accessibility');
  if (activation !== 0) status = activation;
  if (status === 0) {
    status = await setAndVerifyContentSize(
      context.control.helpers, context.narrowUdid, 'accessibility-extra-large', 'Accessibility',
      { cwd: process.cwd() },
    );
  }
  removeAll(paths.accessibilityResultBundle, paths.accessibilityXcodebuildLog);
  if (status === 0 && identity !== undefined) {
    status = await runEvidenceTests({
      logFile: paths.accessibilityXcodebuildLog,
      resultBundle: paths.accessibilityResultBundle,
      testProducts: paths.evidenceTestProducts,
      testPlan: evidenceTestPlan,
      configuration: accessibilityEvidenceConfiguration,
      destination: context.narrowDestination(),
      identifiers: selection.identifiers,
      env: {
        ...process.env,
        TEST_RUNNER_ISSUE_4549_EXACT_HEAD_SHA: requiredEnv('EXACT_HEAD_SHA'),
        TEST_RUNNER_ISSUE_4549_DEVICE_NAME: identity.deviceName,
        TEST_RUNNER_ISSUE_4549_DEVICE_MODEL: identity.deviceModel,
        TEST_RUNNER_ISSUE_4549_RUNTIME: identity.runtime,
      },
    });
  }
  if (status !== 0) return status;
  return validateResultSummary(
    paths.accessibilityResultBundle, selection.expectedTestCount, selection.label,
  );
}

interface EvidenceOutcome {
  readonly statuses: Partial<LaneStatuses>;
  readonly executed: number;
}

/**
 * Runs every evidence group this shard owns. Each group records its own status
 * and none of them short-circuits another, so one failure never hides the
 * diagnostics of a group that had not run yet.
 */
async function runEvidenceGroups(context: EvidenceContext): Promise<EvidenceOutcome> {
  const { groups } = context;
  let executed = 0;
  let narrowPaywall = 0;
  let accountUpdate = 0;
  let accessibility = 0;

  if (context.narrowPaywallRequired) {
    executed += 1;
    narrowPaywall = await runNarrowPaywallEvidence(context);
  }

  if (evidenceGroupRequired(groups, 'account-update')) {
    executed += 1;
    accountUpdate = await runAccountUpdateEvidence(context);
  } else {
    logLine('Skipping unowned account-update evidence group.');
  }

  if (accessibilityEvidenceRequired(groups)) {
    executed += 1;
    accessibility = await runAccessibilityEvidence(context);
  } else {
    logLine('Skipping unowned accessibility and onboarding-copy evidence groups.');
  }

  return {
    executed,
    statuses: { narrowPaywall, accountUpdate, accessibility },
  };
}

/** Runs the compiled main shards for a native lane. */
async function runMainTests(): Promise<number> {
  const result = await runCommand('bash', [scriptPath('run-ios-ci-main-tests.sh')], {
    cwd: process.cwd(),
  });
  return result.status;
}

/**
 * What a cancelled or failed lane must still do before the step ends. Replaced
 * once the lane's simulators are known; until then there is nothing to undo.
 */
let releaseOwnedSimulators: () => void = () => { /* no simulator is owned yet. */ };

async function run(): Promise<number> {
  installSignalTraps(() => { releaseOwnedSimulators(); });
  const rawGroups = optionalEnv('IOS_EVIDENCE_GROUPS');
  const groups = parseEvidenceGroups(rawGroups);
  const route = routeCiLane(requiredEnv('IOS_CI_LANE'), groups);
  if (route.kind === 'unknown-lane') {
    logLine(route.message);
    return 1;
  }
  if (route.kind !== 'evidence-only') {
    const mainStatus = await runMainTests();
    if (mainStatus !== 0 || route.kind !== 'main-tests-then-evidence') return mainStatus;
  }

  const paths = readLanePaths();
  exportResultPaths(paths);

  const primaryUdid = simulatorUdidFromDestination(requiredEnv('IOS_PRIMARY_DESTINATION'));
  const narrowDestinationValue = optionalEnv('IOS_NARROW_DESTINATION');
  const narrowUdid = narrowDestinationValue.length === 0
    ? '' : simulatorUdidFromDestination(narrowDestinationValue);
  const control: SimulatorControl = {
    helpers,
    ownedUdids: [primaryUdid, narrowUdid],
    cwd: process.cwd(),
  };

  // Registered before the disk check so a lane that refuses to start still
  // hands its simulators back at the default content size.
  releaseOwnedSimulators = () => { restoreContentSizeSync(control, [primaryUdid, narrowUdid]); };
  const cleanup = async (): Promise<void> => {
    terminateActiveProcesses();
    await restoreContentSize(control, [primaryUdid, narrowUdid]);
  };

  const releaseStatus = await releaseBuildScratch(paths);
  if (releaseStatus !== 0) {
    await cleanup();
    return releaseStatus;
  }

  const context: EvidenceContext = {
    paths,
    control,
    narrowUdid,
    narrowDestination: () => requiredEnv('IOS_NARROW_DESTINATION'),
    groups,
    narrowPaywallRequired: booleanEnv('IOS_NARROW_PAYWALL_REQUIRED'),
  };
  const outcome = await runEvidenceGroups(context);
  await cleanup();

  const unrecognized = unrecognizedEvidenceSelection(rawGroups, outcome.executed);
  if (unrecognized !== undefined) {
    logLine(unrecognized);
    return 1;
  }

  const statuses: LaneStatuses = {
    main: 0,
    storekit: 0,
    executedGroups: outcome.executed,
    narrowPaywall: outcome.statuses.narrowPaywall ?? 0,
    accountUpdate: outcome.statuses.accountUpdate ?? 0,
    accessibility: outcome.statuses.accessibility ?? 0,
  };
  logLine(laneStatusSummary(statuses));
  return laneExitStatus(statuses);
}

run().then((status) => {
  process.exitCode = status;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  terminateActiveProcesses();
  releaseOwnedSimulators();
  process.exitCode = 1;
});

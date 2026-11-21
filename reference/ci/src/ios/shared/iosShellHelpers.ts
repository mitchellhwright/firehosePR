import { join } from 'node:path';

import { runCommand } from './processRunner.ts';
import type { CommandResult } from './processRunner.ts';
import { runSetupCommand } from './setupDeadline.ts';
import { prepareOwnedSimulator, setSimulatorContentSize } from './simulatorPreparation.ts';

/**
 * Only Busy/StoreKit recovery still bridges to a shell state machine. Simulator
 * preparation and deadlines execute directly through their shared typed owners.
 */

const BUSY_RETRY_PROGRAM = [
  'set -o pipefail',
  'source "$1"',
  'log_file="$2"',
  'phase="$3"',
  'shift 3',
  'run_ios_xcodebuild_with_busy_retry "$phase" "$log_file" xcodebuild "$@"',
].join('\n');

/** The phase label the step has always reported for its supplemental runs. */
export const supplementalEvidencePhase = 'Supplemental iOS evidence';

export interface IosShellHelperPaths {
  readonly busyRetry: string;
}

export function iosShellHelperPaths(scriptsDirectory: string): IosShellHelperPaths {
  return {
    busyRetry: join(scriptsDirectory, 'ios-xctrunner-busy-retry.sh'),
  };
}

export interface HelperRunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly capture?: boolean;
}

/**
 * `run_with_timeout <seconds> <command...>`. The helper enforces the deadline
 * and honours `IOS_CI_SETUP_TIMEOUT_SECONDS`, which may only shorten it.
 */
export async function runWithTimeout(
  _helpers: IosShellHelperPaths,
  seconds: number,
  command: readonly string[],
  options: HelperRunOptions = {},
): Promise<CommandResult> {
  return runSetupCommand(seconds, command, options);
}

/** `prepare_simulator <udid> <label>`: boot, retry, erase, verify AutoFill. */
export async function prepareSimulator(
  _helpers: IosShellHelperPaths,
  udid: string,
  label: string,
  options: HelperRunOptions = {},
): Promise<number> {
  return prepareOwnedSimulator(udid, label, options);
}

/** `set_and_verify_content_size <udid> <size> <label>`: set, read back, retry. */
export async function setAndVerifyContentSize(
  _helpers: IosShellHelperPaths,
  udid: string,
  contentSize: string,
  label: string,
  options: HelperRunOptions = {},
): Promise<number> {
  return setSimulatorContentSize(udid, contentSize, label, options);
}

/**
 * `run_ios_xcodebuild_with_busy_retry <phase> <log> xcodebuild <args...>`:
 * primes StoreKit, runs xcodebuild, and retries once after rebooting a
 * simulator that failed its `.xctrunner` preflight with Busy.
 */
export async function runXcodebuildWithBusyRetry(
  helpers: IosShellHelperPaths,
  logFile: string,
  xcodebuildArguments: readonly string[],
  options: HelperRunOptions = {},
  phase: string = supplementalEvidencePhase,
): Promise<number> {
  const result = await runCommand(
    'bash',
    ['-c', BUSY_RETRY_PROGRAM, 'ios-busy-retry',
      helpers.busyRetry, logFile, phase, ...xcodebuildArguments],
    options,
  );
  return result.status;
}

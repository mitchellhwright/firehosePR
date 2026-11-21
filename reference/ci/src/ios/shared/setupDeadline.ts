import { resolveSetupTimeoutSeconds } from '../executionPlan.ts';
import { runCommand, type CommandResult, type RunOptions } from './processRunner.ts';

/** Shared deadline owner for typed lanes and the remaining shell callers. */
export async function runSetupCommand(
  requestedSeconds: number,
  command: readonly string[],
  options: Pick<RunOptions, 'cwd' | 'env' | 'capture'> = {},
): Promise<CommandResult> {
  if (!Number.isSafeInteger(requestedSeconds) || requestedSeconds <= 0
    || requestedSeconds > Math.floor(2_147_483_647 / 1_000)) {
    throw new Error('Simulator setup deadline must be a positive bounded integer');
  }
  const [executable, ...args] = command;
  if (executable === undefined || executable.length === 0) {
    throw new Error('Simulator setup requires an executable');
  }
  const environment = options.env ?? process.env;
  // An explicitly empty external override is invalid, matching the former Python owner.
  if (environment.IOS_CI_SETUP_TIMEOUT_SECONDS === '') {
    throw new Error('IOS_CI_SETUP_TIMEOUT_SECONDS must be positive and cannot extend setup deadlines');
  }
  const seconds = resolveSetupTimeoutSeconds(requestedSeconds, environment.IOS_CI_SETUP_TIMEOUT_SECONDS);
  const result = await runCommand(executable, args, { ...options, timeoutMs: seconds * 1_000, timeoutStatus: 124 });
  if (result.timedOut !== true) return result;
  const diagnostic = `::error::Simulator setup command ${executable} exceeded ${seconds}s\n`;
  if (options.capture !== true) process.stderr.write(diagnostic);
  return { ...result, stderr: result.stderr + diagnostic };
}

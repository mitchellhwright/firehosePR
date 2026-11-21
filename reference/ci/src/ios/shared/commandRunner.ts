import { execFile } from 'node:child_process';

/**
 * Spawning the external tools an iOS step still needs — `git`, `xcrun`,
 * `xcodebuild`, `simctl`.
 *
 * Always an argument array, never a command string: nothing a pull request
 * controls (a branch name, a SHA, a result-bundle path) is ever parsed by a
 * shell, and the seam is a plain function a test can replace.
 */

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBuffer?: number;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/**
 * Resolves with the exit status instead of rejecting on a non-zero one: every
 * call site here is a shell `if ! command` that already decides what a failure
 * means, and losing the status to an exception would lose that distinction.
 */
export const runCommand: CommandRunner = (file, args, options = {}) =>
  new Promise<CommandResult>((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const status = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : 1;
        resolve({ status, stdout, stderr });
      },
    );
  });

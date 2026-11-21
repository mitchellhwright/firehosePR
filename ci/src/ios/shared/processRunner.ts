import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { accessSync, closeSync, constants as fsConstants, openSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * The one place a typed iOS step starts an external process.
 *
 * Every command is an executable plus an argument array — never a shell string
 * — so a simulator UDID, a bundle path or a test identifier can never be read
 * as shell syntax. The step's own signal handling lives here too: `xcodebuild`
 * spawns a tree of helpers that outlive a plain `kill`, so each child is given
 * its own process group and the whole group is signalled, which is what the
 * shell's `pgrep -P` walk achieved.
 */

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Present only when this owner actually expired the command deadline. */
  readonly timedOut?: true;
}

/** True when `path` names a file this process may execute. */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `command -v <name>`: the first executable of that name on `PATH`, or
 * `undefined`. Resolved here rather than through a shell so the name can never
 * be read as shell syntax, and so a step can use the absolute path it found.
 */
export function resolveExecutable(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (name.includes('/')) return isExecutable(name) ? name : undefined;
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = isAbsolute(directory) ? join(directory, name) : join(process.cwd(), directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Wall-clock budget in milliseconds; the group is killed when it elapses. */
  readonly timeoutMs?: number;
  /** Optional deadline verdict; ordinary callers retain signal-derived status. */
  readonly timeoutStatus?: 124;
  /** Capture stdout/stderr instead of streaming them into the step log. */
  readonly capture?: boolean;
  /** A file read as the command's standard input, as the shell's `< path` did. */
  readonly stdinFile?: string;
}

const liveChildren = new Set<ChildProcess>();
let terminationStatus: 130 | 143 | undefined;

/** A signal has started process-tree teardown. Callers can stop new work while cleanup still runs. */
export function isProcessTerminating(): boolean {
  return terminationStatus !== undefined;
}

/** SIGTERM every live process group. Safe to call more than once. */
export function terminateActiveProcesses(): void {
  signalLiveGroups([...liveChildren], 'SIGTERM');
}

function signalLiveGroups(children: readonly ChildProcess[], signal: NodeJS.Signals): void {
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is already gone; the shell ignored this case the same way.
    }
  }
}

/** How long a signalled group gets to exit before it is killed outright. */
const TERMINATION_GRACE_MS = 5_000;

/**
 * Signal every live group and wait for it to actually go, escalating to
 * SIGKILL once. Signalling alone is not enough on cancellation: `process.exit`
 * ends Node before its children emit `close`, so the detached groups outlive
 * the step and stay on a shared Mac holding the simulator.
 *
 * The bounded wait here is not a poll — it reaps processes this step owns and
 * settles as soon as the last one closes. Only a group ignoring SIGTERM pays
 * the full grace period, and it is killed rather than waited on again.
 */
export async function terminateActiveProcessesAndWait(
  graceMs: number = TERMINATION_GRACE_MS,
): Promise<void> {
  const running = [...liveChildren].filter((child) => child.pid !== undefined && child.exitCode === null);
  if (running.length === 0) return;
  const allClosed = Promise.all(running.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('close', () => { resolve(); });
    child.once('error', () => { resolve(); });
  })));
  const within = async (): Promise<void> => {
    await Promise.race([allClosed, new Promise<void>((resolve) => {
      setTimeout(resolve, graceMs).unref();
    })]);
  };
  signalLiveGroups(running, 'SIGTERM');
  await within();
  const stubborn = running.filter((child) => child.exitCode === null);
  if (stubborn.length === 0) return;
  signalLiveGroups(stubborn, 'SIGKILL');
  await within();
}

function spawnTracked(
  command: string,
  args: readonly string[],
  options: RunOptions,
  stdio: StdioOptions,
): ChildProcess {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio,
  });
  liveChildren.add(child);
  child.once('close', () => liveChildren.delete(child));
  return child;
}

/**
 * Runs a command to completion. Resolves with its exit status rather than
 * rejecting, because every call site in the step recorded a status instead of
 * aborting; a process killed by a signal reports `128 + signal`, as `$?` did.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<CommandResult> {
  const capture = options.capture === true;
  const stdin = options.stdinFile === undefined ? undefined : openSync(options.stdinFile, 'r');
  const stdio: StdioOptions = capture
    ? [stdin ?? 'ignore', 'pipe', 'pipe']
    : [stdin ?? 'inherit', 'inherit', 'inherit'];
  let child: ChildProcess;
  try {
    child = spawnTracked(command, args, options, stdio);
  } finally {
    // The child holds its own duplicate of the descriptor.
    if (stdin !== undefined) closeSync(stdin);
  }
  let stdout = '';
  let stderr = '';
  // Readable's decoder carries partial UTF-8 characters between chunks and flushes at EOF.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });

  return new Promise<CommandResult>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let timedOut = false;
    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    if (options.timeoutMs !== undefined && child.pid !== undefined) {
      const pid = child.pid;
      timer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
          timedOut = true;
        } catch {
          // Already exited between the timer firing and this kill.
        }
      }, options.timeoutMs);
    }
    // A command that cannot start is status 127, as the shell reported it,
    // rather than an exception that would bypass the lane's status bookkeeping.
    child.once('error', (error) => {
      settle({ status: 127, stdout, stderr: `${stderr}${command}: ${error.message}\n` });
    });
    child.once('close', (code, signal) => {
      const status = timedOut && options.timeoutStatus !== undefined
        ? options.timeoutStatus
        : code ?? (signal === null ? 1 : 128 + signalNumber(signal));
      settle({ status, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
  });
}

const signalNumbers: Readonly<Record<string, number>> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
};

function signalNumber(signal: NodeJS.Signals): number {
  return signalNumbers[signal] ?? 15;
}

export interface BackgroundProcess {
  readonly child: ChildProcess;
  /** Resolves once the process has exited, whatever its status. */
  readonly exited: Promise<number>;
}

/** Starts a long-running process the step supervises itself (video recording). */
export function startBackgroundCommand(
  command: string,
  args: readonly string[],
  stdio: StdioOptions,
  options: RunOptions = {},
): BackgroundProcess {
  const child = spawnTracked(command, args, options, stdio);
  const exited = new Promise<number>((resolve) => {
    child.once('error', () => { resolve(127); });
    child.once('close', (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128 + signalNumber(signal)));
    });
  });
  return { child, exited };
}

/**
 * Installs the step's INT/TERM handling. The shell exited 130 and 143 after
 * tearing down its process tree, and the aggregating job reads those codes.
 */
export function installSignalTraps(onTerminate: () => void | Promise<void>): void {
  let tearingDown = false;
  const handle = (status: 130 | 143): void => {
    // A second signal during teardown must not restart it and race itself.
    if (tearingDown) return;
    tearingDown = true;
    terminationStatus = status;
    void (async () => {
      // The children go first and are waited for. They own the simulator, so
      // restoring its state while xcodebuild still holds it blocks in
      // CoreSimulator — which is what the shell's `pgrep -P` walk avoided by
      // tearing the tree down before touching the simulator.
      await terminateActiveProcessesAndWait();
      await onTerminate();
      process.exit(status);
    })();
  };
  process.on('SIGINT', () => { handle(130); });
  process.on('SIGTERM', () => { handle(143); });
}

export type RunProcess = typeof runCommand;

/**
 * The shared body of a typed step program: tear down its process groups on
 * INT/TERM, turn a thrown error into one annotated failure, and exit with the
 * status the program returned.
 */
export async function runStepProgram(failure: string, program: () => Promise<number>): Promise<void> {
  installSignalTraps(() => {});
  try {
    process.exitCode = await program();
  } catch (cause) {
    console.error(`::error::${failure}: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}

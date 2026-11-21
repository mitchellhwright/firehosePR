import type { ChildProcess, StdioOptions } from 'node:child_process';
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
export declare function isExecutable(path: string): boolean;
/**
 * `command -v <name>`: the first executable of that name on `PATH`, or
 * `undefined`. Resolved here rather than through a shell so the name can never
 * be read as shell syntax, and so a step can use the absolute path it found.
 */
export declare function resolveExecutable(name: string, environment?: NodeJS.ProcessEnv): string | undefined;
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
/** A signal has started process-tree teardown. Callers can stop new work while cleanup still runs. */
export declare function isProcessTerminating(): boolean;
/** SIGTERM every live process group. Safe to call more than once. */
export declare function terminateActiveProcesses(): void;
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
export declare function terminateActiveProcessesAndWait(graceMs?: number): Promise<void>;
/**
 * Runs a command to completion. Resolves with its exit status rather than
 * rejecting, because every call site in the step recorded a status instead of
 * aborting; a process killed by a signal reports `128 + signal`, as `$?` did.
 */
export declare function runCommand(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
export interface BackgroundProcess {
    readonly child: ChildProcess;
    /** Resolves once the process has exited, whatever its status. */
    readonly exited: Promise<number>;
}
/** Starts a long-running process the step supervises itself (video recording). */
export declare function startBackgroundCommand(command: string, args: readonly string[], stdio: StdioOptions, options?: RunOptions): BackgroundProcess;
/**
 * Installs the step's INT/TERM handling. The shell exited 130 and 143 after
 * tearing down its process tree, and the aggregating job reads those codes.
 */
export declare function installSignalTraps(onTerminate: () => void | Promise<void>): void;
export type RunProcess = typeof runCommand;
/**
 * The shared body of a typed step program: tear down its process groups on
 * INT/TERM, turn a thrown error into one annotated failure, and exit with the
 * status the program returned.
 */
export declare function runStepProgram(failure: string, program: () => Promise<number>): Promise<void>;

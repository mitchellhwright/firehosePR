import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants as fsConstants, openSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
/** True when `path` names a file this process may execute. */
export function isExecutable(path) {
    try {
        accessSync(path, fsConstants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * `command -v <name>`: the first executable of that name on `PATH`, or
 * `undefined`. Resolved here rather than through a shell so the name can never
 * be read as shell syntax, and so a step can use the absolute path it found.
 */
export function resolveExecutable(name, environment = process.env) {
    if (name.includes('/'))
        return isExecutable(name) ? name : undefined;
    for (const directory of (environment.PATH ?? '').split(delimiter)) {
        if (directory.length === 0)
            continue;
        const candidate = isAbsolute(directory) ? join(directory, name) : join(process.cwd(), directory, name);
        if (isExecutable(candidate))
            return candidate;
    }
    return undefined;
}
const liveChildren = new Set();
let terminationStatus;
/** A signal has started process-tree teardown. Callers can stop new work while cleanup still runs. */
export function isProcessTerminating() {
    return terminationStatus !== undefined;
}
/** SIGTERM every live process group. Safe to call more than once. */
export function terminateActiveProcesses() {
    signalLiveGroups([...liveChildren], 'SIGTERM');
}
function signalLiveGroups(children, signal) {
    for (const child of children) {
        if (child.pid === undefined || child.exitCode !== null)
            continue;
        try {
            process.kill(-child.pid, signal);
        }
        catch {
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
export async function terminateActiveProcessesAndWait(graceMs = TERMINATION_GRACE_MS) {
    const running = [...liveChildren].filter((child) => child.pid !== undefined && child.exitCode === null);
    if (running.length === 0)
        return;
    const allClosed = Promise.all(running.map((child) => new Promise((resolve) => {
        if (child.exitCode !== null) {
            resolve();
            return;
        }
        child.once('close', () => { resolve(); });
        child.once('error', () => { resolve(); });
    })));
    const within = async () => {
        await Promise.race([allClosed, new Promise((resolve) => {
                setTimeout(resolve, graceMs).unref();
            })]);
    };
    signalLiveGroups(running, 'SIGTERM');
    await within();
    const stubborn = running.filter((child) => child.exitCode === null);
    if (stubborn.length === 0)
        return;
    signalLiveGroups(stubborn, 'SIGKILL');
    await within();
}
function spawnTracked(command, args, options, stdio) {
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
export async function runCommand(command, args, options = {}) {
    const capture = options.capture === true;
    const stdin = options.stdinFile === undefined ? undefined : openSync(options.stdinFile, 'r');
    const stdio = capture
        ? [stdin ?? 'ignore', 'pipe', 'pipe']
        : [stdin ?? 'inherit', 'inherit', 'inherit'];
    let child;
    try {
        child = spawnTracked(command, args, options, stdio);
    }
    finally {
        // The child holds its own duplicate of the descriptor.
        if (stdin !== undefined)
            closeSync(stdin);
    }
    let stdout = '';
    let stderr = '';
    // Readable's decoder carries partial UTF-8 characters between chunks and flushes at EOF.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    return new Promise((resolve) => {
        let timer;
        let settled = false;
        let timedOut = false;
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            resolve(result);
        };
        if (options.timeoutMs !== undefined && child.pid !== undefined) {
            const pid = child.pid;
            timer = setTimeout(() => {
                try {
                    process.kill(-pid, 'SIGKILL');
                    timedOut = true;
                }
                catch {
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
const signalNumbers = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
};
function signalNumber(signal) {
    return signalNumbers[signal] ?? 15;
}
/** Starts a long-running process the step supervises itself (video recording). */
export function startBackgroundCommand(command, args, stdio, options = {}) {
    const child = spawnTracked(command, args, options, stdio);
    const exited = new Promise((resolve) => {
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
export function installSignalTraps(onTerminate) {
    let tearingDown = false;
    const handle = (status) => {
        // A second signal during teardown must not restart it and race itself.
        if (tearingDown)
            return;
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
/**
 * The shared body of a typed step program: tear down its process groups on
 * INT/TERM, turn a thrown error into one annotated failure, and exit with the
 * status the program returned.
 */
export async function runStepProgram(failure, program) {
    installSignalTraps(() => { });
    try {
        process.exitCode = await program();
    }
    catch (cause) {
        console.error(`::error::${failure}: ${cause instanceof Error ? cause.message : String(cause)}`);
        process.exitCode = 1;
    }
}

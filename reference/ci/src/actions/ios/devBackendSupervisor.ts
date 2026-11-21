import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';

import {
  backendCommand,
  backendEnvironment,
  backendExitStatus,
  backendExitedDevserverLine,
  backendExitedSupervisorLine,
  forceStoppingListenersLine,
  givingUpDevserverLine,
  givingUpSupervisorLine,
  isDevServerReadyLine,
  maxBackendRestarts,
  splitCompleteLines,
  startingBackendDevserverLine,
  startingBackendSupervisorLine,
  stoppingBackendLine,
  supervisorRestartVerdict,
  supervisorStoppingLine,
  supervisorTimestamp,
} from '../../ios/laneDevBackend.ts';
import { forceKill, listeningPids, processGroupId } from '../../ios/shared/processControl.ts';

/**
 * The detached supervisor that keeps a lane's development backend alive.
 *
 * `ensureLaneDevBackend.ts` spawns it as its own session leader, so it
 * outlives the step that started it and the whole session can be stopped as
 * one process group.
 *
 * It never polls or sleeps. It reads the backend's output as it is written,
 * appends it to the devserver log, and reports the dev server's ready line to
 * the step over the spawn channel — so the step blocks on an event rather than
 * tailing a file it could read at the wrong moment. When the backend exits the
 * exit is logged and the backend is restarted a bounded number of times.
 */

const usage =
  'usage: devBackendSupervisor.ts <repoRoot> <devserverLog> <supervisorLog> <pidFile> ' +
  '<buildSha> <port> [providerAuditLog]';

function optionalArgument(index: number): string | undefined {
  return process.argv[index + 2];
}

function argument(index: number): string {
  const value = optionalArgument(index);
  if (value === undefined) throw new Error(usage);
  return value;
}

const repositoryRoot = argument(0);
const devserverLog = argument(1);
const supervisorLog = argument(2);
const pidFile = argument(3);
const expectedBuildSha = argument(4);
const externalProviderAuditLog = optionalArgument(6) ?? '';

const backendPort = Number.parseInt(argument(5), 10);
if (!Number.isInteger(backendPort) || backendPort <= 0) {
  throw new Error(`Supervisor port must be a positive integer, received: ${argument(5)}`);
}

function note(path: string, line: string): void {
  appendFileSync(path, `${line}\n`, 'utf8');
}

function now(): string {
  return supervisorTimestamp(new Date());
}

let readinessReported = false;

/** Tells the step what happened. Silent once the step has stopped listening. */
function report(message: Record<string, unknown>, then?: () => void): void {
  if (process.send === undefined || !process.connected) {
    then?.();
    return;
  }
  process.send(message, undefined, undefined, () => then?.());
}

let running: ChildProcess | undefined;

function stopBackendListener(): void {
  const backend = running;
  if (backend !== undefined && backend.pid !== undefined && backend.exitCode === null) {
    note(supervisorLog, stoppingBackendLine(now(), backend.pid));
    try {
      backend.kill('SIGTERM');
    } catch {
      // The backend exited between the liveness check and the signal.
    }
  }
  const stale = listeningPids(backendPort);
  if (stale.length > 0) {
    note(supervisorLog, forceStoppingListenersLine(now(), backendPort, stale));
    forceKill(stale);
  }
}

/**
 * Appends the backend's output to the devserver log line by line and reports
 * the first ready line. The log stays the artifact the diagnostics upload
 * reads; the report is what unblocks the step.
 */
function followBackendOutput(backend: ChildProcess): void {
  // One buffer per pipe. Sharing it splices fragments from independent
  // streams: stdout emitting `Rea`, stderr a warning, then stdout `dy in 5ms`
  // yields two lines and no ready line, and the step waits out its timeout
  // with the backend already live.
  const pending = { stdout: '', stderr: '' };
  const consume = (stream: keyof typeof pending) => (chunk: Buffer | string): void => {
    const split = splitCompleteLines(pending[stream], chunk.toString());
    pending[stream] = split.remainder;
    for (const line of split.lines) {
      note(devserverLog, line);
      if (readinessReported || !isDevServerReadyLine(line)) continue;
      readinessReported = true;
      report({ event: 'ready', line });
    }
  };
  backend.stdout?.on('data', consume('stdout'));
  backend.stderr?.on('data', consume('stderr'));
  backend.once('close', () => {
    // Whatever followed the last newline on either pipe is still output.
    for (const stream of ['stdout', 'stderr'] as const) {
      if (pending[stream].length > 0) note(devserverLog, pending[stream]);
      pending[stream] = '';
    }
  });
}

function startBackend(): ChildProcess {
  stopBackendListener();
  note(supervisorLog, startingBackendSupervisorLine(now()));
  note(devserverLog, startingBackendDevserverLine(now(), backendPort));

  const { command, args } = backendCommand(backendPort);
  const child = spawn(command, [...args], {
    cwd: repositoryRoot,
    env: backendEnvironment({
      base: process.env,
      port: backendPort,
      expectedBuildSha,
      repositoryRoot,
      externalProviderAuditLog,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid !== undefined) writeFileSync(pidFile, String(child.pid), 'utf8');
  followBackendOutput(child);
  running = child;
  return child;
}

/** Resolves with the status `wait` would have reported for the backend. */
function waitForBackend(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (status: number): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    // A command that cannot be executed is 127, as it was through `exec`.
    child.once('error', () => settle(127));
    child.once('close', (code, signal) => {
      settle(backendExitStatus(code, signal, constants.signals));
    });
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    note(supervisorLog, supervisorStoppingLine(now()));
    process.exit(0);
  });
}
// The session leader has no controlling terminal, but an explicit ignore keeps
// a SIGHUP aimed at the old group from taking the backend down with it.
process.on('SIGHUP', () => {});

// The step blocks on this handoff rather than a timer, and refuses to continue
// unless the detached spawn really gave this supervisor its own session.
report({ event: 'session', pid: process.pid, processGroupId: processGroupId(process.pid) });

let current = startBackend();
let restarts = 0;
for (;;) {
  const status = await waitForBackend(current);
  restarts += 1;
  const timestamp = now();
  const counted = { timestamp, status, restarts, maxRestarts: maxBackendRestarts };
  note(devserverLog, backendExitedDevserverLine(counted));
  note(supervisorLog, backendExitedSupervisorLine(counted));
  if (supervisorRestartVerdict(restarts, maxBackendRestarts) === 'give-up') {
    const line = givingUpDevserverLine(timestamp, restarts);
    note(devserverLog, line);
    note(supervisorLog, givingUpSupervisorLine(timestamp, restarts));
    readinessReported = true;
    // The step is still waiting; tell it before this process disappears.
    report({ event: 'giving-up', line }, () => process.exit(1));
    break;
  }
  current = startBackend();
}

import { spawn } from 'node:child_process';
import { appendFileSync, openSync, writeFileSync } from 'node:fs';

import {
  dashboardProxyEntryPoint,
  dashboardProxyExitRecord,
  dashboardProxyPidRecord,
} from '../../ios/realServerE2eLanes.ts';

/**
 * The detached wrapper that owns the Dashboard offline E2E proxy.
 *
 * `startDashboardOfflineProxy.ts` spawns it and then exits; this process keeps
 * running for the rest of the job so the proxy has a parent and so the two
 * records the lane blocks on are always written: the proxy's pid as soon as it
 * exists, and its exit status when it ends. The stop step waits on that exit
 * record rather than polling, so nothing here may sleep or time out.
 *
 * usage: dashboardOfflineProxySupervisor.ts <logPath> <pidFile>
 */

function argument(index: number): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) {
    throw new Error('usage: dashboardOfflineProxySupervisor.ts <logPath> <pidFile>');
  }
  return value;
}

const logPath = argument(2);
const pidFile = argument(3);

const signalNumbers: Readonly<Record<string, number>> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
};

function note(line: string): void {
  appendFileSync(logPath, `${line}\n`, 'utf8');
}

const logFd = openSync(logPath, 'a');
const proxy = spawn(process.execPath, [dashboardProxyEntryPoint], {
  stdio: ['ignore', logFd, logFd],
});

proxy.once('error', (error: Error) => {
  note(JSON.stringify({ error: error.message }));
  note(dashboardProxyExitRecord(127));
  process.exit(0);
});

proxy.once('spawn', () => {
  const pid = proxy.pid ?? 0;
  // The pid file is written before the record the step blocks on, so the step
  // never reads a file that does not exist yet.
  writeFileSync(pidFile, `${pid}\n`, 'utf8');
  note(dashboardProxyPidRecord(pid));
});

proxy.once('close', (code, signal) => {
  const status = code ?? (signal === null ? 1 : 128 + (signalNumbers[signal] ?? 15));
  note(dashboardProxyExitRecord(status));
  process.exit(0);
});

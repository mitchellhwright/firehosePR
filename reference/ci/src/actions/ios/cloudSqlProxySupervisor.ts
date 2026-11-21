import { spawn } from 'node:child_process';
import { appendFileSync, openSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';

import {
  cloudSqlProxyArguments,
  cloudSqlProxyExecutable,
  cloudSqlProxyExitLine,
} from '../../ios/incomeCloudSqlProxy.ts';

/**
 * The detached wrapper that owns the Income lane's Cloud SQL proxy.
 *
 * The start step cannot own the proxy itself: the step ends long before the
 * suite that uses the database, so whatever starts the proxy has to outlive
 * it. This wrapper starts the proxy, records its PID where the stop step reads
 * it, and — the part everything else depends on — appends one exit line to the
 * proxy log when the proxy ends. The start step blocks on either that line or
 * the proxy's own readiness line, and the stop step blocks on that line after
 * signalling, so neither ever waits on a log nothing will write to again.
 *
 * usage: cloudSqlProxySupervisor.ts <logPath> <pidFile> <port>
 */

const usage = 'usage: cloudSqlProxySupervisor.ts <logPath> <pidFile> <port>';

function argument(index: number): string {
  const value = process.argv[index + 2];
  if (value === undefined) throw new Error(usage);
  return value;
}

const logPath = argument(0);
const pidFile = argument(1);
const port = Number.parseInt(argument(2), 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Cloud SQL proxy port must be a positive integer, received: ${argument(2)}`);
}

// The proxy writes straight into the log file: its output is the evidence the
// lane uploads, and keeping it on a descriptor rather than a pipe means no
// line is lost if this wrapper is signalled.
const logDescriptor = openSync(logPath, 'a');
const proxy = spawn(cloudSqlProxyExecutable, [...cloudSqlProxyArguments(port)], {
  stdio: ['ignore', logDescriptor, logDescriptor],
});
// Written even when the spawn failed, so the start step never blocks reading
// a file that will not appear; an empty PID skips the stop step's `if:`.
writeFileSync(pidFile, proxy.pid === undefined ? '' : String(proxy.pid), 'utf8');

/** The status `wait` would have reported: 127 for an exec failure, 128+n for a signal. */
const status = await new Promise<number>((resolve) => {
  proxy.once('error', () => { resolve(127); });
  proxy.once('close', (code, signal) => {
    if (code !== null) { resolve(code); return; }
    resolve(signal === null ? 1 : 128 + (constants.signals[signal] ?? 15));
  });
});
appendFileSync(logPath, `${cloudSqlProxyExitLine(status)}\n`, 'utf8');

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  classifyProxyReadiness,
  proxyEnvironmentExports,
  proxyNotReadyMessage,
  proxyPidFile,
  proxyReadinessPattern,
} from '../../ios/incomeCloudSqlProxy.ts';
import { appendGithubEnv, errorAnnotation } from '../../ios/shared/githubStepIo.ts';
import { awaitLogLine } from '../../ios/shared/awaitLogLine.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Starts the Income lane's Cloud SQL proxy and does not return until the proxy
 * has either announced itself ready or recorded its own exit.
 *
 * The proxy has to outlive this step, so it is owned by a detached supervisor
 * (`cloudSqlProxySupervisor.ts`) that appends an exit line to the proxy log.
 * The wait below blocks on whichever of the two lines appears first — an
 * event, never a timer — so a proxy that cannot authenticate fails the step
 * immediately instead of holding this Mac until its budget runs out.
 */

const environmentSchema = z.object({
  INCOME_E2E_RUN_DIR: z.string().min(1, 'INCOME_E2E_RUN_DIR is required'),
  INCOME_E2E_DB_PROXY_LOG: z.string().min(1, 'INCOME_E2E_DB_PROXY_LOG is required'),
});

const supervisorEntryPoint = fileURLToPath(new URL('./cloudSqlProxySupervisor.ts', import.meta.url));

/** A port the kernel says is free, as binding to port 0 in the shell did. */
async function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => { reject(new Error('Could not allocate a loopback port')); });
        return;
      }
      const { port } = address;
      server.close(() => { resolve(port); });
    });
  });
}

function readPid(pidFile: string): string {
  try {
    return readFileSync(pidFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/** `cat "$LOG" >&2` on a failure; a log that is not there explains nothing. */
function readLogTail(logPath: string): string {
  try {
    return readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

await runStep('Income Cloud SQL proxy start', async () => {
  const environment = readStepEnvironment(environmentSchema);
  const runDirectory = environment.INCOME_E2E_RUN_DIR;
  const logPath = environment.INCOME_E2E_DB_PROXY_LOG;
  mkdirSync(runDirectory, { recursive: true });

  const pidFile = proxyPidFile(runDirectory);
  // A previous attempt's log would satisfy the wait below immediately.
  for (const stale of [pidFile, logPath]) rmSync(stale, { force: true });

  const port = await allocatePort();
  const supervisor = spawn(
    process.execPath,
    [supervisorEntryPoint, logPath, pidFile, String(port)],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  supervisor.unref();

  const readyLine = await awaitLogLine(logPath, { kind: 'regex', pattern: proxyReadinessPattern });
  appendGithubEnv(proxyEnvironmentExports(port, readPid(pidFile)));

  if (classifyProxyReadiness(readyLine) === 'ready') return;
  errorAnnotation(proxyNotReadyMessage(readyLine));
  process.stderr.write(readLogTail(logPath));
  process.exitCode = 1;
});

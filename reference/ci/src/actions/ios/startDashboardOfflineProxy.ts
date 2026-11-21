import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  dashboardProxyEnvironment,
  dashboardProxyHealthy,
  dashboardProxyNotReadyMessage,
  dashboardProxyOwnershipExports,
  dashboardProxyPidPattern,
  dashboardProxyPort,
  dashboardProxyReadyOrExitPattern,
} from '../../ios/realServerE2eLanes.ts';
import {
  annotateError,
  exportStepEnvBlock,
  logLine,
} from '../../ios/shared/actionIo.ts';
import { maskSecret } from '../../ios/shared/githubStepIo.ts';
import { fetchJson } from '../../ios/shared/httpJson.ts';
import { awaitLogLine } from '../../ios/shared/awaitLogLine.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Starts the proxy that cuts the app's link to the backend on command, which
 * is how the FullOnboarding lane exercises the offline Dashboard.
 *
 * The supervisor logs the proxy's pid first and its exit last, so each wait
 * below terminates on an event, never on a timer. Ownership is exported as
 * soon as the pid exists, before readiness, so the `always()` stop step can end
 * a proxy that stalls on start.
 */

const environmentSchema = z.object({
  RUNNER_TEMP: z.string().min(1),
  ONBOARDING_DEV_BACKEND_PORT: z.string().regex(/^\d+$/, 'must be a port number'),
  ONBOARDING_E2E_COMMIT_SHA: z.string().min(1),
  DASHBOARD_OFFLINE_PROXY_EVENTS: z.string().min(1),
  DASHBOARD_OFFLINE_PROXY_LOG: z.string().min(1),
});

const supervisorEntryPoint = fileURLToPath(
  new URL('./dashboardOfflineProxySupervisor.ts', import.meta.url),
);

/** The deadline the shell gave the health probe's `curl --max-time 30`. */
const healthTimeoutMs = 30_000;

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const controlToken = randomBytes(32).toString('hex');
  maskSecret(controlToken);

  const logPath = environment.DASHBOARD_OFFLINE_PROXY_LOG;
  const pidFile = join(environment.RUNNER_TEMP, 'dashboard-offline-proxy.pid');
  for (const path of [environment.DASHBOARD_OFFLINE_PROXY_EVENTS, logPath, pidFile]) {
    rmSync(path, { force: true });
  }

  const supervisor = spawn(
    process.execPath,
    [supervisorEntryPoint, logPath, pidFile],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...dashboardProxyEnvironment({
          backendPort: environment.ONBOARDING_DEV_BACKEND_PORT,
          controlToken,
          commitSha: environment.ONBOARDING_E2E_COMMIT_SHA,
          eventsPath: environment.DASHBOARD_OFFLINE_PROXY_EVENTS,
        }),
      },
    },
  );
  supervisor.unref();

  await awaitLogLine(logPath, { kind: 'regex', pattern: dashboardProxyPidPattern });
  const proxyPid = readFileSync(pidFile, 'utf8').trim();
  exportStepEnvBlock(
    dashboardProxyOwnershipExports({ pid: Number.parseInt(proxyPid, 10), controlToken }),
  );

  await awaitLogLine(logPath, { kind: 'regex', pattern: dashboardProxyReadyOrExitPattern });
  const port = dashboardProxyPort(readFileSync(logPath, 'utf8'), environment.ONBOARDING_E2E_COMMIT_SHA);
  if (port !== undefined) {
    let healthy = false;
    try {
      healthy = dashboardProxyHealthy(
        await fetchJson({
          url: `http://127.0.0.1:${port}/__example_e2e/health`,
          timeoutMs: healthTimeoutMs,
        }),
        environment.ONBOARDING_E2E_COMMIT_SHA,
      );
    } catch {
      // A health endpoint that cannot answer is a proxy that is not ready; the
      // log is printed below, which is what explains the failure.
      healthy = false;
    }
    if (healthy) {
      exportStepEnvBlock(new Map([['DASHBOARD_OFFLINE_PROXY_PORT', String(port)]]));
      return;
    }
  }
  annotateError(dashboardProxyNotReadyMessage);
  logLine(readFileSync(logPath, 'utf8'));
  throw new StepFailure('', 'stdout');
}

await runStep('Start Dashboard offline E2E proxy', run);

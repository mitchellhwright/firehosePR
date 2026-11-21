import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  dependencyInstallRequired,
  dotenvSource,
  incomeProviderAuditLog,
  isolatedProcessGroupMessage,
  metadataProbeSatisfied,
  missingDotenvMessage,
  notReadyMessage,
  otpProbeConfirmed,
  probeEmail,
  processGroupIsolated,
  readinessVerdict,
  resolveTestOtpSecret,
  secretIsBlank,
  staleListenerMessage,
  supervisorMarkers,
  tailLines,
} from '../../ios/laneDevBackend.ts';
import {
  appendGithubEnv,
  appendGithubEnvBlock,
  errorAnnotation,
  log,
  maskSecret,
} from '../../ios/shared/githubStepIo.ts';
import { fetchJson } from '../../ios/shared/httpJson.ts';
import { forceKill, listeningPids } from '../../ios/shared/processControl.ts';

/**
 * Starts the lane-isolated development backend every real-server E2E lane
 * needs, and does not return until the checked-out commit is the one
 * answering on the lane's port.
 *
 * One program for all four lanes (onboarding, chat-plaid, income, budget);
 * they differ only by the environment the job sets.
 */

const environmentSchema = z.object({
  ONBOARDING_DEV_BACKEND_PORT: z.string().regex(/^\d+$/, 'must be a port number'),
  ONBOARDING_DEV_BACKEND_LOG: z.string().min(1),
  ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG: z.string().min(1),
  ONBOARDING_DEV_BACKEND_PID_FILE: z.string().min(1),
  ONBOARDING_E2E_COMMIT_SHA: z.string().min(1),
  E2E_LANE: z.string().default(''),
  TEST_OTP_SECRET: z.string().default(''),
  INCOME_E2E_PROVIDER_AUDIT_LOG: z.string().default(''),
  SERVER_DEV_DOTENV_B64: z.string().default(''),
  GITHUB_RUN_ID: z.string().default(''),
  GITHUB_RUN_ATTEMPT: z.string().default(''),
  GITHUB_ENV: z.string().default(''),
  HOME: z.string().default(''),
});

const supervisorEntryPoint = fileURLToPath(new URL('./devBackendSupervisor.ts', import.meta.url));

/** A failure whose `::error::` annotation is already on the log; it only sets the exit code. */
class AnnotatedFailure extends Error {}

/** The deadline the first probe needs: dev compiles the route on first request. */
const probeTimeoutMs = 180_000;

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function executable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Anything still listening on the lane's port is a leftover from an earlier
 * run, not a child of this step, so there is nothing to wait for.
 */
function stopStaleBackendListener(port: number): void {
  const stale = listeningPids(port);
  if (stale.length === 0) return;
  log(staleListenerMessage(port, stale));
  forceKill(stale);
}

/**
 * The dev env supplies Plaid sandbox credentials; keyless GCP auth supplies
 * Cloud SQL and Identity Platform. Without one of these sources the lane
 * cannot run at all.
 */
function ensureDotenv(homeDotenv: string, encodedDotenv: string): void {
  const source = dotenvSource({
    dotenvPresent: existsSync('.env'),
    homeDotenvPresent: existsSync(homeDotenv),
    encodedDotenvPresent: encodedDotenv.length > 0,
  });
  switch (source) {
    case 'present':
      return;
    case 'copy-home-dotenv':
      copyFileSync(homeDotenv, '.env');
      return;
    case 'decode-secret':
      writeFileSync('.env', Buffer.from(encodedDotenv, 'base64'));
      return;
    case 'unavailable':
      errorAnnotation(missingDotenvMessage);
      throw new AnnotatedFailure(missingDotenvMessage);
  }
}

function ensureDevDependencies(): void {
  const required = dependencyInstallRequired({
    nodeModulesPresent: directoryExists('node_modules'),
    nextBinaryExecutable: executable('node_modules/.bin/next'),
  });
  if (!required) return;
  const install = spawnSync('npm', ['ci'], { stdio: 'inherit' });
  if (install.status !== 0) {
    throw new Error(`npm ci failed (exit ${install.status ?? 'signal'})`);
  }
}

const sessionMessageSchema = z.object({
  event: z.literal('session'),
  pid: z.number().int().positive(),
  processGroupId: z.number().int(),
});

const readinessMessageSchema = z.object({
  event: z.union([z.literal('ready'), z.literal('giving-up')]),
  line: z.string(),
});

type SessionMessage = z.infer<typeof sessionMessageSchema>;
type ReadinessMessage = z.infer<typeof readinessMessageSchema>;

interface SupervisorReports {
  /** Resolves with the next report, or rejects when the supervisor dies first. */
  next(what: string): Promise<unknown>;
}

/**
 * Buffers the supervisor's reports behind one listener attached at spawn.
 *
 * The spawn channel can emit two messages from a single socket read, so a
 * report the step has not asked for yet would be dropped by a listener
 * attached per wait — and the step would then block until its timeout.
 */
function collectReports(child: ChildProcess): SupervisorReports {
  interface Waiter {
    resolve(message: unknown): void;
    reject(error: Error): void;
    readonly what: string;
  }
  const queued: unknown[] = [];
  let waiting: Waiter | undefined;
  let died: string | undefined;

  child.on('message', (message: unknown) => {
    if (waiting === undefined) {
      queued.push(message);
      return;
    }
    const pending = waiting;
    waiting = undefined;
    pending.resolve(message);
  });

  const fail = (reason: string): void => {
    died ??= reason;
    if (waiting === undefined) return;
    const pending = waiting;
    waiting = undefined;
    pending.reject(new Error(`Dev backend supervisor ${reason} before ${pending.what}`));
  };
  child.on('error', (error: Error) => fail(`could not be started (${error.message})`));
  child.on('exit', (code) => fail(`exited (exit ${code ?? -1})`));

  return {
    next(what: string): Promise<unknown> {
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (died !== undefined) {
        return Promise.reject(new Error(`Dev backend supervisor ${died} before ${what}`));
      }
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject, what };
      });
    },
  };
}

/**
 * Spawns the supervisor as its own session leader and blocks on its handoff,
 * so the step proves the isolated process group instead of timing it.
 */
function spawnSupervisor(
  args: readonly string[],
  childEnvironment: Readonly<Record<string, string>>,
): { readonly child: ChildProcess; readonly reports: SupervisorReports } {
  const child = spawn(process.execPath, [supervisorEntryPoint, ...args], {
    env: childEnvironment,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return { child, reports: collectReports(child) };
}

async function pingBackend(inputs: {
  readonly port: number;
  readonly secret: string;
  readonly repositoryRoot: string;
  readonly buildSha: string;
  readonly runId: string;
  readonly runAttempt: string;
}): Promise<boolean> {
  const headers = { 'x-test-otp-secret': inputs.secret };
  try {
    const metadata = await fetchJson({
      url: `http://127.0.0.1:${inputs.port}/api/test/budget-e2e/metadata`,
      timeoutMs: probeTimeoutMs,
      headers,
    });
    if (
      !metadataProbeSatisfied(metadata, {
        repositoryRoot: inputs.repositoryRoot,
        buildSha: inputs.buildSha,
      })
    ) {
      return false;
    }
    const otp = await fetchJson({
      url: `http://127.0.0.1:${inputs.port}/api/auth/test/otp`,
      method: 'POST',
      timeoutMs: probeTimeoutMs,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: probeEmail({ runId: inputs.runId, runAttempt: inputs.runAttempt }),
        password: 'HealthCheckPass123',
      }),
    });
    return otpProbeConfirmed(otp);
  } catch {
    // A probe that cannot complete is a backend that is not ready; the ready
    // line already told us the dev server started, so the diagnostics below
    // are what explain the failure.
    return false;
  }
}

let spawnedSupervisor: ChildProcess | undefined;

/** Releases the spawn channel so this step can exit; the supervisor lives on. */
function releaseSupervisorChannel(): void {
  if (spawnedSupervisor?.connected === true) spawnedSupervisor.disconnect();
  spawnedSupervisor?.unref();
}

async function run(): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  const port = Number.parseInt(environment.ONBOARDING_DEV_BACKEND_PORT, 10);
  const repositoryRoot = process.cwd();
  const backendLog = environment.ONBOARDING_DEV_BACKEND_LOG;
  const supervisorLog = environment.ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG;
  const homeDotenv = `${environment.HOME}/example-dev.env`;

  const providerAuditLog = incomeProviderAuditLog(
    environment.E2E_LANE,
    environment.INCOME_E2E_PROVIDER_AUDIT_LOG,
  );
  if (providerAuditLog.length > 0) {
    mkdirSync(dirname(providerAuditLog), { recursive: true });
    chmodSync(dirname(providerAuditLog), 0o700);
  }

  // A healthy listener may belong to an older worktree and cannot prove this
  // PR, so it is stopped before the checked-out backend starts.
  stopStaleBackendListener(port);
  ensureDotenv(homeDotenv, environment.SERVER_DEV_DOTENV_B64);

  // Use the dev env's test endpoint secret when present; otherwise create one
  // that exists only for this run.
  let secret = resolveTestOtpSecret(environment.TEST_OTP_SECRET, [
    readIfPresent('.env'),
    readIfPresent(homeDotenv),
  ]);
  if (secretIsBlank(secret)) secret = randomBytes(32).toString('hex');
  maskSecret(secret);
  if (environment.GITHUB_ENV.length > 0) {
    appendGithubEnvBlock('TEST_OTP_SECRET', secret);
  }

  const childEnvironment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnvironment[key] = value;
  }
  childEnvironment.TEST_OTP_SECRET = secret;
  childEnvironment.EXAMPLE_BUILD_SHA = environment.ONBOARDING_E2E_COMMIT_SHA;

  writeFileSync(backendLog, '', 'utf8');
  writeFileSync(supervisorLog, '', 'utf8');
  ensureDevDependencies();

  const { child, reports } = spawnSupervisor(
    [
      repositoryRoot,
      backendLog,
      supervisorLog,
      environment.ONBOARDING_DEV_BACKEND_PID_FILE,
      environment.ONBOARDING_E2E_COMMIT_SHA,
      String(port),
      providerAuditLog,
    ],
    childEnvironment,
  );
  // The spawn channel keeps this step's event loop alive; whatever happens
  // below, the step must be able to exit while the supervisor stays up.
  spawnedSupervisor = child;
  const handoff: SessionMessage = sessionMessageSchema.parse(
    await reports.next('its session handoff'),
  );
  // The ownership markers are exported before the group is validated, so a
  // supervisor that fails validation is still one the cleanup step can stop.
  if (environment.GITHUB_ENV.length > 0) {
    appendGithubEnv(
      supervisorMarkers({
        supervisorPid: handoff.pid,
        pidFile: environment.ONBOARDING_DEV_BACKEND_PID_FILE,
        backendLog,
        supervisorLog,
      }),
    );
  }
  if (!processGroupIsolated(handoff.pid, handoff.processGroupId)) {
    errorAnnotation(isolatedProcessGroupMessage);
    try {
      child.kill('SIGTERM');
    } catch {
      // The supervisor is already gone; nothing to stop.
    }
    throw new AnnotatedFailure(isolatedProcessGroupMessage);
  }

  log(`Waiting for dev backend on :${port} ...`);
  // Block on the dev server's own ready line, or on the supervisor giving up.
  // A backend that exits is restarted by the supervisor, so an exit record
  // alone is not a verdict; the next ready line is.
  const readiness: ReadinessMessage = readinessMessageSchema.parse(
    await reports.next('reporting readiness'),
  );
  // Nothing more is expected from the supervisor; let this step exit while it
  // keeps the backend up for the rest of the job.
  releaseSupervisorChannel();
  if (readinessVerdict(readiness.event) === 'ready') {
    const healthy = await pingBackend({
      port,
      secret,
      repositoryRoot,
      buildSha: environment.ONBOARDING_E2E_COMMIT_SHA,
      runId: environment.GITHUB_RUN_ID,
      runAttempt: environment.GITHUB_RUN_ATTEMPT,
    });
    if (healthy) {
      log(`Checked-out dev backend is up at ${environment.ONBOARDING_E2E_COMMIT_SHA}`);
      return;
    }
  }
  errorAnnotation(notReadyMessage(readiness.line));
  log(tailLines(readFileSync(backendLog, 'utf8'), 80));
  throw new AnnotatedFailure(notReadyMessage(readiness.line));
}

run().catch((error: unknown) => {
  if (!(error instanceof AnnotatedFailure)) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Lane dev backend startup failed: ${message}\n`);
  }
  // A failure after the spawn must still let this step exit and report.
  releaseSupervisorChannel();
  process.exitCode = 1;
});

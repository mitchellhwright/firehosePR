/**
 * Decisions for the lane-isolated development backend that every real-server
 * E2E lane (onboarding, chat-plaid, income, budget) starts before XCTest runs.
 *
 * Everything here is pure: given the environment a lane reports, which dev
 * `.env` to use, which OTP secret wins, whether dependencies must be
 * installed, what the supervisor should log, and whether a probe response
 * proves the checked-out backend is the one listening. The side effects —
 * spawning the supervisor, HTTP probes, GITHUB_ENV — live in
 * `ci/src/actions/ios/ensureLaneDevBackend.ts` and `devBackendSupervisor.ts`.
 */

/** The lane whose provider calls are audited and blocked at the Node boundary. */
export const providerAuditedLane = 'income';

/** The supervisor restarts an exiting backend this many times, then gives up. */
export const maxBackendRestarts = 6;

/**
 * The dev server's own ready line. The supervisor scans the backend's output
 * for it and reports the match to the step, so nothing has to tail a log file
 * and risk missing a write.
 */
export const devServerReadyPattern = /Ready in/;

/** What the supervisor reports back to the step that spawned it. */
export type SupervisorEvent = 'session' | 'ready' | 'giving-up';

export const missingDotenvMessage =
  'No dev .env available (add ~/example-dev.env or SERVER_DEV_DOTENV_B64)';

export const isolatedProcessGroupMessage =
  'Onboarding backend supervisor did not create an isolated process group';

/**
 * The value of the last `TEST_OTP_SECRET=` assignment in a dotenv file, with
 * one layer of surrounding quotes removed.
 *
 * Whitespace after the `=` is deliberately kept: the shell this replaces took
 * everything after the first `=` verbatim, and a secret is compared verbatim.
 */
export function dotenvTestOtpSecret(content: string): string {
  const assignments = content
    .split('\n')
    .filter((line) => /^[ \t]*TEST_OTP_SECRET[ \t]*=/.test(line));
  const last = assignments.at(-1);
  if (last === undefined) return '';
  let value = last.slice(last.indexOf('=') + 1);
  // Each strip is independent, as `${v#\"}` and `${v%\"}` were: a value quoted
  // on one side only still loses that quote.
  if (value.startsWith('"')) value = value.slice(1);
  if (value.endsWith('"')) value = value.slice(0, -1);
  if (value.startsWith("'")) value = value.slice(1);
  if (value.endsWith("'")) value = value.slice(0, -1);
  return value;
}

/**
 * The OTP secret the lane should use: an already-exported one wins, otherwise
 * the first candidate dotenv that names a non-empty one, in the order given.
 * `undefined` stands for a candidate file that does not exist.
 */
export function resolveTestOtpSecret(
  provided: string,
  candidates: readonly (string | undefined)[],
): string {
  if (provided.length > 0) return provided;
  for (const content of candidates) {
    if (content === undefined) continue;
    const secret = dotenvTestOtpSecret(content);
    if (secret.length > 0) return secret;
  }
  return '';
}

/** A secret of nothing but whitespace is no secret; the lane mints its own. */
export function secretIsBlank(value: string): boolean {
  return value.replace(/[ \t\n\r\v\f]/g, '').length === 0;
}

export type DotenvSource = 'present' | 'copy-home-dotenv' | 'decode-secret' | 'unavailable';

/** Where the dev `.env` comes from, in the order the lane is willing to accept. */
export function dotenvSource(inputs: {
  readonly dotenvPresent: boolean;
  readonly homeDotenvPresent: boolean;
  readonly encodedDotenvPresent: boolean;
}): DotenvSource {
  if (inputs.dotenvPresent) return 'present';
  if (inputs.homeDotenvPresent) return 'copy-home-dotenv';
  if (inputs.encodedDotenvPresent) return 'decode-secret';
  return 'unavailable';
}

/**
 * A lane reuses the workspace's `node_modules` only when Next's binary is
 * actually there; a half-installed tree must be reinstalled, not started.
 */
export function dependencyInstallRequired(inputs: {
  readonly nodeModulesPresent: boolean;
  readonly nextBinaryExecutable: boolean;
}): boolean {
  return !(inputs.nodeModulesPresent && inputs.nextBinaryExecutable);
}

/**
 * The provider audit log the backend writes, or `''` for a lane that does not
 * audit. The audited lane fails closed: without a log path its evidence would
 * silently be empty.
 */
export function incomeProviderAuditLog(lane: string, auditLog: string): string {
  if (lane !== providerAuditedLane) return '';
  if (auditLog.length === 0) {
    throw new Error('INCOME_E2E_PROVIDER_AUDIT_LOG is required for the income lane');
  }
  return auditLog;
}

/** The synthetic identity the readiness probe bootstraps, one per run attempt. */
export function probeEmail(inputs: {
  readonly runId: string;
  readonly runAttempt: string;
}): string {
  const runId = inputs.runId.length > 0 ? inputs.runId : 'local';
  const runAttempt = inputs.runAttempt.length > 0 ? inputs.runAttempt : '0';
  return `health-${runId}-${runAttempt}@test.example.local`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True only when the metadata endpoint proves the listener is this checkout's
 * development backend: a healthy listener from an older worktree answers too,
 * and it cannot prove this PR.
 */
export function metadataProbeSatisfied(
  payload: unknown,
  expected: { readonly repositoryRoot: string; readonly buildSha: string },
): boolean {
  if (!isRecord(payload)) return false;
  return (
    payload.ready === true &&
    payload.nodeEnv === 'development' &&
    payload.repositoryRoot === expected.repositoryRoot &&
    payload.buildSha === expected.buildSha
  );
}

/** `/api/auth/test/otp` is only mounted when NODE_ENV=development. */
export function otpProbeConfirmed(payload: unknown): boolean {
  return isRecord(payload) && payload.confirmed === true;
}

/**
 * Whether a line of backend output is the dev server announcing itself.
 *
 * A backend that exits is restarted by the supervisor, so an exit record alone
 * is not a verdict; only a ready line is.
 */
export function isDevServerReadyLine(line: string): boolean {
  return devServerReadyPattern.test(line);
}

/** The step proceeds to probe only when the supervisor reported readiness. */
export function readinessVerdict(event: SupervisorEvent): 'ready' | 'not-ready' {
  return event === 'ready' ? 'ready' : 'not-ready';
}

export function notReadyMessage(readyLine: string): string {
  return `Dev backend did not become ready: ${readyLine}`;
}

export interface LineSplit {
  readonly lines: readonly string[];
  readonly remainder: string;
}

/**
 * Splits a stream chunk into complete lines, keeping whatever follows the last
 * newline for the next chunk. A ready line arriving in two writes must not be
 * missed, and a half-written line must not be matched early.
 */
export function splitCompleteLines(pending: string, chunk: string): LineSplit {
  const parts = `${pending}${chunk}`.split('\n');
  const remainder = parts.pop() ?? '';
  return { lines: parts, remainder };
}

/** The last `count` lines of a log, as `tail -n count` prints them. */
export function tailLines(text: string, count: number): string {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-count).join('\n');
}

export function staleListenerMessage(port: number, pids: readonly number[]): string {
  return `Stopping stale listener(s) on :${port}: ${pids.join(' ')}`;
}

/** Node's `detached` spawn makes the child a session leader, so pgid == pid. */
export function processGroupIsolated(pid: number, processGroupId: number): boolean {
  return pid === processGroupId;
}

/** The ownership markers the cleanup step needs to stop exactly what this run started. */
export function supervisorMarkers(inputs: {
  readonly supervisorPid: number;
  readonly pidFile: string;
  readonly backendLog: string;
  readonly supervisorLog: string;
}): Record<string, string> {
  return {
    ONBOARDING_DEV_BACKEND_SUPERVISOR_PID: String(inputs.supervisorPid),
    ONBOARDING_DEV_BACKEND_PID_FILE: inputs.pidFile,
    ONBOARDING_DEV_BACKEND_PROCESS_GROUP_ID: String(inputs.supervisorPid),
    ONBOARDING_DEV_BACKEND_LOG: inputs.backendLog,
    ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG: inputs.supervisorLog,
  };
}

export interface BackendCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Started through an argument array, so a port can never be read as shell. */
export function backendCommand(port: number): BackendCommand {
  return {
    command: 'npm',
    args: ['run', 'dev', '--', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)],
  };
}

export function backendEnvironment(inputs: {
  readonly base: Readonly<Record<string, string | undefined>>;
  readonly port: number;
  readonly expectedBuildSha: string;
  readonly repositoryRoot: string;
  readonly externalProviderAuditLog: string;
}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs.base)) {
    if (value !== undefined) environment[key] = value;
  }
  environment.NODE_ENV = 'development';
  environment.EXAMPLE_BUILD_SHA = inputs.expectedBuildSha;
  environment.PORT = String(inputs.port);
  environment.HOSTNAME = '127.0.0.1';
  if (inputs.externalProviderAuditLog.length === 0) return environment;

  environment.EXTERNAL_PROVIDER_AUDIT_LOG = inputs.externalProviderAuditLog;
  environment.EXTERNAL_PROVIDER_AUDIT_POLICY = 'block';
  const hook = `--import=${inputs.repositoryRoot}/ci/src/actions/ios/externalProviderAuditHook.ts`;
  environment.NODE_OPTIONS = `${inputs.base.NODE_OPTIONS ?? ''} ${hook}`.trim();
  // The audited lane blocks provider calls at the enumerated Node network
  // APIs. Tool-index maintenance is an unrelated startup task that would
  // otherwise attempt OpenAI and be recorded as an escape.
  environment.ENABLE_VECTOR_TOOL_SELECTION = 'false';
  environment.ENABLE_SCHEDULER_ORCHESTRATOR = 'false';
  return environment;
}

/** `date -u '+%Y-%m-%dT%H:%M:%SZ'`, the stamp every supervisor line carries. */
export function supervisorTimestamp(now: Date): string {
  return `${now.toISOString().slice(0, 19)}Z`;
}

export function stoppingBackendLine(timestamp: string, pid: number): string {
  return `[${timestamp}] stopping dev backend ${pid}`;
}

export function forceStoppingListenersLine(
  timestamp: string,
  port: number,
  pids: readonly number[],
): string {
  return `[${timestamp}] force-stopping :${port} listener(s): ${pids.join(' ')}`;
}

export function startingBackendSupervisorLine(timestamp: string): string {
  return `[${timestamp}] starting dev backend`;
}

export function startingBackendDevserverLine(timestamp: string, port: number): string {
  return `[${timestamp}] supervisor starting dev backend on 127.0.0.1:${port}`;
}

export function supervisorStoppingLine(timestamp: string): string {
  return `[${timestamp}] supervisor stopping`;
}

export function backendExitedDevserverLine(inputs: {
  readonly timestamp: string;
  readonly status: number;
  readonly restarts: number;
  readonly maxRestarts: number;
}): string {
  return (
    `[${inputs.timestamp}] supervisor: dev backend exited with ${inputs.status} ` +
    `(restart ${inputs.restarts}/${inputs.maxRestarts})`
  );
}

export function backendExitedSupervisorLine(inputs: {
  readonly timestamp: string;
  readonly status: number;
  readonly restarts: number;
  readonly maxRestarts: number;
}): string {
  return (
    `[${inputs.timestamp}] dev backend exited with ${inputs.status} ` +
    `(restart ${inputs.restarts}/${inputs.maxRestarts})`
  );
}

export function givingUpDevserverLine(timestamp: string, restarts: number): string {
  return `[${timestamp}] supervisor: giving up after ${restarts} restarts`;
}

export function givingUpSupervisorLine(timestamp: string, restarts: number): string {
  return `[${timestamp}] giving up after ${restarts} restarts`;
}

/** After `maxRestarts` restarts the supervisor stops trying and fails the lane. */
export function supervisorRestartVerdict(
  restarts: number,
  maxRestarts: number,
): 'restart' | 'give-up' {
  return restarts >= maxRestarts ? 'give-up' : 'restart';
}

/**
 * The status `wait` reported for the backend: its exit code, or 128 plus the
 * signal number when a signal ended it.
 */
export function backendExitStatus(
  code: number | null,
  signal: string | null,
  signalNumbers: Readonly<Record<string, number | undefined>>,
): number {
  if (code !== null) return code;
  if (signal === null) return 0;
  return 128 + (signalNumbers[signal] ?? 0);
}

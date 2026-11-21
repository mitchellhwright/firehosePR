/**
 * The Cloud SQL proxy the Income activation lane puts in front of the
 * development database.
 *
 * The lane authenticates with the runner's workload identity, so the proxy is
 * started with `--auto-iam-authn` and bound to loopback on a port the step
 * picks. Everything the step later reads — the readiness line, the exit line,
 * the refusal to stop a process it does not own — is a string this module
 * owns, so the producer and the two consumers can never drift apart.
 *
 * Pure: no sockets, no spawning.
 */

/** The one instance this lane is allowed to reach. */
export const developmentInstanceConnectionName = 'example-app:us-central1:example-dev-postgres';

export const cloudSqlProxyExecutable = 'cloud-sql-proxy';

export function cloudSqlProxyArguments(port: number): readonly string[] {
  return [
    '--auto-iam-authn',
    '--address', '127.0.0.1',
    '--port', String(port),
    developmentInstanceConnectionName,
  ];
}

/** What the supervisor appends when the proxy ends, whatever its status. */
export function cloudSqlProxyExitLine(status: number): string {
  return `${cloudSqlProxyExecutable} exited with ${status}`;
}

export const proxyReadyMarker = 'ready for new connections';
export const proxyExitedMarker = `${cloudSqlProxyExecutable} exited`;

/**
 * The extended regex the start step blocks on. Both alternatives are needed:
 * a proxy that dies on startup never prints the ready line, and without its
 * exit line the step would wait on a log nothing will ever write to again.
 */
export const proxyReadinessPattern = `${proxyReadyMarker}|${proxyExitedMarker}`;

export type ProxyReadiness = 'ready' | 'exited';

export function classifyProxyReadiness(line: string): ProxyReadiness {
  return line.includes(proxyReadyMarker) ? 'ready' : 'exited';
}

export function proxyNotReadyMessage(line: string): string {
  return `Cloud SQL proxy did not become ready: ${line}`;
}

/**
 * The env entries the later Income steps read, in the shell's order. The PID
 * stays a string: a proxy that never started records none, and the stop step's
 * `if: env.INCOME_E2E_DB_PROXY_PID != ''` is what skips it then.
 */
export function proxyEnvironmentExports(port: number, pid: string): Readonly<Record<string, string>> {
  return {
    INCOME_E2E_DB_PROXY_PORT: String(port),
    INCOME_E2E_DB_PROXY_PID: pid,
  };
}

export function proxyPidFile(runDirectory: string): string {
  return `${runDirectory}/cloud-sql-proxy.pid`;
}

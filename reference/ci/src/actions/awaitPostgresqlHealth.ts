import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { containerEngineCommand, runEngine } from '../containerEngineCommand.ts';
import { requiredEnv } from '../ios/shared/githubStepIo.ts';
import { installSignalTraps, runCommand } from '../ios/shared/processRunner.ts';
import { awaitPostgresqlHealth, parseContainerState } from '../postgresqlHealth.ts';

const INSPECT_TIMEOUT_MS = 5_000;

/** Read the engine's current health rather than replaying its bounded event history. */
export async function runPostgresqlHealthAction(
  environment: NodeJS.ProcessEnv = process.env,
  run: typeof runCommand = runCommand,
  now: () => number = Date.now,
  pause: (milliseconds: number) => Promise<void> = sleep,
  log: (message: string) => void = console.log,
  error: (message: string) => void = console.error,
): Promise<number> {
  const command = containerEngineCommand(requiredEnv('DB_CONTAINER_CMD', environment));
  const container = requiredEnv('DB_CONTAINER_NAME', environment);
  const startedAtRaw = requiredEnv('DB_STARTED_AT', environment);
  const startedAtSeconds = Number(startedAtRaw);
  if (!Number.isSafeInteger(startedAtSeconds) || startedAtSeconds <= 0) {
    throw new Error(`Invalid DB_STARTED_AT: ${startedAtRaw}`);
  }
  const engine = (args: readonly string[]) => runEngine(command, args, run, {
    capture: true,
    env: environment,
    timeoutMs: INSPECT_TIMEOUT_MS,
  });
  try {
    await awaitPostgresqlHealth(startedAtSeconds * 1_000, {
      inspect: async () => {
        const result = await engine(['inspect', container]);
        if (result.status !== 0) {
          throw new Error(`Container inspect failed (exit ${result.status}): ${result.stderr.trim()}`);
        }
        return parseContainerState(result.stdout);
      },
      now,
      sleep: pause,
    });
    log('PostgreSQL container is healthy.');
    return 0;
  } catch (cause) {
    error(`::error::PostgreSQL health check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    const logs = await engine(['logs', '--tail', '40', container]);
    const diagnostic = [logs.stdout.trim(), logs.stderr.trim()].filter(Boolean).join('\n');
    if (diagnostic) error(diagnostic);
    if (logs.status !== 0) error(`Container logs failed (exit ${logs.status}).`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  installSignalTraps(() => {});
  try {
    process.exitCode = await runPostgresqlHealthAction();
  } catch (cause) {
    console.error(`::error::PostgreSQL health check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}

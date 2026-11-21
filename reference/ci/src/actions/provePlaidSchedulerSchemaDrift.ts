import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requiredEnv } from '../ios/shared/githubStepIo.ts';
import { installSignalTraps, runCommand } from '../ios/shared/processRunner.ts';
import { containerEngineCommand, runEngine } from '../containerEngineCommand.ts';
import { psqlExecArgs } from '../isolatedPostgresql.ts';
import { provePlaidSchedulerSchemaDrift } from '../plaidSchedulerSchemaDrift.ts';

/** Typed process boundary, injected by the adapter contract without invoking a shell. */
export async function runPlaidSchedulerDriftAction(
  environment: NodeJS.ProcessEnv = process.env,
  run: typeof runCommand = runCommand,
  save: (path: string, contents: string) => void = writeFileSync,
  log: (message: string) => void = console.log,
): Promise<number> {
  const command = containerEngineCommand(requiredEnv('DB_CONTAINER_CMD', environment));
  const container = requiredEnv('DB_CONTAINER_NAME', environment);
  const verifierLog = join(requiredEnv('RUNNER_TEMP', environment), 'plaid-scheduler-drift-verifier.log');
  return provePlaidSchedulerSchemaDrift({
    sql: async (statement) => {
      const result = await runEngine(command, psqlExecArgs(container, 'example', statement), run, { env: environment });
      if (result.stderr) log(result.stderr);
      return result.status;
    },
    verify: () => run('npm', ['run', 'db:verify-plaid-scheduler'], { capture: true, env: environment }),
    writeVerifierLog: (contents) => save(verifierLog, contents),
    log,
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let operation: Promise<number> | undefined;
  installSignalTraps(async () => {
    // Reap the interrupted psql/verifier first, then let the transaction's
    // finally block restore every successful schema mutation before exit.
    try { await operation; } catch { /* The signal handler owns the exit status. */ }
  });
  try {
    operation = runPlaidSchedulerDriftAction();
    process.exitCode = await operation;
  } catch (error) {
    console.error(`::error::Plaid scheduler drift proof failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

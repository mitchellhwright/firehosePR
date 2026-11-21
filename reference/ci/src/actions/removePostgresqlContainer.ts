import { containerEngineCommand } from '../containerEngineCommand.ts';
import { requiredEnv } from '../ios/shared/githubStepIo.ts';
import { runCommand, runStepProgram } from '../ios/shared/processRunner.ts';
import { removeContainer } from '../isolatedPostgresql.ts';

// Cleanup is best effort: an engine error is reported without failing the
// job whose suites already decided its outcome.
await runStepProgram('PostgreSQL container cleanup failed', async () => {
  const container = requiredEnv('DB_CONTAINER_NAME');
  const removed = await removeContainer(
    containerEngineCommand(requiredEnv('DB_CONTAINER_CMD')), container, runCommand, process.env,
  );
  if (removed.status !== 0) {
    console.log(`::warning::Could not remove PostgreSQL container ${container} `
      + `(exit ${removed.status}): ${removed.stderr.trim()}`);
  }
  return 0;
});

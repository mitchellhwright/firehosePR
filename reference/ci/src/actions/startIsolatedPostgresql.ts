import { appendGithubEnv } from '../ios/shared/githubStepIo.ts';
import { runCommand, runStepProgram } from '../ios/shared/processRunner.ts';
import { startIsolatedPostgresql } from '../isolatedPostgresql.ts';

await runStepProgram('Isolated PostgreSQL failed to start', async () => {
  await startIsolatedPostgresql(process.env, {
    run: runCommand,
    now: Date.now,
    exportEnv: (entries) => { appendGithubEnv(entries); },
  });
  return 0;
});

import { ensureContainerEngine } from '../containerEngineCommand.ts';
import { appendGithubEnv } from '../ios/shared/githubStepIo.ts';
import { resolveExecutable, runCommand, runStepProgram } from '../ios/shared/processRunner.ts';

await runStepProgram('Container engine setup failed', async () => {
  const engine = await ensureContainerEngine({
    run: runCommand,
    installed: (name) => resolveExecutable(name) !== undefined,
    env: process.env,
  });
  appendGithubEnv({ DB_CONTAINER_CMD: engine });
  return 0;
});

import { prepareConversationRuntimeDatabases, runTargetedWithEnvironment } from '../databaseLaneSuites.ts';
import { appendGithubEnv } from '../ios/shared/githubStepIo.ts';
import { runCommand, runStepProgram } from '../ios/shared/processRunner.ts';

await runStepProgram('Conversation runtime databases failed', () => prepareConversationRuntimeDatabases({
  run: runCommand,
  env: process.env,
  exportEnv: (entries) => { appendGithubEnv(entries); },
  runTargeted: runTargetedWithEnvironment,
}));

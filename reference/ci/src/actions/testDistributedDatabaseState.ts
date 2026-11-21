import { readFileSync } from 'node:fs';
import { testDistributedDatabaseState } from '../databaseLaneSuites.ts';
import { runCommand, runStepProgram } from '../ios/shared/processRunner.ts';

await runStepProgram('Distributed database state failed', () => testDistributedDatabaseState({
  run: runCommand,
  read: (path) => readFileSync(path, 'utf8'),
  env: process.env,
}));

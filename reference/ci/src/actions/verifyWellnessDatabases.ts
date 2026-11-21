import { readFileSync } from 'node:fs';
import { verifyWellnessDatabases } from '../databaseLaneSuites.ts';
import { runCommand, runStepProgram } from '../ios/shared/processRunner.ts';

await runStepProgram('Wellness database verification failed', () => verifyWellnessDatabases({
  run: runCommand,
  read: (path) => readFileSync(path, 'utf8'),
  env: process.env,
}));

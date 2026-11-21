import { runTargetedServerTests } from '../targetedServerTests.ts';

try {
  process.exitCode = runTargetedServerTests(process.env['TARGETED_SERVER_TESTS_JSON']);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

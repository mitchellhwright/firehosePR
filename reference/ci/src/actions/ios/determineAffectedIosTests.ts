import { resolve } from 'node:path';

import { annotateError, optionalEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';

/**
 * `Determine Affected iOS Tests`.
 *
 * Runs the shared affected-test selector for this lane. Native selection uses
 * the actual changed files; deferred server journeys keep their own trusted
 * execution requirements and are not decided here.
 *
 * The selector reads its whole input from the environment, so this program
 * only normalizes the one variable that may legitimately be absent — an
 * unset changed-file inventory is an empty one, not an unbound variable — and
 * hands the selector its exit status straight back to the step.
 */

const selector = resolve(process.cwd(), '..', 'scripts/select-ios-affected-tests.ts');

async function run(): Promise<number> {
  const result = await runCommand(process.execPath, [selector], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      IOS_AFFECTED_TESTS_CHANGED_FILES: optionalEnv('IOS_AFFECTED_TESTS_CHANGED_FILES'),
    },
  });
  return result.status;
}

run().then((status) => {
  process.exitCode = status;
}).catch((error: unknown) => {
  annotateError(
    `Affected iOS test selection failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

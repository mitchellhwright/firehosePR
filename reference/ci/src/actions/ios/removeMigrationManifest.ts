import { existsSync, rmSync } from 'node:fs';

import { requiredEnv } from '../../ios/shared/actionIo.ts';
import { runStepProgram } from '../../ios/shared/stepDecision.ts';
import {
  manifestRemovalMessage,
  migrationManifestPath,
} from '../../ios/devE2eSchemaVerification.ts';

/**
 * "Remove migration manifest": the `if: always()` cleanup.
 *
 * The manifest holds the pull request's migrations as inert data on a runner
 * that can reach the shared development database, so it is removed whatever
 * the job's outcome. The path is derived by
 * `ci/src/ios/devE2eSchemaVerification.ts` from the same two values the
 * producing steps use, so the cleanup cannot drift from what it cleans up.
 */
runStepProgram('Migration manifest removal', () => {
  const path = migrationManifestPath(requiredEnv('RUNNER_TEMP'), requiredEnv('GITHUB_RUN_ID'));
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return manifestRemovalMessage(path, existed);
});

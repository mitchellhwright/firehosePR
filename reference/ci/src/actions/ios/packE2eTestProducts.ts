import { requiredEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';
import {
  archiveStage,
  copyIntoStage,
  resetStage,
  sealArchive,
} from '../../ios/shared/testProductArchive.ts';

/**
 * `Pack executable E2E products`.
 *
 * Seals the compiled E2E products into the archive every real-server lane
 * restores. Debug symbols are dropped first: the lanes launch the products,
 * they never symbolicate, and the `.dSYM` bundles are most of the transfer
 * this archive costs on every one of the four lanes.
 */
await runStep('E2E test product handoff', async () => {
  const cwd = process.cwd();
  const products = requiredEnv('IOS_E2E_TEST_PRODUCTS');
  const stage = archiveStage({
    runnerTemp: requiredEnv('RUNNER_TEMP'),
    stageName: 'example-ios-e2e-products',
    workspace: requiredEnv('GITHUB_WORKSPACE'),
    archiveName: 'example-ios-e2e.xctestproducts.zip',
    cwd,
  });
  resetStage(stage);

  const pruned = await runCommand(
    'find',
    [products, '-type', 'd', '-name', '*.dSYM', '-prune', '-exec', 'rm', '-rf', '{}', '+'],
    { cwd },
  );
  if (pruned.status !== 0) {
    throw new StepFailure('::error::Could not drop debug symbols from the E2E products.');
  }
  await copyIntoStage(stage, products);

  const headSha = requiredEnv('ONBOARDING_E2E_COMMIT_SHA');
  await sealArchive(stage, {
    headSha,
    producer: {
      schema: 'example-ios-test-product-producer-v1',
      headSha,
      runId: requiredEnv('GITHUB_RUN_ID'),
      runAttempt: requiredEnv('GITHUB_RUN_ATTEMPT'),
      job: requiredEnv('GITHUB_JOB'),
    },
  });
  await runCommand('du', ['-h', stage.archive], { cwd });
});

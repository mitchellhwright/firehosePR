import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { requiredEnv } from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { verifyTestProductToolchainReceipt } from '../../ios/shared/testProductToolchain.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';
import {
  readArchiveProducerProvenance,
  sealArchive,
  type ArchiveProducerProvenance,
  type ArchiveStage,
} from '../../ios/shared/testProductArchive.ts';

const headSha = /^[a-f0-9]{40}$/;

/**
 * Rebinds an already verified, content-identical predecessor archive to the
 * current exact head. The trusted controller admits this step only after its
 * complete typed product-input inventory matches. This action independently
 * verifies the predecessor marker and exact Xcode receipt before changing the
 * receipt. Any stale, corrupt, or incompatible cache requests an ordinary
 * current-head rebuild in the same job.
 */
await runStep('Rebind content-identical E2E products', async () => {
  const workspace = requiredEnv('GITHUB_WORKSPACE');
  const runnerTemp = requiredEnv('RUNNER_TEMP');
  const reusedHead = requiredEnv('IOS_E2E_REUSED_HEAD_SHA');
  const reusedRunId = requiredEnv('IOS_E2E_REUSED_RUN_ID');
  const reusedRunAttempt = requiredEnv('IOS_E2E_REUSED_RUN_ATTEMPT');
  const currentHead = requiredEnv('ONBOARDING_E2E_COMMIT_SHA');
  if (!headSha.test(reusedHead) || !headSha.test(currentHead)) {
    throw new StepFailure('::error::E2E product reuse requires exact lowercase Git commit SHAs.');
  }
  const archive = join(
    workspace,
    '.example-ci/handoff/example-ios-e2e.xctestproducts.zip',
  );
  const extractionRoot = join(runnerTemp, 'example-ios-e2e-rebind');
  const stage: ArchiveStage = {
    stage: join(extractionRoot, 'example-ios-e2e-products'),
    archive,
    cwd: workspace,
  };
  rmSync(extractionRoot, { recursive: true, force: true });
  mkdirSync(extractionRoot, { recursive: true });
  const extracted = await runCommand('ditto', ['-x', '-k', archive, extractionRoot]);
  if (extracted.status !== 0) {
    appendStepOutputs([['rebuild_required', 'true']]);
    return;
  }

  let stagedSha = '';
  try {
    stagedSha = readFileSync(join(stage.stage, 'exact-head-sha'), 'utf8').trim();
  } catch {
    stagedSha = '';
  }
  if (stagedSha !== reusedHead) {
    console.warn(
      `Restored E2E products were built for ${stagedSha || 'an unknown head'}, not the proven predecessor ${reusedHead}; rebuilding the current head.`,
    );
    appendStepOutputs([['rebuild_required', 'true']]);
    return;
  }
  const expectedProducer: ArchiveProducerProvenance = {
    schema: 'example-ios-test-product-producer-v1',
    headSha: reusedHead,
    runId: reusedRunId,
    runAttempt: reusedRunAttempt,
    job: 'build-ios-e2e-test-products',
  };
  const producer = readArchiveProducerProvenance(stage.stage);
  if (producer === null
    || Object.entries(expectedProducer).some(([key, value]) => (
      producer[key as keyof ArchiveProducerProvenance] !== value
    ))) {
    console.warn('Restored E2E products do not match the proven producer run and attempt; rebuilding the current head.');
    appendStepOutputs([['rebuild_required', 'true']]);
    return;
  }
  let verified: 0 | 1 | 3 = 1;
  try {
    verified = await verifyTestProductToolchainReceipt(join(stage.stage, 'toolchain.json'), reusedHead);
  } catch (error: unknown) {
    console.warn(`Restored E2E product toolchain receipt was refused: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (verified !== 0) {
    appendStepOutputs([['rebuild_required', 'true']]);
    return;
  }

  rmSync(archive, { force: true });
  await sealArchive(stage, {
    headSha: currentHead,
    producer: {
      schema: 'example-ios-test-product-producer-v1',
      headSha: currentHead,
      runId: requiredEnv('GITHUB_RUN_ID'),
      runAttempt: requiredEnv('GITHUB_RUN_ATTEMPT'),
      job: requiredEnv('GITHUB_JOB'),
    },
  });
  appendStepOutputs([['rebuild_required', 'false']]);
});

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { booleanEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { runStep } from '../../ios/shared/stepIo.ts';
import {
  archiveStage,
  copyIntoStage,
  requireNonEmptyFile,
  resetStage,
  sealArchive,
} from '../../ios/shared/testProductArchive.ts';

/**
 * `Pack exact-head native test products`.
 *
 * Seals the compiled main products — and the evidence products when the plan
 * was compiled — into the archive the four native execution lanes restore from
 * cache. The archive carries the exact head it was built from and the producer
 * toolchain, so a consumer on a different Xcode rebuilds instead of launching
 * products it cannot trust.
 */
await runStep('Native test product handoff', async () => {
  const cwd = process.cwd();
  const stage = archiveStage({
    runnerTemp: requiredEnv('RUNNER_TEMP'),
    stageName: 'example-ios-native-products',
    workspace: requiredEnv('GITHUB_WORKSPACE'),
    archiveName: 'example-ios-native-products.zip',
    cwd,
  });
  resetStage(stage);
  await copyIntoStage(stage, requiredEnv('IOS_TEST_PRODUCTS'));

  const evidenceProducts = requiredEnv('IOS_EVIDENCE_TEST_PRODUCTS');
  if (booleanEnv('EVIDENCE_PLAN_REQUIRED')) {
    // A plan that was supposed to be compiled but is not here would strand the
    // evidence lanes with nothing to launch, so the handoff fails closed.
    requireNonEmptyFile(
      join(evidenceProducts, 'Info.plist'),
      `Required CI-Evidence products are missing from ${evidenceProducts}.`,
    );
  }
  if (existsSync(evidenceProducts)) await copyIntoStage(stage, evidenceProducts);

  await sealArchive(stage, {
    headSha: requiredEnv('EXACT_HEAD_SHA'),
  });
});

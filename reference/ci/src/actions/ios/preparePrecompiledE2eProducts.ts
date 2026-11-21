import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import {
  precompiledProductsUnavailableMessage,
  precompiledProductsVerdict,
  precompiledRebuildNotice,
  missingPrecompiledProductsVerdict,
  stagedProductsMismatchMessage,
} from '../../ios/realServerE2eLanes.ts';
import {
  annotateError,
  annotateNotice,
  exportStepEnvBlock,
} from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { verifyTestProductToolchainReceipt } from '../../ios/shared/testProductToolchain.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Unpacks the E2E products the build job handed over and decides whether this
 * runner's Xcode can launch them.
 *
 * The products are built once per run on one Mac and consumed by four lanes on
 * possibly different Macs, so the toolchain manifest is verified here; a
 * mismatch is a rebuild request, not a failure.
 */

const environmentSchema = z.object({
  GITHUB_WORKSPACE: z.string().min(1),
  RUNNER_TEMP: z.string().min(1),
  ONBOARDING_E2E_COMMIT_SHA: z.string().min(1),
});

function fileHasContent(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const archive = join(
    environment.GITHUB_WORKSPACE,
    '.example-ci/handoff/example-ios-e2e.xctestproducts.zip',
  );
  if (!fileHasContent(archive)) {
    annotateNotice(precompiledProductsUnavailableMessage);
    const verdict = missingPrecompiledProductsVerdict(environment.RUNNER_TEMP);
    rmSync(dirname(verdict.products), { recursive: true, force: true });
    mkdirSync(dirname(verdict.products), { recursive: true });
    appendStepOutputs([['rebuild_required', 'true']]);
    exportStepEnvBlock(new Map([['IOS_E2E_TEST_PRODUCTS', verdict.products]]));
    return;
  }

  const productsRoot = join(environment.RUNNER_TEMP, 'example-ios-e2e-products');
  mkdirSync(productsRoot, { recursive: true });
  const extracted = await runCommand('ditto', ['-x', '-k', archive, productsRoot]);
  if (extracted.status !== 0) {
    throw new StepFailure('', 'stdout', extracted.status);
  }
  rmSync(archive, { force: true });

  const stage = join(productsRoot, 'example-ios-e2e-products');
  const stagedSha = readFileSync(join(stage, 'exact-head-sha'), 'utf8').trim();
  if (stagedSha !== environment.ONBOARDING_E2E_COMMIT_SHA) {
    annotateError(
      stagedProductsMismatchMessage(stagedSha, environment.ONBOARDING_E2E_COMMIT_SHA),
    );
    throw new StepFailure('', 'stdout');
  }

  const verified = await verifyTestProductToolchainReceipt(join(stage, 'toolchain.json'), environment.ONBOARDING_E2E_COMMIT_SHA);
  const verdict = precompiledProductsVerdict(verified, {
    runnerTemp: environment.RUNNER_TEMP,
    stage,
  });
  if (verdict.kind === 'propagate') throw new StepFailure('', 'stdout', verdict.status);

  if (verdict.kind === 'rebuild') {
    annotateNotice(precompiledRebuildNotice);
    rmSync(productsRoot, { recursive: true, force: true });
    rmSync(dirname(verdict.products), { recursive: true, force: true });
    mkdirSync(dirname(verdict.products), { recursive: true });
  }
  appendStepOutputs([['rebuild_required', String(verdict.kind === 'rebuild')]]);
  exportStepEnvBlock(new Map([['IOS_E2E_TEST_PRODUCTS', verdict.products]]));
}

await runStep('Prepare precompiled E2E launch paths', run);

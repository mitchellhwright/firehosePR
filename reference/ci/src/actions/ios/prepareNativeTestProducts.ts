import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { annotateError, annotateWarning, exportStepEnvBlock, logLine, requiredEnv } from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { verifyTestProductToolchainReceipt } from '../../ios/shared/testProductToolchain.ts';
import {
  laneRunDirectoryPrefix,
  nativeTestProductEnvironment,
  toolchainVerdict,
} from '../../ios/executionPlan.ts';

/**
 * `Prepare native test products and result paths`.
 *
 * Unpacks the exact-head XCTest products the producer job built, proves they
 * were built from this head and for a toolchain this consumer can execute,
 * then exports every result path the lane's later steps read.
 *
 * A consumer whose Xcode differs from the producer's is not a failure: the
 * step reports `rebuild_required` and exports nothing, and the rebuild step
 * that follows exports the same set of paths itself.
 */

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** `$(cat …)`: the file's contents without its trailing newlines. */
function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').replace(/\n+$/, '');
  } catch {
    return undefined;
  }
}

async function run(): Promise<number> {
  const workspace = requiredEnv('GITHUB_WORKSPACE');
  const runnerTemp = requiredEnv('RUNNER_TEMP');
  const exactHeadSha = requiredEnv('EXACT_HEAD_SHA');
  const archive = join(workspace, '.example-ci/handoff/example-ios-native-products.zip');
  if (fileSize(archive) === 0) {
    annotateWarning('Exact-head native test products were unavailable from cache and fallback artifact; rebuilding on this exact-head consumer.');
    appendStepOutputs([['rebuild_required', 'true']]);
    return 0;
  }

  const productsRoot = join(runnerTemp, 'example-ios-native-products-restored');
  rmSync(productsRoot, { recursive: true, force: true });
  mkdirSync(productsRoot, { recursive: true });
  const unpacked = await runCommand('ditto', ['-x', '-k', archive, productsRoot], {
    cwd: process.cwd(),
  });
  if (unpacked.status !== 0) {
    rmSync(productsRoot, { recursive: true, force: true });
    rmSync(archive, { force: true });
    annotateWarning('The restored native test-product archive could not be unpacked; rebuilding on this exact-head consumer.');
    appendStepOutputs([['rebuild_required', 'true']]);
    return 0;
  }
  rmSync(archive, { force: true });

  const stage = join(productsRoot, 'example-ios-native-products');
  if (readTrimmed(join(stage, 'exact-head-sha')) !== exactHeadSha) {
    annotateError(`Restored native test products were not built from ${exactHeadSha}.`);
    return 1;
  }

  const verified = await verifyTestProductToolchainReceipt(join(stage, 'toolchain.json'), exactHeadSha);
  const verdict = toolchainVerdict(verified);
  if (verdict.kind === 'rebuild') {
    logLine("::notice::Rebuilding native test products for the consumer's exact Xcode.");
    appendStepOutputs([['rebuild_required', 'true']]);
    rmSync(productsRoot, { recursive: true, force: true });
    return 0;
  }
  if (verdict.kind === 'failed') return verdict.status;
  appendStepOutputs([['rebuild_required', 'false']]);

  const testProducts = join(stage, 'example-ios-tests.xctestproducts');
  if (fileSize(join(testProducts, 'Info.plist')) === 0) {
    annotateError(`Restored native test products are missing ${testProducts}/Info.plist.`);
    return 1;
  }

  const runDir = mkdtempSync(join(
    runnerTemp,
    laneRunDirectoryPrefix(requiredEnv('GITHUB_RUN_ID'), requiredEnv('GITHUB_RUN_ATTEMPT'))
      + `${requiredEnv('EXECUTION_LANE')}.`,
  ));
  exportStepEnvBlock(nativeTestProductEnvironment({ runDir, stage }));
  return 0;
}

run().then((status) => {
  process.exitCode = status;
}).catch((error: unknown) => {
  annotateError(
    `Native test product preparation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

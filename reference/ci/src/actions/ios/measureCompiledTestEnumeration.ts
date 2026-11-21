import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  compareCompiledPlan,
  compiledTestIdentifiers,
  testPlanSelectors,
  unfilteredEnumerationArguments,
} from '../../ios/compiledTestEnumeration.ts';
import { appendStepSummary, optionalEnv } from '../../ios/shared/actionIo.ts';
import { installSignalTraps, isProcessTerminating, runCommand } from '../../ios/shared/processRunner.ts';

interface ProductPlan {
  readonly productsPath: string;
  readonly planName: 'CI' | 'CI-Unit' | 'CI-Evidence';
}

const activeScratch = new Set<string>();
installSignalTraps(async () => {
  await Promise.allSettled([...activeScratch].map((path) => rm(path, { recursive: true, force: true })));
});

export function productIosDirectory(workspace: string, currentDirectory: string): string {
  if (workspace === '') return currentDirectory;
  if (!isAbsolute(workspace)) throw new Error('IOS_PRODUCT_WORKSPACE must be an absolute path.');
  return join(workspace, 'ios');
}

/**
 * Advisory measurement on the Mac that already built these products. This
 * invokes Xcode's enumeration without -only-testing and without executing a
 * test, then compares its executable inventory with the authored test plan.
 * Until the overhead and output shape are observed in CI, any enumeration
 * failure remains a warning and cannot block the existing unit preflight.
 */
async function measure({ productsPath, planName }: ProductPlan): Promise<void> {
  if (isProcessTerminating()) return;
  if (!existsSync(join(productsPath, 'Info.plist'))) return;
  const workingDirectory = productIosDirectory(
    optionalEnv('IOS_PRODUCT_WORKSPACE'), process.cwd(),
  );
  let tempDirectory: string | undefined;
  const started = performance.now();
  try {
    tempDirectory = await mkdtemp(join(optionalEnv('RUNNER_TEMP', tmpdir()), 'example-ios-enumeration-'));
    activeScratch.add(tempDirectory);
    // A signal may arrive while the asynchronous scratch directory is created.
    // Keep this check adjacent to the synchronous child spawn.
    if (isProcessTerminating()) return;
    const outputPath = join(tempDirectory, 'compiled-tests.json');
    const result = await runCommand('xcodebuild', unfilteredEnumerationArguments({
      planName,
      productsPath,
      destination: optionalEnv('IOS_PRIMARY_DESTINATION', 'generic/platform=iOS Simulator'),
      outputPath,
    }), { cwd: workingDirectory, capture: true, timeoutMs: 30_000 });
    if (isProcessTerminating()) return;
    const durationSeconds = ((performance.now() - started) / 1_000).toFixed(1);
    if (result.status !== 0) {
      process.stdout.write(`::warning::${planName} compiled-test enumeration exited ${result.status} after ${durationSeconds}s: ${result.stderr.trim().slice(-500)}\n`);
      return;
    }
    const planPath = join(workingDirectory, 'example-ios.xcodeproj', 'xcshareddata', 'TestPlans', `${planName}.xctestplan`);
    const [compiledDocument, planDocument] = await Promise.all([
      readFile(outputPath, 'utf8').then((source) => JSON.parse(source) as unknown),
      readFile(planPath, 'utf8').then((source) => JSON.parse(source) as unknown),
    ]);
    const comparison = compareCompiledPlan(
      testPlanSelectors(planDocument),
      compiledTestIdentifiers(compiledDocument),
    );
    const report = `${planName}: ${comparison.compiledMethods} compiled methods, ${comparison.matchedSelectors} matched plan selectors, ${comparison.missingSelectors.length} missing selectors, ${durationSeconds}s enumeration`;
    process.stdout.write(`::notice::${report}\n`);
    if (optionalEnv('GITHUB_STEP_SUMMARY') !== '') appendStepSummary(`- ${report}`);
    if (comparison.missingSelectors.length > 0) {
      process.stdout.write(`::warning::${planName} selectors absent from unfiltered compiled enumeration: ${comparison.missingSelectors.slice(0, 10).join(', ')}\n`);
    }
  } catch (error: unknown) {
    const durationSeconds = ((performance.now() - started) / 1_000).toFixed(1);
    process.stdout.write(`::warning::${planName} compiled-test enumeration could not be measured after ${durationSeconds}s: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    if (tempDirectory !== undefined) {
      await rm(tempDirectory, { recursive: true, force: true }).catch((error: unknown) => {
        process.stdout.write(`::warning::Could not remove enumeration scratch directory: ${error instanceof Error ? error.message : String(error)}\n`);
      });
      activeScratch.delete(tempDirectory);
    }
  }
}

const primaryProducts = optionalEnv('IOS_TEST_PRODUCTS');
if (primaryProducts !== '') {
  const planName = optionalEnv('IOS_TEST_PLAN');
  if (planName === 'CI' || planName === 'CI-Unit') {
    await measure({ productsPath: primaryProducts, planName });
  } else {
    process.stdout.write(`::warning::Unexpected compiled native test plan: ${planName}\n`);
  }
}
const evidenceProducts = optionalEnv('IOS_EVIDENCE_TEST_PRODUCTS');
if (evidenceProducts !== '' && !isProcessTerminating()) {
  await measure({ productsPath: evidenceProducts, planName: 'CI-Evidence' });
}

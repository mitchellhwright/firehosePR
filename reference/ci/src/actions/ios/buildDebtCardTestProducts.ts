import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  debtCardBuildArguments,
  debtCardManifest,
  debtCardManifestJson,
  debtCardUiTestBundle,
} from '../../ios/realServerE2eLanes.ts';
import { findFirstEntry } from '../../ios/shared/fileTree.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Builds the debt-card evidence test products this runner can launch, and
 * stamps the manifest the cache validator reads back.
 *
 * Every build input is passed to `xcodebuild` as an argument, so a derived
 * data path or a product path can never be read as shell syntax. The derived
 * data is removed afterwards: only the product tree is worth caching.
 */

const environmentSchema = z.object({
  BUILD_FINGERPRINT: z.string().min(1),
  CACHE_DIR: z.string().min(1),
  EXACT_HEAD_SHA: z.string().min(1),
  MANIFEST_PATH: z.string().min(1),
  TEST_PRODUCTS_PATH: z.string().min(1),
  ONBOARDING_E2E_RUN_DIR: z.string().min(1),
});

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const derivedData = join(environment.ONBOARDING_E2E_RUN_DIR, 'DerivedData');
  const sourcePackages = join(environment.ONBOARDING_E2E_RUN_DIR, 'SourcePackages');
  const packageCache = join(environment.ONBOARDING_E2E_RUN_DIR, 'PackageCache');
  const directories = [environment.CACHE_DIR, derivedData, sourcePackages, packageCache];
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  for (const directory of directories) mkdirSync(directory, { recursive: true });

  const plaidLink = await runCommand('bash', ['scripts/prepare-ios-plaid-link.sh', sourcePackages]);
  if (plaidLink.status !== 0) throw new StepFailure('', 'stdout', plaidLink.status);

  const built = await runCommand(
    'xcodebuild',
    debtCardBuildArguments({
      testProductsPath: environment.TEST_PRODUCTS_PATH,
      derivedData,
      sourcePackages,
      packageCache,
    }),
  );
  if (built.status !== 0) throw new StepFailure('', 'stdout', built.status);

  const infoPlist = statSync(join(environment.TEST_PRODUCTS_PATH, 'Info.plist'), {
    throwIfNoEntry: false,
  });
  if (infoPlist === undefined || !infoPlist.isFile() || infoPlist.size === 0) {
    throw new StepFailure(
      `${environment.TEST_PRODUCTS_PATH}/Info.plist is missing or empty after the build`,
      'stderr',
    );
  }
  const bundle = findFirstEntry(
    environment.TEST_PRODUCTS_PATH,
    (entry) => entry.kind === 'directory' && entry.name === debtCardUiTestBundle,
  );
  if (bundle === undefined) {
    throw new StepFailure(`${debtCardUiTestBundle} was not produced by the build`, 'stderr');
  }

  writeFileSync(
    environment.MANIFEST_PATH,
    debtCardManifestJson(
      debtCardManifest(environment.EXACT_HEAD_SHA, environment.BUILD_FINGERPRINT),
    ),
    'utf8',
  );
  rmSync(derivedData, { recursive: true, force: true });
}

await runStep('Build exact-head debt-card test products', run);

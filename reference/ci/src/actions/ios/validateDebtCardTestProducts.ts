import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  debtCardManifest,
  debtCardManifestMismatch,
  debtCardManifestMismatchMessage,
  debtCardUiTestBundle,
} from '../../ios/realServerE2eLanes.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { findFirstEntry } from '../../ios/shared/fileTree.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Decides whether the restored debt-card cache may be launched as-is.
 *
 * A cache hit alone proves nothing: the entry must still hold the UI test
 * bundle and a manifest naming this head, this build fingerprint and this test
 * plan. Anything else is reported as unusable so the build step rebuilds,
 * rather than failing the lane.
 */

const environmentSchema = z.object({
  BUILD_FINGERPRINT: z.string().min(1),
  CACHE_HIT: z.string().default(''),
  EXACT_HEAD_SHA: z.string().min(1),
  MANIFEST_PATH: z.string().min(1),
  TEST_PRODUCTS_PATH: z.string().min(1),
});

function run(): void {
  const environment = readStepEnvironment(environmentSchema);
  if (environment.CACHE_HIT !== 'true') {
    appendStepOutputs([['usable', 'false']]);
    return;
  }

  const infoPlist = statSync(join(environment.TEST_PRODUCTS_PATH, 'Info.plist'), {
    throwIfNoEntry: false,
  });
  if (infoPlist === undefined || !infoPlist.isFile() || infoPlist.size === 0) {
    throw new StepFailure(
      `${environment.TEST_PRODUCTS_PATH}/Info.plist is missing or empty`,
      'stderr',
    );
  }
  const products = statSync(environment.TEST_PRODUCTS_PATH, { throwIfNoEntry: false });
  if (products === undefined || !products.isDirectory()) {
    throw new StepFailure(`${environment.TEST_PRODUCTS_PATH} is not a directory`, 'stderr');
  }
  const bundle = findFirstEntry(
    environment.TEST_PRODUCTS_PATH,
    (entry) => entry.kind === 'directory' && entry.name === debtCardUiTestBundle,
  );
  if (bundle === undefined) {
    throw new StepFailure(
      `${debtCardUiTestBundle} is missing from ${environment.TEST_PRODUCTS_PATH}`,
      'stderr',
    );
  }

  const mismatch = debtCardManifestMismatch(
    JSON.parse(readFileSync(environment.MANIFEST_PATH, 'utf8')),
    debtCardManifest(environment.EXACT_HEAD_SHA, environment.BUILD_FINGERPRINT),
  );
  if (mismatch !== undefined) {
    throw new StepFailure(debtCardManifestMismatchMessage(mismatch), 'stderr');
  }
  appendStepOutputs([['usable', 'true']]);
}

await runStep('Validate exact-head debt-card test products', run);

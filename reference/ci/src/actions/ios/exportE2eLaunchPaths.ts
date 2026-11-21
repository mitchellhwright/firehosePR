import { statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import {
  e2eLaunchPathExports,
  missingXctestrunMessage,
} from '../../ios/realServerE2eLanes.ts';
import { annotateError, exportStepEnvBlock } from '../../ios/shared/actionIo.ts';
import { findFirstEntry } from '../../ios/shared/fileTree.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Publishes the one product tree and `.xctestrun` every lane script launches,
 * after proving both exist. Exporting them together is what stops two lanes in
 * the same job from running against different builds.
 */

const environmentSchema = z.object({
  IOS_E2E_TEST_PRODUCTS: z.string().min(1),
});

function run(): void {
  const environment = readStepEnvironment(environmentSchema);
  const products = environment.IOS_E2E_TEST_PRODUCTS;
  if (statSync(join(products, 'Info.plist'), { throwIfNoEntry: false })?.isFile() !== true) {
    throw new StepFailure(`${products}/Info.plist is missing`, 'stderr');
  }
  const xctestrun = findFirstEntry(
    products,
    (entry) => entry.kind === 'file' && entry.name.endsWith('.xctestrun'),
  );
  if (xctestrun === undefined) {
    annotateError(missingXctestrunMessage);
    throw new StepFailure('', 'stdout');
  }
  exportStepEnvBlock(e2eLaunchPathExports(products, xctestrun));
}

await runStep('Export exact-toolchain E2E launch paths', run);

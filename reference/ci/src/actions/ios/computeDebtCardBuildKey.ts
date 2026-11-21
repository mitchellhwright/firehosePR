import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import {
  debtCardBuildFingerprint,
  debtCardCacheKey,
  debtCardFingerprintInputs,
  shasumListing,
} from '../../ios/realServerE2eLanes.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Fingerprints the debt-card evidence build so a cached product tree is only
 * reused by a runner whose Xcode and project inputs still agree with it.
 *
 * The digests reproduce the `shasum -a 256 … | shasum -a 256` pair the shell
 * computed, listing text included, so a key minted before this conversion and
 * one minted after name the same cache entry.
 */

const environmentSchema = z.object({
  EXACT_HEAD_SHA: z.string().min(1),
  RUNNER_OS: z.string().min(1),
  RUNNER_ARCH: z.string().min(1),
});

function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const version = await runCommand('xcodebuild', ['-version'], { capture: true });
  if (version.status !== 0) throw new StepFailure('', 'stdout', version.status);

  const listing = shasumListing(
    debtCardFingerprintInputs.map((path) => [sha256(readFileSync(path)), path] as const),
  );
  const buildFingerprint = debtCardBuildFingerprint(sha256(version.stdout), sha256(listing));
  appendStepOutputs([
    [
      'cache_key',
      debtCardCacheKey({
        runnerOs: environment.RUNNER_OS,
        runnerArch: environment.RUNNER_ARCH,
        exactHeadSha: environment.EXACT_HEAD_SHA,
        buildFingerprint,
      }),
    ],
    ['build_fingerprint', buildFingerprint],
  ]);
}

await runStep('Compute exact-head debt-card build key', run);

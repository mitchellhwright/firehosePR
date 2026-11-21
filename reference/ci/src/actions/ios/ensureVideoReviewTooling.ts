import {
  missingVideoToolingMessage,
  videoToolingBinaries,
  videoToolingPlan,
  videoToolingStillMissingMessage,
} from '../../ios/realServerE2eLanes.ts';
import { annotateError, exportStepPath } from '../../ios/shared/actionIo.ts';
import { resolveExecutable, runCommand } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Makes sure the onboarding video can be compressed and measured before the
 * promotion lane records one.
 *
 * The step is `continue-on-error`: a runner without ffmpeg loses the
 * non-gating video review, not the regression run itself.
 */

async function run(): Promise<void> {
  const brew = resolveExecutable('brew');
  const plan = videoToolingPlan({
    present: videoToolingBinaries.map((binary) => resolveExecutable(binary) !== undefined),
    homebrewAvailable: brew !== undefined,
  });
  if (plan === 'present') return;
  if (plan === 'unavailable') {
    annotateError(missingVideoToolingMessage);
    throw new StepFailure('', 'stdout');
  }

  const homebrew = brew ?? 'brew';
  const listed = await runCommand(homebrew, ['list', 'ffmpeg'], { capture: true });
  if (listed.status !== 0) {
    const installed = await runCommand(homebrew, ['install', 'ffmpeg']);
    if (installed.status !== 0) throw new StepFailure('', 'stdout', installed.status);
  }
  const prefix = await runCommand(homebrew, ['--prefix'], { capture: true });
  if (prefix.status !== 0) throw new StepFailure('', 'stdout', prefix.status);
  const binDirectory = `${prefix.stdout.trim()}/bin`;
  exportStepPath(binDirectory);

  // Later steps read the exported PATH; this step has to look in the new
  // directory itself, so the check is against an explicit search path.
  const searchPath = `${binDirectory}:${process.env.PATH ?? ''}`;
  const missing = videoToolingBinaries.filter(
    (binary) => resolveExecutable(binary, { ...process.env, PATH: searchPath }) === undefined,
  );
  if (missing.length > 0) {
    throw new StepFailure(videoToolingStillMissingMessage(missing), 'stderr');
  }
}

await runStep('Ensure video review tooling', run);

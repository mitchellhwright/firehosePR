import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { logLine, requiredEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import {
  error,
  fail,
  pass,
  runAsyncStepProgram,
  type StepDecision,
} from '../../ios/shared/stepDecision.ts';
import { selectRawVideo } from '../../ios/budgetVideoProcessing.ts';

/**
 * "Process Budget video": compresses the attempt's raw recording.
 *
 * `scripts/process-ios-e2e-video.sh` stays where it is — every lane that
 * records a video shares it — and receives both paths as arguments. The one
 * decision, which of the downloaded files is the recording, is
 * `selectRawVideo` in `ci/src/ios/budgetVideoProcessing.ts`.
 */
function downloadedFiles(directory: string): readonly string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

await runAsyncStepProgram('Budget video processing', async (): Promise<StepDecision> => {
  const runDirectory = requiredEnv('BUDGET_VIDEO_RUN_DIR');
  const compressed = requiredEnv('BUDGET_E2E_COMPRESSED_VIDEO');
  if (!await ensureFfmpeg()) {
    return fail(error('ffmpeg is unavailable and could not be installed on this runner.'));
  }
  const raw = selectRawVideo(downloadedFiles(join(runDirectory, 'raw')));
  logLine(`Compressing ${raw}.`);
  const processed = await runCommand('bash', [
    join(requiredEnv('GITHUB_WORKSPACE'), 'scripts/process-ios-e2e-video.sh'),
    raw,
    compressed,
  ]);
  return processed.status === 0 ? pass() : fail();
});

/**
 * The lane's Linux runners are long-lived and usually already have ffmpeg, so
 * the install only happens the first time one of them processes a video.
 */
async function ensureFfmpeg(): Promise<boolean> {
  const present = await runCommand('ffmpeg', ['-version'], { capture: true });
  if (present.status === 0) return true;
  const update = await runCommand('sudo', ['apt-get', 'update']);
  if (update.status !== 0) return false;
  const install = await runCommand('sudo', [
    'apt-get', 'install', '-y', '--no-install-recommends', 'ffmpeg',
  ]);
  return install.status === 0;
}

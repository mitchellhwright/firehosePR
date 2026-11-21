import {
  cloudSdkHomebrewFormula,
  cloudSdkPythonCandidates,
  cloudSdkPythonProbe,
  homebrewCandidates,
  noCompatiblePythonMessage,
} from '../../ios/realServerE2eLanes.ts';
import { exportStepEnvBlock, logLine } from '../../ios/shared/actionIo.ts';
import { isExecutable, resolveExecutable, runCommand } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Picks the interpreter the Google Cloud SDK runs under.
 *
 * gcloud refuses anything outside 3.10–3.14, and a macOS runner's default
 * `python3` regularly sits outside that window. Each candidate is asked its
 * own version rather than inferred from its path, and only when none answers
 * does the step install one.
 */

async function interpreterAccepted(candidate: string): Promise<boolean> {
  if (!isExecutable(candidate)) return false;
  const probed = await runCommand(candidate, ['-c', cloudSdkPythonProbe], { capture: true });
  return probed.status === 0;
}

async function installedInterpreter(): Promise<string> {
  const homebrew = homebrewCandidates(resolveExecutable('brew') ?? '').find((candidate) =>
    isExecutable(candidate),
  );
  if (homebrew === undefined) throw new StepFailure(noCompatiblePythonMessage, 'stderr');

  const listed = await runCommand(homebrew, ['list', '--versions', cloudSdkHomebrewFormula], {
    capture: true,
  });
  if (listed.status !== 0) {
    const installed = await runCommand(homebrew, ['install', cloudSdkHomebrewFormula]);
    if (installed.status !== 0) throw new StepFailure('', 'stdout', installed.status);
  }
  const prefix = await runCommand(homebrew, ['--prefix', cloudSdkHomebrewFormula], {
    capture: true,
  });
  if (prefix.status !== 0) throw new StepFailure('', 'stdout', prefix.status);
  return `${prefix.stdout.trim()}/bin/python3.12`;
}

async function run(): Promise<void> {
  let interpreter: string | undefined;
  for (const candidate of cloudSdkPythonCandidates(resolveExecutable('python3') ?? '')) {
    if (await interpreterAccepted(candidate)) {
      interpreter = candidate;
      break;
    }
  }
  interpreter ??= await installedInterpreter();

  const probed = await runCommand(interpreter, ['-c', cloudSdkPythonProbe]);
  if (probed.status !== 0) throw new StepFailure('', 'stdout', probed.status);
  const version = await runCommand(interpreter, ['--version'], { capture: true });
  if (version.status !== 0) throw new StepFailure('', 'stdout', version.status);
  logLine(version.stdout.trim());
  exportStepEnvBlock(new Map([['CLOUDSDK_PYTHON', interpreter]]));
}

await runStep('Configure Cloud SDK Python', run);

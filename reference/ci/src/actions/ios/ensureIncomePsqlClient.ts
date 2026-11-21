import {
  installedPsqlMissingMessage,
  missingHomebrewForPsqlMessage,
  psqlBrewFormulae,
  psqlResolution,
  type PsqlCandidate,
} from '../../ios/realServerE2eLanes.ts';
import { annotateError, exportStepPath, logLine } from '../../ios/shared/actionIo.ts';
import { isExecutable, resolveExecutable, runCommand } from '../../ios/shared/processRunner.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Resolves the `psql` the Income harness probes the database with.
 *
 * `scripts/ios-test-income-e2e.sh` takes its verification snapshot through
 * psql. Runner images disagree on whether a Postgres client is installed, and
 * libpq is keg-only so it is absent from `PATH` even where it exists: resolve
 * it first, and install one only when the host really has none.
 */

async function brewPrefix(brew: string, formula: string): Promise<string> {
  const prefix = await runCommand(brew, ['--prefix', formula], { capture: true });
  return prefix.status === 0 ? prefix.stdout.trim() : '';
}

async function reportVersion(psql: string): Promise<void> {
  const version = await runCommand(psql, ['--version']);
  if (version.status !== 0) throw new StepFailure('', 'stdout', version.status);
}

async function run(): Promise<void> {
  const onPath = resolveExecutable('psql');
  const brew = resolveExecutable('brew');

  const candidates: PsqlCandidate[] = [];
  if (onPath === undefined && brew !== undefined) {
    for (const formula of psqlBrewFormulae) {
      const prefix = await brewPrefix(brew, formula);
      candidates.push({ prefix, executable: prefix.length > 0 && isExecutable(`${prefix}/bin/psql`) });
    }
  }

  const resolution = psqlResolution({
    onPath: onPath !== undefined,
    candidates,
    homebrewAvailable: brew !== undefined,
  });

  switch (resolution.kind) {
    case 'on-path':
      await reportVersion(onPath ?? 'psql');
      return;
    case 'prefix':
      exportStepPath(resolution.binDirectory);
      await reportVersion(`${resolution.binDirectory}/psql`);
      return;
    case 'unavailable':
      annotateError(missingHomebrewForPsqlMessage);
      throw new StepFailure('', 'stdout');
    case 'install':
      break;
  }

  const homebrew = brew ?? 'brew';
  const listed = await runCommand(homebrew, ['list', 'libpq'], { capture: true });
  if (listed.status !== 0) {
    const installed = await runCommand(homebrew, ['install', 'libpq']);
    if (installed.status !== 0) throw new StepFailure('', 'stdout', installed.status);
  }
  const prefix = await brewPrefix(homebrew, 'libpq');
  if (prefix.length === 0 || !isExecutable(`${prefix}/bin/psql`)) {
    annotateError(installedPsqlMissingMessage(prefix));
    throw new StepFailure('', 'stdout');
  }
  logLine(`Installed libpq at ${prefix}`);
  exportStepPath(`${prefix}/bin`);
  await reportVersion(`${prefix}/bin/psql`);
}

await runStep('Ensure Income E2E psql client', run);

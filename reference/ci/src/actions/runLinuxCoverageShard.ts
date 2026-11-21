import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import {
  changedLinesFromPatch, formatChangedLineCoverage, lineHitsFromLcov, readMergeServerPatch,
  summarizeChangedLineCoverage,
} from '../changedCodeCoverage.ts';

function run(program: string, args: string[], environment = process.env): number {
  const result = spawnSync(program, args, { stdio: 'inherit', env: environment });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main(): void {
  const shard = process.argv[2];
  if (!shard || !/^[1-4]$/.test(shard)) throw new Error('Expected one Linux shard number from 1 to 4');
  const patch = readMergeServerPatch(process.cwd());
  if (patch === undefined) {
    process.stdout.write('::warning::Changed-line coverage unavailable: cannot compare the merge tree to its base parent.\n');
  }
  const changed = patch === undefined
    ? new Map<string, Set<number>>() : changedLinesFromPatch(patch);
  const files = [...changed.keys()];
  const args = [
    'vitest', 'run', '--config', 'server/vitest.config.ts',
    '--exclude', '**/*.integration.test.ts',
    '--exclude', 'server/tests/chatProviderBoundaryManifest.test.ts',
    '--exclude', 'server/tests/dateWindowTimezone.test.ts',
    `--shard=${shard}/4`,
  ];
  if (files.length > 0) args.push('--coverage');
  process.stdout.write(`Running npx ${args.join(' ')}\n`);
  const environment = files.length > 0
    ? { ...process.env, EXAMPLE_CHANGED_CODE_COVERAGE_FILES: JSON.stringify(files) }
    : process.env;
  const status = run('npx', args, environment);
  if (status !== 0 || files.length === 0) process.exit(status);

  // Reporting is observational: an LCOV or GitHub summary problem cannot
  // turn passing tests into a failed PR check.
  try {
    const lcov = readFileSync('server/coverage/lcov.info', 'utf8');
    const summary = summarizeChangedLineCoverage(changed, lineHitsFromLcov(lcov, process.cwd()));
    const report = formatChangedLineCoverage(summary, shard);
    process.stdout.write(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`::warning::Changed-line coverage report unavailable for shard ${shard}: ${message}\n`);
  }
}

main();

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { z } from 'zod';
import { serverProcessHeavyTests } from './serverSourceTestOwnership.ts';

const targetedTestPath = z.string().regex(
  /^server\/tests\/[A-Za-z0-9_./-]+\.(?:integration\.)?test\.ts$/,
  'Targeted server tests must be server test files.',
).refine(path => !path.includes('..'), 'Targeted server test paths cannot traverse directories.');

const targetedTests = z.array(targetedTestPath).min(1, 'At least one targeted server test is required.');

const assertionResult = z.object({ status: z.string() }).passthrough();
const suiteResult = z.object({
  name: z.string().optional(),
  assertionResults: z.array(assertionResult).optional(),
}).passthrough();
export const vitestReport = z.object({ testResults: z.array(suiteResult).optional() }).passthrough();

const allowedStatuses = new Set(['passed', 'skipped', 'pending', 'todo']);
/** Suites that need the database lane's runtime databases and may never skip. */
export const runtimeDatabaseSuites = [
  'server/tests/conversationRuntimeSql.integration.test.ts',
  'server/tests/profilePreparationDatabase.test.ts',
  'server/tests/durableChatPendingState.integration.test.ts',
  'server/tests/webChatActionEndpoints.integration.test.ts',
] as const;
const strictRuntimeDatabaseSuites: ReadonlySet<string> = new Set(runtimeDatabaseSuites);

export type SpawnTargetedTests = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: 'inherit' },
) => { readonly error?: Error; readonly status: number | null };

export function parseTargetedServerTests(value: string | undefined): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '[]') as unknown;
  } catch (error) {
    throw new Error('Targeted server tests must be valid JSON.', { cause: error });
  }
  const result = targetedTests.safeParse(parsed);
  if (!result.success) {
    const unsafe = Array.isArray(parsed) ? parsed.find(path => !targetedTestPath.safeParse(path).success) : undefined;
    if (unsafe !== undefined) throw new Error(`Unsafe targeted server test path: ${String(unsafe)}`);
    throw new Error(result.error.issues[0]?.message ?? 'Invalid targeted server test selection.');
  }
  return result.data;
}

export function validateTargetedTestResults(
  targets: readonly string[],
  resultsFile: string,
  read: (path: string, encoding: BufferEncoding) => string = readFileSync,
): void {
  const report = vitestReport.parse(JSON.parse(read(resultsFile, 'utf8')) as unknown);
  for (const target of targets) {
    const suite = report.testResults?.find(result => result.name?.endsWith(target));
    if (suite?.assertionResults === undefined || suite.assertionResults.length === 0) {
      throw new Error(`Targeted test did not execute any assertions: ${target}`);
    }
    if (!suite.assertionResults.some(result => result.status === 'passed')) {
      throw new Error(`Targeted test did not execute a passing assertion: ${target}`);
    }
    if (strictRuntimeDatabaseSuites.has(target)
      && !suite.assertionResults.every(result => result.status === 'passed')) {
      throw new Error(`Runtime database suite skipped or failed an assertion: ${target}`);
    }
    if (!suite.assertionResults.every(result => allowedStatuses.has(result.status))) {
      throw new Error(`Targeted test did not pass every assertion: ${target}`);
    }
  }
}

export function runTargetedServerTests(
  value: string | undefined,
  spawn: SpawnTargetedTests = spawnSync,
  exists: (path: string) => boolean = existsSync,
  resultsFile: string | undefined = process.env['TARGETED_TEST_RESULTS_FILE'],
): number {
  const targets = parseTargetedServerTests(value);
  const missingTargets = targets.filter(path => !exists(path));
  if (missingTargets.length > 0) {
    throw new Error(`Selected server test does not exist: ${missingTargets.join(', ')}`);
  }
  const args = ['vitest', 'run', '--config', 'server/vitest.config.ts', ...targets];
  // An older trusted-base planner can still send these suites through the targeted
  // lane. Preserve their single-worker isolation until that planner ages out.
  if (targets.some(path => serverProcessHeavyTests.has(path))) {
    args.push('--pool=threads', '--maxWorkers=1');
  }
  if (resultsFile !== undefined && resultsFile.length > 0) {
    args.push('--reporter=default', '--reporter=json', `--outputFile=${resultsFile}`);
  }
  const result = spawn('npx', args, { stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  const status = result.status ?? 1;
  if (status === 0 && resultsFile !== undefined && resultsFile.length > 0) {
    validateTargetedTestResults(targets, resultsFile);
  }
  return status;
}

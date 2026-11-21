import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const vitestReport = z.object({
  success: z.literal(true),
  numTotalTests: z.number().int().positive(),
  numPendingTests: z.literal(0),
  numFailedTests: z.literal(0),
  numPassedTests: z.number().int().positive(),
});

// Required ENT-01 acceptance is separate from optional broad integration discovery.
export function runEntitlementRepositoryTests(): number {
  if (!process.env.ENTITLEMENT_TEST_DATABASE_URL) {
    throw new Error('ENTITLEMENT_TEST_DATABASE_URL is required; entitlement acceptance cannot be skipped.');
  }
  const output = mkdtempSync(join(tmpdir(), 'example-entitlement-tests-'));
  try {
    const report = join(output, 'results.json');
    const result = spawnSync(process.execPath, [
      'node_modules/vitest/vitest.mjs', 'run', '--config', 'server/vitest.config.ts',
      'server/tests/appStoreEntitlementRepository.integration.test.ts',
      '--reporter=default', '--reporter=json', `--outputFile=${report}`,
    ], { stdio: 'inherit', env: { ...process.env, ENV_FILE: undefined } });
    if (result.error || result.status !== 0) return 1;
    const summary: unknown = JSON.parse(readFileSync(report, 'utf8'));
    const parsed = vitestReport.parse(summary);
    if (parsed.numPassedTests !== parsed.numTotalTests) {
      throw new Error('Entitlement acceptance requires nonzero tests with zero failures/skips');
    }
    process.stdout.write(`Entitlement PostgreSQL acceptance: ${parsed.numPassedTests} passed, zero failed/skipped.\n`);
    return 0;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = runEntitlementRepositoryTests();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

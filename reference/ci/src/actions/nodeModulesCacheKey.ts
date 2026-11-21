import { appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeModulesCacheKey } from '../nodeModulesCache.ts';

/**
 * Compute the exact Actions cache key for the application's `node_modules`
 * and empty the restore path first, so a restored tree is never merged into
 * leftovers from an earlier job on the same workspace.
 */
export function prepareNodeModulesCacheKey(
  root = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const outputFile = environment['GITHUB_OUTPUT'];
  if (!outputFile) throw new Error('GITHUB_OUTPUT is required to publish the node_modules cache key');
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  const key = nodeModulesCacheKey(root, environment);
  appendFileSync(outputFile, `key=${key}\n`, 'utf8');
  process.stdout.write(`node_modules cache key: ${key}\n`);
  return key;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  prepareNodeModulesCacheKey();
}

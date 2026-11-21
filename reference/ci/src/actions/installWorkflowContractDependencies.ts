import { lstatSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCiPackageDependencies } from './installCiPackageDependencies.ts';

/**
 * The workflow-contract lane runs the self-contained CI package and legacy
 * suites that import its small set of dependencies from the repository root.
 * Link that install into root module resolution without cloning the full app
 * dependency tree. A fresh Actions checkout must not already have a root
 * node_modules tree; refusing to replace one keeps local invocations safe.
 */
export function installWorkflowContractDependencies(root = process.cwd()): number {
  const rootModules = join(root, 'node_modules');
  try {
    lstatSync(rootModules);
    throw new Error('workflow-contract dependency install requires an empty root node_modules path');
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  const status = installCiPackageDependencies(root, true);
  if (status !== 0) return status;
  symlinkSync('ci/node_modules', rootModules, 'dir');
  process.stdout.write('Installed CI-only contract dependencies; linked root resolution to ci/node_modules.\n');
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = installWorkflowContractDependencies();
}

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Install the self-contained CI package without executing dependency scripts. */
export function installCiPackageDependencies(root = process.cwd(), preferOffline = false): number {
  const args = ['ci', '--prefix', 'ci', '--no-audit', '--no-fund', '--ignore-scripts'];
  if (preferOffline) args.push('--prefer-offline');
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  if (!existsSync(join(root, 'ci', 'node_modules'))) {
    throw new Error('npm ci succeeded without creating ci/node_modules');
  }
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = installCiPackageDependencies();
}

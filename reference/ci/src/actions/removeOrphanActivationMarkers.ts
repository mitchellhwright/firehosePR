import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Lists `.completed` activation markers for one host that no job will read.
 *
 * Until the installer stopped writing them, every maintenance run that found
 * the hook already active left such a marker. A detached activation always
 * opens its log before writing its marker, so a marker without a log is one
 * of those; a marker with a log still awaits the completion job that reads
 * and removes it.
 */
export function orphanActivationMarkers(markerRoot: string, hostLabel: string): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(hostLabel)) {
    throw new Error(`Unsafe durable host label: ${hostLabel}`);
  }
  if (!existsSync(markerRoot)) return [];
  const pattern = new RegExp(`^example-runner-environment-${hostLabel.replaceAll('.', '\\.')}-\\d+-\\d+\\.completed$`);
  return readdirSync(markerRoot)
    .filter((name) => pattern.test(name))
    .map((name) => join(markerRoot, name))
    .filter((marker) => !existsSync(marker.replace(/\.completed$/, '.log')));
}

function main(): void {
  const [markerRoot, hostLabel, platform] = process.argv.slice(2);
  if (markerRoot === undefined || hostLabel === undefined
    || (platform !== 'macos' && platform !== 'linux')) {
    throw new Error('usage: removeOrphanActivationMarkers.ts MARKER_ROOT HOST_LABEL macos|linux');
  }
  const orphans = orphanActivationMarkers(markerRoot, hostLabel);
  for (const marker of orphans) {
    // Linux markers live in a root-owned directory the runner user cannot write.
    if (platform === 'linux') execFileSync('sudo', ['-n', 'rm', '-f', '--', marker]);
    else rmSync(marker, { force: true });
  }
  if (orphans.length > 0) {
    console.log(`Removed ${orphans.length} orphan activation markers for ${hostLabel}.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

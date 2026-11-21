import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Content-addressed `node_modules` trees in GitHub's Actions cache.
 *
 * Owner decision 2026-09-27 (CI execution-efficiency plan, item 7): PR lanes
 * on GitHub-hosted runners may restore the application's complete
 * `node_modules` from the native Actions cache instead of running `npm ci`
 * again. The repository previously used no remote dependency cache; the
 * exception is bounded here:
 *
 * - The key covers every input that shapes the installed tree: both manifests,
 *   the project `.npmrc`, the exact Node version and module ABI, the npm version, OS, CPU
 *   architecture, runner image, the install arguments (lifecycle scripts run),
 *   and any `NODE_ENV` or `npm_config_*` setting in the environment.
 * - Lanes restore by exact key only (no `restore-keys`), and only the develop
 *   push workflow saves, so PR code can neither write an entry nor receive a
 *   tree built for other inputs.
 * - A restored tree is used only when its stamp names the key this job
 *   computed and `npm ls --depth=0` accepts it; anything else is deleted and
 *   installed with `npm ci`.
 *
 * The CI package (`ci/`) is not cached: its install takes about two seconds,
 * no more than a restore.
 */

export const npmInstallArguments = ['ci', '--no-audit', '--no-fund', '--prefer-offline'] as const;

/** Written into the tree after a successful install; the saved entry carries it. */
export const stampFileName = '.example-node-modules-key';

function npmVersion(root: string): string {
  const result = spawnSync('npm', ['--version'], { cwd: root, encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  const version = result.stdout.trim();
  if (result.status !== 0 || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`npm --version failed (exit ${result.status ?? 'signal'}): ${result.stderr}`);
  }
  return version;
}

function installEnvironment(environment: NodeJS.ProcessEnv): readonly (readonly [string, string])[] {
  const entries: [string, string][] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (name === 'NODE_ENV' || name.toLowerCase().startsWith('npm_config_')) entries.push([name, value]);
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The project npm configuration (`<root>/.npmrc`) that `npm ci` at the root
 * reads, or `absent`. A branch can change `omit`, `ignore-scripts` or
 * `legacy-peer-deps` there without touching either manifest.
 */
function projectConfigDigest(root: string): string {
  const path = join(root, '.npmrc');
  return existsSync(path) ? fileDigest(path) : 'absent';
}

/** The exact Actions cache key for the application tree on this runner. */
export function nodeModulesCacheKey(root: string, environment: NodeJS.ProcessEnv): string {
  const npm = npmVersion(root);
  const imageOs = environment['ImageOS'] ?? 'unknown-image';
  const inputs = {
    installArguments: npmInstallArguments,
    platform: process.platform,
    arch: process.arch,
    imageOs,
    node: process.version,
    moduleAbi: process.versions.modules,
    npm,
    environment: installEnvironment(environment),
    manifest: fileDigest(join(root, 'package.json')),
    lockfile: fileDigest(join(root, 'package-lock.json')),
    projectConfig: projectConfigDigest(root),
  };
  const digest = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  return [
    'example-node-modules-v1', process.platform, process.arch, imageOs.replaceAll(/[^A-Za-z0-9._]/g, '_'),
    `node${process.version.slice(1)}`, `npm${npm}`, digest,
  ].join('-');
}

/**
 * Why the tree in `node_modules` cannot be reused, or undefined when it can.
 * Only a tree restored in this job (`cacheHit`), stamped with this job's key
 * and accepted by `npm ls` is reusable.
 */
export function restoredTreeRejection(options: {
  readonly root: string;
  readonly key: string;
  readonly cacheHit: string | undefined;
}): string | undefined {
  if (options.cacheHit !== 'true') return 'no exact cache entry was restored';
  const stamp = join(options.root, 'node_modules', stampFileName);
  if (!existsSync(stamp)) return 'the restored tree has no key stamp';
  let stamped: string;
  try {
    stamped = readFileSync(stamp, 'utf8').trim();
  } catch (error: unknown) {
    return `the restored tree's key stamp is unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (stamped !== options.key) return `the restored tree is stamped ${stamped}, not ${options.key}`;
  const listing = spawnSync('npm', ['ls', '--depth=0'], { cwd: options.root, encoding: 'utf8' });
  if (listing.error !== undefined) throw listing.error;
  if (listing.status !== 0) return `npm ls --depth=0 rejected the restored tree: ${listing.stderr.trim()}`;
  return undefined;
}

/**
 * Keep a tree restored from the Actions cache when it is exactly this job's
 * tree; otherwise delete whatever is there, install, and stamp the result.
 */
export function installOrReuse(options: {
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly install: () => number;
}): number {
  const { root, environment } = options;
  const key = nodeModulesCacheKey(root, environment);
  const cacheHit = environment['NODE_MODULES_CACHE_HIT'];
  const rejection = restoredTreeRejection({ root, key, cacheHit });
  if (rejection === undefined) {
    process.stdout.write(`Reused the node_modules restored for ${key}; npm ci skipped.\n`);
    return 0;
  }
  if (cacheHit === 'true') process.stderr.write(`Discarding the restored node_modules: ${rejection}.\n`);
  const modules = join(root, 'node_modules');
  rmSync(modules, { recursive: true, force: true });
  const status = options.install();
  if (status !== 0) return status;
  if (!existsSync(modules)) throw new Error('npm ci succeeded without creating node_modules');
  writeFileSync(join(modules, stampFileName), `${key}\n`);
  return 0;
}

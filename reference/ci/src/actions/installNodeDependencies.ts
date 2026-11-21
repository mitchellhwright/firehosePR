import { spawnSync } from 'node:child_process';
import {
  constants, cpSync, existsSync, mkdirSync, mkdtempSync,
  readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync,
  type Dirent,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installOrReuse, nodeModulesCacheKey, npmInstallArguments, restoredTreeRejection, stampFileName,
} from '../nodeModulesCache.ts';

const maxUnusedAgeMs = 7 * 24 * 60 * 60 * 1000;

function install(root: string): number {
  const result = spawnSync('npm', npmInstallArguments, { cwd: root, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function cloneTree(source: string, destination: string): void {
  // FICLONE falls back to an ordinary copy on filesystems without reflinks.
  // Each job receives a writable, private tree rather than a shared symlink.
  cpSync(source, destination, {
    recursive: true,
    force: true,
    mode: constants.COPYFILE_FICLONE,
  });
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Retire the whole publication atomically so a repaired tree can take its name. */
function retireRejectedTree(cacheDir: string, versionRoot: string): void {
  const rejected = mkdtempSync(join(versionRoot, '.rejected-'));
  try {
    try {
      renameSync(cacheDir, rejected);
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
    }
  } finally {
    rmSync(rejected, { recursive: true, force: true });
  }
}

function directories(path: string): Dirent<string>[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingPath(error)) return [];
    throw error;
  }
}

function pruneUnusedTrees(cacheRoot: string, now: Date): void {
  for (const version of directories(cacheRoot)) {
    if (!version.isDirectory() || version.name.startsWith('.')) continue;
    const versionPath = join(cacheRoot, version.name);
    for (const revision of directories(versionPath)) {
      if (!revision.isDirectory()) continue;
      const tree = join(versionPath, revision.name);
      const marker = join(tree, 'complete');
      const activity = existsSync(marker) ? marker : tree;
      let lastUse: number;
      try {
        lastUse = statSync(activity).mtimeMs;
      } catch (error: unknown) {
        if (isMissingPath(error)) continue;
        throw error;
      }
      if (now.getTime() - lastUse > maxUnusedAgeMs) {
        rmSync(tree, { recursive: true, force: true });
      }
    }
  }
}

const runnerEnvironments = ['github-hosted', 'self-hosted'] as const;
type RunnerEnvironment = (typeof runnerEnvironments)[number];

/**
 * The runner class the workflow step passes in from `runner.environment`.
 * GitHub does not export that context as a variable on its own, so a missing
 * value means the step lost its `env` entry; guessing would send hosted jobs
 * down the tool-cache path and make them ignore the restored tree.
 */
export function runnerEnvironment(environment: NodeJS.ProcessEnv): RunnerEnvironment {
  const value = environment['RUNNER_ENVIRONMENT'];
  const known = runnerEnvironments.find((candidate) => candidate === value);
  if (known === undefined) {
    throw new Error(
      `RUNNER_ENVIRONMENT must be ${runnerEnvironments.join(' or ')}, got `
      + `${value === undefined ? 'nothing' : `'${value}'`}; pass \${{ runner.environment }} in `
      + 'the install step env (installNodeDependencySteps in ci/workflows/lib/nodeModulesCache.ts)',
    );
  }
  return known;
}

/**
 * Install once per complete dependency-input key on a persistent runner. A
 * GitHub-hosted VM (or a machine with no tool cache) instead reuses the tree
 * the job restored from the Actions cache when it is exactly this job's tree.
 */
export function installNodeDependencies(
  root = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): number {
  const hosted = runnerEnvironment(environment) === 'github-hosted';
  const toolCache = environment['RUNNER_TOOL_CACHE'];
  if (hosted || !toolCache) {
    return installOrReuse({ root, environment, install: () => install(root) });
  }

  const digest = nodeModulesCacheKey(root, environment);
  const cacheRoot = join(toolCache, 'example-node-modules');
  const versionRoot = join(cacheRoot, process.version);
  const cacheDir = join(versionRoot, digest);
  const cachedModules = join(cacheDir, 'node_modules');
  const marker = join(cacheDir, 'complete');
  const workspaceModules = join(root, 'node_modules');

  if (existsSync(marker) && existsSync(cachedModules)) {
    try {
      utimesSync(marker, now, now);
      rmSync(workspaceModules, { recursive: true, force: true });
      cloneTree(cachedModules, workspaceModules);
      const rejection = restoredTreeRejection({ root, key: digest, cacheHit: 'true' });
      if (rejection !== undefined) {
        process.stderr.write(`Discarding runner-cached node_modules: ${rejection}.\n`);
        retireRejectedTree(cacheDir, versionRoot);
      } else {
        process.stdout.write(`Cloned node_modules for input key ${digest.slice(-12)} on Node ${process.version} from the runner cache.\n`);
        pruneUnusedTrees(cacheRoot, now);
        return 0;
      }
    } catch (error: unknown) {
      process.stderr.write(`Discarding unreadable runner-cached node_modules: ${error instanceof Error ? error.message : String(error)}.\n`);
      retireRejectedTree(cacheDir, versionRoot);
      // A corrupt/unreadable tree or concurrent prune must not strand a job.
      // The fresh install replaces any partially cloned private tree.
    }
  }

  rmSync(workspaceModules, { recursive: true, force: true });
  const status = install(root);
  if (status !== 0) return status;
  if (!existsSync(workspaceModules)) throw new Error('npm ci succeeded without creating node_modules');

  writeFileSync(join(workspaceModules, stampFileName), `${digest}\n`);

  // Stage a complete tree before publication. Parallel jobs may race to fill
  // the same key, but no reader can see half an npm install.
  mkdirSync(versionRoot, { recursive: true });
  const staging = mkdtempSync(join(versionRoot, '.staging-'));
  try {
    cloneTree(workspaceModules, join(staging, 'node_modules'));
    writeFileSync(join(staging, 'complete'), '');
    try {
      renameSync(staging, cacheDir);
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error
        && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY'))) throw error;
      // Another writer may have published the key, or left an incomplete
      // legacy entry. The fresh private install is still valid either way.
      if (!existsSync(marker) || !existsSync(cachedModules)) {
        process.stderr.write(`Dependency cache entry ${cacheDir} is incomplete; using the fresh workspace install.\n`);
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  process.stdout.write(`Cached node_modules for input key ${digest.slice(-12)} on Node ${process.version}.\n`);
  pruneUnusedTrees(cacheRoot, now);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = installNodeDependencies();
}

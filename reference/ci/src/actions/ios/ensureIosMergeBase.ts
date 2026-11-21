import { execFileSync, spawnSync } from 'node:child_process';
import { z } from 'zod';

const sha = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * A fetch normally starts a detached `maintenance --auto`, which can rewrite
 * `.git/shallow` while the next `--deepen` fetch reads it. The checkout is
 * short-lived and reclaimed by the runner, so it never needs auto maintenance.
 * Lazy blob fetches in a partial clone inherit these settings from the parent.
 */
export const noAutoMaintenance: readonly string[] = Object.freeze([
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
]);
const gitTimeoutMs = 120_000;

export interface MergeBaseHistory {
  readonly baseSha: string;
  readonly headSha: string;
  readonly prNumber?: string;
  readonly remote: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Per-command bound; only tests lower it. */
  readonly gitTimeoutMs?: number;
}

/** A selector-history Git command outlived its bound and was stopped. */
export class IosMergeBaseGitTimeout extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`iOS selector history: \`git ${command}\` did not finish within ${timeoutMs / 1000}s and `
      + 'was stopped. The exact base/head ancestry could not be fetched in time; rerun the job, and '
      + 'if one runner repeats it, inspect that host\'s network and Git workspace.');
    this.name = 'IosMergeBaseGitTimeout';
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

function isSpawnTimeout(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT';
}

/**
 * A partial clone (the Mac lanes' `filter: blob:none` checkout) can lazily
 * fetch any blob later, so the ancestry fetches below need only commits and
 * trees. A full checkout has no promisor remote to recover a missing blob.
 */
function isPartialClone(cwd: string, env: NodeJS.ProcessEnv | undefined): boolean {
  const result = spawnSync('git', [
    'config', '--get-regexp', String.raw`^(extensions\.partialclone|remote\..+\.promisor)$`,
  ], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 1) return false;
  if (result.status !== 0) {
    throw new Error(`Could not read the checkout's partial-clone configuration: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').some((line) => {
    const [key, value] = line.trim().split(/\s+/, 2);
    return key === 'extensions.partialclone' ? Boolean(value) : value === 'true';
  });
}

/**
 * The PR gate runs after a shallow exact-head checkout. Fetch only the two
 * immutable revisions, then deepen their ancestry until Git can prove the
 * merge base used by every patch-level iOS selector. A moving branch name
 * must never change the diff of an already-running check.
 */
export function ensureIosMergeBase(input: MergeBaseHistory): string {
  const base = sha.parse(input.baseSha);
  const head = sha.parse(input.headSha);
  const prNumber = input.prNumber === undefined ? undefined
    : z.string().regex(/^[1-9][0-9]*$/).parse(input.prNumber);
  const timeoutMs = input.gitTimeoutMs ?? gitTimeoutMs;
  const git = (args: readonly string[]): string => {
    try {
      return execFileSync('git', [...noAutoMaintenance, ...args], {
        cwd: input.cwd,
        env: input.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      }).trim();
    } catch (error) {
      if (isSpawnTimeout(error)) throw new IosMergeBaseGitTimeout(args.join(' '), timeoutMs);
      throw error;
    }
  };
  const baseRef = 'refs/example-ci/ios-merge-base/base';
  const headRef = 'refs/example-ci/ios-merge-base/head';
  const refspecs = [
    `+${base}:${baseRef}`,
    prNumber === undefined ? `+${head}:${headRef}` : `+refs/pull/${prNumber}/head:${headRef}`,
  ];
  if (git(['rev-parse', 'HEAD']) !== head) {
    throw new Error('iOS selector checkout is not the exact selected head.');
  }
  const filter = isPartialClone(input.cwd, input.env) ? ['--filter=blob:none'] : [];

  const fetch = (depth: number, deepen: boolean): void => {
    const shape = deepen ? `--deepen=${depth}` : `--depth=${depth}`;
    const started = Date.now();
    git(['fetch', '--no-tags', ...filter, shape, input.remote, ...refspecs]);
    process.stderr.write(`iOS selector history: fetch ${[...filter, shape].join(' ')} took `
      + `${((Date.now() - started) / 1000).toFixed(1)}s.\n`);
    if (git(['rev-parse', baseRef]) !== base || git(['rev-parse', headRef]) !== head) {
      throw new Error('iOS base or head changed while preparing merge-base history.');
    }
  };

  try {
    fetch(16, false);
    for (const deepen of [0, 32, 64, 128, 256, 512, 1024, 2048]) {
      if (deepen !== 0) fetch(deepen, true);
      try {
        const mergeBase = git(['merge-base', baseRef, headRef]);
        if (sha.safeParse(mergeBase).success) return mergeBase;
      } catch (error) {
        if (error instanceof IosMergeBaseGitTimeout) throw error;
        // A shallow boundary can hide a real merge base; fetch a little more.
      }
    }
    throw new Error('No PR merge base after bounded ancestry fetch; inspect branch history before rerunning iOS selection.');
  } finally {
    for (const ref of [baseRef, headRef]) {
      try { git(['update-ref', '-d', ref]); } catch { /* Checkout cleanup remains safe. */ }
    }
  }
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { githubGitEnvironment } from './githubGit.ts';
import { reviewedHeadGitRef, reviewedHeadLabel, reviewedHeadSource } from './ciEvent.ts';
import { runCommand } from './ios/shared/processRunner.ts';
import { isScriptOwnershipSource, repositoryScriptSources } from './scriptConsumers.ts';

const revisionSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  /** Exactly one of a PR number and a merge queue ref names the reviewed head. */
  prNumber: z.string().default(''),
  queueRef: z.string().default(''),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  tokens: z.array(z.string().min(1)).min(1),
});

export type ScriptSourceRevision = z.input<typeof revisionSchema>;
// Contract-test existence and deletion are part of the exact-head execution proof.
function isExactHeadSource(path: string): boolean {
  return isScriptOwnershipSource(path) || /^scripts\/tests\/.+\.test\.mjs$/.test(path);
}

const maxSourceBytes = 2_097_152;
const requestTimeoutMs = 30_000;

interface ChangedPath {
  readonly status: string;
  readonly oldPath?: string;
  readonly newPath?: string;
}

/** Parses `git diff --name-status -z`, including rename/copy pairs. */
export function parseNameStatus(output: string): readonly ChangedPath[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes: ChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const first = fields[index++];
    if (status === undefined || first === undefined || status.length === 0) {
      throw new Error('Malformed exact-head source diff.');
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = fields[index++];
      if (second === undefined) throw new Error('Malformed renamed exact-head source path.');
      changes.push({ status, oldPath: first, newPath: second });
    } else if (status === 'D') {
      changes.push({ status, oldPath: first });
    } else {
      changes.push({ status, newPath: first });
    }
  }
  return changes;
}

interface TreeBlob {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
}

function parseTreeBlob(output: string, expectedPath: string): TreeBlob {
  const records = output.split('\0').filter((record) => record.length > 0);
  if (records.length !== 1) throw new Error(`Exact-head source ${expectedPath} is missing or ambiguous.`);
  const match = /^(\d+) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(records[0] ?? '');
  const mode = match?.[1];
  const oid = match?.[2];
  const path = match?.[3];
  if (mode === undefined || oid === undefined || path !== expectedPath
      || !['100644', '100755'].includes(mode)) {
    throw new Error(`Exact-head source ${expectedPath} is not a regular Git blob.`);
  }
  return { mode, oid, path };
}

/**
 * Reconstructs the complete relevant source view at the verified PR head.
 * PR blobs are read as data from Git objects; none are checked out or executed.
 */
export async function exactHeadScriptSources(
  root: string,
  revision: ScriptSourceRevision,
  run: typeof runCommand = runCommand,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const input = revisionSchema.parse(revision);
  const source = reviewedHeadSource(input.prNumber, input.queueRef);
  const token = input.tokens[0];
  if (!token) throw new Error('No Git credential available.');
  const ref = `refs/example-ci/script-sources-${randomUUID()}`;
  const environment = githubGitEnvironment(token);
  const git = (args: readonly string[]) => {
    // Cancellation stops new reads, while ref deletion remains allowed so the
    // caller can await cleanup before the signal handler exits the process.
    if (args[0] !== 'update-ref') signal?.throwIfAborted();
    return run('git', args, {
      cwd: root,
      env: environment,
      capture: true,
      timeoutMs: requestTimeoutMs,
    });
  };
  const cleanup = async (): Promise<void> => {
    let removed = await git(['update-ref', '-d', ref]);
    // If cancellation interrupted cleanup itself, retry once after the shared
    // process owner has reaped the interrupted child. Ref deletion is
    // idempotent, so the retry is safe even if the first command succeeded.
    if (removed.status !== 0 && signal?.aborted) {
      removed = await git(['update-ref', '-d', ref]);
    }
    if (removed.status !== 0) throw new Error('Could not remove the temporary script-source ref.');
  };

  try {
    const base = await git(['rev-parse', 'HEAD']);
    if (base.status !== 0 || base.stdout.trim() !== input.baseSha) {
      throw new Error('Trusted script-source checkout does not match the declared base SHA.');
    }
    const fetched = await git([
      'fetch', '--no-tags', '--depth=1', '--filter=blob:none',
      `https://github.com/${input.repository}.git`,
      `+${reviewedHeadGitRef(source)}:${ref}`,
    ]);
    if (fetched.status !== 0) throw new Error('Could not fetch the PR head for script ownership.');
    const actual = await git(['rev-parse', ref]);
    if (actual.status !== 0 || actual.stdout.trim() !== input.headSha) {
      throw new Error(`${reviewedHeadLabel(source)} changed during script ownership planning.`);
    }

    const diff = await git(['diff', '--name-status', '-z', '--find-renames', input.baseSha, ref, '--']);
    if (diff.status !== 0) throw new Error('Could not compare trusted base and exact-head sources.');
    const sources = new Map(repositoryScriptSources(root));
    for (const change of parseNameStatus(diff.stdout)) {
      if (change.oldPath !== undefined && isExactHeadSource(change.oldPath)) {
        sources.delete(change.oldPath);
      }
      const path = change.newPath;
      if (path === undefined || !isExactHeadSource(path)) continue;
      const tree = await git(['ls-tree', '-z', ref, '--', path]);
      if (tree.status !== 0) throw new Error(`Could not inspect exact-head source ${path}.`);
      const blob = parseTreeBlob(tree.stdout, path);
      const size = await git(['cat-file', '-s', blob.oid]);
      const byteLength = Number(size.stdout.trim());
      if (size.status !== 0 || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maxSourceBytes) {
        throw new Error(`Exact-head source ${path} is unavailable or exceeds ${maxSourceBytes} bytes.`);
      }
      const content = await git(['cat-file', 'blob', blob.oid]);
      if (content.status !== 0 || Buffer.byteLength(content.stdout) !== byteLength) {
        throw new Error(`Could not read the complete exact-head source ${path}.`);
      }
      sources.set(path, content.stdout);
    }
    await cleanup();
    return sources;
  } catch (error: unknown) {
    try {
      await cleanup();
    } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], 'Script-source read and cleanup both failed.');
    }
    throw error;
  }
}

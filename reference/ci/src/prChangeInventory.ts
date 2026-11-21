import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { githubGitEnvironment } from './githubGit.ts';
import { createGithubReader, type GithubReader } from './ios/shared/githubRest.ts';
import { runCommand } from './ios/shared/processRunner.ts';

const pathSchema = z.string().min(1).refine(value => !/[\r\n\0]/.test(value), 'Inventory paths cannot contain line separators');
const revisionSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prNumber: z.string().regex(/^[1-9][0-9]*$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  token: z.string().min(1),
  fallbackToken: z.string().default(''),
});
export type PrInventoryRevision = z.infer<typeof revisionSchema>;

export interface ChangedFileInventory {
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}
export interface SelectedPrInventory extends ChangedFileInventory {
  readonly source: 'superseded' | 'classifier' | 'pull-request' | 'merge-group' | 'unverified';
  readonly metadataOnly: boolean;
}

export function selectPrInventorySource(input: {
  readonly superseded: boolean;
  readonly valid: boolean;
  readonly files: string;
  readonly patchEquivalent: boolean;
}): SelectedPrInventory | undefined {
  if (input.superseded) return { source: 'superseded', changed: [], deleted: [], metadataOnly: true };
  if (!input.valid || (!input.files && !input.patchEquivalent)) return undefined;
  const changed = input.files.split('\n').filter(Boolean).map(path => pathSchema.parse(path));
  return { source: 'classifier', changed, deleted: [], metadataOnly: input.patchEquivalent && changed.length === 0 };
}

/** Parse Git's NUL-delimited status stream without shell quoting or rename loss. */
export function parseGitChangeInventory(contents: string): ChangedFileInventory {
  if (contents === '') return { changed: [], deleted: [] };
  if (!contents.endsWith('\0')) throw new Error('Truncated Git changed-file inventory.');
  const fields = contents.slice(0, -1).split('\0');
  const changed: string[] = [];
  const deleted: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status || !/^(?:[ADMTUXB]|[RC][0-9]{1,3})$/.test(status)) throw new Error('Malformed Git file status.');
    const previous = pathSchema.parse(fields[index++]);
    if (status.startsWith('R') || status.startsWith('C')) {
      const current = pathSchema.parse(fields[index++]);
      changed.push(current);
      if (status.startsWith('R')) deleted.push(previous);
    } else {
      changed.push(previous);
      if (status === 'D') deleted.push(previous);
    }
  }
  return { changed, deleted };
}

const apiRevisionSchema = z.object({
  base: z.object({ sha: revisionSchema.shape.baseSha }),
  head: z.object({ sha: revisionSchema.shape.headSha }),
});

const apiFilesSchema = z.array(z.object({
  filename: pathSchema,
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  previous_filename: pathSchema.optional(),
}));

/** A quota response uses exact Git refs; other HTTP or transport failures remain failures. */
export async function readPrInventoryFromGithub(
  revision: PrInventoryRevision,
  reader?: GithubReader,
  signal?: AbortSignal,
): Promise<ChangedFileInventory | undefined> {
  const input = revisionSchema.parse(revision);
  const read = reader ?? createGithubReader({
    tokens: [...new Set([input.token, input.fallbackToken].filter(Boolean))],
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) }),
  });
  const verifyRevision = async (): Promise<boolean> => {
    signal?.throwIfAborted();
    const response = await read(`https://api.github.com/repos/${input.repository}/pulls/${input.prNumber}`);
    signal?.throwIfAborted();
    if (response.status === 403 || response.status === 429) return false;
    if (response.status !== 200) throw new Error(`GitHub PR revision verification failed: HTTP ${response.status}`);
    const current = apiRevisionSchema.parse(response.body);
    if (current.base.sha !== input.baseSha || current.head.sha !== input.headSha) {
      throw new Error('Pull request revision changed during API inventory collection.');
    }
    return true;
  };
  if (!await verifyRevision()) return undefined;
  const changed: string[] = [];
  const deleted: string[] = [];
  for (let page = 1; ; page += 1) {
    signal?.throwIfAborted();
    const response = await read(`https://api.github.com/repos/${input.repository}/pulls/${input.prNumber}/files?per_page=100&page=${page}`);
    signal?.throwIfAborted();
    if (response.status === 403 || response.status === 429) return undefined;
    if (response.status !== 200) throw new Error(`GitHub PR file inventory failed: HTTP ${response.status}`);
    const files = apiFilesSchema.parse(response.body);
    for (const file of files) {
      changed.push(file.filename);
      if (file.status === 'removed') deleted.push(file.filename);
      if (file.status === 'renamed') deleted.push(pathSchema.parse(file.previous_filename));
    }
    if (files.length < 100) return await verifyRevision() ? { changed, deleted } : undefined;
    // The API caps PR file lists at 3,000. Never turn a capped list into a complete plan.
    if (changed.length >= 3_000) return undefined;
  }
}

export async function readPrInventoryFromGit(
  revision: PrInventoryRevision,
  run: typeof runCommand = runCommand,
  signal?: AbortSignal,
): Promise<ChangedFileInventory> {
  const input = revisionSchema.parse(revision);
  const suffix = randomUUID();
  const baseRef = `refs/example-ci/inventory-base-${suffix}`;
  const headRef = `refs/example-ci/inventory-head-${suffix}`;
  const env = githubGitEnvironment(input.token);
  const git = async (args: readonly string[]): Promise<string> => {
    if (args[0] !== 'update-ref') signal?.throwIfAborted();
    const result = await run('git', args, { capture: true, env });
    if (result.status !== 0) throw new Error(`Git inventory ${args[0]} failed (exit ${result.status}): ${result.stderr}`);
    return result.stdout;
  };
  try {
    const shallow = (await git(['rev-parse', '--is-shallow-repository'])).trim();
    if (shallow !== 'true' && shallow !== 'false') throw new Error('Cannot determine Git repository depth.');
    await git(['fetch', '--no-tags', '--filter=blob:none', ...(shallow === 'true' ? ['--unshallow'] : []),
      `https://github.com/${input.repository}.git`, `+${input.baseSha}:${baseRef}`, `+refs/pull/${input.prNumber}/head:${headRef}`]);
    if ((await git(['rev-parse', baseRef])).trim() !== input.baseSha
      || (await git(['rev-parse', headRef])).trim() !== input.headSha) {
      throw new Error('Pull request revision changed during Git inventory collection.');
    }
    const mergeBase = (await git(['merge-base', baseRef, headRef])).trim();
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) throw new Error('Malformed inventory merge base.');
    return parseGitChangeInventory(await git(['diff', '--name-status', '-z', '--find-renames', mergeBase, headRef]));
  } finally {
    // Always attempt both scoped cleanups, including after a partial fetch.
    const remove = async (ref: string): Promise<void> => {
      try { await git(['update-ref', '-d', ref]); } catch {
        // Cancellation can kill a cleanup already in flight; retry after the owned child exits.
        if (signal?.aborted) await git(['update-ref', '-d', ref]);
      }
    };
    await Promise.allSettled([remove(baseRef), remove(headRef)]);
  }
}

export async function collectPrChangeInventory(
  revision: PrInventoryRevision,
  reader?: GithubReader,
  run?: typeof runCommand,
  signal?: AbortSignal,
): Promise<ChangedFileInventory> {
  return await readPrInventoryFromGithub(revision, reader, signal) ?? readPrInventoryFromGit(revision, run, signal);
}

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { serverTestRuntimeManifestSchema } from './prValidationPlan.ts';
import { createGithubReader, type GithubReader } from './ios/shared/githubRest.ts';
import { runCommand } from './ios/shared/processRunner.ts';
import { githubGitEnvironment } from './githubGit.ts';
import {
  reviewedHeadApiPath, reviewedHeadGitRef, reviewedHeadLabel, reviewedHeadShaFromApi, reviewedHeadSource,
} from './ciEvent.ts';

export const runtimeManifestPath = 'ci/contracts/server-test-runtimes.json';
const maxBytes = 131_072;
const requestTimeoutMs = 30_000;
const revisionSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  /** Exactly one of a PR number and a merge queue ref names the reviewed head. */
  prNumber: z.string().default(''),
  queueRef: z.string().default(''),
  tokens: z.array(z.string().min(1)).min(1),
});
export type RuntimeManifestRevision = z.input<typeof revisionSchema>;

export type ManifestRead =
  | { readonly source: 'github'; readonly contents: string }
  | { readonly source: 'git-required'; readonly reason: 'missing' | 'quota' | 'transient' };

/** Recover a failed API read only through Git's independently verified exact PR head. */
export async function readRuntimeManifestFromGithub(
  revision: RuntimeManifestRevision,
  reader?: GithubReader,
  signal?: AbortSignal,
): Promise<ManifestRead> {
  const input = revisionSchema.parse(revision);
  const source = reviewedHeadSource(input.prNumber, input.queueRef);
  const read = reader ?? createGithubReader({
    tokens: input.tokens,
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([
      AbortSignal.timeout(requestTimeoutMs), ...(signal ? [signal] : []),
    ]) }),
  });
  signal?.throwIfAborted();
  const prefix = `https://api.github.com/repos/${input.repository}`;
  const head = await read(`${prefix}${reviewedHeadApiPath(source)}`);
  signal?.throwIfAborted();
  const fallback = (status: number): ManifestRead | undefined => {
    if (status === 404) return { source: 'git-required', reason: 'missing' };
    if (status === 403 || status === 429) return { source: 'git-required', reason: 'quota' };
    if (status >= 500 && status <= 599) return { source: 'git-required', reason: 'transient' };
    return undefined;
  };
  const headFallback = fallback(head.status);
  if (headFallback) return headFallback;
  if (head.status !== 200) throw new Error(`Cannot verify runtime contract head: HTTP ${head.status}`);
  if (reviewedHeadShaFromApi(source, head.body) !== input.headSha) {
    throw new Error(`${reviewedHeadLabel(source)} changed before runtime contract planning.`);
  }
  // The shared reader uses the JSON Contents API. Decode data, never execute
  // anything from the head. The immutable ref must be supplied explicitly.
  const response = await read(`${prefix}/contents/${runtimeManifestPath}?ref=${input.headSha}`);
  signal?.throwIfAborted();
  const contentFallback = fallback(response.status);
  if (contentFallback) return contentFallback;
  if (response.status !== 200) throw new Error(`Cannot read runtime contract: HTTP ${response.status}`);
  const file = z.object({
    type: z.literal('file'), encoding: z.literal('base64'),
    size: z.number().int().min(0).max(maxBytes), content: z.string(),
  }).parse(response.body);
  const encoded = file.content.replace(/\s/g, '');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength !== file.size || bytes.toString('base64') !== encoded) {
    throw new Error('Runtime contract content was truncated or malformed.');
  }
  return { source: 'github', contents: bytes.toString('utf8') };
}

/** Git fallback uses argv and environment configuration; no generated askpass shell. */
export async function readRuntimeManifestFromGit(
  revision: RuntimeManifestRevision,
  run: typeof runCommand = runCommand,
  signal?: AbortSignal,
): Promise<string | null> {
  const input = revisionSchema.parse(revision);
  const source = reviewedHeadSource(input.prNumber, input.queueRef);
  const ref = `refs/example-ci/runtime-contract-${randomUUID()}`;
  const token = input.tokens[0];
  if (!token) throw new Error('No Git credential available.');
  const env = githubGitEnvironment(token);
  const git = (args: readonly string[]) => {
    // Cancellation stops new work, but the finally-owned ref cleanup must finish.
    if (args[0] !== 'update-ref') signal?.throwIfAborted();
    return run('git', args, { env, capture: true, timeoutMs: requestTimeoutMs });
  };
  const read = async (): Promise<string | null> => {
    const fetched = await git(['fetch', '--no-tags', '--depth=1', '--filter=blob:none',
      `https://github.com/${input.repository}.git`, `+${reviewedHeadGitRef(source)}:${ref}`]);
    if (fetched.status !== 0) throw new Error('Could not fetch the PR head for runtime contract planning.');
    const actual = await git(['rev-parse', ref]);
    if (actual.status !== 0 || actual.stdout.trim() !== input.headSha) {
      throw new Error(`${reviewedHeadLabel(source)} changed during runtime contract Git fallback.`);
    }
    const tree = await git(['ls-tree', '-z', ref, '--', runtimeManifestPath]);
    if (tree.status !== 0) throw new Error('Could not inspect the runtime contract tree.');
    if (tree.stdout === '') return null;
    const blob = `${ref}:${runtimeManifestPath}`;
    const size = await git(['cat-file', '-s', blob]);
    const byteLength = Number(size.stdout.trim());
    if (size.status !== 0 || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > maxBytes) {
      throw new Error('Runtime contract blob is empty, unavailable, or too large.');
    }
    const content = await git(['show', blob]);
    if (content.status !== 0 || Buffer.byteLength(content.stdout) !== byteLength) {
      throw new Error('Could not read the complete runtime contract blob.');
    }
    return content.stdout;
  };
  const cleanup = async (): Promise<void> => {
    let cleaned = await git(['update-ref', '-d', ref]);
    // A signal may arrive while cleanup itself is already running. The shared
    // handler terminates that child too; retry once after it has been reaped.
    // Repeated signals do not restart teardown, and deletion is idempotent.
    if (cleaned.status !== 0 && signal?.aborted) cleaned = await git(['update-ref', '-d', ref]);
    if (cleaned.status !== 0) throw new Error('Could not remove the temporary runtime contract ref.');
  };
  let result: string | null;
  try {
    result = await read();
  } catch (error: unknown) {
    try { await cleanup(); } catch (cleanupError: unknown) {
      throw new AggregateError([error, cleanupError], 'Runtime contract read and cleanup both failed.');
    }
    throw error;
  }
  await cleanup();
  return result;
}

export interface RuntimeManifestOptions {
  readonly metadataOnly: boolean;
  readonly revision?: RuntimeManifestRevision;
  readonly changedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
}
export interface RuntimeManifestPorts {
  readonly fromGithub: (revision: RuntimeManifestRevision) => Promise<ManifestRead>;
  readonly fromGit: (revision: RuntimeManifestRevision) => Promise<string | null>;
  readonly fromBase: () => string;
}
export interface RuntimeManifestResult {
  readonly source: 'github' | 'git' | 'metadata-base' | 'legacy-base';
  readonly contents: string;
}

export async function loadRuntimeManifest(
  options: RuntimeManifestOptions,
  ports?: RuntimeManifestPorts,
  signal?: AbortSignal,
): Promise<RuntimeManifestResult> {
  const readers = ports ?? {
    fromGithub: (revision: RuntimeManifestRevision) => readRuntimeManifestFromGithub(revision, undefined, signal),
    fromGit: (revision: RuntimeManifestRevision) => readRuntimeManifestFromGit(revision, undefined, signal),
    fromBase: () => readFileSync(runtimeManifestPath, 'utf8'),
  };
  signal?.throwIfAborted();
  const validate = (result: RuntimeManifestResult): RuntimeManifestResult => {
    if (Buffer.byteLength(result.contents) > maxBytes) throw new Error('Runtime contract exceeds the byte limit.');
    const value: unknown = JSON.parse(result.contents);
    serverTestRuntimeManifestSchema.parse(value);
    return result;
  };
  if (options.metadataOnly) return validate({ source: 'metadata-base', contents: readers.fromBase() });
  if (!options.revision) throw new Error('Exact-head runtime contract metadata is required.');
  const api = await readers.fromGithub(options.revision);
  signal?.throwIfAborted();
  if (api.source === 'github') return validate(api);
  const git = await readers.fromGit(options.revision);
  signal?.throwIfAborted();
  if (git !== null) return validate({ source: 'git', contents: git });
  if ([...options.changedFiles, ...options.deletedFiles].includes(runtimeManifestPath)) {
    throw new Error('Exact-head runtime contract manifest is missing after being changed or deleted.');
  }
  return validate({ source: 'legacy-base', contents: readers.fromBase() });
}

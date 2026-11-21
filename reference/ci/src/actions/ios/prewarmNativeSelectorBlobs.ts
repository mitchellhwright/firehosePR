import { execFileSync, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { ensureIosMergeBase, noAutoMaintenance } from './ensureIosMergeBase.ts';

const sha = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * The file kinds `scripts/select-ios-affected-tests.ts` reads at the merge
 * base (`git show`, `git diff`): the Xcode project patch and its test-folder
 * exclusions, test plan edits, and test or generated Swift declarations,
 * including deleted test files. The merge-base project and plans it reads
 * for a deleted test are either changed (so in this diff) or identical to
 * the head blobs the checkout already materialized.
 */
const SELECTOR_CONTENT_PATHSPECS: readonly string[] = Object.freeze([
  ':(glob)ios/**/*.pbxproj',
  ':(glob)ios/**/*.xctestplan',
  ':(glob)ios/**/*.swift',
]);

export interface SelectorBlobPrewarm {
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * A blob:none checkout has the commit graph and the head's files, but not the
 * merge-base side of a changed file. The selector runs with credentials
 * disabled, so a blob it reads that is not local fails its lazy fetch
 * ("could not fetch ... from promisor remote"). Producing the patch once here,
 * while this process holds the Git credential, makes Git prefetch every
 * missing blob of those paths in one batch. No source bytes are retained.
 */
export function prewarmNativeSelectorBlobs(input: SelectorBlobPrewarm): void {
  const base = sha.parse(input.mergeBaseSha);
  const head = sha.parse(input.headSha);
  execFileSync('git', [
    ...noAutoMaintenance,
    'diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, head, '--',
    ...SELECTOR_CONTENT_PATHSPECS,
  ], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 120_000,
  });
}

export type SelectorHistoryMode = 'promotion' | 'checkout';

/**
 * The merge base the selector will compare against, with its ancestry local.
 * Promotion always fetches and proves its divergent base. Other events use the
 * checkout's own merge base when it has one; a long-lived PR or an advanced
 * target branch can leave the base outside the bounded exact-head checkout,
 * so that ancestry is then fetched and proved the same bounded way. A base
 * that still cannot be connected fails in `ensureIosMergeBase`. Only an event
 * with no base at all (null) leaves the selector nothing to compare.
 */
export function resolveSelectorMergeBase(input: {
  readonly history: SelectorHistoryMode;
  readonly baseSha: string;
  readonly headSha: string;
  readonly remote: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): string | null {
  if (input.history === 'checkout') {
    if (input.baseSha === '') return null;
    const local = localSelectorMergeBase(input);
    if (local !== null) return local;
  }
  return ensureIosMergeBase({
    baseSha: input.baseSha,
    headSha: input.headSha,
    remote: input.remote,
    cwd: input.cwd,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
}

/**
 * The merge base the selector itself will compute from the checkout's local
 * history, or null when that history cannot connect the two revisions.
 */
export function localSelectorMergeBase(input: {
  readonly baseSha: string;
  readonly headSha: string;
  readonly cwd: string;
}): string | null {
  const result = spawnSync('git', ['merge-base', sha.parse(input.baseSha), sha.parse(input.headSha)], {
    cwd: input.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  const mergeBase = result.stdout.trim();
  return result.status === 0 && sha.safeParse(mergeBase).success ? mergeBase : null;
}

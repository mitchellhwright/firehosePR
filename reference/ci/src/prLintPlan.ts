/** The PR inventory is the sole source of file selection for the lint lane. */
export type PrLintPlan =
  | { readonly mode: 'full'; readonly paths: readonly [] }
  | { readonly mode: 'selected'; readonly paths: readonly string[] }
  | { readonly mode: 'none'; readonly paths: readonly [] };

const lintableExtension = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i;

function affectsLintConfiguration(path: string): boolean {
  const name = path.split('/').at(-1) ?? '';
  return path === 'package.json'
    || path === 'package-lock.json'
    || path === 'ci/package.json'
    || path === 'ci/package-lock.json'
    || name === '.eslintignore'
    || name.startsWith('.eslintrc')
    || name.startsWith('eslint.config.')
    || /^tsconfig(?:\.[^/]+)?\.json$/.test(name)
    || path.startsWith('server/eslint-rules/');
}

/** The pull request's own paths, supplied when the inventory is a base-update delta. */
export interface PullRequestLintScope {
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}

/**
 * Type-aware lint of the pull request's own files depends on the code they
 * import, so a base delta that changes or removes lintable code also re-lints
 * the pull request's surviving files. A delta with nothing lintable leaves
 * that evidence intact.
 */
export function derivePrLintPlan(
  changedFiles: readonly string[],
  deletedFiles: readonly string[],
  fileStatusAvailable: boolean,
  pullRequestScope?: PullRequestLintScope,
): PrLintPlan {
  const deltaPlan = deriveInventoryLintPlan(changedFiles, deletedFiles, fileStatusAvailable);
  if (pullRequestScope === undefined || deltaPlan.mode === 'full') return deltaPlan;
  if (deltaPlan.mode === 'none' && !deletedFiles.some((path) => lintableExtension.test(path))) {
    return deltaPlan;
  }
  return deriveInventoryLintPlan(
    [...changedFiles, ...pullRequestScope.changed],
    [...deletedFiles, ...pullRequestScope.deleted],
    fileStatusAvailable,
  );
}

function deriveInventoryLintPlan(
  changedFiles: readonly string[],
  deletedFiles: readonly string[],
  fileStatusAvailable: boolean,
): PrLintPlan {
  if (!fileStatusAvailable || [...changedFiles, ...deletedFiles].some(affectsLintConfiguration)) {
    return { mode: 'full', paths: [] };
  }
  const deleted = new Set(deletedFiles);
  const paths = [...new Set(changedFiles)]
    .filter((path) => lintableExtension.test(path) && !deleted.has(path))
    .sort();
  return paths.length > 0 ? { mode: 'selected', paths } : { mode: 'none', paths: [] };
}

export function parsePrLintPlan(value: unknown): PrLintPlan {
  if (typeof value !== 'object' || value === null || !('mode' in value)
    || !('paths' in value) || !Array.isArray(value.paths)) {
    throw new Error('Invalid PR lint plan');
  }
  if (value.mode === 'full' || value.mode === 'none') {
    if (value.paths.length !== 0) throw new Error('Full or empty lint plan cannot specify paths');
    return { mode: value.mode, paths: [] };
  }
  if (value.mode !== 'selected' || value.paths.length === 0
    || !value.paths.every((path: unknown) => typeof path === 'string'
      && path.length > 0 && lintableExtension.test(path)
      && !path.startsWith('/') && !path.split('/').includes('..') && !path.includes('\\'))) {
    throw new Error('Invalid selected PR lint paths');
  }
  return { mode: 'selected', paths: value.paths };
}

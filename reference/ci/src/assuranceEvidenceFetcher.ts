import { extractModuleSpecifiers } from './assuranceImportGraph.ts';
import {
  reviewedHeadApiPath, reviewedHeadLabel, reviewedHeadShaFromApi, reviewedHeadSource,
} from './ciEvent.ts';
import type { CalculationAssuranceRegistry } from './calculationAssurancePlan.ts';

const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_BYTES_PER_FILE = 131_072;

/**
 * Every evidence test path declared by an enforced package in `selectedPackageIds`. These are the
 * only files whose exact-head content the trusted-base planning job needs: they are the only paths
 * a PR can freely rewrite without going through the review cycle that ships a new trusted planner
 * bundle, and a package the change does not select is not being gated by this run at all, so
 * fetching its evidence would spend request budget against the fail-closed file limit for nothing.
 */
export function collectSelectedEvidencePaths(
  registry: CalculationAssuranceRegistry,
  selectedPackageIds: readonly string[]
): readonly string[] {
  const selected = new Set(selectedPackageIds);
  const paths = new Set<string>();
  for (const calculationPackage of registry.packages) {
    if (calculationPackage.status !== 'enforced' || !selected.has(calculationPackage.id)) continue;
    for (const testPath of [
      ...calculationPackage.tests.ruleVectors,
      ...calculationPackage.tests.independentOracle,
      ...calculationPackage.tests.metamorphicProperties,
      ...calculationPackage.tests.mutationSentinels,
    ]) {
      paths.add(testPath);
    }
  }
  return [...paths].sort();
}

function resolveRelativeSpecifier(fromRepoRelativePath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromDir = fromRepoRelativePath.includes('/')
    ? fromRepoRelativePath.slice(0, fromRepoRelativePath.lastIndexOf('/'))
    : '';
  const segments = `${fromDir}/${specifier}`.split('/');
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join('/');
}

function candidateSuffixes(base: string): readonly string[] {
  return [base, base.replace(/\.js$/, '.ts'), base.replace(/\.jsx$/, '.tsx'), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
}

export interface AssuranceEvidenceFetchOptions {
  readonly repository: string;
  readonly headSha: string;
  readonly prNumber: string;
  /** Names a merge queue candidate instead of a PR; exactly one of the two is set. */
  readonly queueRef?: string;
  readonly tokens: readonly string[];
  readonly entryPaths: readonly string[];
  readonly maxFiles?: number;
  readonly maxBytesPerFile?: number;
  readonly fetchImpl?: typeof fetch;
}

function githubHeaders(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function verifyReviewedHead(
  repository: string,
  prNumber: string,
  queueRef: string,
  headSha: string,
  tokens: readonly string[],
  fetchImpl: typeof fetch
): Promise<void> {
  const source = reviewedHeadSource(prNumber, queueRef);
  const url = `https://api.github.com/repos/${repository}${reviewedHeadApiPath(source)}`;
  for (const [index, token] of tokens.entries()) {
    const response = await fetchImpl(url, { headers: githubHeaders(token, 'application/vnd.github+json') });
    if ((response.status === 403 || response.status === 429) && index < tokens.length - 1) continue;
    if (!response.ok) {
      throw new Error(`Failed to verify the pull request head before fetching assurance evidence: HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    let liveSha: string | undefined;
    try { liveSha = reviewedHeadShaFromApi(source, body); } catch { liveSha = undefined; }
    if (liveSha !== headSha) {
      throw new Error(`${reviewedHeadLabel(source)} changed before calculation assurance evidence was fetched.`);
    }
    return;
  }
  throw new Error('Failed to verify the pull request head: no usable credentials.');
}

/**
 * Fetches one file's exact-head content via the verified, immutable, SHA-pinned Contents API.
 * Returns `null` when the file does not exist at that revision; throws on any other failure so
 * the caller fails closed instead of silently trusting stale or partial content.
 */
async function fetchFileAtHead(
  repository: string,
  repoRelativePath: string,
  headSha: string,
  tokens: readonly string[],
  fetchImpl: typeof fetch,
  maxBytes: number
): Promise<string | null> {
  const encodedPath = repoRelativePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(headSha)}`;
  for (const [index, token] of tokens.entries()) {
    const response = await fetchImpl(url, {
      headers: githubHeaders(token, 'application/vnd.github.raw+json'),
    });
    if (response.status === 404) return null;
    if ((response.status === 403 || response.status === 429) && index < tokens.length - 1) continue;
    if (!response.ok) {
      throw new Error(`Failed to fetch exact-head calculation assurance evidence ${repoRelativePath}: HTTP ${response.status}`);
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > maxBytes) {
      throw new Error(`Exact-head calculation assurance evidence ${repoRelativePath} exceeds the ${maxBytes}-byte limit`);
    }
    return Buffer.from(body).toString('utf8');
  }
  throw new Error(`Failed to fetch exact-head calculation assurance evidence ${repoRelativePath}: no usable credentials.`);
}

export interface ExactHeadFileFetchOptions {
  readonly repository: string;
  readonly headSha: string;
  readonly prNumber: string;
  /** Names a merge queue candidate instead of a PR; exactly one of the two is set. */
  readonly queueRef?: string;
  readonly tokens: readonly string[];
  readonly path: string;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Fetches one repo-relative file at the verified exact PR head, or `null` when the file does
 * not exist there. Shares the head verification and SHA-pinned Contents API path with the
 * assurance evidence walk, so a planner running from a trusted-base checkout can compare a
 * base file with the PR's version without trusting an unverified worktree.
 */
export async function fetchExactHeadFile(options: ExactHeadFileFetchOptions): Promise<string | null> {
  const { repository, headSha, prNumber, tokens, path } = options;
  const queueRef = options.queueRef ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;
  if (tokens.length === 0) {
    throw new Error(`No credentials are available to fetch exact-head ${path}.`);
  }
  await verifyReviewedHead(repository, prNumber, queueRef, headSha, tokens, fetchImpl);
  return fetchFileAtHead(repository, path, headSha, tokens, fetchImpl, options.maxBytes ?? DEFAULT_MAX_BYTES_PER_FILE);
}

/**
 * Builds a verified map of repo-relative path to exact-PR-head content for every declared
 * assurance evidence entry point and everything it locally imports. This is the secure input
 * boundary `findImportedImplementationFileFromContent` validates against: content is pinned to
 * a PR head confirmed immediately before the fetch, sourced over the network from GitHub's
 * immutable, SHA-addressed Contents API rather than read from an unverified worktree.
 */
export async function fetchExactHeadEvidenceContent(
  options: AssuranceEvidenceFetchOptions
): Promise<ReadonlyMap<string, string>> {
  const { repository, headSha, prNumber, tokens, entryPaths } = options;
  const queueRef = options.queueRef ?? '';
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const fetchImpl = options.fetchImpl ?? fetch;

  const content = new Map<string, string>();
  if (entryPaths.length === 0) return content;
  if (tokens.length === 0) {
    throw new Error('No credentials are available to fetch exact-head calculation assurance evidence.');
  }

  await verifyReviewedHead(repository, prNumber, queueRef, headSha, tokens, fetchImpl);

  const attempted = new Set<string>();
  // Tracks paths ever enqueued, independent of `content`, so a file whose bytes were cached by
  // the inner candidate-resolution loop still gets its own imports walked when it is dequeued.
  const visited = new Set<string>(entryPaths);
  const queue: string[] = [...visited];

  const attempt = async (repoRelativePath: string): Promise<string | null> => {
    if (attempted.has(repoRelativePath)) return content.get(repoRelativePath) ?? null;
    attempted.add(repoRelativePath);
    if (attempted.size > maxFiles) {
      throw new Error(`Calculation assurance evidence import graph exceeds the ${maxFiles}-file fetch limit.`);
    }
    return fetchFileAtHead(repository, repoRelativePath, headSha, tokens, fetchImpl, maxBytesPerFile);
  };

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    const source = await attempt(current);
    if (source === null) continue;
    content.set(current, source);

    for (const specifier of extractModuleSpecifiers(source)) {
      const base = resolveRelativeSpecifier(current, specifier);
      if (base === null) continue;
      for (const candidate of candidateSuffixes(base)) {
        if (visited.has(candidate)) break;
        const candidateSource = await attempt(candidate);
        if (candidateSource !== null) {
          content.set(candidate, candidateSource);
          visited.add(candidate);
          queue.push(candidate);
          break;
        }
      }
    }
  }

  return content;
}

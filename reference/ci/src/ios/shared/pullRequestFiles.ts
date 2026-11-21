import { StepFailure } from './stepFailure.ts';

/**
 * The pull request's complete changed-file inventory, read from the GitHub REST
 * API with the same fail-closed rules the step's inline Python had:
 *
 * - two tokens, the second tried only when the first is rate limited;
 * - five immediate attempts per token for a retryable status or an unreachable
 *   API, because a control runner is not held waiting out a longer outage;
 * - when the budget runs out, a conservative inventory that selects the full
 *   iOS suite rather than a short list that would silently skip lanes;
 * - a non-retryable status, an empty `changed_files` count, or an inventory
 *   shorter than that count fails the step instead of skipping iOS checks.
 */

const maxAttempts = 5;
const retryableStatuses = new Set([403, 429, 500, 502, 503, 504]);
const requestTimeoutMs = 30_000;

/**
 * The inventory used when GitHub cannot answer: one file per lane, so every
 * downstream selector routes to its full coverage.
 */
export const conservativeFullCheckFiles = [
  'ios/example-ios.xcodeproj/project.pbxproj',
  'ios/Subscriptions.storekit',
  'ios/example-ios/UI/Onboarding/OnboardingView.swift',
  'ios/example-ios/UI/Chat/ChatView.swift',
  'ios/example-ios/UI/Cards/Budget/BudgetView.swift',
  'ios/example-iosUITests/IncomeActivationRealServerE2ETests.swift',
] as const;

export interface PullRequestFilesOptions {
  readonly prNumber: string;
  readonly repository: string;
  readonly token: string;
  readonly fallbackToken: string;
  readonly fetchImpl?: typeof fetch;
  /** Where the step's progress and retry notes go; the shell wrote them to stderr. */
  readonly log?: (message: string) => void;
}

/** Raised when the fetch budget is spent; the caller answers with the conservative inventory. */
class FullChecksSelected extends Error {}

interface FetchContext {
  readonly tokens: readonly string[];
  readonly fetchImpl: typeof fetch;
  readonly log: (message: string) => void;
}

function selectFullChecks(context: FetchContext, reason: string): never {
  context.log(`${reason}; conservatively selecting full iOS checks.`);
  throw new FullChecksSelected();
}

async function fetchJson(context: FetchContext, url: string): Promise<unknown> {
  for (let tokenIndex = 0; tokenIndex < context.tokens.length; tokenIndex += 1) {
    const candidate = context.tokens[tokenIndex] ?? '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await context.fetchImpl(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${candidate}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error: unknown) {
        const description = error instanceof Error ? error.message : String(error);
        if (attempt === maxAttempts) {
          selectFullChecks(context, `GitHub API stayed unreachable (${description})`);
        }
        context.log(
          `GitHub API request failed (${description}); `
          + `retrying (attempt ${attempt}/${maxAttempts}).`,
        );
        continue;
      }
      if (response.status < 400) return await response.json() as unknown;
      const body = (await response.text()).slice(0, 500);
      const status = response.status;
      if ((status === 403 || status === 429) && tokenIndex < context.tokens.length - 1) {
        context.log(`GitHub API returned HTTP ${status}; retrying with fallback token.`);
        break;
      }
      if (status === 403 || status === 429) {
        selectFullChecks(context, 'GitHub metadata quota is exhausted');
      }
      if (!retryableStatuses.has(status)) {
        throw new StepFailure(
          `GitHub API request failed with HTTP ${status} for ${url}: ${body}`,
          'stderr',
        );
      }
      if (attempt === maxAttempts) {
        selectFullChecks(context, `GitHub API kept returning HTTP ${status}`);
      }
      context.log(
        `GitHub API returned HTTP ${status}; retrying (attempt ${attempt}/${maxAttempts}): ${body}`,
      );
    }
  }
  throw new StepFailure(`GitHub API request exhausted every credential for ${url}.`, 'stderr');
}

function changedFileCount(pullRequest: unknown): number {
  if (typeof pullRequest !== 'object' || pullRequest === null) return 0;
  const value = (pullRequest as { changed_files?: unknown }).changed_files;
  return typeof value === 'number' && Number.isInteger(value) ? value : 0;
}

function filenamesIn(page: unknown): { readonly names: string[]; readonly size: number } {
  if (!Array.isArray(page)) return { names: [], size: 0 };
  const names: string[] = [];
  for (const item of page) {
    if (typeof item !== 'object' || item === null) continue;
    const filename = (item as { filename?: unknown }).filename;
    if (typeof filename === 'string' && filename.length > 0) names.push(filename);
  }
  return { names, size: page.length };
}

export async function fetchPullRequestChangedFiles(
  options: PullRequestFilesOptions,
): Promise<string> {
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  if (!options.prNumber || !options.repository || !options.token) {
    throw new StepFailure('Missing pull request metadata for iOS change detection.', 'stderr');
  }
  const context: FetchContext = {
    tokens: [...new Set(
      [options.token, options.fallbackToken].filter((token) => token.length > 0),
    )],
    fetchImpl: options.fetchImpl ?? fetch,
    log,
  };

  try {
    const pullRequest = await fetchJson(
      context,
      `https://api.github.com/repos/${options.repository}/pulls/${options.prNumber}`,
    );
    const expected = changedFileCount(pullRequest);
    if (expected < 1) {
      throw new StepFailure(
        'Pull request changed-file metadata was empty or invalid; refusing to skip iOS checks.',
        'stderr',
      );
    }

    const filenames: string[] = [];
    for (let page = 1; ; page += 1) {
      const files = await fetchJson(
        context,
        `https://api.github.com/repos/${options.repository}/pulls/${options.prNumber}/files`
        + `?per_page=100&page=${page}`,
      );
      const { names, size } = filenamesIn(files);
      if (size === 0) break;
      filenames.push(...names);
      if (size < 100) break;
    }

    if (filenames.length !== expected) {
      throw new StepFailure(
        `Pull request changed-file inventory was incomplete (expected ${expected}, `
        + `received ${filenames.length}); refusing to skip iOS checks.`,
        'stderr',
      );
    }
    return filenames.join('\n');
  } catch (error: unknown) {
    if (error instanceof FullChecksSelected) return conservativeFullCheckFiles.join('\n');
    throw error;
  }
}

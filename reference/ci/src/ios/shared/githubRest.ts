/**
 * The token-falling-back GitHub metadata reader the iOS control steps use.
 *
 * Replaces the `github_get` shell function that every control step carried a
 * copy of. Its contract is deliberately the same one those copies had, because
 * the callers branch on it:
 *
 *  - HTTP 200 returns the decoded body.
 *  - HTTP 403 and 429 retry with the next distinct credential, because the
 *    event token is rate-limited far sooner than the trusted app token and a
 *    secondary limit must not fail a gate that a retry would answer.
 *  - A read-only GET retries transient HTTP 5xx responses twice with a short
 *    delay. Writes are never replayed after an uncertain server response.
 *  - Any other status is returned as-is so the caller can report it verbatim.
 *  - A transport failure throws, because "no answer" is not "the answer is no"
 *    for a gate that decides whether required checks run.
 *
 * `statusLabel` carries the three-digit string the shell printed (`000` when
 * no credential was usable at all), so converted error annotations keep the
 * exact text they had.
 */

import { fetchGithubWithReadRetry } from '../../githubReadRetry.ts';

export class GithubTransportError extends Error {}

export interface GithubResponse {
  readonly status: number;
  readonly statusLabel: string;
  /** The decoded JSON body on HTTP 200, `undefined` otherwise or when it is not JSON. */
  readonly body: unknown;
}

export interface GithubReaderOptions {
  readonly tokens: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly warn?: (message: string) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type GithubReader = (url: string) => Promise<GithubResponse>;

/** The same contract for a write. `DELETE` answers 204 with no body. */
export type GithubRequester = (method: string, url: string) => Promise<GithubResponse>;

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function createGithubReader(options: GithubReaderOptions): GithubReader {
  const request = createGithubRequester(options);
  return async (url: string): Promise<GithubResponse> => request('GET', url);
}

/**
 * The reader's credential fallback, retry rule and status contract, for the
 * methods that change something. Deleting an artifact needs exactly the same
 * "try the event token, fall back to the app token" behaviour as reading one,
 * so the two share this implementation rather than growing a second copy.
 */
export function createGithubRequester(options: GithubReaderOptions): GithubRequester {
  const fetchImpl = options.fetchImpl ?? fetch;
  const warn = options.warn ?? defaultWarn;
  return async (method: string, url: string): Promise<GithubResponse> => {
    let lastStatus: number | undefined;
    let previousToken = '';
    for (const token of options.tokens) {
      // The shell skipped an empty credential and a credential identical to
      // the one it had just used; both happen when the trusted app token is
      // unavailable and the fallback resolves to the event token again.
      if (token.length === 0 || token === previousToken) continue;
      previousToken = token;
      let response: Response;
      try {
        response = await fetchGithubWithReadRetry(url, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }, { fetchImpl, warn, sleep: options.sleep });
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new GithubTransportError(`Could not reach ${url}: ${detail}`);
      }
      lastStatus = response.status;
      if (response.status === 200) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          // The shell handed the raw bytes to jq, which then failed the
          // caller's own check. Callers treat an undecodable body the same.
          body = undefined;
        }
        return { status: 200, statusLabel: '200', body };
      }
      if (response.status !== 403 && response.status !== 429) {
        return { status: response.status, statusLabel: String(response.status), body: undefined };
      }
      warn(`::warning::GitHub returned HTTP ${response.status}; retrying metadata read with fallback token.`);
    }
    return {
      status: lastStatus ?? 0,
      statusLabel: lastStatus === undefined ? '000' : String(lastStatus),
      body: undefined,
    };
  };
}

/** The credentials a control step offers, in order, with blanks dropped. */
export function credentialTokens(eventToken: string, fallbackToken: string): readonly string[] {
  return [eventToken, fallbackToken].filter((token) => token.length > 0);
}

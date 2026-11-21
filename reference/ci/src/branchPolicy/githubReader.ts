/**
 * The only way the branch-policy monitor talks to GitHub. It can issue GET
 * requests to a fixed set of read endpoints and nothing else: there is no
 * method parameter, no body, and a path outside the allow-list is refused
 * before any request leaves the process. A failure is returned as a typed
 * reason, never as an empty result, so "could not read" cannot look like
 * "nothing configured".
 */

export type InspectionFailureReason =
  | 'missing-credential'
  | 'unsupported-api-url'
  | 'baseline-not-activatable'
  | 'endpoint-not-allowed'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'
  | 'timeout'
  | 'transport'
  | 'http-error'
  | 'malformed-response'
  | 'incomplete-pagination';

export interface InspectionFailure {
  readonly reason: InspectionFailureReason;
  /** The endpoint template, never a URL carrying query strings or credentials. */
  readonly endpoint: string;
  readonly detail: string;
}

export class InspectionError extends Error {
  readonly failure: InspectionFailure;

  constructor(failure: InspectionFailure) {
    super(`${failure.reason} at ${failure.endpoint}: ${failure.detail}`);
    this.name = 'InspectionError';
    this.failure = failure;
  }
}

export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const PAGE_SIZE = 100;
export const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 15_000;

const branchPattern = '(?:develop|main)';
const repoPattern = '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+';

/** Every endpoint the monitor may read, as anchored path patterns. */
export const ALLOWED_ENDPOINTS: readonly { readonly template: string; readonly pattern: RegExp }[] = [
  { template: 'GET /repos/{repo}', pattern: new RegExp(`^/repos/${repoPattern}$`) },
  { template: 'GET /repos/{repo}/collaborators', pattern: new RegExp(`^/repos/${repoPattern}/collaborators$`) },
  { template: 'GET /repos/{repo}/teams', pattern: new RegExp(`^/repos/${repoPattern}/teams$`) },
  { template: 'GET /repos/{repo}/rulesets', pattern: new RegExp(`^/repos/${repoPattern}/rulesets$`) },
  { template: 'GET /repos/{repo}/rulesets/{id}', pattern: new RegExp(`^/repos/${repoPattern}/rulesets/[0-9]+$`) },
  {
    template: 'GET /repos/{repo}/branches/{branch}/protection',
    pattern: new RegExp(`^/repos/${repoPattern}/branches/${branchPattern}/protection$`),
  },
  {
    template: 'GET /repos/{repo}/rules/branches/{branch}',
    pattern: new RegExp(`^/repos/${repoPattern}/rules/branches/${branchPattern}$`),
  },
];

export interface GithubReaderOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

/** A document that GitHub may report as deliberately absent rather than unreadable. */
export type OptionalDocument = { readonly found: true; readonly body: unknown } | { readonly found: false };

export interface GithubReader {
  /** One JSON document from an allowed endpoint. */
  readonly getJson: (path: string, query?: Readonly<Record<string, string>>) => Promise<unknown>;
  /**
   * One JSON document, or `found: false` when GitHub answers 404 with exactly
   * `absentMessage`. Every other 404 (a hidden or missing resource) and every
   * other failure is still an inspection failure.
   */
  readonly getOptionalJson: (path: string, absentMessage: string) => Promise<OptionalDocument>;
  /** Every item of a paginated JSON array, following `Link: rel="next"` up to MAX_PAGES. */
  readonly getAllPages: (path: string, query?: Readonly<Record<string, string>>) => Promise<readonly unknown[]>;
}

function endpointFor(pathname: string): string {
  const match = ALLOWED_ENDPOINTS.find((endpoint) => endpoint.pattern.test(pathname));
  if (match === undefined) {
    throw new InspectionError({
      reason: 'endpoint-not-allowed',
      endpoint: 'GET <refused>',
      detail: 'the monitor may only read its allow-listed endpoints',
    });
  }
  return match.template;
}

function failureForStatus(response: Response, endpoint: string): InspectionFailure {
  const { status } = response;
  const exhausted = response.headers.get('x-ratelimit-remaining') === '0';
  if (status === 429 || (status === 403 && exhausted)) {
    return { reason: 'rate-limited', endpoint, detail: `HTTP ${status}; retry after the rate-limit window` };
  }
  if (status === 401) {
    return { reason: 'unauthorized', endpoint, detail: 'HTTP 401; the credential is missing, expired or revoked' };
  }
  if (status === 403) {
    return { reason: 'forbidden', endpoint, detail: 'HTTP 403; the credential lacks read access to this endpoint' };
  }
  if (status === 404) {
    return {
      reason: 'not-found',
      endpoint,
      detail: 'HTTP 404; the control may have been removed or the credential cannot see it — both need a human',
    };
  }
  return { reason: 'http-error', endpoint, detail: `HTTP ${status}` };
}

/** The `rel="next"` URL of a GitHub `Link` header, if any. */
export function nextPageUrl(link: string | null): string | undefined {
  if (link === null) return undefined;
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function pageUrl(next: string, endpoint: string): URL {
  try {
    return new URL(next);
  } catch {
    throw new InspectionError({ reason: 'malformed-response', endpoint, detail: 'pagination link is not a URL' });
  }
}

async function jsonBody(response: Response, endpoint: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new InspectionError({ reason: 'malformed-response', endpoint, detail: 'response body is not JSON' });
  }
}

/** The `message` of a GitHub error body, or undefined when the body is not one. */
async function errorMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return undefined;
    const message: unknown = (body as Readonly<Record<string, unknown>>)['message'];
    return typeof message === 'string' ? message : undefined;
  } catch {
    return undefined;
  }
}

export function createGithubReader(options: GithubReaderOptions): GithubReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.apiUrl.replace(/\/$/, '');
  if (origin !== GITHUB_API_ORIGIN) {
    throw new InspectionError({
      reason: 'unsupported-api-url',
      endpoint: 'GET <none>',
      detail: `the monitor only sends its credential to ${GITHUB_API_ORIGIN}`,
    });
  }
  if (options.token.trim() === '') {
    throw new InspectionError({
      reason: 'missing-credential',
      endpoint: 'GET <none>',
      detail: 'no read-only inspection credential was provided',
    });
  }

  async function send(url: URL): Promise<{ readonly endpoint: string; readonly response: Response }> {
    if (url.origin !== origin) {
      throw new InspectionError({
        reason: 'endpoint-not-allowed',
        endpoint: 'GET <refused>',
        detail: 'a pagination link pointed outside the GitHub API',
      });
    }
    const endpoint = endpointFor(url.pathname);
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      return { endpoint, response };
    } catch (error: unknown) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new InspectionError(timedOut
        ? { reason: 'timeout', endpoint, detail: `no response within ${REQUEST_TIMEOUT_MS}ms` }
        : { reason: 'transport', endpoint, detail: error instanceof Error ? error.name : 'request failed' });
    }
  }

  async function request(url: URL): Promise<{ readonly body: unknown; readonly link: string | null }> {
    const { endpoint, response } = await send(url);
    if (!response.ok) throw new InspectionError(failureForStatus(response, endpoint));
    return { body: await jsonBody(response, endpoint), link: response.headers.get('link') };
  }

  function urlFor(path: string, query: Readonly<Record<string, string>>): URL {
    const url = new URL(`${origin}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }

  return {
    async getJson(path, query = {}) {
      return (await request(urlFor(path, query))).body;
    },
    async getOptionalJson(path, absentMessage) {
      const { endpoint, response } = await send(urlFor(path, {}));
      if (response.status === 404 && (await errorMessage(response)) === absentMessage) return { found: false };
      if (!response.ok) throw new InspectionError(failureForStatus(response, endpoint));
      return { found: true, body: await jsonBody(response, endpoint) };
    },
    async getAllPages(path, query = {}) {
      const items: unknown[] = [];
      let url: URL | undefined = urlFor(path, { ...query, per_page: String(PAGE_SIZE) });
      for (let page = 1; url !== undefined; page += 1) {
        if (page > MAX_PAGES) {
          throw new InspectionError({
            reason: 'incomplete-pagination',
            endpoint: endpointFor(url.pathname),
            detail: `more than ${MAX_PAGES} pages; refusing to compare a partial list`,
          });
        }
        const { body, link } = await request(url);
        if (!Array.isArray(body)) {
          throw new InspectionError({
            reason: 'malformed-response',
            endpoint: endpointFor(url.pathname),
            detail: `page ${page} is not a JSON array`,
          });
        }
        items.push(...body);
        const next = nextPageUrl(link);
        url = next === undefined ? undefined : pageUrl(next, endpointFor(url.pathname));
      }
      return items;
    },
  };
}

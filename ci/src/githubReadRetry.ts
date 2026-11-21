/**
 * Retry idempotent GitHub reads after a transient transport or server failure.
 * A write can have succeeded even if its response was lost, so it is never
 * replayed by this helper.
 */
export interface GithubReadRetryOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly warn?: (message: string) => void;
}

const delays = [250, 750] as const;

export async function fetchGithubWithReadRetry(
  url: string,
  init: RequestInit,
  options: GithubReadRetryOptions = {},
): Promise<Response> {
  return fetchWithBoundedRetry(url, init, (init.method ?? 'GET').toUpperCase() === 'GET', options);
}

/**
 * POST a GraphQL query with the same bounded retry as a GET. A query only
 * reads, so replaying it is safe; a mutation is refused here rather than
 * risk applying it twice.
 */
export async function fetchGithubGraphqlQuery(
  url: string,
  request: { readonly headers: Record<string, string>; readonly query: string; readonly variables: Record<string, unknown> },
  options: GithubReadRetryOptions = {},
): Promise<Response> {
  if (!/^\s*(?:query\b|\{)/.test(request.query)) {
    throw new Error('fetchGithubGraphqlQuery retries reads only; send a GraphQL mutation without retry.');
  }
  return fetchWithBoundedRetry(url, {
    method: 'POST',
    headers: { ...request.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: request.query, variables: request.variables }),
  }, true, options);
}

async function fetchWithBoundedRetry(
  url: string,
  init: RequestInit,
  read: boolean,
  options: GithubReadRetryOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const warn = options.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`); });

  for (let attempt = 0; ; attempt += 1) {
    const delay = read ? delays[attempt] : undefined;
    try {
      const response = await fetchImpl(url, init);
      if (response.status < 500 || response.status > 599 || delay === undefined) {
        return response;
      }
      warn(`::warning::GitHub returned HTTP ${response.status}; retrying read in ${delay}ms.`);
    } catch (error: unknown) {
      if (delay === undefined) throw error;
      warn(`::warning::GitHub read transport failed; retrying read in ${delay}ms.`);
    }
    if (delay !== undefined) await sleep(delay);
  }
}

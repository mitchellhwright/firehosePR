/**
 * The `curl -fsS --max-time N … | python3 -c 'json.load(sys.stdin)'` pair the
 * lane steps used, as one typed call: a non-2xx response or an expired
 * deadline throws, and a 2xx body is parsed as JSON.
 *
 * Kept separate from the probes themselves so the decision modules stay pure
 * and the transport has a single seam to stub in tests.
 */

export interface JsonRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly timeoutMs: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Retry-After is either delta-seconds or an HTTP date. Invalid values use normal backoff. */
export function retryAfterMilliseconds(header: string | null, nowMs: number = Date.now()): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
  }
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    retryAfterMs: number | undefined,
    method: string,
    pathname: string,
  ) {
    super(`${method} ${pathname} failed with HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Mirrors `curl -f`: an HTTP error status is a failure, not a payload. */
export async function fetchJson(request: JsonRequest): Promise<unknown> {
  const response = await fetch(request.url, {
    method: request.method ?? 'GET',
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  if (!response.ok) {
    const method = request.method ?? 'GET';
    throw new HttpStatusError(
      response.status,
      response.status === 429 ? retryAfterMilliseconds(response.headers.get('retry-after')) : undefined,
      method,
      new URL(request.url).pathname,
    );
  }
  return JSON.parse(await response.text());
}

/**
 * Percent-encodes everything outside RFC 3986's unreserved set, which is what
 * `curl --data-urlencode` sends. `URLSearchParams` would spell a space `+`
 * instead, so a value is encoded here rather than through it.
 */
export function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Builds a query URL from decoded parameters, as `curl --get --data-urlencode` did. */
export function queryUrl(base: string, parameters: readonly (readonly [string, string])[]): string {
  const query = parameters
    .map(([name, value]) => `${encodeQueryComponent(name)}=${encodeQueryComponent(value)}`)
    .join('&');
  return `${base}?${query}`;
}

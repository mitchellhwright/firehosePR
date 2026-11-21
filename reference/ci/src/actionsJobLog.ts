import { fetchGithubWithReadRetry } from './githubReadRetry.ts';

/**
 * The plain-text log of one completed Actions job.
 *
 * `GET /repos/{o}/{r}/actions/jobs/{id}/logs` answers with a redirect to a
 * short-lived blob URL. That URL is on another origin and already carries its
 * own signature, so the redirect is followed by hand and the GitHub
 * credential is never sent to it. As with every other metadata read, HTTP 403
 * and 429 retry with the next distinct credential; any other answer is an
 * error naming the status, because "no log" is not "no evidence marker".
 */

export interface JobLogReaderOptions {
  readonly tokens: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly warn?: (message: string) => void;
}

export type JobLogReader = (url: string) => Promise<string>;

export function createJobLogReader(options: JobLogReaderOptions): JobLogReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const warn = options.warn ?? ((message: string): void => { process.stderr.write(`${message}\n`); });
  return async (url: string): Promise<string> => {
    let lastStatus: number | undefined;
    let previousToken = '';
    for (const token of options.tokens) {
      if (token.length === 0 || token === previousToken) continue;
      previousToken = token;
      const response = await fetchGithubWithReadRetry(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }, { fetchImpl, warn });
      lastStatus = response.status;
      if (response.status === 200) return response.text();
      if (response.status === 302 || response.status === 301 || response.status === 307) {
        const location = response.headers.get('location');
        if (location === null || location.length === 0) throw new Error(`Job log redirect from ${url} carried no location.`);
        const blob = await fetchImpl(location, { method: 'GET', redirect: 'follow' });
        if (blob.status !== 200) throw new Error(`Job log download answered HTTP ${blob.status}.`);
        return blob.text();
      }
      if (response.status !== 403 && response.status !== 429) break;
      warn(`::warning::GitHub returned HTTP ${response.status} for a job log; retrying with fallback token.`);
    }
    throw new Error(`Job log ${url} answered HTTP ${lastStatus ?? 0}.`);
  };
}

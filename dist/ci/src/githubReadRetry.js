const delays = [250, 750];
export async function fetchGithubWithReadRetry(url, init, options = {}) {
    return fetchWithBoundedRetry(url, init, (init.method ?? 'GET').toUpperCase() === 'GET', options);
}
/**
 * POST a GraphQL query with the same bounded retry as a GET. A query only
 * reads, so replaying it is safe; a mutation is refused here rather than
 * risk applying it twice.
 */
export async function fetchGithubGraphqlQuery(url, request, options = {}) {
    if (!/^\s*(?:query\b|\{)/.test(request.query)) {
        throw new Error('fetchGithubGraphqlQuery retries reads only; send a GraphQL mutation without retry.');
    }
    return fetchWithBoundedRetry(url, {
        method: 'POST',
        headers: { ...request.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: request.query, variables: request.variables }),
    }, true, options);
}
async function fetchWithBoundedRetry(url, init, read, options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const warn = options.warn ?? ((message) => { process.stderr.write(`${message}\n`); });
    for (let attempt = 0;; attempt += 1) {
        const delay = read ? delays[attempt] : undefined;
        try {
            const response = await fetchImpl(url, init);
            if (response.status < 500 || response.status > 599 || delay === undefined) {
                return response;
            }
            warn(`::warning::GitHub returned HTTP ${response.status}; retrying read in ${delay}ms.`);
        }
        catch (error) {
            if (delay === undefined)
                throw error;
            warn(`::warning::GitHub read transport failed; retrying read in ${delay}ms.`);
        }
        if (delay !== undefined)
            await sleep(delay);
    }
}

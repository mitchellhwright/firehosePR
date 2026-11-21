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
export declare function fetchGithubWithReadRetry(url: string, init: RequestInit, options?: GithubReadRetryOptions): Promise<Response>;
/**
 * POST a GraphQL query with the same bounded retry as a GET. A query only
 * reads, so replaying it is safe; a mutation is refused here rather than
 * risk applying it twice.
 */
export declare function fetchGithubGraphqlQuery(url: string, request: {
    readonly headers: Record<string, string>;
    readonly query: string;
    readonly variables: Record<string, unknown>;
}, options?: GithubReadRetryOptions): Promise<Response>;

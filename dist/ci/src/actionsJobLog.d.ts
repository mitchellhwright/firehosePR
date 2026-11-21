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
export declare function createJobLogReader(options: JobLogReaderOptions): JobLogReader;

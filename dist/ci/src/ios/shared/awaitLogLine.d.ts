export type LogMatch = {
    readonly kind: 'literal';
    readonly text: string;
} | {
    readonly kind: 'regex';
    readonly pattern: string;
};
/**
 * Scan complete lines on a bounded interval. Polling is intentional: fs.watch
 * may coalesce or drop events and remains attached to a replaced directory
 * inode, while readiness logs are small and a 250 ms interval is negligible
 * beside process startup. One mechanism handles file creation, truncation,
 * rotation, and directory replacement without retaining a native watcher.
 *
 */
export declare function awaitLogLine(logPath: string, match: LogMatch, signal?: AbortSignal): Promise<string>;

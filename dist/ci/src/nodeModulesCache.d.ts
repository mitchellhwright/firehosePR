/** Exact dependency-tree keys. Restore exact keys only; allow cache writes only
 * from your trusted branch. Install scripts and external dependencies still
 * require consumer-specific invalidation. See docs/cache-and-evidence.md. */
export declare const npmInstallArguments: readonly ['ci', '--no-audit', '--no-fund', '--prefer-offline'];
/** Written into the tree after a successful install; the saved entry carries it. */
export declare const stampFileName = ".firehosepr-node-modules-key";
/** The exact Actions cache key for the application tree on this runner. */
export declare function nodeModulesCacheKey(root: string, environment: NodeJS.ProcessEnv): string;
/**
 * Why the tree in `node_modules` cannot be reused, or undefined when it can.
 * Only a tree restored in this job (`cacheHit`), stamped with this job's key
 * and accepted by `npm ls` is reusable.
 */
export declare function restoredTreeRejection(options: {
    readonly root: string;
    readonly key: string;
    readonly cacheHit: string | undefined;
}): string | undefined;
/**
 * Keep a tree restored from the Actions cache when it is exactly this job's
 * tree; otherwise delete whatever is there, install, and stamp the result.
 */
export declare function installOrReuse(options: {
    readonly root: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly install: () => number;
}): number;

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Exact dependency-tree keys. Restore exact keys only; allow cache writes only
 * from your trusted branch. Install scripts and external dependencies still
 * require consumer-specific invalidation. See docs/cache-and-evidence.md. */
export const npmInstallArguments = ['ci', '--no-audit', '--no-fund', '--prefer-offline'];
/** Written into the tree after a successful install; the saved entry carries it. */
export const stampFileName = '.firehosepr-node-modules-key';
function npmVersion(root) {
    const result = spawnSync('npm', ['--version'], { cwd: root, encoding: 'utf8' });
    if (result.error !== undefined)
        throw result.error;
    const version = result.stdout.trim();
    if (result.status !== 0 || !/^\d+\.\d+\.\d+/.test(version)) {
        throw new Error(`npm --version failed (exit ${result.status ?? 'signal'}): ${result.stderr}`);
    }
    return version;
}
function installEnvironment(environment) {
    const entries = [];
    for (const [name, value] of Object.entries(environment)) {
        if (value === undefined)
            continue;
        if (name === 'NODE_ENV' || name.toLowerCase().startsWith('npm_config_'))
            entries.push([name, value]);
    }
    return entries.sort(([left], [right]) => left.localeCompare(right));
}
function fileDigest(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}
/**
 * The project npm configuration (`<root>/.npmrc`) that `npm ci` at the root
 * reads, or `absent`. A branch can change `omit`, `ignore-scripts` or
 * `legacy-peer-deps` there without touching either manifest.
 */
function projectConfigDigest(root) {
    const path = join(root, '.npmrc');
    return existsSync(path) ? fileDigest(path) : 'absent';
}
/** The exact Actions cache key for the application tree on this runner. */
export function nodeModulesCacheKey(root, environment) {
    const npm = npmVersion(root);
    const imageOs = environment['ImageOS'] ?? 'unknown-image';
    const inputs = {
        installArguments: npmInstallArguments,
        platform: process.platform,
        arch: process.arch,
        imageOs,
        node: process.version,
        moduleAbi: process.versions.modules,
        npm,
        environment: installEnvironment(environment),
        manifest: fileDigest(join(root, 'package.json')),
        lockfile: fileDigest(join(root, 'package-lock.json')),
        projectConfig: projectConfigDigest(root),
    };
    const digest = createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
    return [
        'firehosepr-node-modules-v1', process.platform, process.arch, imageOs.replaceAll(/[^A-Za-z0-9._]/g, '_'),
        `node${process.version.slice(1)}`, `npm${npm}`, digest,
    ].join('-');
}
/**
 * Why the tree in `node_modules` cannot be reused, or undefined when it can.
 * Only a tree restored in this job (`cacheHit`), stamped with this job's key
 * and accepted by `npm ls` is reusable.
 */
export function restoredTreeRejection(options) {
    if (options.cacheHit !== 'true')
        return 'no exact cache entry was restored';
    const stamp = join(options.root, 'node_modules', stampFileName);
    if (!existsSync(stamp))
        return 'the restored tree has no key stamp';
    let stamped;
    try {
        stamped = readFileSync(stamp, 'utf8').trim();
    }
    catch (error) {
        return `the restored tree's key stamp is unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (stamped !== options.key)
        return `the restored tree is stamped ${stamped}, not ${options.key}`;
    const listing = spawnSync('npm', ['ls', '--depth=0'], { cwd: options.root, encoding: 'utf8' });
    if (listing.error !== undefined)
        throw listing.error;
    if (listing.status !== 0)
        return `npm ls --depth=0 rejected the restored tree: ${listing.stderr.trim()}`;
    return undefined;
}
/**
 * Keep a tree restored from the Actions cache when it is exactly this job's
 * tree; otherwise delete whatever is there, install, and stamp the result.
 */
export function installOrReuse(options) {
    const { root, environment } = options;
    const key = nodeModulesCacheKey(root, environment);
    const cacheHit = environment['NODE_MODULES_CACHE_HIT'];
    const rejection = restoredTreeRejection({ root, key, cacheHit });
    if (rejection === undefined) {
        process.stdout.write(`Reused the node_modules restored for ${key}; npm ci skipped.\n`);
        return 0;
    }
    if (cacheHit === 'true')
        process.stderr.write(`Discarding the restored node_modules: ${rejection}.\n`);
    const modules = join(root, 'node_modules');
    rmSync(modules, { recursive: true, force: true });
    const status = options.install();
    if (status !== 0)
        return status;
    if (!existsSync(modules))
        throw new Error('npm ci succeeded without creating node_modules');
    writeFileSync(join(modules, stampFileName), `${key}\n`);
    return 0;
}

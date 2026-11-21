import { fileURLToPath } from 'node:url';
import { beginGuardedBuild, buildExitedOnItsOwn, finishGuardedBuild, } from '../../ios/incrementalBuildGuard.js';
import { annotateWarning, logLine, optionalEnv } from '../../ios/shared/actionIo.js';
import { isProcessTerminating, runCommand, runStepProgram } from '../../ios/shared/processRunner.js';
/**
 * Runs one Xcode build against a persistent derived-data directory, discarding
 * that directory first when the previous build in it never finished.
 * See `ci/src/ios/incrementalBuildGuard.ts` for why.
 *
 * Usage: guardIosIncrementalBuild.ts <derived-data-path> -- <command> [args...]
 * Exits with the command's status.
 */
const USAGE = 'usage: guardIosIncrementalBuild.ts <derived-data-path> -- <command> [args...]';
export function parseGuardArguments(argv) {
    const [derivedData, separator, command, ...args] = argv;
    if (derivedData === undefined || derivedData.length === 0 || separator !== '--'
        || command === undefined || command.length === 0) {
        throw new Error(USAGE);
    }
    return { derivedData, command, args };
}
function buildOwner() {
    const run = optionalEnv('GITHUB_RUN_ID', 'local');
    const attempt = optionalEnv('GITHUB_RUN_ATTEMPT', '0');
    const job = optionalEnv('GITHUB_JOB', 'local');
    return `run ${run} attempt ${attempt} job ${job} pid ${process.pid} started ${new Date().toISOString()}`;
}
export async function guardIosIncrementalBuild(argv) {
    const { derivedData, command, args } = parseGuardArguments(argv);
    if (beginGuardedBuild(derivedData, buildOwner()) === 'discarded-interrupted-build') {
        annotateWarning(`The previous build in ${derivedData} was interrupted before Xcode saved its incremental `
            + 'state, so its object files cannot be trusted. Discarded the derived data; this build '
            + 'compiles from scratch.');
    }
    const { status } = await runCommand(command, args);
    if (buildExitedOnItsOwn(status, isProcessTerminating())) {
        finishGuardedBuild(derivedData);
    }
    else {
        logLine(`The build ended with status ${status} before finishing; the next build in `
            + `${derivedData} will discard it.`);
    }
    return status;
}
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
    await runStepProgram('Guarded iOS build', () => guardIosIncrementalBuild(process.argv.slice(2)));
}

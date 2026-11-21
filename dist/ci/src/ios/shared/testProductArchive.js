import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { runCommand } from './processRunner.js';
import { writeTestProductToolchainReceipt } from './testProductToolchain.js';
import { StepFailure } from './stepFailure.js';
export function archiveStage(inputs) {
    return {
        stage: join(inputs.runnerTemp, inputs.stageName),
        archive: join(inputs.workspace, '.firehosepr-ci', 'handoff', inputs.archiveName),
        cwd: inputs.cwd,
    };
}
/** `rm -rf "$stage" "$archive"` then `mkdir -p "$stage" "$(dirname "$archive")"`. */
export function resetStage(stage) {
    rmSync(stage.stage, { recursive: true, force: true });
    rmSync(stage.archive, { recursive: true, force: true });
    mkdirSync(stage.stage, { recursive: true });
    mkdirSync(dirname(stage.archive), { recursive: true });
}
/**
 * `cp -R "$source" "$stage/"`, spawned rather than reimplemented: the products
 * are macOS bundles whose symlinks and resource forks `cp` preserves and a
 * hand-rolled recursive copy would not.
 */
export async function copyIntoStage(stage, source) {
    const copied = await runCommand('cp', ['-R', source, join(stage.stage, basename(source))], {
        cwd: stage.cwd,
    });
    if (copied.status !== 0) {
        throw new StepFailure(`::error::Could not stage ${source} for the iOS test product handoff.`);
    }
}
const headShaPattern = /^[a-f0-9]{40}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const jobPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export function validArchiveProducerProvenance(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return candidate.schema === 'firehosepr-ios-test-product-producer-v1'
        && headShaPattern.test(candidate.headSha ?? '')
        && positiveIntegerPattern.test(candidate.runId ?? '')
        && positiveIntegerPattern.test(candidate.runAttempt ?? '')
        && jobPattern.test(candidate.job ?? '');
}
export function readArchiveProducerProvenance(stage) {
    try {
        const parsed = JSON.parse(readFileSync(join(stage, 'producer-provenance.json'), 'utf8'));
        return validArchiveProducerProvenance(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
/**
 * Writes the exact-head marker and the toolchain manifest, seals the stage,
 * and proves the archive is non-empty. A consumer reads both files back before
 * it trusts the products, so a stage that cannot be stamped never becomes one.
 */
export async function sealArchive(stage, seal) {
    writeFileSync(join(stage.stage, 'exact-head-sha'), `${seal.headSha}\n`, 'utf8');
    if (seal.producer !== undefined) {
        if (!validArchiveProducerProvenance(seal.producer)
            || seal.producer.headSha !== seal.headSha) {
            throw new StepFailure('::error::Could not record valid test-product producer provenance.');
        }
        writeFileSync(join(stage.stage, 'producer-provenance.json'), `${JSON.stringify(seal.producer)}\n`, 'utf8');
    }
    await writeTestProductToolchainReceipt(join(stage.stage, 'toolchain.json'), seal.headSha);
    const sealed = await runCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stage.stage, stage.archive], { cwd: stage.cwd });
    if (sealed.status !== 0) {
        throw new StepFailure(`::error::Could not seal ${stage.archive}.`);
    }
    requireNonEmptyFile(stage.archive, `Sealed archive ${stage.archive} is empty.`);
}
/** The shell's `test -s <path>`: the path exists and holds at least one byte. */
export function requireNonEmptyFile(path, message) {
    let size = 0;
    try {
        size = statSync(path).size;
    }
    catch {
        size = 0;
    }
    if (size > 0)
        return;
    throw new StepFailure(`::error::${message}`);
}

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { runCommand } from './processRunner.ts';
import { writeTestProductToolchainReceipt } from './testProductToolchain.ts';
import { StepFailure } from './stepFailure.ts';

/**
 * Staging and sealing a `.zip` of compiled XCTest products for a cross-runner
 * handoff.
 *
 * Both producer jobs do the same three things: clear a staging directory, copy
 * the compiled products into it, then stamp it with the exact head it was
 * built from and the toolchain that built it before `ditto` seals it. The
 * consumer refuses an archive whose stamp does not match, so the stamp and the
 * archive must be written together — which is why this lives in one place
 * rather than beside each producer.
 *
 * Every command is spawned with an argument array, so a staging path or a head
 * SHA is data and can never be read as shell syntax.
 */

export interface ArchiveStage {
  /** The directory `ditto` seals, one level below the archive's root entry. */
  readonly stage: string;
  readonly archive: string;
  readonly cwd: string;
}

export function archiveStage(inputs: {
  readonly runnerTemp: string;
  readonly stageName: string;
  readonly workspace: string;
  readonly archiveName: string;
  readonly cwd: string;
}): ArchiveStage {
  return {
    stage: join(inputs.runnerTemp, inputs.stageName),
    archive: join(inputs.workspace, '.example-ci', 'handoff', inputs.archiveName),
    cwd: inputs.cwd,
  };
}

/** `rm -rf "$stage" "$archive"` then `mkdir -p "$stage" "$(dirname "$archive")"`. */
export function resetStage(stage: ArchiveStage): void {
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
export async function copyIntoStage(stage: ArchiveStage, source: string): Promise<void> {
  const copied = await runCommand('cp', ['-R', source, join(stage.stage, basename(source))], {
    cwd: stage.cwd,
  });
  if (copied.status !== 0) {
    throw new StepFailure(`::error::Could not stage ${source} for the iOS test product handoff.`);
  }
}

export interface ArchiveSeal {
  readonly headSha: string;
  /** Exact workflow producer identity, when the archive can cross runs. */
  readonly producer?: ArchiveProducerProvenance;
}

export interface ArchiveProducerProvenance {
  readonly schema: 'example-ios-test-product-producer-v1';
  readonly headSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly job: string;
}

const headShaPattern = /^[a-f0-9]{40}$/;
const positiveIntegerPattern = /^[1-9][0-9]*$/;
const jobPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function validArchiveProducerProvenance(
  value: unknown,
): value is ArchiveProducerProvenance {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ArchiveProducerProvenance>;
  return candidate.schema === 'example-ios-test-product-producer-v1'
    && headShaPattern.test(candidate.headSha ?? '')
    && positiveIntegerPattern.test(candidate.runId ?? '')
    && positiveIntegerPattern.test(candidate.runAttempt ?? '')
    && jobPattern.test(candidate.job ?? '');
}

export function readArchiveProducerProvenance(
  stage: string,
): ArchiveProducerProvenance | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stage, 'producer-provenance.json'), 'utf8'));
    return validArchiveProducerProvenance(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Writes the exact-head marker and the toolchain manifest, seals the stage,
 * and proves the archive is non-empty. A consumer reads both files back before
 * it trusts the products, so a stage that cannot be stamped never becomes one.
 */
export async function sealArchive(stage: ArchiveStage, seal: ArchiveSeal): Promise<void> {
  writeFileSync(join(stage.stage, 'exact-head-sha'), `${seal.headSha}\n`, 'utf8');
  if (seal.producer !== undefined) {
    if (!validArchiveProducerProvenance(seal.producer)
      || seal.producer.headSha !== seal.headSha) {
      throw new StepFailure('::error::Could not record valid test-product producer provenance.');
    }
    writeFileSync(
      join(stage.stage, 'producer-provenance.json'),
      `${JSON.stringify(seal.producer)}\n`,
      'utf8',
    );
  }
  await writeTestProductToolchainReceipt(join(stage.stage, 'toolchain.json'), seal.headSha);
  const sealed = await runCommand(
    'ditto',
    ['-c', '-k', '--sequesterRsrc', '--keepParent', stage.stage, stage.archive],
    { cwd: stage.cwd },
  );
  if (sealed.status !== 0) {
    throw new StepFailure(`::error::Could not seal ${stage.archive}.`);
  }
  requireNonEmptyFile(stage.archive, `Sealed archive ${stage.archive} is empty.`);
}

/** The shell's `test -s <path>`: the path exists and holds at least one byte. */
export function requireNonEmptyFile(path: string, message: string): void {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    size = 0;
  }
  if (size > 0) return;
  throw new StepFailure(`::error::${message}`);
}

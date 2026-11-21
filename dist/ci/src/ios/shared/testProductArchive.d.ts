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
export declare function archiveStage(inputs: {
    readonly runnerTemp: string;
    readonly stageName: string;
    readonly workspace: string;
    readonly archiveName: string;
    readonly cwd: string;
}): ArchiveStage;
/** `rm -rf "$stage" "$archive"` then `mkdir -p "$stage" "$(dirname "$archive")"`. */
export declare function resetStage(stage: ArchiveStage): void;
/**
 * `cp -R "$source" "$stage/"`, spawned rather than reimplemented: the products
 * are macOS bundles whose symlinks and resource forks `cp` preserves and a
 * hand-rolled recursive copy would not.
 */
export declare function copyIntoStage(stage: ArchiveStage, source: string): Promise<void>;
export interface ArchiveSeal {
    readonly headSha: string;
    /** Exact workflow producer identity, when the archive can cross runs. */
    readonly producer?: ArchiveProducerProvenance;
}
export interface ArchiveProducerProvenance {
    readonly schema: 'firehosepr-ios-test-product-producer-v1';
    readonly headSha: string;
    readonly runId: string;
    readonly runAttempt: string;
    readonly job: string;
}
export declare function validArchiveProducerProvenance(value: unknown): value is ArchiveProducerProvenance;
export declare function readArchiveProducerProvenance(stage: string): ArchiveProducerProvenance | null;
/**
 * Writes the exact-head marker and the toolchain manifest, seals the stage,
 * and proves the archive is non-empty. A consumer reads both files back before
 * it trusts the products, so a stage that cannot be stamped never becomes one.
 */
export declare function sealArchive(stage: ArchiveStage, seal: ArchiveSeal): Promise<void>;
/** The shell's `test -s <path>`: the path exists and holds at least one byte. */
export declare function requireNonEmptyFile(path: string, message: string): void;

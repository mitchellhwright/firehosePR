/**
 * A failure reported exactly as the shell reported it. `message` is the whole
 * line the shell printed, `::error::` prefix included when it had one, so a
 * converted step keeps producing the same annotation on the same stream, and
 * the step still exits non-zero.
 *
 * Kept apart from `stepIo.ts` so the pure decision modules can raise one
 * without importing anything that touches the filesystem.
 */
export declare class StepFailure extends Error {
    readonly stream: 'stdout' | 'stderr';
    /** The status the step exits with; `set -e` propagated the failing command's own. */
    readonly exitCode: number;
    /** An empty message reproduces a command that failed the step without printing anything. */
    constructor(message: string, stream?: 'stdout' | 'stderr', exitCode?: number);
}

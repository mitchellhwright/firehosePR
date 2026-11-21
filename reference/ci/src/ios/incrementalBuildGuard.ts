import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keeps a persistent derived-data directory from linking objects left by a
 * build that never finished.
 *
 * Xcode writes each object file as its compile job ends, but it saves a
 * target's incremental state (the Swift driver's build record and dependency
 * graph) only when the whole build finishes. A build killed in between — a
 * cancelled job, a runner shutdown — leaves objects compiled from its own
 * sources next to incremental state that still describes the build before it.
 * The next build trusts that state. A file whose source is unchanged is not
 * recompiled, even when its object on disk was compiled against a declaration
 * the killed build had and this revision does not, so the link fails on a
 * symbol no current source defines. Source modification times cannot catch
 * this: the file whose object is stale never changed.
 *
 * A marker in the derived-data directory brackets each build. It is written
 * before the build starts and removed only when the build exits on its own, so
 * a marker still present at the next start means the directory holds an
 * unfinished build, and the directory is emptied before Xcode reads it.
 */

export const BUILD_IN_PROGRESS_MARKER = '.example-build-in-progress';

export type GuardedBuildStart = 'reused' | 'discarded-interrupted-build';

/**
 * Prepares `derivedData` for one build: empties it when an earlier build in it
 * never finished, then records that a build is in progress. The marker is the
 * only evidence acted on, so a directory this guard never marked is never
 * emptied.
 */
export function beginGuardedBuild(derivedData: string, owner: string): GuardedBuildStart {
  const marker = join(derivedData, BUILD_IN_PROGRESS_MARKER);
  const interrupted = existsSync(marker);
  if (interrupted) rmSync(derivedData, { recursive: true, force: true });
  mkdirSync(derivedData, { recursive: true });
  writeFileSync(marker, `${owner}\n`, 'utf8');
  return interrupted ? 'discarded-interrupted-build' : 'reused';
}

/** Records that the build in `derivedData` finished and saved its incremental state. */
export function finishGuardedBuild(derivedData: string): void {
  rmSync(join(derivedData, BUILD_IN_PROGRESS_MARKER), { force: true });
}

/**
 * Whether a build ran to its own end. A status of 128 or more is a death by
 * signal, and a build this process was already tearing down may have exited
 * with any status; in both cases Xcode may not have saved its state.
 */
export function buildExitedOnItsOwn(status: number, terminating: boolean): boolean {
  return !terminating && status < 128;
}

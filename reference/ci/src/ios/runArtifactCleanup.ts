/**
 * Which of a finished run's artifacts are removed, and what the step reports.
 *
 * Every artifact an iOS run uploads is either an intra-run handoff or evidence
 * that only a failed run needs, and all of it bills against the same Actions
 * budget until retention expires it. Once every producer has finished without
 * failing, nothing can rerun against them, so the run deletes its own.
 *
 * The listing comes back from GitHub as JSON written by a previous job's
 * upload, so it is parsed defensively: an entry without a usable id is skipped
 * rather than turned into a request to a made-up URL.
 */

/**
 * The native selection record artifact, suffixed with the run attempt so a
 * rerun never collides with its own earlier upload. Kept here, free of
 * dependencies, because the cleanup program runs without installed packages.
 */
export const NATIVE_SELECTION_RECORD_ARTIFACT_PREFIX = 'ios-native-selection-record-';

/** A merge queue candidate's per-lane reused/executed record, kept for audit. */
export const QUEUE_EVIDENCE_REUSE_ARTIFACT_PREFIX = 'ios-queue-evidence-reuse-';

export interface RunArtifact {
  readonly id: number;
  readonly name: string;
  readonly sizeInBytes: number;
}

/** A run id reaches the artifact URLs, so it must be a plain number. */
export function isRunIdentifier(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * `.artifacts[] | select(.expired == false)`, as a function over the decoded
 * page, less the retained selection record. An artifact GitHub has already
 * expired is gone; asking for its deletion answers 404 and would fail the step.
 */
export function removableArtifacts(page: unknown): readonly RunArtifact[] {
  const listing = asRecord(page)?.['artifacts'];
  if (!Array.isArray(listing)) return [];
  const removable: RunArtifact[] = [];
  for (const entry of listing) {
    const artifact = asRecord(entry);
    if (artifact === undefined || artifact['expired'] === true) continue;
    const name = artifact['name'];
    // A later base update compares its re-planned selection with this record,
    // so it outlives the cleanup and expires on its own retention.
    if (typeof name === 'string' && name.startsWith(NATIVE_SELECTION_RECORD_ARTIFACT_PREFIX)) continue;
    if (typeof name === 'string' && name.startsWith(QUEUE_EVIDENCE_REUSE_ARTIFACT_PREFIX)) continue;
    const id = artifact['id'];
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue;
    removable.push({
      id,
      name: typeof name === 'string' ? name : String(id),
      sizeInBytes: typeof artifact['size_in_bytes'] === 'number' ? artifact['size_in_bytes'] : 0,
    });
  }
  return removable;
}

/** The page size the listing requests; a run never has more than a few dozen. */
export const artifactPageSize = 100;

/**
 * Whether to ask for another page. The step deletes every artifact it is
 * handed, so the next unseen artifact has moved onto the first page and the
 * walk re-reads that page rather than advancing an index past the gap the
 * deletions just made. A short page means there is nothing left.
 */
export function hasFurtherPage(pageLength: number): boolean {
  return pageLength >= artifactPageSize;
}

/** The hard stop `--paginate` never had: a listing that never goes short. */
export const artifactPassLimit = 50;

export function artifactListingUrl(apiUrl: string, repository: string, runId: string): string {
  return (
    `${apiUrl}/repos/${repository}/actions/runs/${runId}/artifacts?per_page=${artifactPageSize}`
  );
}

export function artifactDeletionUrl(apiUrl: string, repository: string, artifactId: number): string {
  return `${apiUrl}/repos/${repository}/actions/artifacts/${artifactId}`;
}

export function removalLine(artifact: RunArtifact): string {
  return `Removed ${artifact.name} (${artifact.sizeInBytes} bytes)`;
}

export function removalSummary(removed: number, runId: string): string {
  return `Removed ${removed} artifact(s) from run ${runId}.`;
}

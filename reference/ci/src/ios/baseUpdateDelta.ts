import { nameRegExp, workflowNames } from '../../../scripts/ci/generated/workflow-names.ts';
import { iosExecutionScopeChanged } from './iosExecutionInputs.ts';

export interface BaseUpdateComparisonFile {
  readonly filename?: string;
  readonly previous_filename?: string;
  readonly status?: string;
  readonly sha?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changes?: number;
  readonly patch?: string;
}

export interface BaseUpdateComparison {
  readonly status?: string;
  readonly merge_base_commit?: { readonly sha?: string };
  readonly files?: readonly BaseUpdateComparisonFile[];
}

export interface BaseUpdateCommit {
  readonly parents?: readonly { readonly sha?: string }[];
  readonly committer?: { readonly login?: string };
  readonly commit?: {
    readonly message?: string;
    readonly committer?: { readonly email?: string };
    readonly verification?: { readonly verified?: boolean; readonly reason?: string };
  };
}

export interface BaseUpdatePullRequest {
  readonly number: number;
  readonly base: { readonly ref: string };
}

export interface BaseUpdateWorkflowJob {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
}

interface PatchHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

interface EffectivePatchRecord {
  readonly filename: string;
  readonly previous_filename: string | undefined;
  readonly status: string | undefined;
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly changes: number | undefined;
  readonly patch: string;
  readonly hunks: readonly PatchHunk[];
}

const SHA = /^[a-f0-9]{40}$/;
const MAX_EFFECTIVE_PATCH_FILES = 300;
const IOS_TESTS = workflowNames['ios-tests'];
const IOS_EXECUTION_JOB = nameRegExp(IOS_TESTS.jobs['test-ios-execution']);
const IOS_REAL_SERVER_E2E_JOB = nameRegExp(IOS_TESTS.jobs['budget-e2e']);

type NamedComparisonFile = BaseUpdateComparisonFile & { readonly filename: string };

type EffectivePatchFile = NamedComparisonFile & {
  readonly status: string;
  readonly sha: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * A bounded file inventory in which every entry names its file. A missing or
 * non-object entry makes the whole inventory unusable rather than throwing.
 */
export function validCompleteFiles(
  files: readonly BaseUpdateComparisonFile[] | null | undefined,
): files is readonly NamedComparisonFile[] {
  return Array.isArray(files)
    && files.length < MAX_EFFECTIVE_PATCH_FILES
    && files.every((file) => nonEmptyString(file?.filename));
}

/**
 * A complete inventory whose every entry carries the metadata an effective
 * patch comparison relies on. `previous_filename` is required on a rename and,
 * when present anywhere else, must still be a path: a malformed value is
 * rejected rather than read as "no previous path".
 */
export function validEffectivePatchFiles(
  files: readonly BaseUpdateComparisonFile[] | null | undefined,
): files is readonly EffectivePatchFile[] {
  return validCompleteFiles(files)
    && files.every((file) => nonEmptyString(file.status)
      && SHA.test(file.sha ?? '')
      && Number.isInteger(file.additions)
      && Number.isInteger(file.deletions)
      && Number.isInteger(file.changes)
      && file.changes === (file.additions ?? Number.NaN) + (file.deletions ?? Number.NaN)
      && (file.previous_filename === undefined
        ? file.status !== 'renamed'
        : nonEmptyString(file.previous_filename)));
}

function normalizedPatch(file: BaseUpdateComparisonFile | undefined): {
  readonly patch: string;
  readonly hunks: readonly PatchHunk[];
} | null {
  if (typeof file?.patch !== 'string' || file.patch.length === 0) return null;
  const hunks: PatchHunk[] = [];
  let valid = true;
  let additions = 0;
  let deletions = 0;
  const patch = file.patch.split('\n').map((line) => {
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
    if (!line.startsWith('@@ ')) return line;
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (!match) {
      valid = false;
      return line;
    }
    const [, oldStartValue, oldCountValue = '1', newStartValue, newCountValue = '1', section = ''] = match;
    const hunk = {
      oldStart: Number.parseInt(oldStartValue ?? '', 10),
      oldCount: Number.parseInt(oldCountValue, 10),
      newStart: Number.parseInt(newStartValue ?? '', 10),
      newCount: Number.parseInt(newCountValue, 10),
    };
    if (Object.values(hunk).some((value) => !Number.isSafeInteger(value) || value < 0)
      || (hunk.oldCount === 0 && hunk.newCount === 0)) valid = false;
    hunks.push(hunk);
    return `@@ -,${oldCountValue} +,${newCountValue} @@${section}`;
  }).join('\n');
  return valid
    && hunks.length > 0
    && additions === file.additions
    && deletions === file.deletions
    ? { patch, hunks }
    : null;
}

function effectivePatchRecords(
  files: readonly BaseUpdateComparisonFile[] | null | undefined,
): readonly EffectivePatchRecord[] | null {
  if (!validEffectivePatchFiles(files)) return null;
  const records: EffectivePatchRecord[] = [];
  for (const file of files) {
    const normalized = normalizedPatch(file);
    if (!normalized) return null;
    records.push({
      filename: file.filename,
      previous_filename: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: normalized.patch,
      hunks: normalized.hunks,
    });
  }
  return records.sort((left, right) => {
    const leftKey = `${left.filename}\0${left.previous_filename ?? ''}`;
    const rightKey = `${right.filename}\0${right.previous_filename ?? ''}`;
    return leftKey.localeCompare(rightKey);
  });
}

/**
 * A base-independent identity for a file inventory's patch, or `null` when the
 * inventory is not a well-formed effective patch.
 */
export function effectivePatchFingerprint(
  files: readonly BaseUpdateComparisonFile[] | null | undefined,
): string | null {
  const records = effectivePatchRecords(files);
  return records === null
    ? null
    : JSON.stringify(records.map(({ hunks: _hunks, ...record }) => record));
}

function mappedHunkStart(hunk: PatchHunk, lineageHunks: readonly PatchHunk[]): number | null {
  const sourceStart = hunk.oldStart;
  const sourceEnd = sourceStart + Math.max(hunk.oldCount, 1);
  let shift = 0;
  let previousLineageEnd = 0;
  for (const lineageHunk of lineageHunks) {
    const lineageStart = lineageHunk.oldStart;
    const lineageEnd = lineageStart + Math.max(lineageHunk.oldCount, 1);
    if (lineageStart < previousLineageEnd) return null;
    previousLineageEnd = lineageEnd;
    if (Math.max(sourceStart, lineageStart) < Math.min(sourceEnd, lineageEnd)) return null;
    if (lineageEnd <= sourceStart) {
      shift += lineageHunk.newCount - lineageHunk.oldCount;
      continue;
    }
    if (lineageStart >= sourceEnd) break;
  }
  return sourceStart + shift;
}

/**
 * Whether two effective patches carry the same source edit. Omitting
 * `baseLineageComparison` compares them with no lineage remapping; passing
 * `null` (an unverified lineage) always fails.
 */
export function equivalentEffectivePatch(
  left: readonly BaseUpdateComparisonFile[] | null | undefined,
  right: readonly BaseUpdateComparisonFile[] | null | undefined,
  baseLineageComparison?: BaseUpdateComparison | null,
): boolean {
  const leftFingerprint = effectivePatchFingerprint(left);
  const rightFingerprint = effectivePatchFingerprint(right);
  if (leftFingerprint === null || leftFingerprint !== rightFingerprint) return false;
  const leftRecords = effectivePatchRecords(left);
  const rightRecords = effectivePatchRecords(right);
  if (!leftRecords || !rightRecords) return false;
  const lineageFiles = baseLineageComparison === undefined
    ? []
    : ['ahead', 'identical'].includes(baseLineageComparison?.status ?? '')
      && validEffectivePatchFiles(baseLineageComparison?.files)
      ? baseLineageComparison.files
      : null;
  if (!lineageFiles) return false;
  return leftRecords.every((leftRecord, fileIndex) => {
    const rightRecord = rightRecords[fileIndex];
    if (!rightRecord) return false;
    const recordPaths = new Set([
      rightRecord.filename,
      ...(rightRecord.previous_filename ? [rightRecord.previous_filename] : []),
    ]);
    const matchingLineage = lineageFiles.filter((file) => [file.filename, file.previous_filename]
      .some((path) => path !== undefined && recordPaths.has(path)));
    if (matchingLineage.length > 1) return false;
    let lineageHunks: readonly PatchHunk[] = [];
    if (matchingLineage.length === 1) {
      if (matchingLineage[0]?.status !== 'modified') return false;
      const normalizedLineage = normalizedPatch(matchingLineage[0]);
      if (!normalizedLineage) return false;
      lineageHunks = normalizedLineage.hunks;
    }
    return leftRecord.hunks.length === rightRecord.hunks.length
      && leftRecord.hunks.every((leftHunk, hunkIndex) => {
        const rightHunk = rightRecord.hunks[hunkIndex];
        return rightHunk !== undefined
          && mappedHunkStart(rightHunk, lineageHunks) === leftHunk.oldStart
          && leftHunk.newStart - leftHunk.oldStart === rightHunk.newStart - rightHunk.oldStart;
      });
  });
}

function isControllerBaseUpdateCommit({
  commit,
  pullRequest,
  firstParent,
  baseParent,
}: {
  readonly commit?: BaseUpdateCommit;
  readonly pullRequest: BaseUpdatePullRequest;
  readonly firstParent?: string;
  readonly baseParent?: string;
}): boolean {
  const expectedMessage = `chore: update PR #${pullRequest.number} from ${pullRequest.base.ref}`;
  const parents = commit?.parents;
  return commit?.commit?.message === expectedMessage
    && Array.isArray(parents)
    && parents.length === 2
    && SHA.test(parents[0]?.sha ?? '')
    && SHA.test(parents[1]?.sha ?? '')
    && (!firstParent || parents[0]?.sha === firstParent)
    && (!baseParent || parents[1]?.sha === baseParent)
    && parents[0]?.sha !== parents[1]?.sha;
}

export function isVerifiedNormalBaseUpdateCommit({
  commit,
  pullRequest,
  firstParent,
  baseParent,
}: {
  readonly commit?: BaseUpdateCommit;
  readonly pullRequest: BaseUpdatePullRequest;
  readonly firstParent?: string;
  readonly baseParent?: string;
}): boolean {
  const parents = commit?.parents;
  return Array.isArray(parents)
    && parents.length === 2
    && SHA.test(parents[0]?.sha ?? '')
    && SHA.test(parents[1]?.sha ?? '')
    && (!firstParent || parents[0]?.sha === firstParent)
    && (!baseParent || parents[1]?.sha === baseParent)
    && parents[0]?.sha !== parents[1]?.sha
    && commit?.committer?.login === 'web-flow'
    && commit.commit?.committer?.email === 'noreply@github.com'
    && commit.commit?.verification?.verified === true
    && commit.commit?.verification?.reason === 'valid'
    && commit.commit?.message !== `chore: update PR #${pullRequest.number} from ${pullRequest.base.ref}`;
}

export function isEligibleBaseUpdateCommit(options: {
  readonly commit?: BaseUpdateCommit;
  readonly pullRequest: BaseUpdatePullRequest;
  readonly firstParent?: string;
  readonly baseParent?: string;
}): boolean {
  return isControllerBaseUpdateCommit(options) || isVerifiedNormalBaseUpdateCommit(options);
}

/**
 * An identical base (`undefined`) has no lineage to invalidate iOS evidence;
 * any real base advancement must not change iOS execution inputs.
 */
export function isReusableIosBaseLineage(
  baseLineageComparison: BaseUpdateComparison | null | undefined,
): boolean {
  return baseLineageComparison === undefined
    || !iosExecutionScopeChanged(baseLineageComparison?.files);
}

/**
 * The completed job that constitutes reusable native iOS evidence, shared by
 * the classifier that defers to a run and the cancellation that retains one.
 */
export function isReusableIosLaneJob(job: BaseUpdateWorkflowJob | undefined): boolean {
  return job?.status === 'completed'
    && job.conclusion === 'success'
    && (IOS_EXECUTION_JOB.test(job.name ?? '')
      || IOS_REAL_SERVER_E2E_JOB.test(job.name ?? ''));
}

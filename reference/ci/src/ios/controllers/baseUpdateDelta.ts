import { appendFileSync, readFileSync } from 'node:fs';
import { QUEUE_REUSE_LANES } from '../queueEvidenceReuseRecord.ts';
import { iosProductVerifiedLineageFiles, isReusableIosWorkflowLineage, loadIosWorkflowInputProof,
  type IosWorkflowInputProof as EquivalentIosE2eProductInputs } from '../workflowEvidenceInputs.ts';
export { iosProductVerifiedLineageFiles } from '../workflowEvidenceInputs.ts';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import type {
  Commit, Comparison, ComparisonFile, EventPayload, GitHubJson, GitHubJsonReader,
  GitReference, RestPullRequest, TimelineEvent, WorkflowJob, WorkflowRun,
} from '../../../../scripts/ci/types/github.d.mts';

import { nameRegExp, workflowNames } from '../../../../scripts/ci/generated/workflow-names.ts';
import { createGithubReader, type GithubReaderOptions } from '../shared/githubRest.ts';
import { bindReplanRecord, type ReplanRecordBinding } from '../replanRecordBinding.ts';
import {
  iosBaseLineageReusePlan,
  iosExecutionScopeChangedPaths,
} from '../iosExecutionInputs.ts';
import {
  effectivePatchFingerprint,
  equivalentEffectivePatch,
  isEligibleBaseUpdateCommit,
  isReusableIosBaseLineage,
  isReusableIosLaneJob,
  isVerifiedNormalBaseUpdateCommit,
  validCompleteFiles,
  validEffectivePatchFiles,
} from '../baseUpdateDelta.ts';

// The classifier decides whether a predecessor's PR Checks evidence can be
// reused, so it matches runs by the name that definition renders.
const PR_CHECKS_WORKFLOW_NAME = workflowNames['pr-checks'].workflow;
// The aggregate job, matched the same way. A literal here is exactly what let
// the rename break this consumer silently: the workflow name was already read
// from the definition one line up while the job name beside it was spelled out.
// Runs that finished before the rename report the old name and no longer match,
// so the first classification after it falls back to full routing — one extra
// run, rather than a dual-name matcher that would outlive its own purpose.
const PR_CHECKS_VALIDATE_JOB = nameRegExp(workflowNames['pr-checks'].jobs.validate);
// The other workflow whose evidence this classifier reuses. A run reports the
// workflow name and a job reports its own, so the two are read from the two
// places the definition publishes them rather than from one shared spelling
// that happens to match today.
const IOS_TESTS = workflowNames['ios-tests'];
const IOS_TESTS_WORKFLOW_NAME = IOS_TESTS.workflow;
const IOS_AGGREGATE_JOB_NAME = IOS_TESTS.jobs['test-ios'].name;
const IOS_NATIVE_PRODUCTS_JOB_NAME = IOS_TESTS.jobs['build-ios-native-test-products'].name;
const IOS_E2E_PRODUCTS_JOB_NAME = IOS_TESTS.jobs['build-ios-e2e-test-products'].name;
const IOS_STOREKIT_JOB_NAME = IOS_TESTS.jobs['storekit-purchase-status'].name;
const IOS_DEV_E2E_SCHEMA_JOB_NAME = IOS_TESTS.jobs['prepare-dev-e2e-schema'].name;
const IOS_ONBOARDING_E2E_JOB_NAME = IOS_TESTS.jobs['onboarding-e2e-status'].name;
// Both lane families render one name per lane, so they are matched by the
// generated matcher, which carries the parenthesised suffix the job appends.
// `budget-e2e` is the suffixed real-server job; the fixed-suffix siblings
// (onboarding, chat-plaid, income) render the same shape and match it too.
const IOS_EXECUTION_JOB = nameRegExp(IOS_TESTS.jobs['test-ios-execution']);
// The two workflows whose completed jobs are worth reading back as evidence.

const EVIDENCE_WORKFLOW_NAMES: readonly string[] = [PR_CHECKS_WORKFLOW_NAME, IOS_TESTS_WORKFLOW_NAME];
// Which execution lanes carry reusable native evidence is this controller's
// decision, so the lane list stays here; only the name it is spliced into is
// the definition's.

const REUSABLE_IOS_EXECUTION_LANES: ReadonlySet<string> = new Set([
  'native1', 'native2', 'native3', 'native4', 'evidence-account-update',
  'evidence-account-update-2', 'evidence-visual',
]);

/** Synchronize events carry the head and base whose change they report. */
type SynchronizedPullRequest = RestPullRequest & {
  readonly number: number;
  readonly head: GitReference & { readonly sha: string };
  readonly base: GitReference & { readonly sha: string; readonly ref: string };
};

type SynchronizeEvent = EventPayload & { readonly pull_request?: SynchronizedPullRequest };

type JobsByRunId = Record<string, readonly WorkflowJob[]>;

/** A run whose id, attempt, and head SHA passed job-provenance validation. */
type ProvenWorkflowRun = WorkflowRun & {
  readonly id: number;
  readonly run_attempt: number;
  readonly head_sha: string;
};

interface ReusedIosEvidence {
  runId: number;
  runAttempt: number;
  headSha: string;
  jobIds: (number | undefined)[];
}

/** The exact successful run whose recorded selection a re-plan is compared with. */
interface ReplanEvidenceRun {
  runId: number;
  runAttempt: number;
  headSha: string;
}

interface WorkflowEvidence {
  reusable: boolean;
  successfulRun?: ReplanEvidenceRun;
  rerunIosLanes: (string | undefined)[];
  rerunIosAuxiliary?: string[];
  reuseNativeEvidence?: boolean;
  reusedIosEvidence?: ReusedIosEvidence;
  reusedE2eProducts?: { runId: number, runAttempt: number, headSha: string, producerJobId: number, inputDigest?: string };
  nativeEvidenceReusable?: boolean;
}

interface BaseUpdateDelta {
  priorHead: string;
  changedFiles: (string | undefined)[];
  deletedFiles?: string[];
  rerunIosLanes?: (string | undefined)[];
  rerunIosAuxiliary?: string[];
  reuseNativeEvidence?: boolean;
  reusedIosEvidence?: ReusedIosEvidence;
  reusedE2eProducts?: { runId: number, runAttempt: number, headSha: string, producerJobId: number, inputDigest: string };
  /** Set when a non-iOS workflow is routed by the base delta alone. */
  baseDeltaRoute?: BaseDeltaRoute;
  /** Set when the base changed only selection or controller code. */
  replanSelection?: ReplanEvidenceRun;
}

/**
 * A verified base update routes a non-iOS workflow by the paths the base
 * brought in. The pull request's own paths are carried separately for the
 * consumers that must still cover them, such as selected lint.
 */
interface BaseDeltaRoute {
  pullRequestFiles: string[];
  pullRequestDeletedFiles: string[];
}

const sha = /^[a-f0-9]{40}$/;
const MAX_EQUIVALENT_HEAD_SEARCH = 20;

export class UnusableComparisonError extends Error {

  constructor(message: string) {
    super(message);
    this.name = 'UnusableComparisonError';
  }
}

function validLineageComparison(comparison: Comparison | undefined, priorBaseSha: string | undefined): boolean {
  return comparison?.merge_base_commit?.sha === priorBaseSha
    && ['ahead', 'identical'].includes(comparison?.status ?? '')
    && validEffectivePatchFiles(comparison?.files);
}

function verifiedLineageOrIdentity(comparison: Comparison | undefined, priorBaseSha: string | undefined, currentBaseSha: string | undefined): Comparison | null | undefined {
  if (priorBaseSha === currentBaseSha) return undefined;
  return validLineageComparison(comparison, priorBaseSha) ? comparison : null;
}

export function isVerifiedPatchEquivalentBaseUpdate({
  pullRequest, commit, previousHead, priorBaseComparison,
  effectiveComparison, priorEffectiveComparison, baseLineageComparison, equivalentIosWorkflowInputs,
}: {
  pullRequest: SynchronizedPullRequest;
  commit: Commit | undefined;
  previousHead: string | undefined;
  priorBaseComparison: Comparison | undefined;
  effectiveComparison: Comparison | undefined;
  priorEffectiveComparison: Comparison | undefined;
  baseLineageComparison: Comparison | undefined;
  equivalentIosWorkflowInputs?: EquivalentIosE2eProductInputs;
}): boolean {
  const baseSha = pullRequest?.base?.sha;
  const oldBase = priorBaseComparison?.merge_base_commit?.sha;
  const repository = pullRequest?.base?.repo?.full_name;
  const lineage = verifiedLineageOrIdentity(baseLineageComparison, oldBase, baseSha);
  return typeof repository === 'string' && repository.length > 0
    && pullRequest?.head?.repo?.full_name === repository
    && isEligibleBaseUpdateCommit({
      commit, pullRequest, firstParent: previousHead, baseParent: baseSha,
    })
    && sha.test(oldBase ?? '')
    && effectiveComparison?.merge_base_commit?.sha === baseSha
    && ['ahead', 'identical'].includes(effectiveComparison?.status ?? '')
    && priorEffectiveComparison?.merge_base_commit?.sha === oldBase
    && ['ahead', 'identical'].includes(priorEffectiveComparison?.status ?? '')
    && lineage !== null
    && isReusableIosBaseLineage(lineage === undefined || lineage === null ? lineage : {
      ...lineage, files: iosProductVerifiedLineageFiles(lineage.files, equivalentIosWorkflowInputs,
        previousHead ?? '', pullRequest.head.sha),
    })
    && equivalentEffectivePatch(
      effectiveComparison?.files, priorEffectiveComparison?.files, lineage,
    );
}

// A verified base-only update may have no predecessor run for a workflow that
// the source patch never selected. In that case there is no result to reuse or
// wait for. Returning to the workflow's normal changed-file routing is safe:
// affected work runs again, while unrelated work remains skipped. This fast
// fallback is allowed when GitHub's complete comparisons prove that the source
// patch itself is unchanged across the base update. A GitHub-signed normal
// merge can also route its current effective patch when no predecessor run
// exists at all; no result is being reused in that case.

export function canFallBackWithoutPredecessorEvidence({
  pullRequest, commit, previousHead, priorBaseComparison,
  effectiveComparison, priorEffectiveComparison, baseLineageComparison,
  runs, timeline, workflows,
}: {
  pullRequest: SynchronizedPullRequest;
  commit: Commit | undefined;
  previousHead: string | undefined;
  priorBaseComparison: Comparison | undefined;
  effectiveComparison: Comparison | undefined;
  priorEffectiveComparison: Comparison | undefined;
  baseLineageComparison: Comparison | undefined;
  runs: readonly WorkflowRun[] | undefined;
  timeline: readonly TimelineEvent[] | undefined;
  workflows: readonly string[] | undefined;
}): boolean {
  const baseSha = pullRequest?.base?.sha;
  const oldBase = priorBaseComparison?.merge_base_commit?.sha;
  const lineage = verifiedLineageOrIdentity(baseLineageComparison, oldBase, baseSha);
  if (!isEligibleBaseUpdateCommit({
    commit, pullRequest, firstParent: previousHead, baseParent: baseSha,
  })
    || !sha.test(oldBase ?? '')
    || effectiveComparison?.merge_base_commit?.sha !== baseSha
    || !['ahead', 'identical'].includes(effectiveComparison?.status ?? '')
    || priorEffectiveComparison?.merge_base_commit?.sha !== oldBase
    || !['ahead', 'identical'].includes(priorEffectiveComparison?.status ?? '')
    || lineage === null
    || !isReusableIosBaseLineage(lineage)
    || !Array.isArray(runs)
    || !Array.isArray(timeline)
    || !Array.isArray(workflows) || workflows.length !== 1 || workflows[0] !== IOS_TESTS_WORKFLOW_NAME) return false;
  const baseChanges = timeline.filter(event => event?.event === 'base_ref_changed');
  if (baseChanges.some(event => typeof event?.created_at !== 'string'
    || Number.isNaN(Date.parse(event.created_at)))) return false;
  const sourcePatchUnchanged = equivalentEffectivePatch(
    effectiveComparison?.files, priorEffectiveComparison?.files, lineage,
  );
  const predecessorRunExists = runs.some(run => run?.name === IOS_TESTS_WORKFLOW_NAME
    && run?.head_sha === previousHead
    && Array.isArray(run?.pull_requests)
    && run.pull_requests.some((candidate: RestPullRequest) =>
      candidate?.number === pullRequest.number));
  if (!sourcePatchUnchanged
    && (!isVerifiedNormalBaseUpdateCommit({
      commit, pullRequest, firstParent: previousHead, baseParent: baseSha,
    }) || predecessorRunExists)) return false;
  return workflows.some(workflow => reusableRunState(
    runs, workflow, previousHead, pullRequest.number, baseChanges, pullRequest.base.ref,
  ) === 'unavailable');
}

interface PathInventory {
  changed: string[];
  deleted: string[];
}

/** Changed paths keep their current names; removals and rename sources are also deletions. */
function pathInventory(files: readonly ComparisonFile[]): PathInventory {
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const file of files) {
    if (typeof file.filename !== 'string' || file.filename.length === 0) continue;
    changed.add(file.filename);
    if (file.status === 'removed') deleted.add(file.filename);
    if (file.status === 'renamed' && typeof file.previous_filename === 'string'
      && file.previous_filename.length > 0) deleted.add(file.previous_filename);
  }
  return { changed: [...changed], deleted: [...deleted] };
}

/**
 * Prior validation covered the unchanged pull request patch on the old base.
 * Only the paths the base update changed can alter a lane's inputs, so those
 * are the paths the planner's impact model routes. Lanes they do not select
 * keep their evidence; lanes they do select run again on this head.
 */
function baseDeltaRoute(
  priorHead: string,
  deltaFiles: readonly ComparisonFile[],
  pullRequestPatch: readonly ComparisonFile[] | undefined,
): BaseUpdateDelta | null {
  if (!validEffectivePatchFiles(pullRequestPatch)) return null;
  const delta = pathInventory(deltaFiles);
  const pullRequest = pathInventory(pullRequestPatch);
  return {
    priorHead,
    changedFiles: delta.changed,
    ...(delta.deleted.length > 0 ? { deletedFiles: delta.deleted } : {}),
    baseDeltaRoute: {
      pullRequestFiles: pullRequest.changed,
      pullRequestDeletedFiles: pullRequest.deleted,
    },
  };
}

/**
 * The base changed only selection or controller code. The current gate
 * re-plans the unchanged patch with that code and may keep the prior run's
 * native lanes only when the new selection is covered by the one that run
 * recorded. A combined server-lane rerun or a failed predecessor has no single
 * recorded selection to compare with, so those keep full routing.
 */
function replanRoute(priorHead: string, { evidence, successfulIosEvidence, baseAuxiliaryReruns, effectiveComparison }: {
  evidence: readonly WorkflowEvidence[];
  successfulIosEvidence: WorkflowEvidence | undefined;
  baseAuxiliaryReruns: readonly string[];
  effectiveComparison: Comparison | undefined;
}): BaseUpdateDelta | null {
  const successfulRun = successfulIosEvidence?.successfulRun;
  if (successfulRun === undefined || baseAuxiliaryReruns.length > 0
    || evidence.some(result => result.rerunIosLanes.length > 0
      || (result.rerunIosAuxiliary ?? []).length > 0)) return null;
  const changedFiles = normalRoutingChangedFiles(effectiveComparison?.files);
  if (changedFiles === null) return null;
  return { priorHead, changedFiles, replanSelection: successfulRun };
}

export function normalRoutingChangedFiles(files: readonly ComparisonFile[] | undefined): (string | undefined)[] | null {
  if (!validEffectivePatchFiles(files)) return null;
  return [...new Set(files.flatMap(file => [
    file.filename,
    ...(file.status === 'renamed' ? [file.previous_filename] : []),
  ]))];
}

function isActiveRun(run: WorkflowRun | undefined): boolean {
  return ['queued', 'in_progress', 'pending', 'requested', 'waiting'].includes(run?.status ?? '');
}

export function activeEquivalentIosPredecessor({ runs, previousHead, pullRequest }: {
  runs: readonly WorkflowRun[] | undefined;
  previousHead: string | undefined;
  pullRequest: SynchronizedPullRequest;
}): WorkflowRun | null {
  return (Array.isArray(runs) ? runs : [])
    .filter(run => run?.name === IOS_TESTS_WORKFLOW_NAME
      && run?.head_sha === previousHead
      && Number.isInteger(run?.id)
      && isActiveRun(run)
      && Array.isArray(run?.pull_requests)
      && run.pull_requests.some((candidate: RestPullRequest) =>
        candidate?.number === pullRequest?.number
        && candidate?.base?.ref === pullRequest?.base?.ref)
      && typeof run?.created_at === 'string'
      && !Number.isNaN(Date.parse(run.created_at)))
    .sort((left, right) =>
      Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''))[0] ?? null;
}

// Same completed-evidence boundary cancelObsoleteIosRuns.ts's
// findRetainedPredecessorIds stops at: once a hop already has a completed,
// job-verified successful Test - iOS run, nothing older is worth deferring
// to, because cancellation will not retain an active run past that hop.

async function hasCompletedReusableIosSuccess({ runs, headSha, pullRequest, request, token }: {
  runs: readonly WorkflowRun[] | undefined;
  headSha: string | undefined;
  pullRequest: SynchronizedPullRequest;
  request: GitHubJsonReader;
  token: string | undefined;
}): Promise<boolean> {
  const successfulRuns = (Array.isArray(runs) ? runs : []).filter(run => run?.name === IOS_TESTS_WORKFLOW_NAME
    && run?.head_sha === headSha
    && run?.status === 'completed'
    && run?.conclusion === 'success'
    && Number.isInteger(run?.id)
    && Array.isArray(run?.pull_requests)
    && run.pull_requests.some((candidate: RestPullRequest) =>
      candidate?.number === pullRequest?.number
      && candidate?.base?.ref === pullRequest?.base?.ref));
  for (const run of successfulRuns) {
    const listing = await request(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`, token);
    if (Array.isArray(listing?.jobs) && listing.jobs.some(isReusableIosLaneJob)) return true;
  }
  return false;
}

// Keep the nearest active run as the legacy scalar, while retaining every
// active ancestor reached only through verified patch-equivalent base updates.

export async function findActiveEquivalentIosPredecessorChain({
  pullRequest, previousHead, runs, priorEffectiveComparison, request, token,
}: {
  pullRequest: SynchronizedPullRequest;
  previousHead: string;
  runs: readonly WorkflowRun[] | undefined;
  priorEffectiveComparison: Comparison | undefined;
  request: GitHubJsonReader;
  token: string | undefined;
}): Promise<WorkflowRun[]> {

  const retained: WorkflowRun[] = [];

  let candidateSha: string | undefined = previousHead;

  let candidateRuns: readonly WorkflowRun[] | undefined = runs;
  let candidatePatch = priorEffectiveComparison;
  for (let depth = 0; depth < MAX_EQUIVALENT_HEAD_SEARCH; depth += 1) {
    if (await hasCompletedReusableIosSuccess({
      runs: candidateRuns, headSha: candidateSha, pullRequest, request, token,
    })) return retained;
    const active = activeEquivalentIosPredecessor({ runs: candidateRuns, previousHead: candidateSha, pullRequest });
    if (active) retained.push(active);
    const candidateCommit = await request(`commits/${candidateSha}`, token);
    if (candidateCommit?.sha !== candidateSha
      || !isEligibleBaseUpdateCommit({ commit: candidateCommit, pullRequest })) return retained;
    let parentPatch;
    try {
      parentPatch = await loadEquivalentParentEffectiveComparison({
        candidateCommit, candidateEffectiveComparison: candidatePatch, request, token,
        preserveIosExecution: true,
      });
    } catch (error) {
      if (error instanceof UnusableComparisonError) return retained;
      throw error;
    }
    if (!parentPatch) return retained;
    candidateSha = candidateCommit.parents?.[0]?.sha;
    if (candidateSha === undefined) return retained;
    candidatePatch = parentPatch;
    candidateRuns = await loadWorkflowRunsForHead({ headSha: candidateSha, request, token });
  }
  throw new Error('Active iOS predecessor chain exceeded the verified ancestor limit.');
}

/**
 * A run belongs to the PR's current base when its own pull-request record
 * names that base, or when it was created after every recorded base-ref
 * change. The first form is the run's own evidence and needs no timeline.
 */
function runBelongsToCurrentBase(run: WorkflowRun, prNumber: number, baseChanges: readonly TimelineEvent[], baseRef: string | undefined): boolean {
  if (baseRef !== undefined && run.pull_requests?.some(pullRequest =>
    pullRequest?.number === prNumber && pullRequest?.base?.ref === baseRef)) return true;
  return baseChanges.every(event =>
    Date.parse(event.created_at ?? '') <= Date.parse(run.created_at ?? ''));
}

function matchingRuns(runs: readonly WorkflowRun[] | undefined, workflow: string, headSha: string | undefined, prNumber: number, baseChanges: readonly TimelineEvent[], baseRef: string | undefined): WorkflowRun[] {
  return Array.isArray(runs) ? runs.filter(run =>
    run?.name === workflow
    && run?.head_sha === headSha
    && Array.isArray(run?.pull_requests)
    && run.pull_requests.some((pullRequest: RestPullRequest) =>
      pullRequest?.number === prNumber)
    && typeof run?.created_at === 'string'
    && !Number.isNaN(Date.parse(run.created_at))
    && runBelongsToCurrentBase(run, prNumber, baseChanges, baseRef)
  ) : [];
}

function hasExactJobProvenance(run: WorkflowRun | undefined, jobs: readonly WorkflowJob[]): run is ProvenWorkflowRun {
  if (run?.id === undefined || !Number.isSafeInteger(run.id) || run.id <= 0
    || run.run_attempt === undefined
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0
    || !sha.test(run?.head_sha ?? '')) return false;
  const jobIds = new Set();
  return jobs.every(job => {
    if (job?.id === undefined || !Number.isSafeInteger(job.id) || job.id <= 0
      || jobIds.has(job.id)
      || job.run_id !== run.id
      || job.run_attempt !== run.run_attempt
      || job.head_sha !== run.head_sha) return false;
    jobIds.add(job.id);
    return true;
  });
}

function reusableWorkflowEvidence(runs: readonly WorkflowRun[] | undefined, jobsByRunId: JobsByRunId | undefined, workflow: string, headSha: string | undefined, prNumber: number, baseChanges: readonly TimelineEvent[], baseRef: string | undefined): WorkflowEvidence {
  const matching = matchingRuns(runs, workflow, headSha, prNumber, baseChanges, baseRef);
  const successfulRuns = matching.filter(run =>
    run.status === 'completed' && run.conclusion === 'success');
  if (workflow !== IOS_TESTS_WORKFLOW_NAME && successfulRuns.length > 0) {
    return { reusable: true, rerunIosLanes: [] };
  }
  if (workflow === IOS_TESTS_WORKFLOW_NAME) {
    const successfulRun = successfulRuns
      .sort((left, right) => Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''))
      .find(run => {
        if (run.id === undefined || !Number.isInteger(run.id)) return true;
        const jobs = jobsByRunId?.[run.id];
        return Array.isArray(jobs) && jobs.some(isReusableIosLaneJob);
      });
    if (successfulRun) {
      const jobs = successfulRun.id === undefined ? undefined : jobsByRunId?.[successfulRun.id];
      if (!Array.isArray(jobs) || jobs.length === 0
        || !hasExactJobProvenance(successfulRun, jobs)) {
        return { reusable: true, rerunIosLanes: [] };
      }
      const nativeProducer = jobs.find(job => (
        job.name === IOS_NATIVE_PRODUCTS_JOB_NAME
        && job.status === 'completed' && job.conclusion === 'success'
      ));
      const storekit = jobs.find(job => (
        job.name === IOS_STOREKIT_JOB_NAME
        && job.status === 'completed' && job.conclusion === 'success'
      ));
      const nativeLanes = jobs.filter(job => {
        const lane = IOS_EXECUTION_JOB.exec(job.name ?? '')?.groups?.suffix;
        return lane !== undefined && REUSABLE_IOS_EXECUTION_LANES.has(lane)
          && job.status === 'completed' && job.conclusion === 'success';
      });
      const e2eProducer = jobs.find(job => (
        job.name === IOS_E2E_PRODUCTS_JOB_NAME
        && job.status === 'completed' && job.conclusion === 'success'
      ));
      const nativeEvidenceReusable = nativeProducer !== undefined
        && storekit !== undefined
        && nativeLanes.length > 0;
      const reusableJobIds = [nativeProducer, storekit, ...nativeLanes]
        .flatMap(job => job?.id === undefined ? [] : [job.id]);
      return {
        reusable: true,
        rerunIosLanes: [],
        successfulRun: {
          runId: successfulRun.id,
          runAttempt: successfulRun.run_attempt,
          headSha: successfulRun.head_sha,
        },
        nativeEvidenceReusable,
        ...(nativeEvidenceReusable ? {
          reusedIosEvidence: {
            runId: successfulRun.id,
            runAttempt: successfulRun.run_attempt,
            headSha: successfulRun.head_sha,
            jobIds: reusableJobIds,
          },
        } : {}),
        ...(e2eProducer?.id === undefined ? {} : {
          reusedE2eProducts: {
            runId: successfulRun.id,
            runAttempt: successfulRun.run_attempt,
            headSha: successfulRun.head_sha,
            producerJobId: e2eProducer.id,
          },
        }),
      };
    }
  }
  if (workflow !== IOS_TESTS_WORKFLOW_NAME) return { reusable: false, rerunIosLanes: [] };
  const failedRun = matching
    .filter(run => run.status === 'completed' && run.conclusion === 'failure'
      && Number.isInteger(run.id))
    .sort((left, right) =>
      Date.parse(right.created_at ?? '') - Date.parse(left.created_at ?? ''))[0];
  const jobs = failedRun?.id === undefined ? null : jobsByRunId?.[failedRun.id];
  if (!Array.isArray(jobs) || jobs.length === 0
    || jobs.some(job => job?.status !== 'completed')) {
    return { reusable: false, rerunIosLanes: [] };
  }

  const rerunIosLanes: (string | undefined)[] = [];

  const auxiliaryFailures: (string | undefined)[] = [];

  const reusedJobIds: (number | undefined)[] = [];
  let nativeProducerPassed = false;
  let storeKitStatusPassed = false;
  let nativeEvidencePassed = false;
  for (const job of jobs) {
    if (job?.name === IOS_AGGREGATE_JOB_NAME) continue;
    const lane = IOS_EXECUTION_JOB.exec(job?.name ?? '')?.groups?.suffix;
    if (lane !== undefined && REUSABLE_IOS_EXECUTION_LANES.has(lane)) {
      if (!['success', 'skipped'].includes(job?.conclusion ?? '')) rerunIosLanes.push(lane);
      else if (job.conclusion === 'success') {
        nativeEvidencePassed = true;
        reusedJobIds.push(job.id);
      }
      continue;
    }
    if (job?.name === IOS_NATIVE_PRODUCTS_JOB_NAME
      && job.conclusion === 'success') {
      nativeProducerPassed = true;
      reusedJobIds.push(job.id);
      continue;
    }
    if (job?.name === IOS_STOREKIT_JOB_NAME && job.conclusion === 'success') {
      storeKitStatusPassed = true;
      reusedJobIds.push(job.id);
      continue;
    }
    if ([IOS_DEV_E2E_SCHEMA_JOB_NAME, IOS_ONBOARDING_E2E_JOB_NAME].includes(job?.name ?? '')
      && !['success', 'skipped'].includes(job?.conclusion ?? '')) {
      auxiliaryFailures.push(job.name);
      continue;
    }
    if (!['success', 'skipped'].includes(job?.conclusion ?? '')) {
      return { reusable: false, rerunIosLanes: [] };
    }
  }
  if (auxiliaryFailures.length > 0) {
    const rerunIosAuxiliary = auxiliaryFailures.includes(IOS_ONBOARDING_E2E_JOB_NAME)
      ? ['onboarding']
      : [];
    if (rerunIosAuxiliary.length === 0
      || !nativeProducerPassed || !storeKitStatusPassed || !nativeEvidencePassed
      || !hasExactJobProvenance(failedRun, jobs)) {
      return { reusable: false, rerunIosLanes: [] };
    }
    return {
      reusable: true,
      rerunIosLanes: [...new Set(rerunIosLanes)],
      rerunIosAuxiliary,
      reuseNativeEvidence: true,
      reusedIosEvidence: {
        runId: failedRun.id,
        runAttempt: failedRun.run_attempt,
        headSha: failedRun.head_sha,
        jobIds: reusedJobIds,
      },
    };
  }
  if (rerunIosLanes.length === 0) return { reusable: false, rerunIosLanes: [] };
  return { reusable: true, rerunIosLanes: [...new Set(rerunIosLanes)] };
}

function reusableRunState(runs: readonly WorkflowRun[] | undefined, workflow: string, headSha: string | undefined, prNumber: number, baseChanges: readonly TimelineEvent[], baseRef: string | undefined): 'success' | 'active' | 'terminal' | 'unavailable' {
  const matching = matchingRuns(runs, workflow, headSha, prNumber, baseChanges, baseRef);
  // Completed success is sufficient evidence on its own. A concurrent rerun or
  // reopen duplicate must not mask it, or the gate waits out its full timeout
  // for a run whose predecessor already succeeded.
  if (matching.some(run => run.status === 'completed' && run.conclusion === 'success')) return 'success';
  if (matching.some(isActiveRun)) return 'active';
  if (matching.some(run => run.status === 'completed')) return 'terminal';
  return 'unavailable';
}

/**
 * Read the previous head's runs once. Nothing waits for an unfinished
 * predecessor: it either finished before this read, in which case its
 * evidence is reused, or the head runs normally (PR Checks) or defers through
 * the marker job and resume handler (Test - iOS). Holding a runner to poll for
 * it only blocks the queue that run is waiting in.
 */
export async function observeReusableRuns({ input, runs, loadCurrentHead = async () => input.pullRequest.head.sha }: {
  input: { pullRequest: SynchronizedPullRequest };
  runs: readonly WorkflowRun[] | undefined;
  loadCurrentHead?: () => Promise<string | undefined>;
}): Promise<readonly WorkflowRun[] | null> {
  if (await loadCurrentHead() !== input.pullRequest.head.sha) return null;
  return Array.isArray(runs) ? runs : [];
}

// An incremental route is an optimization only. It is safe solely when GitHub
// identifies the preceding same-repository head and that head already completed
// the workflow whose expensive result is being reused. Controller-authored base
// merges additionally require the exact message and parent structure.

export function controllerBaseUpdateDelta({
  pullRequest, commit, comparison, priorBaseComparison, effectiveComparison, priorEffectiveComparison,
  baseLineageComparison,
  runs, jobsByRunId = {}, timeline, workflows, previousHead, equivalentIosE2eProductInputs,
}: {
  pullRequest: SynchronizedPullRequest;
  commit: Commit | undefined;
  comparison: Comparison | undefined;
  priorBaseComparison: Comparison | undefined;
  effectiveComparison?: Comparison;
  priorEffectiveComparison?: Comparison;
  baseLineageComparison?: Comparison;
  runs: readonly WorkflowRun[] | undefined;
  jobsByRunId?: JobsByRunId;
  timeline: readonly TimelineEvent[] | undefined;
  workflows: readonly string[] | undefined;
  previousHead: string | undefined;
  equivalentIosE2eProductInputs?: EquivalentIosE2eProductInputs;
}): BaseUpdateDelta | null {
  const headSha = pullRequest?.head?.sha;
  const baseSha = pullRequest?.base?.sha;
  const repository = pullRequest?.base?.repo?.full_name;
  if (!sha.test(headSha ?? '') || !sha.test(baseSha ?? '')
    || pullRequest?.head?.repo?.full_name !== repository
    || !Array.isArray(workflows) || workflows.length === 0) return null;
  if (!Array.isArray(timeline)) return null;
  const baseChanges = timeline.filter(event => event?.event === 'base_ref_changed');
  if (baseChanges.some(event => typeof event?.created_at !== 'string'
    || Number.isNaN(Date.parse(event.created_at)))) return null;
  if (commit?.sha !== headSha || previousHead === undefined || !sha.test(previousHead)
    || previousHead === headSha) return null;
  const controllerMessage = `chore: update PR #${pullRequest.number} from ${pullRequest.base.ref}`;
  const isControllerBaseUpdate = commit?.commit?.message === controllerMessage;
  const parents = commit?.parents;
  const hasExactBaseUpdateParents = Array.isArray(parents) && parents.length === 2
    && parents[0]?.sha === previousHead && parents[1]?.sha === baseSha
    && previousHead !== baseSha;
  // GitHub signs and attributes commits it authors itself (merges, the
  // "Update branch" button, PUT .../update-branch) to committer "web-flow"
  // with a verified, valid signature. isTrustedDependabotUpdate relies on the
  // same signal. A contributor's own locally signed merge can never match it,
  // so this lets a verified normal update stand in for the controller's own
  // custom-message merge without weakening provenance.
  const isVerifiedNormalBaseUpdate = !isControllerBaseUpdate && hasExactBaseUpdateParents
    && commit?.committer?.login === 'web-flow'
    && commit?.commit?.committer?.email === 'noreply@github.com'
    && commit?.commit?.verification?.verified === true
    && commit?.commit?.verification?.reason === 'valid';
  if (isControllerBaseUpdate) {
    if (!hasExactBaseUpdateParents) return null;
  } else if (!isVerifiedNormalBaseUpdate && (priorBaseComparison?.merge_base_commit?.sha !== baseSha
    || !['ahead', 'identical'].includes(priorBaseComparison?.status ?? ''))) {
    // A normal synchronize event contains only the contributor's new delta.
    // Reuse is safe only if the already-tested previous head also contained
    // the PR's current base. Controller base merges and verified normal
    // updates instead prove and include the base delta through their exact
    // two-parent shape above.
    return null;
  }
  const priorHead = previousHead;
  const evidence = workflows.map(workflow => reusableWorkflowEvidence(
    runs, jobsByRunId, workflow, priorHead, pullRequest.number, baseChanges, pullRequest.base.ref,
  ));
  if (evidence.some(result => !result.reusable)) return null;
  const files = comparison?.files;
  if (comparison?.merge_base_commit?.sha !== priorHead || comparison?.status !== 'ahead'
    || !validCompleteFiles(files)
    || files.some(file => typeof file?.filename !== 'string' || file.filename.length === 0)) return null;
  const hasEffectivePatchEvidence = effectiveComparison !== undefined
    || priorEffectiveComparison !== undefined;
  const routesIos = workflows.includes(IOS_TESTS_WORKFLOW_NAME);

  let baseLineagePlan: ReturnType<typeof iosBaseLineageReusePlan> | undefined;
  let baseLineageFiles: readonly ComparisonFile[] = [];
  if (hasEffectivePatchEvidence) {
    const priorEffectiveBaseSha = priorEffectiveComparison?.merge_base_commit?.sha;
    const lineage = verifiedLineageOrIdentity(
      baseLineageComparison, priorEffectiveBaseSha, baseSha,
    );
    baseLineagePlan = lineage === undefined || !routesIos
      ? { invalidatingPaths: [], replanPaths: [], changedFiles: [], rerunAuxiliary: [] }
      : iosBaseLineageReusePlan(iosProductVerifiedLineageFiles(
        lineage?.files, equivalentIosE2eProductInputs, priorHead, headSha,
      ));
    if (effectiveComparison?.merge_base_commit?.sha !== baseSha
      || !['ahead', 'identical'].includes(effectiveComparison?.status ?? '')
      || !sha.test(priorEffectiveBaseSha ?? '')
      || lineage === null
      || (routesIos
        && (baseLineagePlan === null || baseLineagePlan.invalidatingPaths.length > 0))
      || !equivalentEffectivePatch(
        effectiveComparison?.files, priorEffectiveComparison?.files, lineage,
      )) return null;
    baseLineageFiles = lineage?.files ?? [];
  }
  const trustedControllerInfrastructure = new Set([
    'ci/src/ios/controllers/baseUpdateDelta.ts',
    'scripts/controller-base-update-delta.mjs',
  ]);
  const selectedFiles = files.filter(file => (
    !isControllerBaseUpdate || !trustedControllerInfrastructure.has(file.filename)
  ));
  if (hasEffectivePatchEvidence && !routesIos) {
    // The verified lineage is everything the base brought in since the
    // evidence head; the head comparison adds any merge-commit residue.
    return baseDeltaRoute(
      priorHead, [...baseLineageFiles, ...selectedFiles], effectiveComparison?.files,
    );
  }
  const baseAuxiliaryReruns = baseLineagePlan?.rerunAuxiliary ?? [];
  const baseNeedsPartialIosReuse = baseAuxiliaryReruns.length > 0;
  const successfulIosEvidence = routesIos
    ? evidence[workflows.indexOf(IOS_TESTS_WORKFLOW_NAME)]
    : undefined;
  if (routesIos && (baseLineagePlan?.replanPaths.length ?? 0) > 0) {
    return replanRoute(priorHead, {
      evidence, successfulIosEvidence, baseAuxiliaryReruns, effectiveComparison,
    });
  }
  let retainedIosEvidence = evidence.find(result => result.reuseNativeEvidence === true);
  if (baseNeedsPartialIosReuse) {
    const productEvidence = successfulIosEvidence?.reusedE2eProducts;
    if (successfulIosEvidence?.nativeEvidenceReusable !== true
      || successfulIosEvidence.reusedIosEvidence === undefined
      || productEvidence === undefined
      || equivalentIosE2eProductInputs?.priorHead !== priorHead
      || equivalentIosE2eProductInputs.currentHead !== headSha
      || !/^[a-f0-9]{64}$/.test(equivalentIosE2eProductInputs.digest)) return null;
    retainedIosEvidence = {
      ...successfulIosEvidence,
      reuseNativeEvidence: true,
      reusedE2eProducts: {
        ...productEvidence,
        inputDigest: equivalentIosE2eProductInputs.digest,
      },
    };
  }
  if (retainedIosEvidence && !hasEffectivePatchEvidence) return null;
  const retainedPatchFiles = retainedIosEvidence && !baseNeedsPartialIosReuse
    ? normalRoutingChangedFiles(priorEffectiveComparison?.files)
    : null;
  if (retainedIosEvidence && !baseNeedsPartialIosReuse && retainedPatchFiles === null) return null;
  const changedFiles = baseNeedsPartialIosReuse
    ? [...(baseLineagePlan?.changedFiles ?? [])]
    : retainedPatchFiles !== null
    ? retainedPatchFiles
    : hasEffectivePatchEvidence
      ? []
      : selectedFiles.map(file => file.filename);
  const deletedFiles = hasEffectivePatchEvidence ? [] : selectedFiles.flatMap(file => {
    if (file.status === 'removed') return [file.filename];
    if (file.status === 'renamed' && typeof file.previous_filename === 'string'
      && file.previous_filename.length > 0) return [file.previous_filename];
    return [];
  });
  const rerunIosLanes = [...new Set(evidence.flatMap(result => result.rerunIosLanes))];
  const rerunIosAuxiliary = [...new Set(evidence.flatMap(
    result => result.rerunIosAuxiliary ?? [],
  ).concat(baseAuxiliaryReruns))];
  return {
    priorHead,
    changedFiles,
    ...(deletedFiles.length > 0 ? { deletedFiles } : {}),
    ...(rerunIosLanes.length > 0 ? { rerunIosLanes } : {}),
    ...(rerunIosAuxiliary.length > 0 ? { rerunIosAuxiliary } : {}),
    ...(retainedIosEvidence ? {
      reuseNativeEvidence: true,
      reusedIosEvidence: retainedIosEvidence.reusedIosEvidence,
      ...(baseNeedsPartialIosReuse && retainedIosEvidence.reusedE2eProducts?.inputDigest
        ? {
          reusedE2eProducts: {
            ...retainedIosEvidence.reusedE2eProducts,
            inputDigest: retainedIosEvidence.reusedE2eProducts.inputDigest,
          },
        }
        : {}),
    } : {}),
  };
}

export async function githubJson(path: string, token: string | undefined, options: {
  readonly apiUrl?: string;
  readonly repository?: string;
  readonly fallbackToken?: string;
  readonly fetchImpl?: GithubReaderOptions['fetchImpl'];
  readonly warn?: GithubReaderOptions['warn'];
} = {}): Promise<GitHubJson> {
  const fallback = options.fallbackToken ?? process.env.GITHUB_FALLBACK_TOKEN;
  // The Promotion Checkpoint App intentionally has repository metadata access,
  // but no Actions permission. Actions evidence therefore uses only the
  // per-run token and must remain unavailable rather than being replaced by a
  // misleading empty result.
  const actionsPath = path.startsWith('actions/');
  const tokens = [token, ...(actionsPath ? [] : [fallback])]
    .filter((value, index, values): value is string =>
      typeof value === 'string' && value.length > 0 && values.indexOf(value) === index);
  if (tokens.length === 0) throw new Error(`GitHub API ${path} has no available token.`);
  const read = createGithubReader({
    tokens,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.warn ? { warn: options.warn } : {}),
  });
  const apiUrl = options.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const repository = options.repository ?? process.env.GITHUB_REPOSITORY;
  const url = `${apiUrl}/repos/${repository}/${path}`;
  const response = await read(url);
  if (response.status === 200 && response.body !== undefined) return response.body as GitHubJson;
  if ([403, 429].includes(response.status)) throw new GitHubQuotaError(path, response.status);
  throw new Error(`GitHub API ${path} failed with HTTP ${response.status}.`);
}

export class GitHubQuotaError extends Error {

  constructor(path: string, status: number) {
    super(`GitHub API ${path} is quota-limited (HTTP ${status}).`);
    this.name = 'GitHubQuotaError';
  }
}

export function controllerFailurePolicy(error: Error): { exitCode: number, message: string } {
  if (error instanceof GitHubQuotaError) {
    return {
      exitCode: 0,
      message: `${error.message} Retaining full workflow routing instead of blocking the pull request.`,
    };
  }
  return { exitCode: 1, message: error.message };
}

async function githubPages<TItem>(path: string, token: string | undefined, request: (path: string, token: string | undefined) => Promise<unknown>): Promise<TItem[]> {

  const items: TItem[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await request(`${path}${separator}per_page=100&page=${page}`, token);
    if (!Array.isArray(batch)) throw new Error(`GitHub API ${path} returned an invalid page.`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(`GitHub API ${path} exceeded the pagination limit.`);
}

async function githubCompleteComparison(path: string, token: string | undefined, request: GitHubJsonReader): Promise<Comparison> {
  const comparison = await request(path, token);
  if (!comparison || !validEffectivePatchFiles(comparison.files)) {
    throw new UnusableComparisonError(`GitHub API ${path} returned an incomplete comparison.`);
  }
  return comparison;
}

async function loadVerifiedLineageComparison({ priorSha, currentSha, request, token }: {
  priorSha: string | undefined;
  currentSha: string | undefined;
  request: GitHubJsonReader;
  token: string | undefined;
}): Promise<Comparison> {
  if (priorSha === undefined || currentSha === undefined
    || !sha.test(priorSha) || !sha.test(currentSha)) {
    throw new UnusableComparisonError('GitHub returned an invalid base lineage endpoint.');
  }
  if (priorSha === currentSha) {
    return { status: 'identical', merge_base_commit: { sha: priorSha }, files: [] };
  }
  const comparison = await githubCompleteComparison(
    `compare/${priorSha}...${currentSha}`, token, request,
  );
  if (!validLineageComparison(comparison, priorSha)) {
    throw new UnusableComparisonError(
      `GitHub returned an unusable ${priorSha.slice(0, 12)}...${currentSha.slice(0, 12)} base lineage.`,
    );
  }
  return comparison;
}

async function loadEquivalentParentEffectiveComparison({
  candidateCommit, candidateEffectiveComparison, request, token,
  preserveIosExecution = false,
}: {
  candidateCommit: Commit | undefined;
  candidateEffectiveComparison: Comparison | undefined;
  request: GitHubJsonReader;
  token: string | undefined;
  preserveIosExecution?: boolean;
}): Promise<Comparison | null> {
  const parent0 = candidateCommit?.parents?.[0]?.sha;
  const parent1 = candidateCommit?.parents?.[1]?.sha;
  if (!sha.test(parent0 ?? '') || !sha.test(parent1 ?? '')) return null;
  const parentBaseComparison = await request(`compare/${parent1}...${parent0}`, token);
  const oldBase = parentBaseComparison?.merge_base_commit?.sha;
  if (!sha.test(oldBase ?? '')) {
    throw new UnusableComparisonError('GitHub returned no merge base for a chained base-update parent.');
  }
  const [parentEffectiveComparison, parentBaseLineageComparison] = await Promise.all([
    githubCompleteComparison(`compare/${oldBase}...${parent0}`, token, request),
    loadVerifiedLineageComparison({ priorSha: oldBase, currentSha: parent1, request, token }),
  ]);
  if (parentEffectiveComparison.merge_base_commit?.sha !== oldBase
    || !['ahead', 'identical'].includes(parentEffectiveComparison.status ?? '')) {
    throw new UnusableComparisonError('GitHub returned an unusable chained parent comparison.');
  }
  if (preserveIosExecution && !await isReusableIosWorkflowLineage({
    comparison: parentBaseLineageComparison, priorHead: parent0!, currentHead: candidateCommit!.sha!,
    read: (path) => request(path, token),
  })) {
    return null;
  }
  return equivalentEffectivePatch(
    candidateEffectiveComparison?.files,
    parentEffectiveComparison.files,
    parentBaseLineageComparison,
  )
    ? parentEffectiveComparison
    : null;
}

async function loadWorkflowRunsForHead({ headSha, request, token }: {
  headSha: string;
  request: GitHubJsonReader;
  token: string | undefined;
}): Promise<readonly WorkflowRun[]> {
  const listing = await request(`actions/runs?event=pull_request&head_sha=${headSha}&per_page=100`, token);
  if (!Array.isArray(listing?.workflow_runs)) {
    throw new Error(`GitHub API actions/runs returned no workflow evidence for ${headSha.slice(0, 12)}.`);
  }
  return listing.workflow_runs;
}

/**
 * Proves that the predecessor and current head have identical compiled iOS
 * product inputs. Complete recursive Git trees feed the typed allowlist of iOS
 * sources, build scripts and Test - iOS programs. The archive itself remains
 * bound to the predecessor head and exact Xcode build.
 */
export async function loadEquivalentIosE2eProductInputs({ priorHead, currentHead, request, token }: {
  priorHead: string; currentHead: string; request: GitHubJsonReader; token: string | undefined;
}): Promise<EquivalentIosE2eProductInputs | null> {
  return loadIosWorkflowInputProof({ priorHead, currentHead, read: (path) => request(path, token) });
}

export async function findEquivalentPatchHead({
  pullRequest, currentCommit, previousHead, priorBaseComparison, initialPriorEffectiveComparison,
  currentEffectiveComparison, currentBaseLineageComparison, comparison,
  runs, jobsByRunId, timeline, workflows, request, token,
}: {
  pullRequest: SynchronizedPullRequest;
  currentCommit: Commit | undefined;
  previousHead: string;
  priorBaseComparison: Comparison | undefined;
  initialPriorEffectiveComparison: Comparison | undefined;
  currentEffectiveComparison: Comparison | undefined;
  currentBaseLineageComparison: Comparison | undefined;
  comparison: Comparison | undefined;
  runs: readonly WorkflowRun[] | undefined;
  jobsByRunId: JobsByRunId;
  timeline: readonly TimelineEvent[];
  workflows: readonly string[];
  request: GitHubJsonReader;
  token: string | undefined;
}): Promise<BaseUpdateDelta | null> {
  if (!isEligibleBaseUpdateCommit({
    commit: currentCommit, pullRequest, firstParent: previousHead, baseParent: pullRequest.base.sha,
  })) return null;
  if (effectivePatchFingerprint(currentEffectiveComparison?.files) === null) return null;

  let candidateSha: string | undefined = previousHead;

  let candidateRuns: readonly WorkflowRun[] | undefined = runs;

  let carriedEffectiveComparison: Comparison | undefined;

  let candidateCommit: Commit | undefined;
  for (let depth = 0; depth < MAX_EQUIVALENT_HEAD_SEARCH; depth += 1) {
    candidateCommit = await request(`commits/${candidateSha}`, token);
    if (candidateCommit?.sha !== candidateSha) return null;
    const isImmediateCandidate = candidateSha === previousHead && !carriedEffectiveComparison;
    if (!carriedEffectiveComparison && !isImmediateCandidate
      && !isEligibleBaseUpdateCommit({ commit: candidateCommit, pullRequest })) return null;
    const candidateBaseSha = carriedEffectiveComparison?.merge_base_commit?.sha
      ?? (isImmediateCandidate
        ? priorBaseComparison?.merge_base_commit?.sha
        : candidateCommit.parents?.[1]?.sha);
    if (!sha.test(candidateBaseSha ?? '')) return null;
    const candidateBaseLineageComparison = isImmediateCandidate
      && currentBaseLineageComparison !== undefined
      ? currentBaseLineageComparison
      : await loadVerifiedLineageComparison({
        priorSha: candidateBaseSha,
        currentSha: pullRequest.base.sha,
        request,
        token,
      });
    if (!validLineageComparison(candidateBaseLineageComparison, candidateBaseSha)) return null;
    let equivalentIosE2eProductInputs: EquivalentIosE2eProductInputs | null | undefined;
    if (workflows.includes(IOS_TESTS_WORKFLOW_NAME)
      && candidateBaseLineageComparison.files?.some((file) => file.filename === '.github/workflows/ios-tests.yml')) {
      equivalentIosE2eProductInputs = await loadEquivalentIosE2eProductInputs({
        priorHead: candidateSha, currentHead: pullRequest.head.sha, request, token,
      });
    }
    const candidateLineagePlan = iosBaseLineageReusePlan(iosProductVerifiedLineageFiles(
      candidateBaseLineageComparison.files, equivalentIosE2eProductInputs ?? undefined,
      candidateSha, pullRequest.head.sha,
    ));
    if (workflows.includes(IOS_TESTS_WORKFLOW_NAME)
      && (candidateLineagePlan === null || candidateLineagePlan.invalidatingPaths.length > 0)) return null;
    let candidateEffectiveComparison = carriedEffectiveComparison;
    if (!candidateEffectiveComparison) {
      if (isImmediateCandidate && initialPriorEffectiveComparison !== undefined) {
        candidateEffectiveComparison = initialPriorEffectiveComparison;
      } else {
        candidateEffectiveComparison = await githubCompleteComparison(
          `compare/${candidateBaseSha}...${candidateSha}`, token, request,
        );
      }
      if (candidateEffectiveComparison.merge_base_commit?.sha !== candidateBaseSha
        || !['ahead', 'identical'].includes(candidateEffectiveComparison.status ?? '')) return null;
    }
    if (equivalentEffectivePatch(
      currentEffectiveComparison?.files, candidateEffectiveComparison.files,
      candidateBaseLineageComparison,
    )) {
      if (candidateRuns === undefined) {
        candidateRuns = await loadWorkflowRunsForHead({ headSha: candidateSha, request, token });
      }
      const candidateJobs = candidateSha === previousHead
        ? jobsByRunId
        : await loadCompletedWorkflowJobs({
          runs: candidateRuns, workflows, previousHead: candidateSha,
          prNumber: pullRequest.number, baseRef: pullRequest.base.ref,
          baseChanges: timeline.filter(event => event?.event === 'base_ref_changed'),
          request, token,
        });
      const candidateIsBaseUpdate = isEligibleBaseUpdateCommit({ commit: candidateCommit, pullRequest });
      if (workflows.includes(PR_CHECKS_WORKFLOW_NAME) && !hasSuccessfulValidationJob({
        runs: candidateRuns, baseRef: pullRequest.base.ref, jobsByRunId: candidateJobs, previousHead: candidateSha,
        prNumber: pullRequest.number,
        baseChanges: timeline.filter(event => event?.event === 'base_ref_changed'),
      })) {
        if (!candidateIsBaseUpdate) return null;
        const parentEffectiveComparison = await loadEquivalentParentEffectiveComparison({
          candidateCommit, candidateEffectiveComparison, request, token,
          preserveIosExecution: workflows.includes(IOS_TESTS_WORKFLOW_NAME),
        });
        if (!parentEffectiveComparison) return null;
        candidateSha = candidateCommit.parents?.[0]?.sha;
        if (candidateSha === undefined || !sha.test(candidateSha)) return null;
        candidateRuns = undefined;
        carriedEffectiveComparison = parentEffectiveComparison;
        continue;
      }
      const syntheticCommit = {
        ...currentCommit,
        parents: [{ sha: candidateSha }, { sha: pullRequest.base.sha }],
      };
      equivalentIosE2eProductInputs ??= workflows.includes(IOS_TESTS_WORKFLOW_NAME)
        && candidateLineagePlan !== null
        && candidateLineagePlan.rerunAuxiliary.length > 0
        ? await loadEquivalentIosE2eProductInputs({
          priorHead: candidateSha,
          currentHead: pullRequest.head.sha,
          request,
          token,
        })
        : undefined;
      const result = controllerBaseUpdateDelta({
        pullRequest, commit: syntheticCommit,
        comparison: { ...comparison, status: 'ahead', merge_base_commit: { sha: candidateSha }, files: [] },
        priorBaseComparison: { status: 'ahead', merge_base_commit: { sha: pullRequest.base.sha } },
        effectiveComparison: currentEffectiveComparison,
        priorEffectiveComparison: candidateEffectiveComparison,
        baseLineageComparison: candidateBaseLineageComparison,
        runs: candidateRuns, jobsByRunId: candidateJobs, timeline, workflows,
        previousHead: candidateSha,
        ...(equivalentIosE2eProductInputs ? { equivalentIosE2eProductInputs } : {}),
      });
      if (result) return result;
      if (candidateIsBaseUpdate) {
        const parentEffectiveComparison = await loadEquivalentParentEffectiveComparison({
          candidateCommit, candidateEffectiveComparison, request, token,
          preserveIosExecution: workflows.includes(IOS_TESTS_WORKFLOW_NAME),
        });
        if (!parentEffectiveComparison) return null;
        candidateSha = candidateCommit.parents?.[0]?.sha;
        if (candidateSha === undefined || !sha.test(candidateSha)) return null;
        candidateRuns = undefined;
        carriedEffectiveComparison = parentEffectiveComparison;
        continue;
      }
    }
    candidateSha = candidateCommit.parents?.[0]?.sha;
    if (candidateSha === undefined || !sha.test(candidateSha)) return null;
    candidateRuns = undefined;
    carriedEffectiveComparison = undefined;
  }
  return null;
}

/** An unreadable job history proves no record attempt, so the re-plan reports no record. */
async function bindReplanRecordOrFailClosed(
  run: ReplanEvidenceRun,
  request: GitHubJsonReader,
  token: string | undefined,
): Promise<ReplanRecordBinding> {
  try {
    return await bindReplanRecord({ ...run, request, token });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`${reason} The re-plan has no provable selection record.`);
    return { recordAttempt: null, detail: 'jobs-unavailable', successfulJobs: [] };
  }
}

function namedPaths(paths: readonly string[]): string {
  return paths.length <= 10
    ? paths.join(', ')
    : `${paths.slice(0, 10).join(', ')} (+${paths.length - 10} more)`;
}

/** Selection-only base changes are re-planned; execution changes discard evidence. */
export function lineageChangeMessage(plan: ReturnType<typeof iosBaseLineageReusePlan>): string {
  if (plan === null) {
    return 'Target branch changed iOS execution inputs (an incomplete target-branch change '
      + 'inventory); prior iOS evidence cannot be reused.';
  }
  if (plan.invalidatingPaths.length > 0) {
    return `Target branch changed iOS execution inputs (${namedPaths(plan.invalidatingPaths)}); `
      + 'prior iOS evidence cannot be reused.';
  }
  return `Target branch changed iOS selection or controller code (${namedPaths(plan.replanPaths)}); `
    + 'the selection is re-planned against the prior run\'s recorded selection.';
}

function writeOutput(key: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const delimiter = `CONTROLLER_BASE_UPDATE_${process.env.GITHUB_RUN_ID ?? 'local'}_${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`;
  appendFileSync(output, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export async function loadCompletedWorkflowJobs({ runs, workflows, previousHead, prNumber, baseChanges, baseRef, request, token }: {
  runs: readonly WorkflowRun[] | undefined;
  workflows: readonly string[];
  previousHead: string | undefined;
  prNumber: number;
  baseChanges: readonly TimelineEvent[];
  baseRef: string | undefined;
  request: GitHubJsonReader;
  token: string | undefined;
}): Promise<JobsByRunId> {
  const evidenceWorkflows = workflows.filter(
    workflow => EVIDENCE_WORKFLOW_NAMES.includes(workflow)
  );
  const completedRuns = evidenceWorkflows.flatMap(workflow => matchingRuns(
    runs, workflow, previousHead, prNumber, baseChanges, baseRef,
  )).filter(run => run.status === 'completed' && Number.isInteger(run.id));

  const entries: [PropertyKey, readonly WorkflowJob[]][] = await Promise.all(completedRuns.map(async run => {
    const listing = await request(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`, token);
    if (run.id === undefined || !Number.isInteger(listing?.total_count)
      || !listing.jobs || listing.total_count !== listing.jobs.length) {
      throw new Error(`GitHub returned incomplete workflow job evidence for run ${run.id}.`);
    }
    return [run.id, listing.jobs];
  }));
  return Object.fromEntries(entries);
}

/**
 * Load completed-job evidence once. Incomplete or failed evidence yields no
 * reusable jobs, so the head keeps full routing; it never retries on a runner.
 */
export async function loadWorkflowJobEvidence({ loadJobs, loadCurrentHead, expectedHead }: {
  loadJobs: () => Promise<JobsByRunId>;
  loadCurrentHead: () => Promise<string | undefined>;
  expectedHead: string;
}): Promise<JobsByRunId | null> {

  let jobs: JobsByRunId;
  try {
    jobs = await loadJobs();
  } catch (error) {
    if (await loadCurrentHead() !== expectedHead) return null;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`${reason} Retaining full workflow routing.`);
    return {};
  }
  if (await loadCurrentHead() !== expectedHead) return null;
  return jobs;
}

// Retain the original export for callers that only need iOS evidence.
export const loadCompletedIosJobs = loadCompletedWorkflowJobs;

export function hasSuccessfulValidationJob({ runs, jobsByRunId, previousHead, prNumber, baseChanges, baseRef }: {
  runs: readonly WorkflowRun[] | undefined;
  jobsByRunId: JobsByRunId | undefined;
  previousHead: string | undefined;
  prNumber: number;
  baseChanges: readonly TimelineEvent[];
  baseRef: string | undefined;
}): boolean {
  return matchingRuns(runs, PR_CHECKS_WORKFLOW_NAME, previousHead, prNumber, baseChanges, baseRef)
    .filter(run => run.status === 'completed' && run.conclusion === 'success' && Number.isInteger(run.id))
    .some(run => {
      const jobs = run.id === undefined ? undefined : jobsByRunId?.[run.id];
      return Array.isArray(jobs) && jobs.some(job =>
        typeof job?.name === 'string' && PR_CHECKS_VALIDATE_JOB.test(job.name)
        && job?.status === 'completed' && job?.conclusion === 'success');
    });
}

/**
 * The event body is this controller's only input, so a workflow that forgot to
 * hand it over is a configuration error rather than something to guess around.
 */
function requiredEventPath(): string {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required.');
  return eventPath;
}

export async function main({ event = JSON.parse(readFileSync(requiredEventPath(), 'utf8')), token = process.env.GITHUB_TOKEN, workflows = String(process.env.CONTROLLER_BASE_UPDATE_WORKFLOWS ?? '').split(',').map(value => value.trim()).filter(Boolean), request = githubJson }: {
  event?: SynchronizeEvent;
  token?: string | undefined;
  workflows?: readonly string[];
  request?: GitHubJsonReader;
} = {}) {
  const pullRequest = event?.pull_request;
  const previousHead = event?.before;
  if (event?.action !== 'synchronize' || !pullRequest || !token
    || previousHead === undefined || !sha.test(previousHead)) return null;
  const commit = await request(`commits/${pullRequest.head.sha}`, token);
  const currentIsBaseUpdate = commit?.sha === pullRequest.head.sha
    && isEligibleBaseUpdateCommit({
      commit, pullRequest, firstParent: previousHead, baseParent: pullRequest.base.sha,
    });

  let comparison: Comparison;

  let priorBaseComparison: Comparison;

  let listing: GitHubJson;

  let timeline: TimelineEvent[];
  try {
    [comparison, priorBaseComparison, listing, timeline] = await Promise.all([
      githubCompleteComparison(`compare/${previousHead}...${pullRequest.head.sha}`, token, request),
      request(`compare/${pullRequest.base.sha}...${previousHead}`, token),
      request(`actions/runs?event=pull_request&head_sha=${previousHead}&per_page=100`, token),
      githubPages<TimelineEvent>(`issues/${pullRequest.number}/timeline`, token, request),
    ]);
  } catch (error) {
    if (error instanceof UnusableComparisonError) {
      console.warn(`${error.message} Retaining full workflow routing.`);
      return null;
    }
    throw error;
  }

  let effectiveComparison: Comparison | undefined;

  let priorEffectiveComparison: Comparison | undefined;

  let baseLineageComparison: Comparison | undefined;
  try {
    if (currentIsBaseUpdate) {
      const oldBase = priorBaseComparison?.merge_base_commit?.sha;
      if (sha.test(oldBase ?? '')) {
        [effectiveComparison, priorEffectiveComparison, baseLineageComparison] = await Promise.all([
          githubCompleteComparison(
            `compare/${pullRequest.base.sha}...${pullRequest.head.sha}`, token, request,
          ),
          githubCompleteComparison(`compare/${oldBase}...${previousHead}`, token, request),
          loadVerifiedLineageComparison({
            priorSha: oldBase,
            currentSha: pullRequest.base.sha,
            request,
            token,
          }),
        ]);
      } else {
        effectiveComparison = await githubCompleteComparison(
          `compare/${pullRequest.base.sha}...${pullRequest.head.sha}`, token, request,
        );
      }
    }
  } catch (error) {
    if (error instanceof UnusableComparisonError) {
      console.warn(`${error.message} Retaining full workflow routing.`);
      return null;
    }
    throw error;
  }
  const input = {
    pullRequest, commit, comparison, priorBaseComparison,
    runs: listing?.workflow_runs, timeline, workflows, previousHead,
  };
  const lineageExecutionChanges = iosExecutionScopeChangedPaths(baseLineageComparison?.files);
  const equivalentIosWorkflowInputs = currentIsBaseUpdate && workflows.includes(IOS_TESTS_WORKFLOW_NAME)
    && lineageExecutionChanges?.length === 1 && lineageExecutionChanges[0] === '.github/workflows/ios-tests.yml'
    ? await loadEquivalentIosE2eProductInputs({ priorHead: previousHead, currentHead: pullRequest.head.sha, request, token })
    : null;
  if (equivalentIosWorkflowInputs?.workflowEvidenceEquivalent === true) {
    console.log(JSON.stringify({ reason: 'verified-ios-workflow-input-equivalence',
      priorHead: previousHead, currentHead: pullRequest.head.sha,
      productInputDigest: equivalentIosWorkflowInputs.digest, lanes: QUEUE_REUSE_LANES }));
  } else if (currentIsBaseUpdate && workflows.includes(IOS_TESTS_WORKFLOW_NAME)
    && baseLineageComparison !== undefined && !isReusableIosBaseLineage(baseLineageComparison)) {
    console.log(lineageChangeMessage(iosBaseLineageReusePlan(baseLineageComparison.files)));
  }
  const patchEquivalentBaseUpdate = isVerifiedPatchEquivalentBaseUpdate({
    pullRequest, commit, previousHead, priorBaseComparison,
    effectiveComparison, priorEffectiveComparison, baseLineageComparison,
    ...(equivalentIosWorkflowInputs ? { equivalentIosWorkflowInputs } : {}),
  });
  const routeCurrentEffectivePatch = async (reason: string) => {
    const currentHead = (await request(`pulls/${pullRequest.number}`, token))?.head?.sha;
    if (currentHead !== pullRequest.head.sha) {
      console.log(`Skipping superseded workflow for ${pullRequest.head.sha}; the pull request has a newer head.`);
      writeOutput('superseded', 'true');
      return { superseded: true };
    }
    const changedFiles = normalRoutingChangedFiles(effectiveComparison?.files);
    if (changedFiles === null) return null;
    const result = { priorHead: previousHead, changedFiles };
    console.log(reason);
    writeOutput('valid', 'true');
    writeOutput('changed_files', changedFiles.join('\n'));
    writeOutput('deleted_files', '');
    writeOutput('patch_equivalent', 'false');
    writeOutput('prior_head', previousHead);
    writeOutput('rerun_ios_lanes', '[]');
    return result;
  };
  if (patchEquivalentBaseUpdate && workflows.length === 1 && workflows[0] === IOS_TESTS_WORKFLOW_NAME) {
    // An active predecessor is relevant only when the verified current patch
    // contains an iOS execution input. Server paths still flow through normal
    // routing so their real-server E2E lanes are selected on this head.
    const iosInputs = iosExecutionScopeChangedPaths(effectiveComparison?.files);
    if (iosInputs !== null && iosInputs.length === 0) {
      return routeCurrentEffectivePatch(
        `Verified non-iOS effective patch at ${pullRequest.head.sha.slice(0, 12)}; routing current-head checks without waiting for the iOS predecessor.`,
      );
    }
    const predecessors = await findActiveEquivalentIosPredecessorChain({
      runs: input.runs, previousHead, pullRequest, priorEffectiveComparison, request, token,
    });
    const predecessor = predecessors[0];
    if (predecessor) {
      const currentHead = (await request(`pulls/${pullRequest.number}`, token))?.head?.sha;
      if (currentHead !== pullRequest.head.sha) {
        console.log(`Skipping superseded workflow for ${pullRequest.head.sha}; the pull request has a newer head.`);
        writeOutput('superseded', 'true');
        return { superseded: true };
      }
      console.log(`Deferring ${pullRequest.head.sha.slice(0, 12)} until patch-equivalent iOS run ${predecessor.id} completes.`);
      writeOutput('deferred', 'true');
      writeOutput('predecessor_run_id', String(predecessor.id));
      writeOutput('predecessor_run_ids', JSON.stringify(predecessors.map(run => run.id)));
      writeOutput('deferred_base_sha', pullRequest.base.sha);
      return {
        deferred: true,
        predecessorRunId: predecessor.id,
        predecessorRunIds: predecessors.map(run => run.id),
        deferredBaseSha: pullRequest.base.sha,
      };
    }
  }
  if (canFallBackWithoutPredecessorEvidence({
    ...input, effectiveComparison, priorEffectiveComparison, baseLineageComparison,
  })) {
    return routeCurrentEffectivePatch(
      `No predecessor iOS evidence exists for verified base-only update ${pullRequest.head.sha.slice(0, 12)}; routing the verified effective patch without waiting.`,
    );
  }
  const runs = await observeReusableRuns({
    input,
    runs: listing?.workflow_runs,
    loadCurrentHead: async () => (await request(`pulls/${pullRequest.number}`, token))?.head?.sha,
  });
  if (runs === null) {
    console.log(`Skipping superseded workflow for ${pullRequest.head.sha}; the pull request has a newer head.`);
    writeOutput('superseded', 'true');
    return { superseded: true };
  }
  const baseChanges = timeline.filter(event => event?.event === 'base_ref_changed');
  const jobsByRunId = await loadWorkflowJobEvidence({
    loadJobs: () => loadCompletedWorkflowJobs({
      runs,
      workflows,
      previousHead,
      prNumber: pullRequest.number,
      baseRef: pullRequest.base.ref,
      baseChanges,
      request,
      token,
    }),
    loadCurrentHead: async () => (await request(`pulls/${pullRequest.number}`, token))?.head?.sha,
    expectedHead: pullRequest.head.sha,
  });
  if (jobsByRunId === null) {
    console.log(`Skipping superseded workflow for ${pullRequest.head.sha}; the pull request has a newer head.`);
    writeOutput('superseded', 'true');
    return { superseded: true };
  }
  let equivalentResult;
  try {
    equivalentResult = await findEquivalentPatchHead({
      ...input, currentCommit: commit, runs, jobsByRunId, priorBaseComparison,
      initialPriorEffectiveComparison: priorEffectiveComparison,
      currentEffectiveComparison: effectiveComparison,
      currentBaseLineageComparison: baseLineageComparison,
      request, token,
    });
  } catch (error) {
    if (error instanceof UnusableComparisonError) {
      console.warn(`${error.message} Retaining full workflow routing.`);
      equivalentResult = null;
    } else {
      throw error;
    }
  }
  const isBaseUpdate = isEligibleBaseUpdateCommit({
    commit, pullRequest, firstParent: previousHead, baseParent: pullRequest.base.sha,
  });
  if (!equivalentResult && workflows.includes(PR_CHECKS_WORKFLOW_NAME) && !hasSuccessfulValidationJob({
    runs, jobsByRunId, previousHead, prNumber: pullRequest.number, baseChanges, baseRef: pullRequest.base.ref,
  })) {
    console.log(`Prior ${PR_CHECKS_WORKFLOW_NAME} evidence for ${previousHead.slice(0, 12)} `
      + 'did not execute validate successfully; retaining full PR routing.');
    return null;
  }
  const result = equivalentResult ?? (isBaseUpdate
    ? controllerBaseUpdateDelta({
      ...input, runs, jobsByRunId, effectiveComparison, priorEffectiveComparison,
      baseLineageComparison,
    })
    : controllerBaseUpdateDelta({ ...input, runs, jobsByRunId }));
  if (!result) {
    if (isBaseUpdate) {
      console.log(`No reusable patch-equivalent ${workflows.join(', ')} evidence matched ${pullRequest.head.sha.slice(0, 12)}; retaining full workflow routing.`);
    }
    return null;
  }
  writeOutput('valid', 'true');
  writeOutput('changed_files', result.changedFiles.join('\n'));
  writeOutput('deleted_files', (result.deletedFiles ?? []).join('\n'));
  writeOutput('patch_equivalent', String(result.changedFiles.length === 0
    && ((comparison.files !== undefined && comparison.files.length === 0)
      || equivalentResult !== null)));
  writeOutput('prior_head', result.priorHead);
  writeOutput('rerun_ios_lanes', JSON.stringify(result.rerunIosLanes ?? []));
  writeOutput('rerun_ios_auxiliary', JSON.stringify(result.rerunIosAuxiliary ?? []));
  writeOutput('reuse_native_evidence', String(result.reuseNativeEvidence === true));
  writeOutput('reused_ios_evidence', JSON.stringify(result.reusedIosEvidence ?? null));
  writeOutput('reuse_e2e_products', String(result.reusedE2eProducts !== undefined));
  writeOutput('reused_e2e_run_id', String(result.reusedE2eProducts?.runId ?? ''));
  writeOutput('reused_e2e_run_attempt', String(result.reusedE2eProducts?.runAttempt ?? ''));
  writeOutput('reused_e2e_head_sha', result.reusedE2eProducts?.headSha ?? '');
  writeOutput('reused_e2e_producer_job_id', String(result.reusedE2eProducts?.producerJobId ?? ''));
  writeOutput('reused_e2e_product_digest', result.reusedE2eProducts?.inputDigest ?? '');
  writeOutput('base_delta_route', String(result.baseDeltaRoute !== undefined));
  writeOutput('pull_request_files', (result.baseDeltaRoute?.pullRequestFiles ?? []).join('\n'));
  writeOutput(
    'pull_request_deleted_files',
    (result.baseDeltaRoute?.pullRequestDeletedFiles ?? []).join('\n'),
  );
  if (result.baseDeltaRoute) {
    console.log(`Base update route: reason=base-delta workflows=${workflows.join(',')} `
      + `prior_head=${result.priorHead.slice(0, 12)} routed_paths=${result.changedFiles.length} `
      + `pull_request_paths=${result.baseDeltaRoute.pullRequestFiles.length}`);
  }
  writeOutput('replan_selection', String(result.replanSelection !== undefined));
  writeOutput('replan_evidence_run_id', String(result.replanSelection?.runId ?? ''));
  writeOutput('replan_evidence_run_attempt', String(result.replanSelection?.runAttempt ?? ''));
  writeOutput('replan_evidence_head_sha', result.replanSelection?.headSha ?? '');
  if (result.replanSelection) {
    const binding = await bindReplanRecordOrFailClosed(result.replanSelection, request, token);
    writeOutput('replan_record_attempt', String(binding.recordAttempt ?? ''));
    writeOutput('replan_record_detail', binding.detail);
    writeOutput('replan_successful_jobs', JSON.stringify(binding.successfulJobs));
    console.log(`iOS selection replan: reason=replan-required prior_run=${result.replanSelection.runId} `
      + `record_attempt=${binding.recordAttempt ?? 'unproven'} `
      + `success_attempt=${result.replanSelection.runAttempt} detail=${binding.detail} `
      + `prior_head=${result.replanSelection.headSha.slice(0, 12)} routed_paths=${result.changedFiles.length}`);
  }
  if (result.reusedIosEvidence) {
    console.log(`Retaining native iOS evidence from run ${result.reusedIosEvidence.runId} attempt ${result.reusedIosEvidence.runAttempt} at ${result.reusedIosEvidence.headSha}: jobs ${result.reusedIosEvidence.jobIds.join(', ')}.`);
  }
  if (result.reusedE2eProducts) {
    console.log(`Reusing E2E products from run ${result.reusedE2eProducts.runId} at ${result.reusedE2eProducts.headSha}; typed iOS product-input digest ${result.reusedE2eProducts.inputDigest}.`);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    const failure = controllerFailurePolicy(error);
    const report = failure.exitCode === 0 ? console.warn : console.error;
    report(failure.message);
    process.exitCode = failure.exitCode;
  });
}

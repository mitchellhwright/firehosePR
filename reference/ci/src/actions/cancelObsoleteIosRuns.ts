#!/usr/bin/env node

/**
 * The single owner of `Test - iOS` run cancellation for pull-request events in
 * the continuity controller (`refresh-pr-ci-after-base-edit.yml`, job
 * `cancel-obsolete-ios`). It reads the facts GitHub holds for one event,
 * `ci/src/tupleLifecycle.ts` decides which active runs are obsolete, and this
 * file cancels exactly those while the event's tuple is still live.
 *
 * Triggers: `synchronize` (older heads) and `edited` with a base change
 * (current-head runs from the prior base branch). See the module comment in
 * `ci/src/tupleLifecycle.ts` for why native `cancel-in-progress` cannot own
 * either decision.
 *
 * `Test - iOS` job `release-full-routing-predecessor` runs this file a second
 * time for the same `synchronize`, from the trusted verifier checkout, with
 * `IOS_GATE_FULL_ROUTING=true` once the head's iOS gate has routed it in full.
 * That job's step runs only when the trusted revision no longer carries the
 * retired `ci/src/ios/controllers/cancelBlockedPrCi.ts`, i.e. when this file
 * has the `full-routing` rule.
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  equivalentEffectivePatch,
  isEligibleBaseUpdateCommit,
  isReusableIosLaneJob,
} from '../ios/baseUpdateDelta.ts';
import { createGithubRequester } from '../ios/shared/githubRest.ts';
import { isReusableIosWorkflowLineage } from '../ios/workflowEvidenceInputs.ts';
import { iosExecutionScopeChanged } from '../ios/iosExecutionInputs.ts';
import { runsStaleTupleGuard } from '../ios/staleTupleGuardJobs.ts';
import {
  deriveTupleLifecyclePlan,
  type PullRequestTuple,
  type TupleLifecycleInput,
  type TupleLifecyclePlan,
  type VerifiedAncestor,
  type WorkflowRun,
  activeRunStatuses,
} from '../tupleLifecycle.ts';
import { workflowNames } from '../../../scripts/ci/generated/workflow-names.ts';

export interface GithubObject {
  readonly [key: string]: unknown;
  readonly id: number;
  readonly name: string;
  readonly number: number;
  readonly action: string;
  readonly before: string;
  readonly state: string;
  readonly draft: boolean;
  readonly sha: string;
  readonly ref: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly run_attempt: number;
  readonly filename: string;
  readonly total_count: number;
  readonly head_sha: string;
  readonly full_name: string;
  readonly files: readonly GithubObject[];
  readonly parents: readonly GithubObject[];
  readonly workflow_runs: readonly GithubObject[];
  readonly jobs: readonly GithubObject[];
  readonly pull_requests: readonly GithubObject[];
  readonly pull_request: GithubObject;
  readonly head: GithubObject;
  readonly base: GithubObject;
  readonly repo: GithubObject;
  readonly merge_base_commit: GithubObject;
  readonly conflict?: boolean;
}

type GithubRequest = (
  path: string,
  options?: { readonly method?: 'GET' | 'POST' },
) => Promise<GithubObject>;

interface CancelMainOptions {
  readonly event?: GithubObject;
  readonly repository?: string;
  readonly request?: GithubRequest;
  /** Whether the head's iOS gate routed this `synchronize` in full. */
  readonly fullRouting?: boolean;
}

/** What one event decided and did: the facts read, the typed plan, and the runs cancelled. */
export interface CancellationOutcome {
  readonly facts: TupleLifecycleInput | null;
  readonly plan: TupleLifecyclePlan | null;
  readonly cancelled: readonly number[];
}

// Every run this controller inventories, retains or cancels belongs to one
// workflow, so its name comes from the definition that renders it — including
// in the messages that report what the inventory found.
const IOS_TESTS_WORKFLOW_NAME = workflowNames['ios-tests'].workflow;
const SHA = /^[a-f0-9]{40}$/;
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/** The iOS gate's full-routing verdict, as the release job passes it. */
function fullRoutingFromEnvironment(): boolean {
  const value = process.env.IOS_GATE_FULL_ROUTING;
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  throw new Error(`IOS_GATE_FULL_ROUTING must be 'true' or unset, not ${JSON.stringify(value)}.`);
}

const ACTIVE: ReadonlySet<string> = new Set(activeRunStatuses);
const MAX_FILTERED_RUNS = 1_000;

export async function githubRequest(path: string, { method = 'GET' }: { readonly method?: 'GET' | 'POST' } = {}): Promise<GithubObject> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GitHub token is required.');
  const request = createGithubRequester({ tokens: [token] });
  const response = await request(
    method,
    `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${process.env.GITHUB_REPOSITORY}/${path}`,
  );
  if (response.status === 202 || response.status === 204) return {} as GithubObject;
  if (method === 'POST' && response.status === 409) return { conflict: true } as GithubObject;
  if (response.status !== 200) throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}.`);
  if (response.body === null || typeof response.body !== 'object' || Array.isArray(response.body)) {
    throw new Error(`GitHub API ${method} ${path} returned a malformed JSON object.`);
  }
  return response.body as GithubObject;
}

async function loadIosWorkflowRuns(request: GithubRequest, branch: string): Promise<GithubObject[]> {
  const encodedBranch = encodeURIComponent(branch);
  let previousActiveIds = null;
  for (let round = 1; round <= 3; round += 1) {
    // Activity is read from each run's own status inside one branch listing
    // rather than from which of several status-filtered queries answered.
    // `Test - iOS` queues 19 jobs behind their own concurrency groups on scarce
    // self-hosted Macs, so a run drops from `in_progress` back to `queued`
    // whenever its started jobs finish while the next ones wait for a host. A
    // run that moves backwards between two time-separated filtered reads is
    // returned by neither and silently leaves the inventory. Repeating the
    // whole listing still closes the boundary where a run is created or reaches
    // a terminal status while the inventory is read.
    const branchRuns = await loadIosWorkflowRunListing(request, encodedBranch);
    const snapshot = new Map(branchRuns
      .filter(run => ACTIVE.has(run?.status))
      .map(run => [run.id, run]));
    const activeIds = [...snapshot.keys()].sort((left, right) => left - right).join(',');
    if (activeIds === previousActiveIds) return [...snapshot.values()];
    previousActiveIds = activeIds;
  }
  throw new Error(`${IOS_TESTS_WORKFLOW_NAME} active workflow-run inventory did not stabilize after 3 complete branch scans.`);
}

/**
 * A busy queue's total_count can legitimately drift between pages while runs
 * start or finish underneath GitHub's offset-based pagination. Follow the
 * listing's end signal and reconcile the collected run IDs with the final
 * page's total instead of restarting on every intermediate total change.
 */
async function loadIosWorkflowRunListing(request: GithubRequest, encodedBranch: string, status = '', headSha = ''): Promise<GithubObject[]> {
  const scope = status || 'branch';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const runs = new Map();
    let latestTotal = 0;
    let reachedEnd = false;
    for (let page = 1; page <= 10; page += 1) {
      const listing = await request(
        `actions/workflows/ios-tests.yml/runs?event=pull_request${status ? `&status=${status}` : ''}&branch=${encodedBranch}${headSha ? `&head_sha=${headSha}` : ''}&per_page=100&page=${page}`,
      );
      if (!Number.isInteger(listing?.total_count) || !Array.isArray(listing?.workflow_runs)) {
        throw new Error(`GitHub returned an invalid ${IOS_TESTS_WORKFLOW_NAME} workflow-runs page.`);
      }
      if (listing.total_count > MAX_FILTERED_RUNS) {
        throw new Error(`${IOS_TESTS_WORKFLOW_NAME} ${scope} workflow-run inventory exceeds GitHub's 1,000-run query cap.`);
      }
      latestTotal = listing.total_count;
      for (const run of listing.workflow_runs) {
        if (Number.isInteger(run?.id)) runs.set(run.id, run);
      }
      if (listing.workflow_runs.length < 100 || runs.size >= latestTotal) {
        reachedEnd = true;
        break;
      }
    }
    if (!reachedEnd) {
      throw new Error(`${IOS_TESTS_WORKFLOW_NAME} ${scope} workflow-run discovery exceeded the pagination limit.`);
    }
    if (runs.size === latestTotal) return [...runs.values()];
  }
  throw new Error(`${IOS_TESTS_WORKFLOW_NAME} ${scope} workflow-run inventory did not stabilize after 3 attempts.`);
}

function runMatchesPullBase(run: GithubObject, pullRequest: GithubObject): boolean {
  return Array.isArray(run?.pull_requests)
    && run.pull_requests.some(candidate => candidate?.number === pullRequest.number
      && candidate?.base?.ref === pullRequest.base.ref);
}

async function completedRunHasReusableIosLane(request: GithubRequest, runId: number): Promise<boolean> {
  const jobs = await loadRunJobs(request, runId);
  return jobs.some(isReusableIosLaneJob);
}

async function loadRunJobs(request: GithubRequest, runId: number): Promise<GithubObject[]> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const jobs = new Map<number, GithubObject>();
    let totalCount: number | undefined;
    let inventoryChanged = false;
    for (let page = 1; page <= 10; page += 1) {
      const listing = await request(`actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`);
      if (!Number.isInteger(listing?.total_count) || !Array.isArray(listing?.jobs)) {
        throw new Error(`GitHub returned invalid ${IOS_TESTS_WORKFLOW_NAME} job evidence for run ${runId}.`);
      }
      totalCount ??= listing.total_count;
      if (totalCount > MAX_FILTERED_RUNS) {
        throw new Error(`${IOS_TESTS_WORKFLOW_NAME} job evidence for run ${runId} exceeds GitHub's 1,000-job query cap.`);
      }
      if (listing.total_count !== totalCount) {
        inventoryChanged = true;
        break;
      }
      for (const job of listing.jobs) {
        if (Number.isInteger(job?.id)) jobs.set(job.id, job);
      }
      if (jobs.size >= totalCount) {
        return [...jobs.values()];
      }
      if (listing.jobs.length === 0) {
        inventoryChanged = true;
        break;
      }
    }
    if (!inventoryChanged) {
      throw new Error(`${IOS_TESTS_WORKFLOW_NAME} job evidence for run ${runId} exceeded the pagination limit.`);
    }
  }
  throw new Error(`${IOS_TESTS_WORKFLOW_NAME} job evidence for run ${runId} did not stabilize after 3 attempts.`);
}

/**
 * A run with nothing left to prove can safely yield the PR concurrency slot:
 * no job is executing, no lane has already produced reusable evidence, and
 * what waits includes a job that must re-prove the live tuple before Xcode
 * (`ci/src/ios/staleTupleGuardJobs.ts`). Queued verdict or aggregation jobs
 * alone do not qualify; they run without that guard and finish the run's
 * completed Mac evidence. The run's own status flips between `in_progress`
 * and `queued` while its next jobs wait for a Mac, so both are read from its
 * jobs rather than trusted.
 */
async function holdsOnlyUnstartedJobs(request: GithubRequest, run: GithubObject): Promise<boolean> {
  if (run.status !== 'in_progress' && run.status !== 'queued') return false;
  const jobs = await loadRunJobs(request, run.id);
  return jobs.some(job => job.status === 'queued' && runsStaleTupleGuard(job.name))
    && jobs.every(job => job.status === 'completed' || job.status === 'queued')
    && !jobs.some(isReusableIosLaneJob);
}

async function hasCompletedReusableIosEvidence({ request, branch, previousHead, pullRequest }: { request: GithubRequest; branch: string; previousHead: string; pullRequest: GithubObject }): Promise<boolean> {
  const successfulRuns = await loadIosWorkflowRunListing(
    request, encodeURIComponent(branch), 'success', previousHead,
  );
  for (const run of successfulRuns) {
    if (run?.name !== IOS_TESTS_WORKFLOW_NAME
      || run?.head_sha !== previousHead
      || run?.status !== 'completed'
      || run?.conclusion !== 'success'
      || !Number.isInteger(run?.id)
      || !runMatchesPullBase(run, pullRequest)) continue;
    if (await completedRunHasReusableIosLane(request, run.id)) return true;
  }
  return false;
}

function sameTuple(expected: GithubObject | undefined, current: GithubObject): boolean {
  return current?.state === 'open'
    && current?.draft === false
    && current?.number === expected?.number
    && current?.head?.sha === expected?.head?.sha
    && current?.head?.repo?.full_name === expected?.head?.repo?.full_name
    && current?.base?.sha === expected?.base?.sha
    && current?.base?.ref === expected?.base?.ref
    && current?.base?.repo?.full_name === expected?.base?.repo?.full_name;
}

const MAX_PREDECESSOR_CHAIN_DEPTH = 20;

/**
 * Walks back through a chain of verified base-update commits from
 * `previousHead`, retaining the newest active run at every verified ancestor
 * until completed reusable evidence or the original product commit is reached.
 * An active intermediate can itself be waiting on older native work.
 *
 * A target branch that advances twice before the original iOS run finishes
 * makes `previousHead` itself an intermediate base-update commit whose own
 * deferred run has already failed; the run worth keeping belongs to an older
 * first-parent ancestor. Checking only `previousHead` would leave that
 * still-valid ancestor unretained and cancel it, forcing another Mac cycle.
 */
async function findRetainedPredecessorIds({
  pullRequest, previousHead, activeRuns, request, observeAncestor = () => undefined,
}: { pullRequest: GithubObject; previousHead: string; activeRuns: readonly GithubObject[]; request: GithubRequest; observeAncestor?: (ancestor: { headSha: string; completedReusableEvidence: boolean }) => void }): Promise<number[]> {
  const retainedIds: number[] = [];
  const currentPatch = await request(`compare/${pullRequest.base.sha}...${pullRequest.head.sha}`);
  if (currentPatch?.merge_base_commit?.sha !== pullRequest.base.sha
    || !['ahead', 'identical'].includes(currentPatch?.status)) return retainedIds;

  // The immediate candidate's base is derived the same way
  // isPatchEquivalentTargetUpdate derives it: from the actual historical
  // merge-base, not from previousHead's own commit shape (which the caller
  // has not yet fetched and need not be a base-update commit at all).
  const priorBase = await request(`compare/${pullRequest.base.sha}...${previousHead}`);
  let candidateSha = previousHead;
  let candidateBaseSha = priorBase?.merge_base_commit?.sha;
  let referencePatch = currentPatch;
  let referenceBaseSha = pullRequest.base.sha;

  for (let depth = 0; depth < MAX_PREDECESSOR_CHAIN_DEPTH; depth += 1) {
    if (!SHA.test(candidateBaseSha ?? '')) return retainedIds;
    const candidatePatch = await request(`compare/${candidateBaseSha}...${candidateSha}`);
    if (candidatePatch?.merge_base_commit?.sha !== candidateBaseSha
      || !['ahead', 'identical'].includes(candidatePatch?.status)) return retainedIds;
    let baseLineage;
    if (candidateBaseSha !== referenceBaseSha) {
      baseLineage = await request(`compare/${candidateBaseSha}...${referenceBaseSha}`);
      if (baseLineage?.merge_base_commit?.sha !== candidateBaseSha
        || !['ahead', 'identical'].includes(baseLineage?.status)) return retainedIds;
    }
    // A predecessor built before an iOS execution-contract change cannot be
    // reused by the updated base, even when the PR's own effective patch is
    // unchanged. Stop the retained chain at that boundary so the old run is
    // cancelled and the current head can exercise the new contract.
    if (!await isReusableIosWorkflowLineage({ comparison: baseLineage,
      priorHead: candidateSha, currentHead: pullRequest.head.sha, read: (path) => request(path),
    })) {
      return retainedIds;
    }
    if (!equivalentEffectivePatch(referencePatch.files, candidatePatch.files, baseLineage)) {
      return retainedIds;
    }

    const reusableSuccess = await hasCompletedReusableIosEvidence({
      request, branch: pullRequest.head.ref, previousHead: candidateSha, pullRequest,
    });
    observeAncestor({ headSha: candidateSha, completedReusableEvidence: reusableSuccess });
    if (reusableSuccess) return retainedIds;

    const retained = activeRuns
      .filter(run => run?.name === IOS_TESTS_WORKFLOW_NAME
        && run?.head_sha === candidateSha
        && Number.isInteger(run?.id)
        && runMatchesPullBase(run, pullRequest)
        && typeof run?.created_at === 'string'
        && !Number.isNaN(Date.parse(run.created_at)))
      // A later pending attempt must not displace an executing or Mac-queued
      // attempt for this same patch-equivalent head.
      .sort(preferExecutingRun)[0]?.id ?? null;
    if (retained !== null) retainedIds.push(retained);

    // Walking further requires candidateSha to itself be a verified
    // base-update commit. Its second parent is only the base it was updated
    // onto, not its own predecessor's original base, so re-derive the true
    // merge base between the two parents the same way
    // the typed base-update classifier does, rather than trusting the second
    // parent directly.
    const candidateCommit = await request(`commits/${candidateSha}`);
    if (candidateCommit?.sha !== candidateSha
      || !isEligibleBaseUpdateCommit({ commit: candidateCommit, pullRequest })) return retainedIds;
    const parentSha = candidateCommit.parents?.[0]?.sha;
    const updatedOntoSha = candidateCommit.parents?.[1]?.sha;
    if (!SHA.test(parentSha ?? '') || !SHA.test(updatedOntoSha ?? '')) return retainedIds;
    const parentBaseComparison = await request(`compare/${updatedOntoSha}...${parentSha}`);
    const nextBaseSha = parentBaseComparison?.merge_base_commit?.sha;
    if (!SHA.test(nextBaseSha ?? '')) return retainedIds;
    referencePatch = candidatePatch;
    referenceBaseSha = candidateBaseSha;
    candidateSha = parentSha!;
    candidateBaseSha = nextBaseSha!;
  }
  throw new Error('Retained iOS predecessor chain exceeded the verified ancestor limit.');
}

function preferExecutingRun(left: GithubObject, right: GithubObject): number {
  const priority = (run: GithubObject) => run.status === 'in_progress' ? 2
    : run.status === 'queued' ? 1 : 0;
  return priority(right) - priority(left)
    || Date.parse(right.created_at) - Date.parse(left.created_at);
}

export async function isPatchEquivalentTargetUpdate({ pullRequest, previousHead, request }: { pullRequest: GithubObject; previousHead: string; request: GithubRequest }): Promise<boolean> {
  const commit = await request(`commits/${pullRequest.head.sha}`);
  if (!isEligibleBaseUpdateCommit({
    commit, pullRequest, firstParent: previousHead, baseParent: pullRequest.base.sha,
  })) return false;
  const priorBase = await request(`compare/${pullRequest.base.sha}...${previousHead}`);
  const oldBase = priorBase?.merge_base_commit?.sha;
  if (!SHA.test(oldBase ?? '')) return false;
  const [currentPatch, priorPatch, baseLineage] = await Promise.all([
    request(`compare/${pullRequest.base.sha}...${pullRequest.head.sha}`),
    request(`compare/${oldBase}...${previousHead}`),
    request(`compare/${oldBase}...${pullRequest.base.sha}`),
  ]);
  return currentPatch?.merge_base_commit?.sha === pullRequest.base.sha
    && ['ahead', 'identical'].includes(currentPatch?.status)
    && priorPatch?.merge_base_commit?.sha === oldBase
    && ['ahead', 'identical'].includes(priorPatch?.status)
    && baseLineage?.merge_base_commit?.sha === oldBase
    && ['ahead', 'identical'].includes(baseLineage?.status)
    && await isReusableIosWorkflowLineage({ comparison: baseLineage,
      priorHead: previousHead, currentHead: pullRequest.head.sha, read: (path) => request(path),
    })
    && equivalentEffectivePatch(currentPatch?.files, priorPatch?.files, baseLineage);
}

const isoDateTime = z.iso.datetime({ offset: true });
type ActiveRunStatus = typeof activeRunStatuses[number];

function isActiveStatus(status: unknown): status is ActiveRunStatus {
  return typeof status === 'string' && ACTIVE.has(status);
}

function projectRef(ref: GithubObject | undefined): PullRequestTuple['head'] {
  return { sha: ref?.sha ?? '', ref: ref?.ref ?? '', repository: ref?.repo?.full_name ?? '' };
}

/**
 * The live pull request, or `null` when GitHub answered without one this owner
 * can compare: an unreadable tuple counts as superseded, never as current.
 */
function projectLivePullRequest(pullRequest: GithubObject | null | undefined): PullRequestTuple | null {
  if (typeof pullRequest !== 'object' || pullRequest === null
    || !Number.isSafeInteger(pullRequest.number) || pullRequest.number <= 0
    || !SHA.test(pullRequest.head?.sha ?? '') || !SHA.test(pullRequest.base?.sha ?? '')) return null;
  return projectPullRequest(pullRequest);
}

function projectPullRequest(pullRequest: GithubObject): PullRequestTuple {
  return {
    number: pullRequest.number,
    state: pullRequest.state === 'open' ? 'open' : 'closed',
    // An absent flag is treated as draft, so it can never pass the live-tuple check.
    draft: pullRequest.draft !== false,
    head: projectRef(pullRequest.head),
    base: projectRef(pullRequest.base),
  };
}

function projectRunPullRequests(run: GithubObject): WorkflowRun['pullRequests'] {
  const entries = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  return entries.flatMap((entry): WorkflowRun['pullRequests'] => {
    if (!Number.isSafeInteger(entry?.number) || entry.number <= 0) return [];
    const baseRef = entry.base?.ref;
    return [typeof baseRef === 'string' && baseRef.length > 0
      ? { number: entry.number, baseRef }
      : { number: entry.number }];
  });
}

/**
 * A run the owner could act on. One without a positive id, a workflow name, an
 * exact head SHA or an active status can be neither cancelled nor retained, so
 * it is left out of the facts rather than failing the whole event.
 */
function projectRun(run: GithubObject): WorkflowRun[] {
  const { id, name, head_sha: headSha, status } = run;
  if (!Number.isSafeInteger(id) || id <= 0 || typeof name !== 'string' || name.length === 0
    || !SHA.test(headSha ?? '') || !isActiveStatus(status)) return [];
  return [{
    id,
    workflow: name,
    headSha,
    status,
    createdAt: isoDateTime.safeParse(run.created_at).success ? run.created_at : null,
    pullRequests: projectRunPullRequests(run),
  }];
}

/**
 * Whether each obsolete head's iOS execution inputs differ from the live
 * head's. Measured from every run's own head rather than from the event's
 * `before`: synchronize controllers share one per-PR concurrency group, so
 * after `A->B` is replaced by `B->C` an active run for `A` must still be judged
 * on everything in `A..C`. When a run head is not an ancestor of the live head
 * (a force-push or reset), its own side since the merge base is compared too,
 * because those commits are also in what it tests. Missing or truncated
 * comparisons fail closed as changed.
 */
async function iosScopeChangesByHead(
  request: GithubRequest,
  runHeads: readonly string[],
  liveHead: string,
): Promise<Record<string, boolean>> {
  const changed: Record<string, boolean> = {};
  for (const runHead of runHeads) {
    const forward = await request(`compare/${runHead}...${liveHead}`);
    if (iosExecutionScopeChanged(forward?.files)) {
      changed[runHead] = true;
    } else if (forward?.status === 'ahead' || forward?.status === 'identical') {
      changed[runHead] = false;
    } else {
      changed[runHead] = iosExecutionScopeChanged((await request(`compare/${liveHead}...${runHead}`))?.files);
    }
  }
  return changed;
}

type Trigger = NonNullable<TupleLifecyclePlan['trigger']>;

function hasBaseChange(event: GithubObject): boolean {
  const changes = event.changes;
  return typeof changes === 'object' && changes !== null
    && (changes as { readonly base?: unknown }).base != null;
}

/**
 * The rule an event invokes, decided from the event alone so an event this
 * owner never acts on costs no API request. `tupleLifecycle.ts` repeats these
 * checks against the facts it is given.
 */
function eventTrigger(
  { event, repository, fullRouting }:
  { event: GithubObject | undefined; repository: string | undefined; fullRouting: boolean },
): Trigger | null {
  const pullRequest = event?.pull_request;
  if (event === undefined || repository === undefined
    || pullRequest?.head?.repo?.full_name !== repository
    || pullRequest?.base?.repo?.full_name !== repository) return null;
  if (event.action === 'synchronize') {
    if (!SHA.test(event.before ?? '')) return null;
    return fullRouting ? 'full-routing' : 'synchronize';
  }
  // The gate's verdict belongs to a synchronize; on any other event it is a wiring error.
  if (fullRouting) throw new Error(`A full-routing release needs a synchronize event, not ${event.action}.`);
  if (event.action === 'edited' && hasBaseChange(event)
    && pullRequest.state === 'open' && pullRequest.draft === false) return 'retarget';
  return null;
}

function eventFacts(
  { event, repository, trigger, livePullRequest }:
  { event: GithubObject; repository: string; trigger: Trigger; livePullRequest: GithubObject },
): TupleLifecycleInput {
  return {
    repository,
    event: {
      action: event.action,
      previousHeadSha: typeof event.before === 'string' ? event.before : null,
      baseChanged: trigger === 'retarget',
      fullRouting: trigger === 'full-routing',
    },
    pullRequest: projectPullRequest(event.pull_request),
    livePullRequest: projectLivePullRequest(livePullRequest),
    iosExecutionScopeChangedByHead: null,
    patchEquivalentPredecessor: null,
    verifiedLineage: [],
    runs: [],
    queuedOnlyRunIds: [],
  };
}

function liveHeadBranch(pullRequest: GithubObject): string {
  if (typeof pullRequest?.head?.ref !== 'string' || pullRequest.head.ref.length === 0) {
    throw new Error('Current pull request is missing its head branch.');
  }
  return pullRequest.head.ref;
}

/**
 * Runs that may yield the per-PR concurrency slot although they are verified
 * predecessors or their head's iOS scope is unchanged: nothing is executing,
 * no lane holds reusable evidence, and every waiting Mac job would have to
 * re-prove a tuple that is no longer live (`holdsOnlyUnstartedJobs`).
 *
 * Every Mac job re-proves the live tuple before Xcode starts
 * (ci/src/actions/ios/verifyExactIosRevision.ts), so a verified predecessor
 * with no executing job has no evidence left to produce. An unchanged-scope
 * run is released only while a current-head run waits behind it in the
 * workflow-level per-PR concurrency group.
 */
async function releasableQueuedRunIds({
  request, pullRequest, activeRuns, obsoleteRuns, verifiedPredecessorIds, scopeByHead,
}: {
  request: GithubRequest;
  pullRequest: GithubObject;
  activeRuns: readonly GithubObject[];
  obsoleteRuns: readonly GithubObject[];
  verifiedPredecessorIds: readonly number[];
  scopeByHead: Readonly<Record<string, boolean>>;
}): Promise<number[]> {
  const releasable: number[] = [];
  for (const runId of verifiedPredecessorIds) {
    const run = activeRuns.find(candidate => candidate?.id === runId);
    if (run !== undefined && await holdsOnlyUnstartedJobs(request, run)) releasable.push(runId);
  }
  const currentHeadWaiting = activeRuns.some(run => run?.name === IOS_TESTS_WORKFLOW_NAME
    && run?.head_sha === pullRequest.head.sha
    && (run?.status === 'pending' || run?.status === 'queued')
    && runMatchesPullBase(run, pullRequest));
  if (!currentHeadWaiting) return releasable;
  for (const run of obsoleteRuns) {
    if (scopeByHead[run.head_sha] === false
      && !verifiedPredecessorIds.includes(run.id)
      && await holdsOnlyUnstartedJobs(request, run)) {
      releasable.push(run.id);
    }
  }
  return releasable;
}

async function collectSynchronizeFacts(
  { event, repository, request, trigger }:
  { event: GithubObject; repository: string; request: GithubRequest; trigger: 'synchronize' | 'full-routing' },
): Promise<TupleLifecycleInput> {
  const pullRequest = event.pull_request;
  const previousHead = event.before;
  const currentPull = await request(`pulls/${pullRequest.number}`);
  const facts = eventFacts({ event, repository, trigger, livePullRequest: currentPull });
  if (!sameTuple(pullRequest, currentPull)) return facts;
  // Even a server-only base update leaves old pending iOS runs in the PR's
  // workflow queue. Keep its verified executing predecessor and release the
  // other old heads so the latest event reaches the required verdict.
  const patchEquivalent = await isPatchEquivalentTargetUpdate({ pullRequest, previousHead, request });
  const activeRuns = await loadIosWorkflowRuns(request, liveHeadBranch(currentPull));
  const verifiedLineage: VerifiedAncestor[] = [];
  const verifiedPredecessorIds = patchEquivalent
    ? await findRetainedPredecessorIds({
      pullRequest: currentPull,
      previousHead,
      activeRuns,
      request,
      observeAncestor: ancestor => verifiedLineage.push(ancestor),
    })
    : [];
  const obsoleteRuns = activeRuns
    .filter(run => run?.name === IOS_TESTS_WORKFLOW_NAME
      && SHA.test(run?.head_sha ?? '')
      && run.head_sha !== pullRequest.head.sha
      && ACTIVE.has(run?.status)
      && Array.isArray(run?.pull_requests)
      && run.pull_requests.some(candidate => candidate?.number === pullRequest.number));
  const scopeByHead = await iosScopeChangesByHead(
    request, [...new Set(obsoleteRuns.map(run => run.head_sha))], pullRequest.head.sha);
  const queuedOnlyRunIds = await releasableQueuedRunIds({
    request, pullRequest, activeRuns, obsoleteRuns, verifiedPredecessorIds, scopeByHead,
  });
  return {
    ...facts,
    iosExecutionScopeChangedByHead: scopeByHead,
    patchEquivalentPredecessor: patchEquivalent,
    verifiedLineage,
    runs: activeRuns.flatMap(projectRun),
    queuedOnlyRunIds,
  };
}

async function collectRetargetFacts(
  { event, repository, request }: { event: GithubObject; repository: string; request: GithubRequest },
): Promise<TupleLifecycleInput> {
  const currentPull = await request(`pulls/${event.pull_request.number}`);
  const facts = eventFacts({ event, repository, trigger: 'retarget', livePullRequest: currentPull });
  if (!sameTuple(event.pull_request, currentPull)) return facts;
  const activeRuns = await loadIosWorkflowRuns(request, liveHeadBranch(currentPull));
  return { ...facts, runs: activeRuns.flatMap(projectRun) };
}

/**
 * Cancels the plan's runs one at a time, in plan order, while the event's
 * tuple is still the live one: a newer event owns its own cleanup. A run
 * planned for release because none of its jobs had started is re-read first
 * and kept if a Mac picked one of them up in the meantime.
 */
async function cancelPlannedRuns(
  { pullRequest, facts, plan, request }:
  { pullRequest: GithubObject; facts: TupleLifecycleInput; plan: TupleLifecyclePlan; request: GithubRequest },
): Promise<number[]> {
  const headByRunId = new Map(facts.runs.map(run => [run.id, run.headSha]));
  const queuedOnlyRunIds = facts.queuedOnlyRunIds ?? [];
  const cancelled: number[] = [];
  for (const runId of plan.cancelRunIds) {
    if (!sameTuple(pullRequest, await request(`pulls/${pullRequest.number}`))) break;
    if (queuedOnlyRunIds.includes(runId)) {
      const currentRun = await request(`actions/runs/${runId}`);
      if (currentRun?.head_sha !== headByRunId.get(runId)
        || !await holdsOnlyUnstartedJobs(request, currentRun)) continue;
    }
    const cancellation = await request(`actions/runs/${runId}/cancel`, { method: 'POST' });
    if (cancellation?.conflict === true) {
      const currentRun = await request(`actions/runs/${runId}`);
      if (ACTIVE.has(currentRun?.status)) {
        throw new Error(`Cancellation of obsolete ${IOS_TESTS_WORKFLOW_NAME} run ${runId} conflicted while it remained active.`);
      }
    }
    cancelled.push(runId);
  }
  return cancelled;
}

export async function main({
  event = JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')) as GithubObject,
  repository = process.env.GITHUB_REPOSITORY,
  request = githubRequest,
  fullRouting = fullRoutingFromEnvironment(),
}: CancelMainOptions = {}): Promise<CancellationOutcome> {
  const trigger = eventTrigger({ event, repository, fullRouting });
  if (trigger === null || repository === undefined) return { facts: null, plan: null, cancelled: [] };
  const facts = trigger === 'retarget'
    ? await collectRetargetFacts({ event, repository, request })
    : await collectSynchronizeFacts({ event, repository, request, trigger });
  const plan = deriveTupleLifecyclePlan(facts);
  const cancelled = plan.cancelRunIds.length === 0
    ? []
    : await cancelPlannedRuns({ pullRequest: event.pull_request, facts, plan, request });
  return { facts, plan, cancelled };
}

export function report({ plan, cancelled }: CancellationOutcome): string[] {
  if (plan === null) return [`No ${IOS_TESTS_WORKFLOW_NAME} cancellation rule applies to this event.`];
  const lines = [`${IOS_TESTS_WORKFLOW_NAME} ${plan.trigger ?? 'event'} plan for PR #${plan.tuple.pullRequest}: `
    + (plan.applicable ? 'decisions derived.' : `inapplicable (${plan.reasonCode}).`)];
  for (const decision of plan.decisions) {
    lines.push(`run ${decision.runId} at ${decision.headSha.slice(0, 12)}: ${decision.disposition} (${decision.reasonCode})`);
  }
  for (const ignored of plan.ignoredRuns) lines.push(`run ${ignored.runId}: left alone (${ignored.reasonCode})`);
  lines.push(cancelled.length > 0
    ? `Cancelled ${IOS_TESTS_WORKFLOW_NAME} runs: ${cancelled.join(', ')}.`
    : `No ${IOS_TESTS_WORKFLOW_NAME} run required cancellation.`);
  return lines;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((outcome) => {
    for (const line of report(outcome)) console.log(line);
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

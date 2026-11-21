#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  equivalentEffectivePatch,
  isEligibleBaseUpdateCommit,
} from '../ios/baseUpdateDelta.ts';
import { loadStabilizedActionsInventory } from '../github/stabilizedActionsInventory.ts';
import { isReusableIosWorkflowLineage } from '../ios/workflowEvidenceInputs.ts';
import { workflowNames } from '../../../scripts/ci/generated/workflow-names.ts';

export interface GithubObject {
  readonly [key: string]: unknown;
  readonly id: number;
  readonly name: string;
  readonly number: number;
  readonly event: string;
  readonly state: string;
  readonly draft: boolean;
  readonly status: string;
  readonly conclusion: string | null;
  readonly sha: string;
  readonly ref: string;
  readonly full_name: string;
  readonly head_sha: string;
  readonly created_at: string;
  readonly total_count: number;
  readonly head: GithubObject;
  readonly base: GithubObject;
  readonly repo: GithubObject;
  readonly repository: GithubObject;
  readonly pull_request: GithubObject;
  readonly workflow_run: GithubObject;
  readonly merge_base_commit: GithubObject;
  readonly parents: readonly GithubObject[];
  readonly pull_requests: readonly GithubObject[];
  readonly workflow_runs: readonly GithubObject[];
  readonly jobs: readonly GithubObject[];
  readonly steps: readonly GithubObject[];
  readonly files: readonly GithubObject[];
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT';
  readonly token?: string;
  readonly body?: Readonly<Record<string, unknown>>;
}
type GithubRequest = (path: string, options?: RequestOptions) => Promise<GithubObject>;

interface RetainedEvidence {
  readonly predecessorRunId: number;
  readonly deferredBaseSha: string;
  readonly predecessorRunIds?: readonly number[];
}

interface ResumeMainOptions {
  readonly event?: GithubObject;
  readonly eventName?: string;
  readonly repository?: string;
  readonly updateToken?: string;
  readonly request?: GithubRequest;
  readonly refreshTarget?: (
    pullRequest: GithubObject,
    options: { readonly eventToken: string; readonly validateTargetSha: (targetSha: string) => Promise<boolean> },
  ) => Promise<boolean>;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

// The workflow whose completed runs trigger this handler, named by the
// definition that renders it rather than restated here.
const IOS_TESTS_WORKFLOW_NAME = workflowNames['ios-tests'].workflow;
const SHA = /^[a-f0-9]{40}$/;
const API_VERSION = '2022-11-28';
async function githubRequest(path: string, {
  method = 'GET', token = process.env.GITHUB_TOKEN, body,
}: RequestOptions = {}): Promise<GithubObject> {
  if (!token) throw new Error('GitHub token is required.');
  const response = await fetch(
    `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${process.env.GITHUB_REPOSITORY}/${path}`,
    {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-GitHub-Api-Version': API_VERSION,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (response.status === 204 || response.status === 201 || response.status === 202) return {} as GithubObject;
  if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}.`);
  return await response.json() as GithubObject;
}

function sameCurrentPull(expected: GithubObject, current: GithubObject): boolean {
  return current?.number === expected.number
    && current.state === 'open'
    && current.draft === false
    && current.head?.sha === expected.head.sha
    && current.head?.repo?.full_name === expected.head.repo.full_name
    && current.base?.sha === expected.base.sha
    && current.base?.ref === expected.base.ref
    && current.base?.repo?.full_name === expected.base.repo.full_name;
}

export async function loadWorkflowRunsForHead(request: GithubRequest, headSha: string): Promise<GithubObject[]> {
  const path = `actions/runs?event=pull_request&head_sha=${headSha}&per_page=100`;
  return await loadStabilizedActionsInventory<GithubObject>({
    label: `workflow-run evidence for ${headSha}`,
    loadPage: page => request(page === 1 ? path : `${path}&page=${page}`),
    selectItems: listing => listing?.workflow_runs,
  });
}

/** A queued current-head run will classify the predecessor after serialization releases it. */
export function hasActiveCurrentHeadIosRun(
  runs: readonly GithubObject[], headSha: string, pullNumber: number, completedRunId: number,
): boolean {
  return runs.some(run => run?.id !== completedRunId
    && run?.name === IOS_TESTS_WORKFLOW_NAME
    && run?.event === 'pull_request'
    && run?.head_sha === headSha
    && run?.status !== 'completed'
    && Array.isArray(run?.pull_requests)
    && run.pull_requests.some(candidate => candidate?.number === pullNumber));
}

export async function loadWorkflowJobs(request: GithubRequest, runId: number): Promise<GithubObject[]> {
  const path = `actions/runs/${runId}/jobs?filter=latest&per_page=100`;
  return await loadStabilizedActionsInventory<GithubObject>({
    label: `workflow job evidence for run ${runId}`,
    loadPage: page => request(page === 1 ? path : `${path}&page=${page}`),
    selectItems: listing => listing?.jobs,
  });
}

// The job display name stays static and human-readable (the ios-tests.yml
// job's `name:` field), so the retained predecessor identity is encoded in
// this step's name instead, where GitHub still renders the interpolated
// expression per run. Runs recorded before this job name became static (PR
// #5548's dynamic job name, replaced above) carry the identical marker text
// as the job name itself instead; a PR workflow can still be running that
// older shape when this controller reaches the default branch, so both
// shapes must keep resolving.
export const AWAIT_RETAINED_IOS_PREDECESSOR_JOB_NAME =
  workflowNames['ios-tests'].jobs['await-retained-ios-predecessor'].name;

// Both shapes spell the job's own name and then the identity: the current
// marker step appends it to that name, and the historical dynamic job name
// carried the same text. Building the matcher from the published name is what
// makes a rename of the job rename both, instead of leaving this behind.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKER_TEXT = new RegExp(
  `^${escapeRegExp(AWAIT_RETAINED_IOS_PREDECESSOR_JOB_NAME)}`
  + ' \\(([1-9][0-9]*) at ([a-f0-9]{40})\\)(?: \\[ancestors: (\\[[0-9,]*\\])\\])?$',
);

function parseMarkerText(name: string | undefined): RetainedEvidence | null {
  const match = MARKER_TEXT.exec(name ?? '');
  if (!match) return null;
  const predecessorRunId = Number(match[1]);
  let ids: unknown;
  try { ids = match[3] ? JSON.parse(match[3]) : [predecessorRunId]; } catch { return null; }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || ids[0] !== predecessorRunId
    || new Set(ids).size !== ids.length
    || ids.some((id: unknown) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) return null;
  return { predecessorRunId, deferredBaseSha: match[2]!,
    ...(match[3] ? { predecessorRunIds: ids } : {}) };
}

// A job identifies retained-predecessor evidence in exactly one of two
// shapes: the current static job name with the marker on its single step, or
// the historical dynamic job name carrying the same marker text directly. A
// job matching neither is unrelated and must not be inspected further, so a
// coincidentally marker-shaped step on some other job never resolves.
function markerForJob(job: GithubObject): RetainedEvidence | null {
  if (job?.status !== 'completed' || job?.conclusion !== 'success') return null;
  if (job?.name === AWAIT_RETAINED_IOS_PREDECESSOR_JOB_NAME) {
    return (Array.isArray(job?.steps) ? job.steps : [])
      .map(step => parseMarkerText(step?.name))
      .find((candidate): candidate is RetainedEvidence => candidate !== null) ?? null;
  }
  return parseMarkerText(job?.name);
}

export function deferredPredecessor(jobs: readonly GithubObject[] | undefined): RetainedEvidence | null {
  const matches = (Array.isArray(jobs) ? jobs : []).flatMap(job => {
    const marker = markerForJob(job);
    return marker ? [marker] : [];
  });
  if (matches.length !== 1) return null;
  const [match] = matches;
  return match !== undefined && Number.isSafeInteger(match.predecessorRunId) ? match : null;
}

export const deferredPredecessorId = (jobs: readonly GithubObject[] | undefined): number | null => deferredPredecessor(jobs)?.predecessorRunId ?? null;

export function selectDeferredIosRun({
  eventName, workflowRun, repository, currentPull, currentCommit,
  priorBaseComparison, currentEffectiveComparison, priorEffectiveComparison,
  currentRuns, jobsByRunId,
}: { eventName: string; workflowRun: GithubObject; repository: string; currentPull: GithubObject; currentCommit: GithubObject; priorBaseComparison: GithubObject; currentEffectiveComparison: GithubObject; priorEffectiveComparison: GithubObject; currentRuns: readonly GithubObject[]; jobsByRunId: Readonly<Record<number, readonly GithubObject[]>> }): (RetainedEvidence & { run: GithubObject }) | null {
  if (eventName !== 'workflow_run'
    || workflowRun?.name !== IOS_TESTS_WORKFLOW_NAME
    || workflowRun?.event !== 'pull_request'
    || workflowRun?.status !== 'completed'
    || !Number.isInteger(workflowRun?.id)
    || !SHA.test(workflowRun?.head_sha ?? '')
    || workflowRun?.repository?.full_name !== repository
    || !Array.isArray(workflowRun?.pull_requests)
    || workflowRun.pull_requests.length !== 1
    || !Number.isInteger(workflowRun.pull_requests[0]?.number)) return null;

  const number = workflowRun.pull_requests[0].number;
  const selected = (Array.isArray(currentRuns) ? currentRuns : [])
    .flatMap(run => {
      if (run?.name !== IOS_TESTS_WORKFLOW_NAME
        || run?.event !== 'pull_request'
        || run?.status !== 'completed'
        || run?.conclusion !== 'failure'
        || run?.head_sha !== currentPull?.head?.sha
        || !Number.isInteger(run?.id)
        || run.id === workflowRun.id
        || !Array.isArray(run?.pull_requests)
        || !run.pull_requests.some((candidate: GithubObject) => candidate?.number === number)
        || !Array.isArray(jobsByRunId?.[run.id])) return [];
      const evidence = deferredPredecessor(jobsByRunId[run.id]);
      if (evidence === null) return [];
      return (evidence.predecessorRunIds ?? [evidence.predecessorRunId]).includes(workflowRun.id) ? [{ run, ...evidence }] : [];
    })
    .sort((left, right) => Date.parse(right.run.created_at) - Date.parse(left.run.created_at))[0];
  if (!selected) return null;
  if (currentPull?.number !== number
    || currentPull.state !== 'open'
    || currentPull.draft !== false
    || currentPull.head?.repo?.full_name !== repository
    || currentPull.base?.repo?.full_name !== repository
    || !SHA.test(currentPull.head?.sha ?? '')
    || !SHA.test(currentPull.base?.sha ?? '')
    || currentPull.head.sha === workflowRun.head_sha
    || !isEligibleBaseUpdateCommit({
      commit: currentCommit,
      pullRequest: currentPull,
      firstParent: workflowRun.head_sha,
      baseParent: selected.deferredBaseSha,
    })) return null;

  const oldBase = priorBaseComparison?.merge_base_commit?.sha;
  if (!SHA.test(oldBase ?? '')
    || currentEffectiveComparison?.merge_base_commit?.sha !== selected.deferredBaseSha
    || !['ahead', 'identical'].includes(currentEffectiveComparison?.status)
    || priorEffectiveComparison?.merge_base_commit?.sha !== oldBase
    || !['ahead', 'identical'].includes(priorEffectiveComparison?.status)
    || !equivalentEffectivePatch(
      currentEffectiveComparison?.files, priorEffectiveComparison?.files,
    )) return null;

  return selected;
}

async function isVerifiedAncestor({ currentCommit, currentPull, predecessorHead, deferredBaseSha, request }: { currentCommit: GithubObject; currentPull: GithubObject; predecessorHead: string; deferredBaseSha: string; request: GithubRequest }): Promise<boolean> {
  let commit = currentCommit;
  for (let depth = 0; depth < 20; depth += 1) {
    if (!isEligibleBaseUpdateCommit({ commit, pullRequest: currentPull,
      ...(depth === 0 ? { baseParent: deferredBaseSha } : {}) })) return false;
    const parent = commit.parents?.[0]?.sha;
    if (parent === predecessorHead) return true;
    if (!SHA.test(parent ?? '')) return false;
    commit = await request(`commits/${parent}`);
    if (commit?.sha !== parent) return false;
  }
  return false;
}

const MAX_LINEAGE_HOP_DEPTH = 20;

// A single oldBase...deferredBaseSha comparison covers every base change
// since the predecessor ran. A deferral that outlives several base updates
// can accumulate enough cumulative churn to exceed GitHub's usable
// comparison size even though every individual base-update hop that produced
// it was small and already verified as patch-equivalent when it happened.
// Replay that same bounded, hop-by-hop verification here instead of trusting
// one comparison that can no longer be evaluated.
export async function hopByHopLineageEquivalence({
  currentCommit, currentPull, deferredBaseSha, currentEffectiveComparison,
  predecessorHead, oldBase, priorEffectiveComparison, request,
}: { currentCommit: GithubObject; currentPull: GithubObject; deferredBaseSha: string; currentEffectiveComparison: GithubObject; predecessorHead: string; oldBase: string; priorEffectiveComparison: GithubObject; request: GithubRequest }): Promise<boolean> {
  let candidateCommit = currentCommit;
  let candidateBaseSha = deferredBaseSha;
  let candidateEffectiveComparison = currentEffectiveComparison;
  for (let depth = 0; depth < MAX_LINEAGE_HOP_DEPTH; depth += 1) {
    if (!isEligibleBaseUpdateCommit({
      commit: candidateCommit, pullRequest: currentPull,
      ...(depth === 0 ? { baseParent: deferredBaseSha } : {}),
    })) return false;
    const parentHead = candidateCommit.parents?.[0]?.sha;
    const parentBase = candidateCommit.parents?.[1]?.sha;
    if (!SHA.test(parentHead ?? '') || !SHA.test(parentBase ?? '')
      || parentBase !== candidateBaseSha) return false;
    const hopBaseComparison = await request(`compare/${parentBase}...${parentHead}`);
    const hopOldBase = hopBaseComparison?.merge_base_commit?.sha;
    if (!SHA.test(hopOldBase ?? '')) return false;
    const loadHopLineage = () => (hopOldBase === candidateBaseSha
      ? Promise.resolve({ status: 'identical', merge_base_commit: { sha: hopOldBase }, files: [] })
      : request(`compare/${hopOldBase}...${candidateBaseSha}`));
    if (parentHead === predecessorHead) {
      const hopLineageComparison = await loadHopLineage();
      return hopOldBase === oldBase
        && hopLineageComparison?.merge_base_commit?.sha === hopOldBase
        && ['ahead', 'identical'].includes(hopLineageComparison?.status)
        && await isReusableIosWorkflowLineage({ comparison: hopLineageComparison,
          priorHead: parentHead!, currentHead: candidateCommit.sha, read: (path) => request(path),
        })
        && equivalentEffectivePatch(
          candidateEffectiveComparison?.files, priorEffectiveComparison?.files, hopLineageComparison,
        );
    }
    const [hopEffectiveComparison, hopLineageComparison] = await Promise.all([
      request(`compare/${hopOldBase}...${parentHead}`), loadHopLineage(),
    ]);
    if (hopEffectiveComparison?.merge_base_commit?.sha !== hopOldBase
      || !['ahead', 'identical'].includes(hopEffectiveComparison?.status)
      || hopLineageComparison?.merge_base_commit?.sha !== hopOldBase
      || !['ahead', 'identical'].includes(hopLineageComparison?.status)
      || !await isReusableIosWorkflowLineage({ comparison: hopLineageComparison,
        priorHead: parentHead!, currentHead: candidateCommit.sha, read: (path) => request(path),
      })
      || !equivalentEffectivePatch(
        candidateEffectiveComparison?.files, hopEffectiveComparison?.files, hopLineageComparison,
      )) return false;
    const nextCommit = await request(`commits/${parentHead}`);
    if (nextCommit?.sha !== parentHead) return false;
    candidateCommit = nextCommit;
    candidateBaseSha = hopOldBase;
    candidateEffectiveComparison = hopEffectiveComparison;
  }
  return false;
}

async function completedRetainedRuns({ evidence, number, repository, request }: { evidence: RetainedEvidence; number: number; repository: string; request: GithubRequest }): Promise<GithubObject[] | null> {
  const ids = evidence.predecessorRunIds ?? [evidence.predecessorRunId];
  const runs = await Promise.all(ids.map(id => request(`actions/runs/${id}`)));
  return runs.every((run, index) => run?.id === ids[index]
    && run.status === 'completed' && run.name === IOS_TESTS_WORKFLOW_NAME
    && run.event === 'pull_request' && run.repository?.full_name === repository
    && run.pull_requests?.length === 1 && run.pull_requests[0]?.number === number)
    ? runs : null;
}

export async function refreshTargetBranchNative(
  pullRequest: GithubObject,
  {
    eventToken,
    validateTargetSha,
    request = githubRequest,
  }: { readonly eventToken: string; readonly validateTargetSha: (targetSha: string) => Promise<boolean>; readonly request?: GithubRequest },
): Promise<boolean> {
  if (!allowsAutomaticTargetRefresh(pullRequest)) return false;
  const target = await request(`branches/${encodeURIComponent(pullRequest.base.ref)}`);
  const targetCommit = target['commit'] as GithubObject | undefined;
  const targetSha = targetCommit?.sha;
  if (typeof targetSha !== 'string' || !SHA.test(targetSha)) {
    throw new Error(`Current target branch ${pullRequest.base.ref} is unavailable.`);
  }
  if (!await validateTargetSha(targetSha)) {
    throw new Error(`Current target branch ${pullRequest.base.ref} at ${targetSha} failed caller validation.`);
  }
  const comparison = await request(
    `compare/${encodeURIComponent(targetSha)}...${encodeURIComponent(pullRequest.head.sha)}`,
  );
  if (comparison.status === 'ahead' || comparison.status === 'identical') return false;
  if (comparison.status !== 'behind' && comparison.status !== 'diverged') {
    throw new Error(`GitHub returned unknown target-update status ${comparison.status}.`);
  }
  const current = await request(`pulls/${pullRequest.number}`);
  if (!sameCurrentPull(pullRequest, current)) {
    throw new Error(`PR #${pullRequest.number} changed before its native target update.`);
  }
  await request(`pulls/${pullRequest.number}/update-branch`, {
    method: 'PUT',
    token: eventToken,
    body: { expected_head_sha: pullRequest.head.sha },
  });
  return true;
}

/**
 * Production promotions are immutable snapshots of develop. Updating either
 * the mutable develop-to-main PR or an immutable promotion/develop-* checkpoint
 * from main would change the snapshot being promoted, so those PRs advance by
 * creating a new checkpoint instead of accepting a native target refresh.
 */
export function allowsAutomaticTargetRefresh(pullRequest: GithubObject): boolean {
  const headRef = pullRequest?.head?.ref ?? '';
  const headRepository = pullRequest?.head?.repo?.full_name;
  const baseRepository = pullRequest?.base?.repo?.full_name;
  const sameRepository = typeof headRepository === 'string'
    && headRepository.length > 0
    && headRepository === baseRepository;
  const mutablePromotion = sameRepository
    && pullRequest?.base?.ref === 'main'
    && headRef === 'develop';
  const immutableCheckpoint = sameRepository
    && /^promotion\/develop-[a-f0-9]{40}$/.test(headRef);
  return !mutablePromotion && !immutableCheckpoint;
}

export async function main({
  event = JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')) as GithubObject,
  eventName = process.env.GITHUB_EVENT_NAME,
  repository = process.env.GITHUB_REPOSITORY,
  updateToken = process.env.GITHUB_EVENT_TOKEN,
  request = githubRequest,
  refreshTarget = refreshTargetBranchNative,
}: ResumeMainOptions = {}): Promise<number | null> {
  const workflowRun = event?.workflow_run;
  if (eventName !== 'workflow_run' || workflowRun?.name !== IOS_TESTS_WORKFLOW_NAME
    || workflowRun?.event !== 'pull_request' || workflowRun?.status !== 'completed'
    || workflowRun?.repository?.full_name !== repository
    || workflowRun?.pull_requests?.length !== 1) return null;
  const number = workflowRun.pull_requests[0]?.number;
  if (!Number.isInteger(number)) return null;

  const currentPull = await request(`pulls/${number}`);
  if (currentPull?.number !== number
    || currentPull.state !== 'open'
    || currentPull.draft !== false
    || currentPull.head?.repo?.full_name !== repository
    || currentPull.base?.repo?.full_name !== repository) return null;
  let predecessorRun = workflowRun;
  let immediateDeferredRun = null;
  let deferredBaseSha = null;
  if (currentPull?.head?.sha === workflowRun.head_sha) {
    const triggerJobs = await loadWorkflowJobs(request, workflowRun.id);
    const evidence = deferredPredecessor(triggerJobs);
    if (!evidence) return null;
    const retainedRuns = await completedRetainedRuns({ evidence, number, repository, request });
    if (!retainedRuns) return null;
    predecessorRun = retainedRuns.at(-1)!;
    immediateDeferredRun = workflowRun;
    deferredBaseSha = evidence.deferredBaseSha;
  }
  const currentCommit = await request(`commits/${currentPull.head.sha}`);
  const currentRuns = await loadWorkflowRunsForHead(request, currentPull.head.sha);
  if (hasActiveCurrentHeadIosRun(currentRuns, currentPull.head.sha, number, workflowRun.id)) {
    console.log(`A current-head iOS run for PR #${number} is already pending or running.`);
    return null;
  }
  const jobsByRunId = Object.fromEntries(await Promise.all(currentRuns
    .filter(run => run?.name === IOS_TESTS_WORKFLOW_NAME
      && run?.event === 'pull_request'
      && run?.status === 'completed'
      && run?.conclusion === 'failure'
      && run?.head_sha === currentPull.head.sha
      && Number.isInteger(run?.id)
      && Array.isArray(run?.pull_requests)
      && run.pull_requests.some((candidate: GithubObject) => candidate?.number === number))
    .map(async run => {
      const jobs = await loadWorkflowJobs(request, run.id);
      return [run.id, jobs];
    })));
  let deferredRun = immediateDeferredRun;
  if (!deferredRun) {
    const selected = currentRuns
      .flatMap(run => {
        if (run?.name !== IOS_TESTS_WORKFLOW_NAME
          || run?.event !== 'pull_request'
          || run?.status !== 'completed'
          || run?.conclusion !== 'failure'
          || run?.head_sha !== currentPull.head.sha
          || !Number.isInteger(run?.id)
          || run.id === predecessorRun.id
          || !Array.isArray(run?.pull_requests)
          || !run.pull_requests.some((candidate: GithubObject) => candidate?.number === number)) return [];
        const evidence = deferredPredecessor(jobsByRunId?.[run.id]);
        if (evidence === null) return [];
        return (evidence.predecessorRunIds ?? [evidence.predecessorRunId]).includes(predecessorRun.id) ? [{ run, ...evidence }] : [];
      })
      .sort((left, right) => Date.parse(right.run.created_at) - Date.parse(left.run.created_at))[0];
    if (!selected) return null;
    if (selected.predecessorRunIds) {
      const retainedRuns = await completedRetainedRuns({ evidence: selected, number, repository, request });
      if (!retainedRuns) return null;
      predecessorRun = retainedRuns.at(-1)!;
    }
    deferredRun = selected.run;
    deferredBaseSha = selected.deferredBaseSha;
  }
  if (typeof deferredBaseSha !== 'string' || !SHA.test(deferredBaseSha) || !await isVerifiedAncestor({
    currentCommit, currentPull, predecessorHead: predecessorRun.head_sha, deferredBaseSha, request,
  })) return null;

  const priorBaseComparison = await request(`compare/${deferredBaseSha}...${predecessorRun.head_sha}`);
  const oldBase = priorBaseComparison?.merge_base_commit?.sha;
  if (typeof oldBase !== 'string' || !SHA.test(oldBase)) return null;
  const [currentEffectiveComparison, priorEffectiveComparison] = await Promise.all([
    request(`compare/${deferredBaseSha}...${currentPull.head.sha}`),
    request(`compare/${oldBase}...${predecessorRun.head_sha}`),
  ]);
  let equivalentPatch = false;
  if (oldBase === deferredBaseSha) {
    equivalentPatch = equivalentEffectivePatch(
      currentEffectiveComparison?.files, priorEffectiveComparison?.files,
    );
  } else {
    const baseLineageComparison = await request(`compare/${oldBase}...${deferredBaseSha}`);
    const completeLineagePaths = Array.isArray(baseLineageComparison?.files)
      && baseLineageComparison.files.length < 300
      && baseLineageComparison.files.every(file => (
        typeof file?.filename === 'string' && file.filename.length > 0
      ));
    const reusableLineage = await isReusableIosWorkflowLineage({ comparison: baseLineageComparison,
      priorHead: predecessorRun.head_sha, currentHead: currentPull.head.sha, read: (path) => request(path),
    });
    if (completeLineagePaths && !reusableLineage) return null;
    equivalentPatch = baseLineageComparison?.merge_base_commit?.sha === oldBase
      && reusableLineage
      && equivalentEffectivePatch(
        currentEffectiveComparison?.files,
        priorEffectiveComparison?.files,
        baseLineageComparison,
      );
    if (!equivalentPatch) {
      equivalentPatch = await hopByHopLineageEquivalence({
        currentCommit, currentPull, deferredBaseSha, currentEffectiveComparison,
        predecessorHead: predecessorRun.head_sha, oldBase, priorEffectiveComparison, request,
      });
    }
  }
  if (currentEffectiveComparison?.merge_base_commit?.sha !== deferredBaseSha
    || !['ahead', 'identical'].includes(currentEffectiveComparison?.status)
    || priorEffectiveComparison?.merge_base_commit?.sha !== oldBase
    || !['ahead', 'identical'].includes(priorEffectiveComparison?.status)
    || !equivalentPatch) return null;

  const latestPull = await request(`pulls/${number}`);
  if (!sameCurrentPull(currentPull, latestPull)) {
    throw new Error(`PR #${number} changed before retained iOS work could be resumed.`);
  }
  if (currentPull.base.sha !== deferredBaseSha) {
    const baseAdvancement = await request(`compare/${deferredBaseSha}...${currentPull.base.sha}`);
    if (baseAdvancement?.merge_base_commit?.sha !== deferredBaseSha
      || !['ahead', 'identical'].includes(baseAdvancement?.status)) {
      throw new Error(`PR #${number} target moved non-linearly after iOS work was deferred.`);
    }
    if (!allowsAutomaticTargetRefresh(currentPull)) {
      console.log(`Skipped target refresh for immutable promotion PR #${number}.`);
      return null;
    }
    if (!updateToken) {
      throw new Error(`A scoped GitHub App token is required to update PR #${number} and trigger replacement CI.`);
    }
    const updated = await refreshTarget(currentPull, {
      eventToken: updateToken,
      validateTargetSha: async targetSha => {
        const targetAdvancement = await request(`compare/${deferredBaseSha}...${targetSha}`);
        if (targetAdvancement?.merge_base_commit?.sha !== deferredBaseSha
          || !['ahead', 'identical'].includes(targetAdvancement?.status)) {
          throw new Error(`PR #${number} target moved non-linearly before its exact update.`);
        }
        return true;
      },
    });
    if (!updated) throw new Error(`Exact target update for PR #${number} was not applied.`);
    console.log(`Updated PR #${number} from the exact current target before resuming retained iOS evidence.`);
    return null;
  }
  const latestDeferredRun = await request(`actions/runs/${deferredRun.id}`);
  if (latestDeferredRun?.status !== 'completed'
    || latestDeferredRun?.conclusion !== 'failure'
    || latestDeferredRun?.head_sha !== currentPull.head.sha) {
    console.log(`Deferred iOS run ${deferredRun.id} was already resumed or replaced.`);
    return null;
  }
  const rerunPull = await request(`pulls/${number}`);
  if (!sameCurrentPull(currentPull, rerunPull)
    || rerunPull.base.sha !== deferredBaseSha) {
    throw new Error(`PR #${number} changed immediately before retained iOS work could be rerun.`);
  }
  await request(`actions/runs/${deferredRun.id}/rerun`, { method: 'POST' });
  console.log(`Reran deferred iOS run ${deferredRun.id} for PR #${number} after predecessor ${predecessorRun.id} completed.`);
  return deferredRun.id;
}


if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

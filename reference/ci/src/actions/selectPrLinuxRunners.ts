import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { workflowNames } from '../../../scripts/ci/generated/workflow-names.ts';
import {
  externalLinuxLaneMarker,
  hostedLinuxRunnerLabels,
  sharedDatabaseLinuxRunnerLabels,
  sharedPortableLinuxRunnerLabels,
  supportedPrLinuxRoutePairs,
  trustedControlLinuxRunnerLabels,
} from '../runnerPolicy.ts';

const PORTABLE_HEARTBEAT_JOB_NAME = workflowNames['linux-runner-heartbeat']
  .jobs['portable-heartbeat'].name;
const DATABASE_HEARTBEAT_JOB_NAME = workflowNames['linux-runner-heartbeat']
  .jobs['database-heartbeat'].name;
const HOSTED_ADMISSION_WORKFLOW_NAME = workflowNames['hosted-linux-admission'].workflow;
const HOSTED_ADMISSION_JOB_NAME = workflowNames['hosted-linux-admission'].jobs.probe.name;
const HOSTED_ADMISSION_WORKFLOW = 'hosted-linux-admission.yml';
// Hosted Linux admission (GitHub billing and platform availability) changes on
// an hours scale, while GitHub may delay a dispatched probe when Actions is busy.
const HOSTED_ADMISSION_MAX_AGE_MS = 60 * 60 * 1000;
const HOSTED_ADMISSION_RUN_PAGE_SIZE = 10;
const JOB_LISTING_PAGE_SIZE = 100;
const JOB_LISTING_MAX_PAGES = 10;
const HOSTED_FAILURE_RETRY_AGE_MS = 15 * 60 * 1000;
const HOSTED_PROBE_POLL_ATTEMPTS = 6;
const HOSTED_PROBE_POLL_INTERVAL_MS = 2_000;
const HOSTED_PROBE_POLL_REQUEST_TIMEOUT_MS = 4_000;
const EXTERNAL_HEARTBEAT_MAX_AGE_MS = 15 * 60 * 1000;
// Inventory reads share the repository's GITHUB_TOKEN rate limit with every
// concurrent planner, so active runs are read in small batches, stopping once
// both roles are proven busy.
const ACTIVE_RUN_BATCH_SIZE = 10;
const MAX_ACTIVE_RUNS_INSPECTED = 40;
export const GITHUB_REQUEST_TIMEOUT_MS = 20_000;

const hostedDefault = hostedLinuxRunnerLabels;
const portableDefault = sharedPortableLinuxRunnerLabels;
const databaseDefault = sharedDatabaseLinuxRunnerLabels;
const externalLaneMarker = externalLinuxLaneMarker;
const trustedControlMarker = trustedControlLinuxRunnerLabels;

/** Refuse an incomplete job listing rather than infer hosted capacity from partial evidence. */
async function readCompleteListing<T>(
  readPage: (page: number) => Promise<T>,
  itemCount: (page: T) => number,
): Promise<T[]> {
  const pages: T[] = [];
  for (let page = 1; page <= JOB_LISTING_MAX_PAGES; page += 1) {
    const current = await readPage(page);
    pages.push(current);
    if (itemCount(current) < JOB_LISTING_PAGE_SIZE) return pages;
  }
  throw new Error(`listing has more than ${JOB_LISTING_MAX_PAGES} pages; refusing a partial list`);
}

type CapacityState = 'idle' | 'busy' | 'unknown';
type InventorySource = 'active' | 'heartbeat-completed' | 'recent-work-completed';

interface WorkflowStep {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
}

export interface WorkflowJob {
  readonly id?: number;
  readonly run_attempt?: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly runner_name?: string | null;
  readonly labels?: readonly unknown[];
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly steps?: readonly WorkflowStep[];
  readonly workflowRun?: WorkflowRun;
}

export interface WorkflowRun {
  readonly id: number | string;
  readonly run_attempt?: number;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly event?: string;
  readonly head_branch?: string;
}

interface AnnotatedJob extends WorkflowJob {
  readonly runId: number | string;
  readonly inventorySource: InventorySource;
  readonly workflowRun: WorkflowRun;
}

export interface RoleEvidence {
  readonly state: CapacityState;
  readonly reason: string;
  readonly runnerName?: string;
}

export interface ExternalCapacity {
  readonly portable: RoleEvidence;
  readonly database: RoleEvidence;
}

export interface JsonResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
}

export type ApiRequest = (url: string, init?: RequestInit) => Promise<JsonResponse>;

interface SelectorResolution {
  readonly checks: readonly string[];
  readonly database: readonly string[];
  readonly usedFallback: boolean;
  readonly reason: string;
}

export interface HostedAdmission {
  readonly available: boolean;
  readonly reason: string;
  /** When GitHub allocated the hosted runner behind this evidence. */
  readonly admittedAt?: number;
}

export interface HostedProbeInspection {
  readonly admission: HostedAdmission;
  readonly run?: WorkflowRun;
  readonly pending: boolean;
}

function parsedLabels(value: unknown): string[] | undefined {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(parsed) && parsed.length > 0
      && parsed.every((label): label is string =>
        typeof label === 'string' && label.length > 0)) return parsed;
  } catch {
    // The caller chooses the fail-closed route and reports the configuration reason.
  }
  return undefined;
}

function normalizedLabels(subjectLabels: unknown): Set<string> {
  if (!Array.isArray(subjectLabels)) return new Set();
  return new Set(subjectLabels.map((label) => {
    if (typeof label === 'string') return label.toLowerCase();
    if (typeof label === 'object' && label !== null && 'name' in label
      && typeof label.name === 'string') return label.name.toLowerCase();
    return String(label).toLowerCase();
  }));
}

export function selectorMatchesLabels(
  subjectLabels: unknown,
  selector: readonly string[],
): boolean {
  const normalized = normalizedLabels(subjectLabels);
  return selector.every(label => normalized.has(label.toLowerCase()));
}

function sameLabelSet(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizedLabels(left);
  const normalizedRight = normalizedLabels(right);
  return normalizedLeft.size === normalizedRight.size
    && [...normalizedLeft].every(label => normalizedRight.has(label));
}

function supportedRoutePair(
  checks: readonly string[],
  database: readonly string[],
): typeof supportedPrLinuxRoutePairs[number] | undefined {
  return supportedPrLinuxRoutePairs.find(route =>
    sameLabelSet(checks, route.portable) && sameLabelSet(database, route.database));
}

export function resolvePrLinuxRoleLabels({
  checkLabels,
  databaseLabels,
}: {
  readonly checkLabels?: unknown;
  readonly databaseLabels?: unknown;
}): SelectorResolution {
  const checks = parsedLabels(checkLabels);
  const database = parsedLabels(databaseLabels);
  if (checks === undefined || !supportedPrLinuxRoutePairs.some(route =>
    sameLabelSet(checks, route.portable))) {
    return {
      checks: portableDefault,
      database: databaseDefault,
      usedFallback: true,
      reason: 'portable-selector-invalid',
    };
  }
  if (database === undefined || !supportedPrLinuxRoutePairs.some(route =>
    sameLabelSet(database, route.database))) {
    return {
      checks: portableDefault,
      database: databaseDefault,
      usedFallback: true,
      reason: 'database-selector-invalid',
    };
  }
  const route = supportedRoutePair(checks, database);
  if (route === undefined) {
    return {
      checks: portableDefault,
      database: databaseDefault,
      usedFallback: true,
      reason: 'role-selectors-not-compatible',
    };
  }
  return {
    checks,
    database,
    usedFallback: false,
    reason: route.kind === 'dedicated' ? 'explicit-role-selectors' : 'shared-portable-lane',
  };
}

export function evaluateHostedAdmission({
  run,
  jobs,
  now = Date.now(),
  maxAgeMs = HOSTED_ADMISSION_MAX_AGE_MS,
  expectedLabels = hostedDefault,
}: {
  readonly run?: WorkflowRun;
  readonly jobs?: readonly WorkflowJob[];
  readonly now?: number;
  readonly maxAgeMs?: number;
  readonly expectedLabels?: readonly string[];
}): HostedAdmission {
  if (run === undefined) return { available: false, reason: 'hosted-probe-missing' };
  if (run.status !== 'completed') return { available: false, reason: 'hosted-probe-incomplete' };
  if (run.conclusion !== 'success') return { available: false, reason: 'hosted-probe-failed' };

  const probe = (jobs ?? [])
    .find(job => job.name === HOSTED_ADMISSION_JOB_NAME);
  if (probe === undefined) return { available: false, reason: 'hosted-probe-job-missing' };
  if (probe.status !== 'completed' || probe.conclusion !== 'success') {
    return { available: false, reason: 'hosted-probe-job-failed' };
  }
  if (typeof probe.runner_name !== 'string' || probe.runner_name.trim() === '') {
    return { available: false, reason: 'hosted-probe-runnerless' };
  }
  if (!sameLabelSet(probe.labels, expectedLabels)) {
    return { available: false, reason: 'hosted-probe-label-mismatch' };
  }
  const successfulStep = (probe.steps ?? [])
    .some(step => step.status === 'completed' && step.conclusion === 'success');
  if (!successfulStep) return { available: false, reason: 'hosted-probe-step-missing' };

  const completedAt = Date.parse(probe.completed_at ?? run.updated_at ?? '');
  const age = now - completedAt;
  if (!Number.isFinite(completedAt) || age < 0 || age > maxAgeMs) {
    return { available: false, reason: 'hosted-probe-stale' };
  }
  return { available: true, reason: 'hosted-probe-fresh' };
}

function startedTimestamp(job: WorkflowJob): number {
  return Date.parse(job.started_at ?? '');
}

/**
 * Successful real work on the hosted route is admission evidence the cron
 * cannot delay. The evidence dates from runner allocation (`started_at`), not
 * completion: a long job admitted before a billing block proves nothing after it.
 */
export function evaluateRecentHostedWork({
  jobs,
  now = Date.now(),
  maxAgeMs = HOSTED_ADMISSION_MAX_AGE_MS,
  expectedLabels = hostedDefault,
}: {
  readonly jobs?: readonly WorkflowJob[];
  readonly now?: number;
  readonly maxAgeMs?: number;
  readonly expectedLabels?: readonly string[];
}): HostedAdmission {
  const candidates = [...(jobs ?? [])]
    .filter(job => job.status === 'completed'
      && job.conclusion === 'success'
      && sameLabelSet(job.labels, expectedLabels)
      && typeof job.runner_name === 'string'
      && job.runner_name.trim() !== ''
      && (job.steps ?? []).some(step => step.status === 'completed'
        && step.conclusion === 'success')
      && Number.isFinite(startedTimestamp(job)))
    .sort((left, right) => startedTimestamp(right) - startedTimestamp(left));
  const recent = candidates[0];
  if (recent === undefined) return { available: false, reason: 'hosted-recent-work-missing' };
  const admittedAt = startedTimestamp(recent);
  const age = now - admittedAt;
  if (age < 0 || age > maxAgeMs) {
    return { available: false, reason: 'hosted-recent-work-stale' };
  }
  return { available: true, reason: 'hosted-recent-work-fresh', admittedAt };
}

/**
 * Admit hosted overflow on a fresh probe, or on fresh successful hosted work
 * whose runner was allocated after any failed probe (a newer failure is a
 * billing signal).
 */
export function combineHostedAdmission({
  probe,
  probeRun,
  recentWork,
}: {
  readonly probe: HostedAdmission;
  readonly probeRun?: WorkflowRun;
  readonly recentWork?: HostedAdmission;
}): HostedAdmission {
  if (probe.available || recentWork?.available !== true) return probe;
  if (probe.reason === 'hosted-probe-failed') {
    const failedAt = Date.parse(probeRun?.updated_at ?? '');
    if (!Number.isFinite(failedAt) || failedAt >= (recentWork.admittedAt ?? 0)) return probe;
  }
  return recentWork;
}

function completedTimestamp(job: WorkflowJob): number {
  return Date.parse(job.completed_at ?? job.workflowRun?.updated_at ?? '');
}

export function evaluateExternalHeartbeat({
  jobs,
  jobName,
  expectedLabels,
  now = Date.now(),
  maxAgeMs = EXTERNAL_HEARTBEAT_MAX_AGE_MS,
}: {
  readonly jobs?: readonly WorkflowJob[];
  readonly jobName: string;
  readonly expectedLabels: readonly string[];
  readonly now?: number;
  readonly maxAgeMs?: number;
}): RoleEvidence {
  const candidates = [...(jobs ?? [])]
    .filter(job => job.name === jobName)
    .sort((left, right) => completedTimestamp(right) - completedTimestamp(left));
  const heartbeat = candidates[0];
  if (heartbeat === undefined) {
    return { state: 'unknown', reason: 'heartbeat-missing', runnerName: undefined };
  }
  if (!sameLabelSet(heartbeat.labels, expectedLabels)) {
    return { state: 'unknown', reason: 'heartbeat-selector-mismatch', runnerName: undefined };
  }
  if (heartbeat.status !== 'completed' || heartbeat.conclusion !== 'success') {
    return { state: 'unknown', reason: 'heartbeat-failed', runnerName: undefined };
  }
  if (typeof heartbeat.runner_name !== 'string' || heartbeat.runner_name.trim() === '') {
    return { state: 'unknown', reason: 'heartbeat-runnerless', runnerName: undefined };
  }
  const successfulStep = (heartbeat.steps ?? [])
    .some(step => step.status === 'completed' && step.conclusion === 'success');
  if (!successfulStep) {
    return { state: 'unknown', reason: 'heartbeat-step-missing', runnerName: undefined };
  }
  const completedAt = completedTimestamp(heartbeat);
  const age = now - completedAt;
  if (!Number.isFinite(completedAt) || age < 0 || age > maxAgeMs) {
    return { state: 'unknown', reason: 'heartbeat-stale', runnerName: undefined };
  }
  return {
    state: 'idle',
    reason: 'heartbeat-fresh',
    runnerName: heartbeat.runner_name,
  };
}

/** Completed work is fresher capacity evidence than a delayed scheduled heartbeat. */
export function evaluateRecentExternalWork({
  jobs,
  expectedLabels,
  now = Date.now(),
  maxAgeMs = EXTERNAL_HEARTBEAT_MAX_AGE_MS,
}: {
  readonly jobs?: readonly WorkflowJob[];
  readonly expectedLabels: readonly string[];
  readonly now?: number;
  readonly maxAgeMs?: number;
}): RoleEvidence {
  const candidates = [...(jobs ?? [])]
    .filter(job => job.status === 'completed'
      && job.conclusion === 'success'
      && selectorMatchesLabels(job.labels, expectedLabels)
      && typeof job.runner_name === 'string'
      && job.runner_name.trim() !== ''
      && (job.steps ?? []).some(step => step.status === 'completed'
        && step.conclusion === 'success'))
    .sort((left, right) => completedTimestamp(right) - completedTimestamp(left));
  const recent = candidates[0];
  if (recent === undefined) return { state: 'unknown', reason: 'recent-work-missing' };
  const age = now - completedTimestamp(recent);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    return { state: 'unknown', reason: 'recent-work-stale' };
  }
  return { state: 'idle', reason: 'recent-work-fresh', runnerName: recent.runner_name ?? undefined };
}

function busyRoleEvidence(reason: string): RoleEvidence {
  return { state: 'busy', reason, runnerName: undefined };
}

export function selectPrLinuxRunners({
  sameRepository,
  checkLabels,
  databaseLabels,
  hostedAvailable,
  externalCapacity,
  externalInventoryAvailable = true,
  externalInventorySaturated = false,
  externalProvenBusy = { portable: false, database: false },
}: {
  readonly sameRepository: boolean;
  readonly checkLabels?: unknown;
  readonly databaseLabels?: unknown;
  readonly hostedAvailable: boolean;
  readonly externalCapacity?: ExternalCapacity;
  readonly externalInventoryAvailable?: boolean;
  /** The inventory failed in a way (rate limit, timeout) that accompanies saturation. */
  readonly externalInventorySaturated?: boolean;
  /** Roles a failed inventory had already proven busy. */
  readonly externalProvenBusy?: RoleDemand;
}): {
  readonly checks: readonly string[];
  readonly database: readonly string[];
  readonly overflow: readonly string[];
  readonly reason: string;
} {
  const roleLabels = resolvePrLinuxRoleLabels({ checkLabels, databaseLabels });
  const { checks, database } = roleLabels;

  // Fork code never receives a persistent runner. A hosted outage therefore
  // remains a hosted-only block for forks rather than weakening isolation.
  if (!sameRepository) {
    return {
      checks: hostedDefault,
      database: hostedDefault,
      overflow: hostedDefault,
      reason: hostedAvailable ? 'fork-hosted-only' : 'fork-hosted-unavailable',
    };
  }

  // GitHub rejects inventory reads exactly when many planners and queued runs
  // compete for the API. With fresh hosted evidence, the portable and overflow
  // lanes take hosted capacity instead of queueing behind the saturated fleet.
  // The database role still moves only on positive busy evidence, which a
  // truncated scan may already hold.
  if (!externalInventoryAvailable && externalInventorySaturated && hostedAvailable) {
    return {
      checks: hostedDefault,
      database: externalProvenBusy.database ? hostedDefault : database,
      overflow: hostedDefault,
      reason: 'external-inventory-unavailable-hosted-overflow',
    };
  }

  const portableCapacity = externalCapacity?.portable
    ?? { state: 'unknown', reason: 'external-inventory-unavailable' };
  const databaseCapacity = externalCapacity?.database
    ?? { state: 'unknown', reason: 'external-inventory-unavailable' };
  // Unknown inventory or a missed heartbeat does not justify paid work. It
  // queues on the positive external selectors until evidence becomes legible.
  const hostedOverflowAllowed = hostedAvailable && externalInventoryAvailable;
  const portableBusy = portableCapacity.state === 'busy';
  const databaseBusy = databaseCapacity.state === 'busy';
  const checkRoute = hostedOverflowAllowed && portableBusy ? hostedDefault : checks;
  const databaseRoute = hostedOverflowAllowed && databaseBusy ? hostedDefault : database;
  // Overflow lanes are the bounded excess beyond the preferred external
  // route. Selection runs once before the fan-out queues, so pinning these
  // lanes to an idle external snapshot would serialize them after the first
  // preferred jobs occupy the fleet. Fresh hosted admission evidence is the contract
  // that permits this bounded paid fan-out; unknown inventory still fails
  // closed on the external selector.
  const overflowRoute = hostedOverflowAllowed && portableCapacity.state !== 'unknown'
    ? hostedDefault
    : checks;

  let reason: string;
  if (!externalInventoryAvailable) reason = 'external-inventory-unavailable';
  else if (portableBusy || databaseBusy) {
    reason = hostedAvailable ? 'external-busy-hosted-overflow' : 'hosted-admission-unavailable';
  } else if (portableCapacity.state === 'unknown' || databaseCapacity.state === 'unknown') {
    reason = 'external-heartbeat-unknown';
  } else reason = 'external-capacity-preferred';

  return {
    checks: checkRoute,
    database: databaseRoute,
    overflow: overflowRoute,
    reason,
  };
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function workflowRun(value: unknown): WorkflowRun {
  const candidate = record(value);
  if (candidate === undefined
    || (typeof candidate.id !== 'number' && typeof candidate.id !== 'string')) {
    throw new Error('workflow inventory contains an invalid run');
  }
  return {
    id: candidate.id,
    ...(typeof candidate.status === 'string' ? { status: candidate.status } : {}),
    ...(typeof candidate.conclusion === 'string' || candidate.conclusion === null
      ? { conclusion: candidate.conclusion }
      : {}),
    ...(typeof candidate.created_at === 'string' ? { created_at: candidate.created_at } : {}),
    ...(typeof candidate.updated_at === 'string' ? { updated_at: candidate.updated_at } : {}),
    ...(typeof candidate.event === 'string' ? { event: candidate.event } : {}),
    ...(typeof candidate.head_branch === 'string' ? { head_branch: candidate.head_branch } : {}),
  };
}

export function workflowRunsPayload(payload: unknown): WorkflowRun[] {
  const runs = record(payload)?.workflow_runs;
  if (!Array.isArray(runs)) {
    throw new Error('workflow inventory returned an invalid payload');
  }
  return runs.map(workflowRun);
}

function workflowStep(value: unknown): WorkflowStep {
  const candidate = record(value);
  if (candidate === undefined) throw new Error('job inventory contains an invalid step');
  return {
    ...(typeof candidate.status === 'string' ? { status: candidate.status } : {}),
    ...(typeof candidate.conclusion === 'string' || candidate.conclusion === null
      ? { conclusion: candidate.conclusion }
      : {}),
  };
}

function workflowJob(value: unknown): WorkflowJob {
  const candidate = record(value);
  if (candidate === undefined || typeof candidate.name !== 'string'
    || typeof candidate.status !== 'string') {
    throw new Error('job inventory contains an invalid job');
  }
  return {
    ...(typeof candidate.id === 'number' ? { id: candidate.id } : {}),
    name: candidate.name,
    status: candidate.status,
    ...(typeof candidate.conclusion === 'string' || candidate.conclusion === null
      ? { conclusion: candidate.conclusion }
      : {}),
    ...(typeof candidate.runner_name === 'string' || candidate.runner_name === null
      ? { runner_name: candidate.runner_name }
      : {}),
    ...(Array.isArray(candidate.labels) ? { labels: candidate.labels } : {}),
    ...(typeof candidate.started_at === 'string' || candidate.started_at === null
      ? { started_at: candidate.started_at }
      : {}),
    ...(typeof candidate.completed_at === 'string' || candidate.completed_at === null
      ? { completed_at: candidate.completed_at }
      : {}),
    ...(Array.isArray(candidate.steps)
      ? { steps: candidate.steps.map(workflowStep) }
      : {}),
  };
}

export function workflowJobsPayload(payload: unknown): WorkflowJob[] {
  const jobs = record(payload)?.jobs;
  if (!Array.isArray(jobs)) throw new Error('job inventory returned an invalid payload');
  return jobs.map(workflowJob);
}

/** Every GitHub request in this planner carries a bounded abort signal. */
export function boundedRequest(request: ApiRequest, timeoutMs: number): ApiRequest {
  return (url, init = {}) => request(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function requestTimedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

export async function inspectHostedAdmission({
  apiUrl,
  repository,
  defaultBranch,
  token,
  request = fetch,
  now = Date.now(),
}: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly token: string;
  readonly request?: ApiRequest;
  readonly now?: number;
}): Promise<HostedProbeInspection> {
  const branch = encodeURIComponent(defaultBranch);
  const runsResponse = await request(
    `${apiUrl}/repos/${repository}/actions/workflows/${HOSTED_ADMISSION_WORKFLOW}`
      + `/runs?branch=${branch}&per_page=${HOSTED_ADMISSION_RUN_PAGE_SIZE}`,
    { headers: apiHeaders(token) },
  );
  if (!runsResponse.ok) {
    throw new Error(`hosted admission inventory returned HTTP ${runsResponse.status}`);
  }
  const runs = workflowRunsPayload(await runsResponse.json());
  // Concurrent dispatches replace an older pending probe; that cancellation is
  // not hosted billing evidence, and a queued probe must not hide the newest
  // completed one.
  const pending = runs.some(run => run.status !== 'completed');
  const run = runs.find(candidate => candidate.status === 'completed'
    && candidate.conclusion !== 'cancelled');
  if (run === undefined) {
    return {
      admission: {
        available: false,
        reason: pending ? 'hosted-probe-incomplete' : 'hosted-probe-missing',
      },
      pending,
    };
  }
  if (run.conclusion !== 'success') {
    return { admission: evaluateHostedAdmission({ run, jobs: [], now }), run, pending };
  }
  const jobsResponse = await request(
    `${apiUrl}/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    { headers: apiHeaders(token) },
  );
  if (!jobsResponse.ok) {
    throw new Error(`hosted admission job inventory returned HTTP ${jobsResponse.status}`);
  }
  return {
    admission: evaluateHostedAdmission({
      run,
      jobs: workflowJobsPayload(await jobsResponse.json()),
      now,
    }),
    run,
    pending,
  };
}

function probeRefreshNeeded(inspection: HostedProbeInspection, now: number): boolean {
  if (inspection.pending) return false;
  const { reason } = inspection.admission;
  if (reason === 'hosted-probe-stale' || reason === 'hosted-probe-missing') return true;
  if (reason !== 'hosted-probe-failed') return false;
  const failedAt = Date.parse(inspection.run?.updated_at ?? '');
  return Number.isFinite(failedAt) && now - failedAt >= HOSTED_FAILURE_RETRY_AGE_MS;
}

/**
 * Read the newest probe state with a bounded request and settle it, so the
 * planner can start it alongside the external inventory. A token-wide rate
 * limit then fails both reads together, and no further request is needed to
 * decide admission.
 */
export async function readHostedProbe({
  apiUrl,
  repository,
  defaultBranch,
  token,
  request = fetch,
  now = Date.now(),
  timeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
}: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly token: string;
  readonly request?: ApiRequest;
  readonly now?: number;
  readonly timeoutMs?: number;
}): Promise<PromiseSettledResult<HostedProbeInspection>> {
  if (defaultBranch === '') {
    return { status: 'rejected', reason: new Error('REPOSITORY_DEFAULT_BRANCH is required') };
  }
  const [result] = await Promise.allSettled([inspectHostedAdmission({
    apiUrl, repository, defaultBranch, token, request: boundedRequest(request, timeoutMs), now,
  })]);
  return result;
}

/**
 * Decide admission from already-read evidence without further requests. A
 * probe that was read wins when it is fresh or when its failure is newer than
 * the hosted work. A probe that could not be read is unknown, not failed:
 * fresh hosted work alone then admits, because the read failure (usually the
 * shared token's rate limit) says nothing about hosted billing, while the
 * work proves GitHub allocated a hosted runner within the window.
 */
export function decideHostedAdmission({
  probe,
  recentWork,
}: {
  readonly probe: PromiseSettledResult<HostedProbeInspection>;
  readonly recentWork?: HostedAdmission;
}): HostedAdmission {
  if (probe.status === 'fulfilled') {
    return combineHostedAdmission({
      probe: probe.value.admission,
      ...(probe.value.run === undefined ? {} : { probeRun: probe.value.run }),
      ...(recentWork === undefined ? {} : { recentWork }),
    });
  }
  if (recentWork?.available === true) return recentWork;
  return {
    available: false,
    reason: requestTimedOut(probe.reason)
      ? 'hosted-admission-timeout'
      : 'hosted-probe-inventory-unavailable',
  };
}

/**
 * Decide admission and, when a busy fleet has no fresh evidence, request one
 * probe. A caller may briefly poll that probe to avoid queueing selected work
 * on saturated external Linux after hosted capacity becomes available. A
 * failed, unreadable, or delayed probe keeps the external route.
 */
export async function finishHostedAdmission({
  apiUrl,
  repository,
  defaultBranch,
  token,
  probe,
  recentWork,
  requestRefresh,
  waitForDispatchedProbe = false,
  pollDelay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  pollNow = Date.now,
  request = fetch,
  now = Date.now(),
  timeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
}: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly token: string;
  readonly probe: PromiseSettledResult<HostedProbeInspection>;
  readonly recentWork?: HostedAdmission;
  readonly requestRefresh: boolean;
  readonly waitForDispatchedProbe?: boolean;
  readonly pollDelay?: (milliseconds: number) => Promise<void>;
  readonly pollNow?: () => number;
  readonly request?: ApiRequest;
  readonly now?: number;
  readonly timeoutMs?: number;
}): Promise<HostedAdmission> {
  const admission = decideHostedAdmission({
    probe,
    ...(recentWork === undefined ? {} : { recentWork }),
  });
  if (probe.status === 'rejected') {
    console.warn(`Hosted admission probe unreadable: ${String(probe.reason)}`);
  }
  if (admission.available || !requestRefresh || probe.status === 'rejected'
    || !probeRefreshNeeded(probe.value, now)) {
    return admission;
  }
  const workReason = recentWork === undefined ? '' : `, ${recentWork.reason}`;
  console.log(`Hosted Linux admission needs fresh proof: ${admission.reason}${workReason}`);
  try {
    const response = await boundedRequest(request, timeoutMs)(
      `${apiUrl}/repos/${repository}/actions/workflows/${HOSTED_ADMISSION_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: defaultBranch }),
      },
    );
    if (!response.ok) {
      return { available: false, reason: `hosted-probe-dispatch-http-${response.status}` };
    }
  } catch (error: unknown) {
    console.warn(`Hosted admission probe dispatch failed: ${String(error)}`);
    const reason = requestTimedOut(error)
      ? 'hosted-probe-dispatch-timeout'
      : 'hosted-probe-dispatch-failed';
    return { available: false, reason };
  }
  console.log('Requested a hosted Linux admission probe.');
  if (waitForDispatchedProbe) {
    for (let attempt = 0; attempt < HOSTED_PROBE_POLL_ATTEMPTS; attempt += 1) {
      await pollDelay(HOSTED_PROBE_POLL_INTERVAL_MS);
      try {
        const refreshed = await inspectHostedAdmission({
          apiUrl, repository, defaultBranch, token,
          request: boundedRequest(request, Math.min(timeoutMs, HOSTED_PROBE_POLL_REQUEST_TIMEOUT_MS)),
          now: pollNow(),
        });
        if (refreshed.admission.available) return refreshed.admission;
        if (refreshed.admission.reason === 'hosted-probe-failed'
          || refreshed.admission.reason === 'hosted-probe-job-failed') return refreshed.admission;
      } catch (error: unknown) {
        console.warn(`Hosted admission probe refresh unreadable: ${String(error)}`);
      }
    }
  }
  return { available: false, reason: 'hosted-probe-refresh-requested' };
}

/** Read the probe, decide admission, and dispatch a probe when needed. */
export async function resolveHostedAdmission(input: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly token: string;
  readonly recentWork?: HostedAdmission;
  readonly requestRefresh: boolean;
  readonly request?: ApiRequest;
  readonly now?: number;
  readonly timeoutMs?: number;
}): Promise<HostedAdmission> {
  return finishHostedAdmission({ ...input, probe: await readHostedProbe(input) });
}

function externalJobRoles(
  job: WorkflowJob,
  checks: readonly string[],
  database: readonly string[],
): { readonly portable: boolean; readonly database: boolean } {
  // Workflow-jobs `labels` are the requested selector, not the labels carried
  // by the assigned runner. They can classify requested capacity, but must
  // never be copied into a synthetic runner inventory.
  if (selectorMatchesLabels(job.labels, trustedControlMarker)) {
    return { portable: false, database: false };
  }
  const portable = selectorMatchesLabels(job.labels, checks);
  const databaseRole = selectorMatchesLabels(job.labels, database);
  if (portable || databaseRole) return { portable, database: databaseRole };
  // A legacy broad lane request can consume either role, so reserve both.
  if (selectorMatchesLabels(job.labels, externalLaneMarker)) {
    return { portable: true, database: true };
  }
  return { portable: false, database: false };
}

function entryIsActive(job: AnnotatedJob): boolean {
  return job.inventorySource === 'active'
    && ['queued', 'in_progress'].includes(job.status);
}

export interface RoleDemand {
  readonly portable: boolean;
  readonly database: boolean;
}

function directRoleDemand(
  activeJobs: readonly AnnotatedJob[],
  checks: readonly string[],
  database: readonly string[],
): RoleDemand {
  let portable = false;
  let databaseRole = false;
  for (const job of activeJobs) {
    const roles = externalJobRoles(job, checks, database);
    portable ||= roles.portable;
    databaseRole ||= roles.database;
  }
  return { portable, database: databaseRole };
}

/** An unreadable external inventory, marked when the cause suggests CI saturation. */
export class ExternalInventoryError extends Error {
  readonly saturationLikely: boolean;
  /** Hosted admission evidence read independently of the failed capacity scan. */
  readonly recentHostedWork: HostedAdmission | undefined;
  /** Roles already proven busy before the scan failed; busy is monotonic. */
  readonly provenBusy: RoleDemand;

  constructor(
    message: string,
    saturationLikely: boolean,
    recentHostedWork?: HostedAdmission,
    provenBusy: RoleDemand = { portable: false, database: false },
  ) {
    super(message);
    this.name = 'ExternalInventoryError';
    this.saturationLikely = saturationLikely;
    this.recentHostedWork = recentHostedWork;
    this.provenBusy = provenBusy;
  }
}

async function readRecentPrWorkJobs({
  get,
  apiUrl,
  repository,
}: {
  readonly get: (url: string) => Promise<unknown>;
  readonly apiUrl: string;
  readonly repository: string;
}): Promise<AnnotatedJob[]> {
  const runs = workflowRunsPayload(await get(
    `${apiUrl}/repos/${repository}/actions/workflows/pr-checks.yml/runs`
      + '?status=completed&per_page=10&page=1',
  ));
  return (await Promise.all(runs.map(async (run) => {
    const jobs = await readCompleteListing(async (page) => workflowJobsPayload(await get(
      `${apiUrl}/repos/${repository}/actions/runs/${run.id}/jobs`
        + `?filter=latest&per_page=100&page=${page}`,
    )), pageJobs => pageJobs.length);
    return jobs.flat().map(job => ({
      ...job, runId: run.id, inventorySource: 'recent-work-completed' as const,
      workflowRun: run,
    }));
  }))).flat();
}

/** The same recent hosted-work proof used by the PR route, without its active-run scan. */
export async function inspectRecentHostedWork({
  apiUrl,
  repository,
  token,
  request = fetch,
  now = Date.now(),
  timeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
}: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly token: string;
  readonly request?: ApiRequest;
  readonly now?: number;
  readonly timeoutMs?: number;
}): Promise<HostedAdmission> {
  const bounded = boundedRequest(request, timeoutMs);
  const get = async (url: string): Promise<unknown> => {
    const response = await bounded(url, { headers: apiHeaders(token) });
    if (!response.ok) throw new Error(`recent PR work returned HTTP ${response.status}`);
    return response.json();
  };
  return evaluateRecentHostedWork({
    jobs: await readRecentPrWorkJobs({ get, apiUrl, repository }), now,
  });
}

function saturationStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

/** Rate limits, server errors, timeouts and truncated scans accompany saturated CI. */
export function inventoryFailureSuggestsSaturation(error: unknown): boolean {
  if (error instanceof ExternalInventoryError) return error.saturationLikely;
  return requestTimedOut(error);
}

export async function inspectExternalCapacity({
  apiUrl,
  repository,
  token,
  checkLabels,
  databaseLabels,
  request = fetch,
  now = Date.now(),
  excludeRunId,
  databaseRequired = true,
  timeoutMs = GITHUB_REQUEST_TIMEOUT_MS,
}: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly token: string;
  readonly checkLabels?: unknown;
  readonly databaseLabels?: unknown;
  readonly request?: ApiRequest;
  readonly now?: number;
  readonly timeoutMs?: number;
  /** The planner's own run releases its listener before dependent work starts. */
  readonly excludeRunId?: string;
  /** A plan without database work needs only portable demand to decide overflow. */
  readonly databaseRequired?: boolean;
}): Promise<{
  readonly roles: ExternalCapacity;
  readonly hasQueuedPortableWork: boolean;
  readonly hasQueuedDatabaseWork: boolean;
  readonly recentHostedWork: HostedAdmission;
}> {
  const resolved = resolvePrLinuxRoleLabels({ checkLabels, databaseLabels });
  const { checks, database } = resolved;
  const headers = apiHeaders(token);
  const bounded = boundedRequest(request, timeoutMs);
  const get = async (url: string): Promise<unknown> => {
    const response = await bounded(url, { headers });
    if (!response.ok) {
      throw new ExternalInventoryError(
        `external inventory returned HTTP ${response.status} for ${url}`,
        saturationStatus(response.status),
      );
    }
    return response.json();
  };
  const listRuns = async ({
    url,
    pageSize,
    paginate,
    source,
  }: {
    readonly url: string;
    readonly pageSize: number;
    readonly paginate: boolean;
    readonly source: InventorySource;
  }): Promise<{ readonly run: WorkflowRun; readonly source: InventorySource }[]> => {
    const listed: { readonly run: WorkflowRun; readonly source: InventorySource }[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const payload = await get(`${url}&per_page=${pageSize}&page=${page}`);
      const workflowRuns = workflowRunsPayload(payload);
      listed.push(...workflowRuns.map(run => ({ run, source })));
      if (!paginate || workflowRuns.length < pageSize) return listed;
    }
    // More than ten full pages of queued or running runs is saturation.
    throw new ExternalInventoryError(
      'active workflow inventory exceeded the pagination limit',
      true,
    );
  };
  const runJobs = async ({ run, source }: {
    readonly run: WorkflowRun;
    readonly source: InventorySource;
  }): Promise<AnnotatedJob[]> => {
    const jobs: WorkflowJob[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const pageJobs = workflowJobsPayload(await get(
        `${apiUrl}/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`,
      ));
      jobs.push(...pageJobs);
      if (pageJobs.length < 100) {
        return jobs.map(job => ({
          ...job, runId: run.id, inventorySource: source, workflowRun: run,
        }));
      }
    }
    throw new Error(`job inventory for run ${run.id} exceeded the pagination limit`);
  };
  // GitHub may delay or drop scheduled heartbeats for hours. Recent real PR
  // work proves that a matching listener executed successfully without
  // consuming a separate runner slot merely to refresh capacity evidence. It
  // is also hosted admission evidence, so it is settled independently: a
  // failed or truncated capacity scan still reports it.
  const recentWorkResult = Promise.allSettled([
    readRecentPrWorkJobs({ get, apiUrl, repository }),
  ]).then(([result]) => result);
  // Shared with the failure path: roles proven busy before a scan failure
  // stay busy, so the saturation route can follow the evidence per role.
  const activeJobs: AnnotatedJob[] = [];
  // A workflow can remain queued after one of its jobs completes. That job
  // still proves which external listener took work recently, even though it
  // no longer contributes to current demand.
  const completedActiveJobs: AnnotatedJob[] = [];
  let heartbeatRead: Promise<PromiseSettledResult<AnnotatedJob[][]>> | undefined;
  const readCapacityJobs = async (): Promise<{
    readonly heartbeatJobs: readonly AnnotatedJob[];
  }> => {
    const [queuedRuns, inProgressRuns, heartbeatRuns] = await Promise.all([
      listRuns({
        url: `${apiUrl}/repos/${repository}/actions/runs?status=queued`,
        pageSize: 100,
        paginate: true,
        source: 'active',
      }),
      listRuns({
        url: `${apiUrl}/repos/${repository}/actions/runs?status=in_progress`,
        pageSize: 100,
        paginate: true,
        source: 'active',
      }),
      // Each heartbeat run carries both role jobs, so the newest two runs hold
      // the newest heartbeat for each role.
      listRuns({
        url: `${apiUrl}/repos/${repository}/actions/workflows/linux-runner-heartbeat.yml/runs?status=completed`,
        pageSize: 2,
        paginate: false,
        source: 'heartbeat-completed',
      }),
    ]);
    // Settled at creation: a heartbeat read may fail while the active scan is
    // still awaiting, and an unobserved rejection would terminate the planner.
    const heartbeatResult = Promise.allSettled([Promise.all(heartbeatRuns.map(runJobs))])
      .then(([result]) => result);
    heartbeatRead = heartbeatResult;
    // The planner's own run releases its listener before dependent work starts.
    // The oldest queued work is the strongest backlog evidence. Inspect it
    // before newer workflows whose first-stage planner has not emitted lanes.
    const oldestQueued = [...queuedRuns].sort((left, right) => {
      const leftTime = Date.parse(left.run.created_at ?? '');
      const rightTime = Date.parse(right.run.created_at ?? '');
      return Number.isFinite(leftTime) && Number.isFinite(rightTime)
        ? leftTime - rightTime : 0;
    });
    // Give the oldest queued batch first claim on the scan, then inspect
    // running jobs before a large queued backlog can exhaust its bound.
    const activeRuns = [...new Map([
      ...oldestQueued.slice(0, ACTIVE_RUN_BATCH_SIZE),
      ...inProgressRuns,
      ...oldestQueued.slice(ACTIVE_RUN_BATCH_SIZE),
    ]
      .filter(entry => String(entry.run.id) !== excludeRunId)
      .map(entry => [entry.run.id, entry])).values()];
    // Busy is monotonic. A plan with no database lane need not inspect enough
    // unrelated runs to prove database demand that cannot affect this PR.
    for (let start = 0; start < activeRuns.length; start += ACTIVE_RUN_BATCH_SIZE) {
      const demand = directRoleDemand(activeJobs, checks, database);
      if (demand.portable && (!databaseRequired || demand.database)) break;
      if (start >= MAX_ACTIVE_RUNS_INSPECTED) {
        throw new ExternalInventoryError(
          `more than ${MAX_ACTIVE_RUNS_INSPECTED} active runs without proving selected roles busy`,
          true,
        );
      }
      // Each run settles on its own, so a sibling's failure cannot discard
      // demand that a successful read in the same batch already proved.
      const batch = await Promise.allSettled(activeRuns
        .slice(start, start + ACTIVE_RUN_BATCH_SIZE)
        .map(runJobs));
      for (const result of batch) {
        if (result.status === 'fulfilled') {
          activeJobs.push(...result.value.filter(entryIsActive));
          completedActiveJobs.push(...result.value.filter(entry => entry.status === 'completed'));
        }
      }
      const failed = batch.find((result): result is PromiseRejectedResult =>
        result.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
    }
    const heartbeat = await heartbeatResult;
    if (heartbeat.status === 'rejected') throw heartbeat.reason;
    return { heartbeatJobs: heartbeat.value.flat() };
  };
  // Recent work is supplementary evidence: when it cannot be read, capacity
  // falls back to heartbeats and hosted admission to the probe. Both the
  // success and failure paths read it through this one function.
  const readRecentWork = async (): Promise<{
    readonly jobs: readonly AnnotatedJob[];
    readonly hostedWork: HostedAdmission;
  }> => {
    const recentWork = await recentWorkResult;
    if (recentWork.status === 'fulfilled') {
      return {
        jobs: recentWork.value,
        hostedWork: evaluateRecentHostedWork({ jobs: recentWork.value, now }),
      };
    }
    console.warn(`Recent PR Checks work unreadable: ${String(recentWork.reason)}`);
    return { jobs: [], hostedWork: { available: false, reason: 'hosted-recent-work-unreadable' } };
  };
  let capacityJobs: Awaited<ReturnType<typeof readCapacityJobs>>;
  try {
    capacityJobs = await readCapacityJobs();
  } catch (error: unknown) {
    // The failure path runs the success computation on whatever was read, so
    // a role proven busy here is exactly a role the full scan would call busy.
    const recentWork = await readRecentWork();
    const heartbeat = heartbeatRead === undefined ? undefined : await heartbeatRead;
    const partial = evaluateCapacityEvidence({
      activeJobs,
      heartbeatJobs: heartbeat?.status === 'fulfilled' ? heartbeat.value.flat() : [],
      recentWorkJobs: [...recentWork.jobs, ...completedActiveJobs],
      checks,
      database,
      now,
    });
    throw new ExternalInventoryError(
      error instanceof Error ? error.message : String(error),
      inventoryFailureSuggestsSaturation(error),
      recentWork.hostedWork,
      { portable: partial.hasQueuedPortableWork, database: partial.hasQueuedDatabaseWork },
    );
  }
  const recentWork = await readRecentWork();
  return {
    ...evaluateCapacityEvidence({
      activeJobs,
      heartbeatJobs: capacityJobs.heartbeatJobs,
      recentWorkJobs: [...recentWork.jobs, ...completedActiveJobs],
      checks,
      database,
      now,
    }),
    recentHostedWork: recentWork.hostedWork,
  };
}

/**
 * Per-role capacity from the evidence that was read. Both the successful and
 * the failed inventory call this, so their per-role busy verdicts agree.
 */
function evaluateCapacityEvidence({
  activeJobs,
  heartbeatJobs,
  recentWorkJobs,
  checks,
  database,
  now,
}: {
  readonly activeJobs: readonly AnnotatedJob[];
  readonly heartbeatJobs: readonly AnnotatedJob[];
  readonly recentWorkJobs: readonly AnnotatedJob[];
  readonly checks: readonly string[];
  readonly database: readonly string[];
  readonly now: number;
}): {
  readonly roles: ExternalCapacity;
  readonly hasQueuedPortableWork: boolean;
  readonly hasQueuedDatabaseWork: boolean;
} {
  const directDemand = directRoleDemand(activeJobs, checks, database);
  const hasDirectPortableWork = directDemand.portable;
  const hasDirectDatabaseWork = directDemand.database;
  const portableHeartbeat = evaluateExternalHeartbeat({
    jobs: heartbeatJobs,
    jobName: PORTABLE_HEARTBEAT_JOB_NAME,
    expectedLabels: checks,
    now,
  });
  const databaseHeartbeat = evaluateExternalHeartbeat({
    jobs: heartbeatJobs,
    jobName: DATABASE_HEARTBEAT_JOB_NAME,
    expectedLabels: database,
    now,
  });
  const recentPortableWork = evaluateRecentExternalWork({
    jobs: recentWorkJobs,
    expectedLabels: checks,
    now,
  });
  const recentDatabaseWork = evaluateRecentExternalWork({
    jobs: recentWorkJobs,
    expectedLabels: database,
    now,
  });
  const portableEvidence = recentPortableWork.state === 'idle'
    ? recentPortableWork : portableHeartbeat;
  const databaseEvidence = recentDatabaseWork.state === 'idle'
    ? recentDatabaseWork : databaseHeartbeat;
  const occupiesRunner = (job: AnnotatedJob, runnerName: string | undefined): boolean =>
    job.status === 'in_progress'
      && runnerName !== undefined
      && job.runner_name?.trim().toLowerCase() === runnerName.trim().toLowerCase();
  // A physical listener may advertise both the trusted-control and worker
  // capabilities. Direct role demand is still classified from requested job
  // labels, but listener occupancy must inspect every in-progress job: a
  // control job occupies the same CPU that the most recent worker heartbeat
  // identified even though externalJobRoles intentionally excludes it.
  const workOnPortableRunner = activeJobs.find(job =>
    occupiesRunner(job, portableEvidence.runnerName));
  const workOnDatabaseRunner = activeJobs.find(job =>
    occupiesRunner(job, databaseEvidence.runnerName));
  const hasQueuedPortableWork = hasDirectPortableWork || workOnPortableRunner !== undefined;
  const hasQueuedDatabaseWork = hasDirectDatabaseWork || workOnDatabaseRunner !== undefined;
  const sharedRunnerReason = (job: AnnotatedJob | undefined): string => {
    if (job === undefined) return 'shared-runner-other-work';
    const roles = externalJobRoles(job, checks, database);
    if (roles.database) return 'shared-runner-database-work';
    if (roles.portable) return 'shared-runner-portable-work';
    return 'shared-runner-other-work';
  };
  const portable = hasQueuedPortableWork
    ? busyRoleEvidence(hasDirectPortableWork
      ? 'active-portable-work'
      : sharedRunnerReason(workOnPortableRunner))
    : portableEvidence;
  const databaseCapacity = hasQueuedDatabaseWork
    ? busyRoleEvidence(hasDirectDatabaseWork
      ? 'active-database-work'
      : sharedRunnerReason(workOnDatabaseRunner))
    : databaseEvidence;
  return {
    roles: { portable, database: databaseCapacity },
    hasQueuedPortableWork,
    hasQueuedDatabaseWork,
  };
}

/** Hosted admission evidence survives a failed capacity scan that still read it. */
export function recentHostedWorkFromInventory(
  result: PromiseSettledResult<{ readonly recentHostedWork: HostedAdmission }>,
): HostedAdmission | undefined {
  if (result.status === 'fulfilled') return result.value.recentHostedWork;
  return result.reason instanceof ExternalInventoryError
    ? result.reason.recentHostedWork
    : undefined;
}

/** Roles a failed inventory had already proven busy; none for any other failure. */
export function provenBusyFromInventory(result: PromiseSettledResult<unknown>): RoleDemand {
  return result.status === 'rejected' && result.reason instanceof ExternalInventoryError
    ? result.reason.provenBusy
    : { portable: false, database: false };
}

export function hostedOverflowPolicyEnabled(value: unknown): boolean {
  return value === '1';
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function main(): Promise<void> {
  const roleSelectors = resolvePrLinuxRoleLabels({
    checkLabels: process.env.PR_PORTABLE_RUNNER_LABELS,
    databaseLabels: process.env.PR_DATABASE_RUNNER_LABELS,
  });
  if (roleSelectors.usedFallback) {
    console.warn(
      `External role selector configuration is unsafe (${roleSelectors.reason}); `
      + 'using fixed positive lane selectors.',
    );
  }
  const hostedPolicyValue = process.env.CI_HOSTED_LINUX_AVAILABLE ?? '0';
  const hostedPolicyEnabled = hostedOverflowPolicyEnabled(hostedPolicyValue);
  if (!hostedPolicyEnabled) {
    console.warn(
      `Hosted overflow policy is disabled (CI_HOSTED_LINUX_AVAILABLE=${hostedPolicyValue}); `
      + 'queueing on external Linux.',
    );
  }
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const token = requiredEnvironment('GITHUB_TOKEN');
  // Read existing proof for idle fleets too: the overflow route will be used
  // once preferred jobs occupy them. The probe read runs alongside the
  // inventory, so a token-wide rate limit needs no further request to decide.
  const hostedEligible = hostedPolicyEnabled && process.env.PR_HEAD_REPOSITORY === repository;
  const defaultBranch = process.env.REPOSITORY_DEFAULT_BRANCH ?? '';
  const [inventoryResult, probe] = await Promise.all([
    Promise.allSettled([inspectExternalCapacity({
      apiUrl,
      repository,
      token,
      checkLabels: roleSelectors.checks,
      databaseLabels: roleSelectors.database,
      excludeRunId: process.env.GITHUB_RUN_ID,
      databaseRequired: process.env.DATABASE_REQUIRED !== 'false',
    })]).then(([result]) => result),
    hostedEligible ? readHostedProbe({ apiUrl, repository, defaultBranch, token }) : undefined,
  ]);
  const externalInventoryAvailable = inventoryResult.status === 'fulfilled';
  const externalInventorySaturated = inventoryResult.status === 'rejected'
    && inventoryFailureSuggestsSaturation(inventoryResult.reason);
  if (inventoryResult.status === 'rejected') {
    console.warn(
      `External reservation inventory unavailable (saturation likely: `
      + `${externalInventorySaturated}): ${String(inventoryResult.reason)}`,
    );
  }
  const recentHostedWork = recentHostedWorkFromInventory(inventoryResult);
  const externalCapacity: ExternalCapacity = inventoryResult.status === 'fulfilled'
    ? inventoryResult.value.roles
    : {
      portable: { state: 'unknown', reason: 'external-inventory-unavailable' },
      database: { state: 'unknown', reason: 'external-inventory-unavailable' },
    };
  let hostedAdmission: HostedAdmission = {
    available: false,
    reason: hostedPolicyEnabled ? 'external-capacity-preferred' : 'hosted-overflow-policy-disabled',
  };
  if (probe !== undefined && (externalInventoryAvailable || externalInventorySaturated)) {
    hostedAdmission = await finishHostedAdmission({
      apiUrl,
      repository,
      defaultBranch,
      token,
      probe,
      ...(recentHostedWork === undefined ? {} : { recentWork: recentHostedWork }),
      requestRefresh: externalInventorySaturated
        || externalCapacity.portable.state === 'busy'
        || externalCapacity.database.state === 'busy'
        // The plan can fan out overflow lanes after the preferred lanes take
        // today's free listeners. Fresh admission is needed before that fan-out.
        || (externalInventoryAvailable && externalCapacity.portable.state === 'idle'),
      waitForDispatchedProbe: true,
    });
  }
  const selection = selectPrLinuxRunners({
    sameRepository: process.env.PR_HEAD_REPOSITORY === process.env.GITHUB_REPOSITORY,
    checkLabels: roleSelectors.checks,
    databaseLabels: roleSelectors.database,
    hostedAvailable: hostedAdmission.available,
    externalCapacity,
    externalInventoryAvailable,
    externalInventorySaturated,
    externalProvenBusy: provenBusyFromInventory(inventoryResult),
  });
  const output = requiredEnvironment('GITHUB_OUTPUT');
  appendFileSync(output, `pr_linux_runner_labels=${JSON.stringify(selection.checks)}\n`);
  appendFileSync(output, `pr_database_runner_labels=${JSON.stringify(selection.database)}\n`);
  appendFileSync(output, `pr_linux_overflow_labels=${JSON.stringify(selection.overflow)}\n`);
  appendFileSync(output, `route_reason=${selection.reason}\n`);
  console.log(`${HOSTED_ADMISSION_WORKFLOW_NAME}: ${hostedAdmission.reason}`);
  console.log(
    `Portable external evidence: ${externalCapacity.portable.state} `
    + `(${externalCapacity.portable.reason})`,
  );
  console.log(
    `Database external evidence: ${externalCapacity.database.state} `
    + `(${externalCapacity.database.reason})`,
  );
  console.log(`PR validation runner: ${JSON.stringify(selection.checks)}`);
  console.log(`PR database runner: ${JSON.stringify(selection.database)}`);
  console.log(`PR validation overflow runner: ${JSON.stringify(selection.overflow)}`);
  console.log(`PR runner route reason: ${selection.reason}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

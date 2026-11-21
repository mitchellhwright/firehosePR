import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  hostedLinuxRunnerLabels,
  trustedControlLinuxRunnerLabels,
} from '../runnerPolicy.ts';
import {
  boundedRequest,
  combineHostedAdmission,
  GITHUB_REQUEST_TIMEOUT_MS,
  hostedOverflowPolicyEnabled,
  inspectHostedAdmission,
  inspectRecentHostedWork,
  selectorMatchesLabels,
  workflowJobsPayload,
  workflowRunsPayload,
  type ApiRequest,
  type HostedAdmission,
  type HostedProbeInspection,
  type WorkflowJob,
} from './selectPrLinuxRunners.ts';

/**
 * Routes a run's seconds-long control and verdict jobs. They prefer the
 * external Linux fleet and overflow to GitHub-hosted Linux while that fleet
 * has a backlog or all of its known slots are occupied. Hosted overflow needs
 * the hosted policy lever
 * (`CI_HOSTED_LINUX_AVAILABLE=1`) and recent hosted admission evidence, read
 * once; anything unproven keeps the external route. Fork revisions always use
 * hosted Linux, as the static routes they replace did.
 */

export type ControlRouteReason =
  | 'fork-isolated'
  | 'external-free'
  | 'external-backlog'
  | 'hosted-policy-disabled'
  | 'hosted-admission-unproven'
  | 'external-inventory-unavailable';

export interface ControlRoute {
  readonly labels: readonly string[];
  readonly reason: ControlRouteReason;
}

export interface ControlRouteInput {
  readonly sameRepository: boolean;
  readonly external: readonly string[];
  /** External queue pressure, including a full known pool; undefined when inventory failed. */
  readonly queuedOnExternal: number | undefined;
  readonly hostedPolicyEnabled: boolean;
  readonly hostedAdmitted: boolean;
}

export function selectControlRoute(input: ControlRouteInput): ControlRoute {
  const hosted = hostedLinuxRunnerLabels;
  if (!input.sameRepository) return { labels: hosted, reason: 'fork-isolated' };
  if (input.queuedOnExternal === undefined) {
    return { labels: input.external, reason: 'external-inventory-unavailable' };
  }
  if (input.queuedOnExternal === 0) return { labels: input.external, reason: 'external-free' };
  if (!input.hostedPolicyEnabled) return { labels: input.external, reason: 'hosted-policy-disabled' };
  if (!input.hostedAdmitted) return { labels: input.external, reason: 'hosted-admission-unproven' };
  return { labels: hosted, reason: 'external-backlog' };
}

/** Queued jobs, outside `excludeRunId`, whose requested labels include `selector`. */
export function queuedJobsFor(
  jobs: readonly (WorkflowJob & { readonly runId: string })[],
  selector: readonly string[],
  excludeRunId: string | undefined,
): number {
  return jobs.filter((job) => job.status === 'queued'
    && job.runId !== excludeRunId
    && selectorMatchesLabels(job.labels, selector)).length;
}

/** Running jobs of other runs occupying a pool's known slots. */
export function runningJobsFor(
  jobs: readonly (WorkflowJob & { readonly runId: string })[],
  selector: readonly string[],
  excludeRunId: string | undefined,
): number {
  return jobs.filter((job) => job.status === 'in_progress'
    && job.runId !== excludeRunId
    && selectorMatchesLabels(job.labels, selector)).length;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function paged<T>(
  request: ApiRequest,
  url: string,
  token: string,
  parse: (payload: unknown) => T[],
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request(`${url}&per_page=${PAGE_SIZE}&page=${page}`, { headers: headers(token) });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const pageItems = parse(await response.json());
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) return items;
  }
  throw new Error(`${url} exceeded ${MAX_PAGES} pages`);
}

const RUN_BATCH_SIZE = 10;
const MAX_RUNS_SCANNED = 200;

export interface BacklogScan {
  readonly apiUrl: string;
  readonly repository: string;
  readonly token: string;
  /** Pools to measure, by output name. */
  readonly pools: Readonly<Record<string, readonly string[]>>;
  /** Known parallel slots for pools where all running slots imply saturation. */
  readonly poolSizes?: Readonly<Record<string, number>>;
  readonly excludeRunId: string | undefined;
  readonly request?: ApiRequest;
  readonly timeoutMs?: number;
}

/**
 * Queue pressure for each pool: queued jobs plus one when all known slots
 * are occupied. Zero means neither was found; unread runs make zero unknown.
 * Queued runs are read before in-progress ones, job lists are
 * fetched RUN_BATCH_SIZE runs at a time up to MAX_RUNS_SCANNED, and the scan
 * stops as soon as every pool has a backlog. Every request is bounded.
 */
export async function externalBacklog(scan: BacklogScan): Promise<Record<string, number | undefined>> {
  const request = boundedRequest(scan.request ?? fetch, scan.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS);
  const base = `${scan.apiUrl}/repos/${scan.repository}/actions`;
  const runs = [];
  for (const status of ['queued', 'in_progress']) {
    runs.push(...await paged(request, `${base}/runs?status=${status}`, scan.token, workflowRunsPayload));
  }
  const ids = [...new Set(runs.map((run) => String(run.id)))]
    .filter((id) => id !== scan.excludeRunId)
    .slice(0, MAX_RUNS_SCANNED);
  const counts: Record<string, number> = Object.fromEntries(Object.keys(scan.pools).map((name) => [name, 0]));
  const runningCounts: Record<string, number> = Object.fromEntries(Object.keys(scan.pools).map((name) => [name, 0]));
  const pressure = (name: string): number => (counts[name] ?? 0)
    + ((scan.poolSizes?.[name] ?? Infinity) <= (runningCounts[name] ?? 0) ? 1 : 0);
  let unreadRuns = 0;
  for (let start = 0; start < ids.length; start += RUN_BATCH_SIZE) {
    const batch = await Promise.allSettled(ids.slice(start, start + RUN_BATCH_SIZE).map(async (id) => (
      (await paged(request, `${base}/runs/${id}/jobs?filter=latest`, scan.token, workflowJobsPayload))
        .map((job) => ({ ...job, runId: id })))));
    for (const result of batch) {
      if (result.status === 'rejected') {
        unreadRuns += 1;
        console.warn(`Job inventory unavailable for one run: ${String(result.reason)}`);
        continue;
      }
      for (const [name, labels] of Object.entries(scan.pools)) {
        counts[name] = (counts[name] ?? 0) + queuedJobsFor(result.value, labels, scan.excludeRunId);
        runningCounts[name] = (runningCounts[name] ?? 0) + runningJobsFor(result.value, labels, scan.excludeRunId);
      }
    }
    if (Object.keys(scan.pools).every((name) => pressure(name) > 0)) break;
  }
  return Object.fromEntries(Object.keys(scan.pools).map((name) => [
    name, pressure(name) === 0 && unreadRuns > 0 ? undefined : pressure(name),
  ]));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to route control jobs`);
  return value;
}

export async function controlHostedAdmission(input: {
  readonly apiUrl: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly token: string;
  readonly request?: ApiRequest;
  readonly now?: number;
}): Promise<HostedAdmission> {
  const request = boundedRequest(input.request ?? fetch, GITHUB_REQUEST_TIMEOUT_MS);
  let probe: HostedProbeInspection | undefined;
  try {
    probe = await inspectHostedAdmission({ ...input, request });
    if (probe.admission.available) return probe.admission;
  } catch (error: unknown) {
    console.warn(`Hosted probe evidence unavailable: ${String(error)}`);
  }
  let recent: HostedAdmission | undefined;
  try {
    recent = await inspectRecentHostedWork({
      apiUrl: input.apiUrl, repository: input.repository, token: input.token,
      request, ...(input.now === undefined ? {} : { now: input.now }),
    });
  } catch (error: unknown) {
    console.warn(`Recent hosted-work evidence unavailable: ${String(error)}`);
  }
  return combineHostedAdmission({
    probe: probe?.admission ?? { available: false, reason: 'hosted-probe-inventory-unavailable' },
    ...(probe?.run === undefined ? {} : { probeRun: probe.run }),
    ...(recent === undefined ? {} : { recentWork: recent }),
  });
}

/** A control job already allocated on GitHub-hosted Linux is fresh admission proof. */
export function currentHostedControlAdmission(
  runnerEnvironment: string | undefined,
): HostedAdmission | undefined {
  return runnerEnvironment === 'github-hosted'
    ? { available: true, reason: 'hosted-current-control-job' }
    : undefined;
}

export async function main(): Promise<void> {
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const repository = required('GITHUB_REPOSITORY');
  const token = required('GITHUB_TOKEN');
  // The workflow's own sameRepositoryCode condition: a same-repository pull
  // request, a queue candidate, or a dispatch. Anything else is fork code.
  const sameRepository = process.env.SAME_REPOSITORY_CODE === 'true';
  const hostedPolicyEnabled = hostedOverflowPolicyEnabled(process.env.CI_HOSTED_LINUX_AVAILABLE ?? '0');
  const pools = {
    control_runner_labels: trustedControlLinuxRunnerLabels,
  } as const;
  let queued: Record<string, number | undefined> = {};
  try {
    queued = sameRepository
      ? await externalBacklog({ apiUrl, repository, token, pools,
        poolSizes: { control_runner_labels: 2 }, excludeRunId: process.env.GITHUB_RUN_ID })
      : {};
  } catch (error: unknown) {
    console.warn(`Active run inventory unavailable; keeping external routes: ${String(error)}`);
  }
  const needsHosted = sameRepository && hostedPolicyEnabled
    && Object.values(queued).some((count) => (count ?? 0) > 0);
  const admission = needsHosted
    ? currentHostedControlAdmission(process.env.RUNNER_ENVIRONMENT)
      ?? await controlHostedAdmission({ apiUrl, repository, token,
        defaultBranch: required('REPOSITORY_DEFAULT_BRANCH') })
    : { available: false, reason: 'not-needed' };
  const output = required('GITHUB_OUTPUT');
  for (const [name, external] of Object.entries(pools)) {
    const route = selectControlRoute({
      sameRepository,
      external,
      queuedOnExternal: queued[name],
      hostedPolicyEnabled,
      hostedAdmitted: admission.available,
    });
    appendFileSync(output, `${name}=${JSON.stringify(route.labels)}\n`);
    console.log(`${name}: ${JSON.stringify(route.labels)} (${route.reason}; `
      + `${queued[name] ?? 'unknown'} external pressure; hosted admission ${admission.reason})`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import { fileURLToPath } from 'node:url';

import { requiredEnv } from '../ios/shared/actionIo.ts';

/**
 * GitHub deletes a merge group's `gh-readonly-queue/...` branch when the queue
 * rebuilds or dequeues it, but it does not cancel that group's `merge_group`
 * runs. Their jobs keep holding Macs and Linux lanes for a candidate that can
 * no longer merge. Every new `merge_group` event runs this once: it reads the
 * in-flight queue runs of the validation workflows and cancels only those
 * whose queue branch is gone. Nothing waits or polls.
 */

const ACTIVE_RUN_STATUS_LIST = ['queued', 'in_progress', 'pending', 'requested', 'waiting'] as const;
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUS_LIST);
const MERGE_QUEUE_BRANCH_PREFIX = 'gh-readonly-queue/';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export interface GithubResponse {
  readonly status: number;
  readonly body: unknown;
}

export type GithubRequest = (
  path: string,
  options?: { readonly method?: 'GET' | 'POST' },
) => Promise<GithubResponse>;

export interface MergeGroupRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly event: string;
  readonly headBranch: string;
}

export type RefState =
  | { readonly kind: 'exists' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown'; readonly reason: string };

export interface SupersededRunOptions {
  readonly request: GithubRequest;
  readonly workflowNames: ReadonlySet<string>;
  readonly currentRunId?: number | undefined;
  readonly log?: (line: string) => void;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function decodeRun(value: unknown): MergeGroupRun | undefined {
  const run = record(value);
  const id = positiveInteger(run?.['id']);
  const name = nonEmptyString(run?.['name']);
  const status = nonEmptyString(run?.['status']);
  const event = nonEmptyString(run?.['event']);
  const headBranch = nonEmptyString(run?.['head_branch']);
  if (id === undefined || name === undefined || status === undefined
    || event === undefined || headBranch === undefined) return undefined;
  return { id, name, status, event, headBranch };
}

function decodeRunPage(response: GithubResponse, path: string): readonly MergeGroupRun[] {
  const values = record(response.body)?.['workflow_runs'];
  if (response.status !== 200 || !Array.isArray(values)) {
    throw new Error(`Listing merge_group runs failed: GET ${path} returned HTTP ${response.status}.`);
  }
  return values.flatMap((value): readonly MergeGroupRun[] => {
    const run = decodeRun(value);
    return run === undefined ? [] : [run];
  });
}

/**
 * The active queue runs of the named workflows, other than the current run.
 * A `pull_request` run, a non-queue branch or a finished run is never a
 * candidate, whatever the listing returned.
 */
export function supersessionCandidates(
  runs: readonly MergeGroupRun[],
  options: Pick<SupersededRunOptions, 'workflowNames' | 'currentRunId'>,
): readonly MergeGroupRun[] {
  const unique = new Map<number, MergeGroupRun>();
  for (const run of runs) {
    if (run.event !== 'merge_group') continue;
    if (!run.headBranch.startsWith(MERGE_QUEUE_BRANCH_PREFIX)) continue;
    if (!options.workflowNames.has(run.name)) continue;
    if (!ACTIVE_RUN_STATUSES.has(run.status)) continue;
    if (run.id === options.currentRunId) continue;
    unique.set(run.id, run);
  }
  return [...unique.values()];
}

async function activeMergeGroupRuns(request: GithubRequest): Promise<readonly MergeGroupRun[]> {
  // Start every status read together. Reading them one after another can miss
  // a run that moves from a not-yet-read status to an already-read status.
  const groups = await Promise.all(ACTIVE_RUN_STATUS_LIST.map(async (status) => {
    const runs: MergeGroupRun[] = [];
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) throw new Error('merge_group run listing exceeded the page limit.');
      const path = `actions/runs?event=merge_group&status=${status}&per_page=${PAGE_SIZE}&page=${page}`;
      const values = decodeRunPage(await request(path), path);
      runs.push(...values);
      if (values.length < PAGE_SIZE) break;
    }
    return runs;
  }));
  return groups.flat();
}

/** One read of the queue branch: 200 is live, 404 is deleted, anything else is unknown. */
export async function lookupQueueBranch(request: GithubRequest, branch: string): Promise<RefState> {
  const path = `git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  try {
    const response = await request(path);
    if (response.status === 200) return { kind: 'exists' };
    if (response.status === 404) return { kind: 'missing' };
    return { kind: 'unknown', reason: `GET ${path} returned HTTP ${response.status}` };
  } catch (error: unknown) {
    return { kind: 'unknown', reason: `GET ${path} failed: ${errorMessage(error)}` };
  }
}

type CancelOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'finished' }
  | { readonly kind: 'failed'; readonly reason: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A 409 is only a cancellation conflict. The run counts as finished only when
 * a re-read shows it is no longer active; otherwise the conflict is a failure.
 */
async function confirmFinished(request: GithubRequest, runId: number): Promise<CancelOutcome> {
  const path = `actions/runs/${runId}`;
  const response = await request(path);
  const status = nonEmptyString(record(response.body)?.['status']);
  if (response.status !== 200 || status === undefined) {
    return { kind: 'failed', reason: `cancel returned HTTP 409 and GET ${path} returned HTTP ${response.status}` };
  }
  if (ACTIVE_RUN_STATUSES.has(status)) {
    return { kind: 'failed', reason: `cancel returned HTTP 409 while run ${runId} is still ${status}` };
  }
  return { kind: 'finished' };
}

async function cancelRun(request: GithubRequest, runId: number): Promise<CancelOutcome> {
  const path = `actions/runs/${runId}/cancel`;
  try {
    const response = await request(path, { method: 'POST' });
    if (response.status === 202) return { kind: 'cancelled' };
    if (response.status === 409) return await confirmFinished(request, runId);
    return { kind: 'failed', reason: `POST ${path} returned HTTP ${response.status}` };
  } catch (error: unknown) {
    return { kind: 'failed', reason: `POST ${path} failed: ${errorMessage(error)}` };
  }
}

/**
 * Cancels in-flight `merge_group` runs whose queue branch no longer exists.
 * A branch that still exists, or whose lookup failed, keeps its runs. Every
 * cancellation is attempted, even after one throws, before a failure is
 * reported.
 */
export async function cancelSupersededMergeGroupRuns(
  options: SupersededRunOptions,
): Promise<readonly number[]> {
  const log = options.log ?? console.log;
  const candidates = supersessionCandidates(await activeMergeGroupRuns(options.request), options);
  const branchStates = new Map<string, RefState>();
  for (const branch of new Set(candidates.map(run => run.headBranch))) {
    const state = await lookupQueueBranch(options.request, branch);
    branchStates.set(branch, state);
    if (state.kind === 'unknown') {
      log(`Kept runs on ${branch}: its queue branch could not be read (${state.reason}).`);
    }
  }
  const cancelled: number[] = [];
  const failures: string[] = [];
  for (const run of candidates) {
    if (branchStates.get(run.headBranch)?.kind !== 'missing') continue;
    const outcome = await cancelRun(options.request, run.id);
    if (outcome.kind === 'cancelled') {
      cancelled.push(run.id);
      log(`Cancelled ${run.name} run ${run.id}: queue branch ${run.headBranch} was deleted.`);
    } else if (outcome.kind === 'finished') {
      log(`${run.name} run ${run.id} finished before it could be cancelled.`);
    } else {
      failures.push(outcome.reason);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Cancelled [${cancelled.join(', ')}] but could not cancel superseded runs: ${failures.join('; ')}.`,
    );
  }
  return cancelled;
}

async function githubRequest(
  path: string,
  options: { readonly method?: 'GET' | 'POST' } = {},
): Promise<GithubResponse> {
  const method = options.method ?? 'GET';
  const apiUrl = requiredEnv('GITHUB_API_URL').replace(/\/$/, '');
  const response = await fetch(`${apiUrl}/repos/${requiredEnv('GITHUB_REPOSITORY')}/${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${requiredEnv('GITHUB_TOKEN')}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) as unknown };
}

async function main(): Promise<void> {
  const workflowNames = new Set(requiredEnv('CI_WORKFLOW_NAMES').split(',')
    .map(value => value.trim()).filter(Boolean));
  const runId = Number(process.env['GITHUB_RUN_ID']);
  const cancelled = await cancelSupersededMergeGroupRuns({
    request: githubRequest,
    workflowNames,
    ...(Number.isSafeInteger(runId) && runId > 0 ? { currentRunId: runId } : {}),
  });
  console.log(cancelled.length === 0
    ? 'No superseded merge_group runs required cancellation.'
    : `Cancelled superseded merge_group run(s): ${cancelled.join(', ')}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { requiredEnv } from '../ios/shared/actionIo.ts';

const ACTIVE_RUN_STATUS_LIST = ['queued', 'in_progress', 'pending', 'requested', 'waiting'] as const;
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(ACTIVE_RUN_STATUS_LIST);
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Why a pull request's validation runs can no longer back a merge. `closed`
 * and `converted_to_draft` arrive as pull-request events; `conflicted` comes
 * from the base-update fan-out after GitHub refused to update the branch,
 * because resolving a conflict always produces a new head.
 */
export type TerminalReason = 'closed' | 'converted_to_draft' | 'conflicted';

export interface TerminalTarget {
  readonly action: TerminalReason;
  readonly pullRequest: number;
  readonly headBranch: string;
  readonly headSha: string;
}

interface WorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly event: string;
  readonly headBranch: string;
  readonly pullRequests: readonly number[];
}

interface OpenPullRequest {
  readonly number: number;
  readonly state: string;
  readonly draft: boolean;
  readonly headBranch: string;
}

export interface GithubRequest {
  (path: string, options?: { readonly method?: 'GET' | 'POST' }): Promise<unknown>;
}

interface CancellationOptions {
  readonly request: GithubRequest;
  readonly workflowNames: ReadonlySet<string>;
  readonly currentRunId?: number | undefined;
}

export const CANCELLATION_CONFLICT = Object.freeze({
  kind: 'cancellation-conflict' as const,
});

function isCancellationConflict(value: unknown): boolean {
  return record(value)?.['kind'] === CANCELLATION_CONFLICT.kind;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function nestedRecord(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  return record(value?.[key]);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isHeadSha(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{40}$/.test(value);
}

export function terminalTarget(event: unknown): TerminalTarget | undefined {
  const body = record(event);
  const action = body?.['action'];
  if (action !== 'closed' && action !== 'converted_to_draft') return undefined;
  const pull = nestedRecord(body, 'pull_request');
  const head = nestedRecord(pull, 'head');
  const pullRequest = positiveInteger(pull?.['number']);
  const headBranch = nonEmptyString(head?.['ref']);
  const headSha = nonEmptyString(head?.['sha']);
  if (pullRequest === undefined || headBranch === undefined || !isHeadSha(headSha)) {
    throw new Error('Terminal pull-request event is missing its exact PR, branch, or head SHA.');
  }
  return { action, pullRequest, headBranch, headSha };
}

/**
 * Parses the fan-out's `conflicted_pull_requests` output: a non-empty JSON
 * array of `{ number, headRef, headSha }`. Anything else fails the step, so a
 * renamed field cannot silently cancel nothing.
 */
export function conflictedTargets(json: string): readonly TerminalTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('CONFLICTED_PULL_REQUESTS is not valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('CONFLICTED_PULL_REQUESTS must be a non-empty JSON array.');
  }
  return parsed.map((value: unknown, index): TerminalTarget => {
    const entry = record(value);
    const pullRequest = positiveInteger(entry?.['number']);
    const headBranch = nonEmptyString(entry?.['headRef']);
    const headSha = nonEmptyString(entry?.['headSha']);
    if (pullRequest === undefined || headBranch === undefined || !isHeadSha(headSha)) {
      throw new Error(
        `CONFLICTED_PULL_REQUESTS[${index}] needs a positive number, a headRef and a 40-hex headSha.`,
      );
    }
    return { action: 'conflicted', pullRequest, headBranch, headSha };
  });
}

function decodeWorkflowRun(value: unknown): WorkflowRun | undefined {
  const run = record(value);
  const id = positiveInteger(run?.['id']);
  const name = nonEmptyString(run?.['name']);
  const status = nonEmptyString(run?.['status']);
  const event = nonEmptyString(run?.['event']);
  const headBranch = nonEmptyString(run?.['head_branch']);
  const rawPullRequests = run?.['pull_requests'];
  if (id === undefined || name === undefined || status === undefined
    || event === undefined || headBranch === undefined || !Array.isArray(rawPullRequests)) {
    return undefined;
  }
  const pullRequests = rawPullRequests.flatMap((value): readonly number[] => {
    const number = positiveInteger(record(value)?.['number']);
    return number === undefined ? [] : [number];
  });
  return { id, name, status, event, headBranch, pullRequests };
}

function decodeOpenPullRequest(value: unknown): OpenPullRequest | undefined {
  const pull = record(value);
  const number = positiveInteger(pull?.['number']);
  const state = nonEmptyString(pull?.['state']);
  const draft = pull?.['draft'];
  const headBranch = nonEmptyString(nestedRecord(pull, 'head')?.['ref']);
  if (number === undefined || state === undefined || typeof draft !== 'boolean'
    || headBranch === undefined) return undefined;
  return { number, state, draft, headBranch };
}

function workflowRuns(payload: unknown): readonly WorkflowRun[] {
  const values = record(payload)?.['workflow_runs'];
  if (!Array.isArray(values)) throw new Error('GitHub returned an invalid workflow-run page.');
  return values.flatMap((value): readonly WorkflowRun[] => {
    const run = decodeWorkflowRun(value);
    return run === undefined ? [] : [run];
  });
}

function pullRequests(payload: unknown): readonly OpenPullRequest[] {
  if (!Array.isArray(payload)) throw new Error('GitHub returned an invalid pull-request page.');
  return payload.flatMap((value): readonly OpenPullRequest[] => {
    const pull = decodeOpenPullRequest(value);
    return pull === undefined ? [] : [pull];
  });
}

export function terminalRunIds(options: {
  readonly runs: readonly WorkflowRun[];
  readonly target: TerminalTarget;
  readonly openPullRequests: readonly OpenPullRequest[];
  readonly workflowNames: ReadonlySet<string>;
  readonly currentRunId?: number | undefined;
}): readonly number[] {
  const otherOpen = options.openPullRequests.filter(pull => pull.state === 'open'
    && !pull.draft && pull.number !== options.target.pullRequest);
  const otherOpenNumbers = new Set(otherOpen.map(pull => pull.number));
  const branchIsShared = otherOpen.some(pull => pull.headBranch === options.target.headBranch);
  return options.runs.flatMap((run): readonly number[] => {
    if (!options.workflowNames.has(run.name) || !ACTIVE_RUN_STATUSES.has(run.status)
      || run.event !== 'pull_request' || run.headBranch !== options.target.headBranch
      || run.id === options.currentRunId
      || run.pullRequests.some(number => otherOpenNumbers.has(number))) return [];
    if (run.pullRequests.includes(options.target.pullRequest)) return [run.id];
    return run.pullRequests.length === 0 && !branchIsShared ? [run.id] : [];
  });
}

/**
 * Why the live pull request no longer matches the target, or `undefined` when
 * it still does. Every cancellation re-reads the pull request first, so a
 * reopened, re-readied, resolved or pushed pull request keeps its runs.
 */
function liveTargetMismatch(payload: unknown, target: TerminalTarget): string | undefined {
  const pull = record(payload);
  const head = nestedRecord(pull, 'head');
  if (head?.['ref'] !== target.headBranch || head?.['sha'] !== target.headSha) {
    return 'its head moved';
  }
  const state = pull?.['state'];
  switch (target.action) {
    case 'closed':
      return state === 'closed' ? undefined : `it is ${String(state)}`;
    case 'converted_to_draft':
      return state === 'open' && pull?.['draft'] === true ? undefined : 'it is no longer an open draft';
    case 'conflicted': {
      if (state !== 'open') return `it is ${String(state)}`;
      const mergeable = pull?.['mergeable'];
      const mergeableState = pull?.['mergeable_state'];
      if (mergeable === false && mergeableState === 'dirty') return undefined;
      if (mergeable === null) return 'GitHub has not computed its mergeability yet';
      return `GitHub reports mergeable=${String(mergeable)} (${String(mergeableState)})`;
    }
  }
}

async function collectPages<T>(
  load: (page: number) => Promise<unknown>,
  decode: (payload: unknown) => readonly T[],
): Promise<readonly T[]> {
  const collected: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const values = decode(await load(page));
    collected.push(...values);
    if (values.length < PAGE_SIZE) return collected;
  }
  throw new Error('GitHub pagination exceeded the supported limit.');
}

async function liveMismatch(
  request: GithubRequest,
  target: TerminalTarget,
): Promise<string | undefined> {
  return liveTargetMismatch(await request(`pulls/${target.pullRequest}`), target);
}

async function activeRunsFor(
  request: GithubRequest,
  headBranch: string,
): Promise<readonly WorkflowRun[]> {
  const branch = encodeURIComponent(headBranch);
  let previousIds: string | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pages = await Promise.all(ACTIVE_RUN_STATUS_LIST.map(status => collectPages(
      page => request(
        `actions/runs?event=pull_request&branch=${branch}&status=${status}&per_page=${PAGE_SIZE}&page=${page}`,
      ),
      workflowRuns,
    )));
    const runs = [...new Map(pages.flat().filter(run => ACTIVE_RUN_STATUSES.has(run.status))
      .map(run => [run.id, run])).values()];
    const ids = runs.map(run => run.id).sort((left, right) => left - right).join(',');
    // A run can move from in_progress back to queued while its next job waits
    // for a Mac. It can then be absent from both independently filtered reads.
    // Require two matching inventories before deciding there is nothing to
    // cancel; an unstable listing must not silently strand abandoned work.
    if (ids === previousIds) return runs;
    previousIds = ids;
  }
  throw new Error('Active pull-request workflow-run inventory did not stabilize after 3 scans.');
}

async function cancelRun(request: GithubRequest, id: number): Promise<void> {
  const cancellation = await request(`actions/runs/${id}/cancel`, { method: 'POST' });
  if (!isCancellationConflict(cancellation)) return;
  const latestRun = record(await request(`actions/runs/${id}`));
  const latestStatus = nonEmptyString(latestRun?.['status']);
  if (latestStatus === undefined || ACTIVE_RUN_STATUSES.has(latestStatus)) {
    throw new Error(
      `GitHub rejected cancellation for run ${id}, which is still ${latestStatus ?? 'in an unknown state'}.`,
    );
  }
}

/**
 * The single cancellation path for every terminal reason: verify the live pull
 * request, inventory active runs on its head branch, keep work another open
 * pull request owns, and re-verify the live pull request before each cancel.
 */
export async function cancelTargetRuns(
  target: TerminalTarget,
  options: CancellationOptions,
): Promise<readonly number[]> {
  const initialMismatch = await liveMismatch(options.request, target);
  if (initialMismatch !== undefined) {
    console.log(`Left PR #${target.pullRequest} runs alone (${target.action}): ${initialMismatch}.`);
    return [];
  }
  const [runs, openPullRequests] = await Promise.all([
    activeRunsFor(options.request, target.headBranch),
    collectPages(
      page => options.request(`pulls?state=open&per_page=${PAGE_SIZE}&page=${page}`),
      pullRequests,
    ),
  ]);
  const ids = terminalRunIds({
    runs,
    target,
    openPullRequests,
    workflowNames: options.workflowNames,
    currentRunId: options.currentRunId,
  });
  const cancelled: number[] = [];
  for (const id of ids) {
    const mismatch = await liveMismatch(options.request, target);
    if (mismatch !== undefined) {
      console.log(`Stopped cancelling PR #${target.pullRequest} runs (${target.action}): ${mismatch}.`);
      break;
    }
    await cancelRun(options.request, id);
    cancelled.push(id);
  }
  return cancelled;
}

export async function cancelTerminalPrRuns(options: CancellationOptions & {
  readonly event: unknown;
}): Promise<readonly number[]> {
  const target = terminalTarget(options.event);
  if (target === undefined) return [];
  return cancelTargetRuns(target, options);
}

/**
 * Cancels the runs of each pull request the base-update fan-out left in merge
 * conflict. Every target is attempted before a failure is reported, so one
 * rejected cancellation cannot keep another pull request's runs queued.
 */
export async function cancelConflictedPrRuns(options: CancellationOptions & {
  readonly targets: readonly TerminalTarget[];
}): Promise<readonly number[]> {
  const cancelled: number[] = [];
  const failures: string[] = [];
  for (const target of options.targets) {
    try {
      cancelled.push(...await cancelTargetRuns(target, options));
    } catch (error: unknown) {
      failures.push(`PR #${target.pullRequest}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Conflicted PR cleanup cancelled [${cancelled.join(', ')}] but failed for ${failures.join(' ')}`,
    );
  }
  return cancelled;
}

async function githubRequest(
  path: string,
  options: { readonly method?: 'GET' | 'POST' } = {},
): Promise<unknown> {
  const method = options.method ?? 'GET';
  const response = await fetch(
    `${requiredEnv('GITHUB_API_URL').replace(/\/$/, '')}/repos/${requiredEnv('GITHUB_REPOSITORY')}/${path}`,
    {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${requiredEnv('GITHUB_TOKEN')}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (response.status === 409) return CANCELLATION_CONFLICT;
  if (response.status === 202 || response.status === 204) return undefined;
  if (!response.ok) throw new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}.`);
  return response.json() as Promise<unknown>;
}

async function main(): Promise<void> {
  const workflowNames = new Set(requiredEnv('CI_WORKFLOW_NAMES').split(',')
    .map(value => value.trim()).filter(Boolean));
  const runId = Number(process.env['GITHUB_RUN_ID']);
  const options: CancellationOptions = {
    request: githubRequest,
    workflowNames,
    ...(Number.isSafeInteger(runId) && runId > 0 ? { currentRunId: runId } : {}),
  };
  // The base-update fan-out passes the pull requests it left conflicted; the
  // terminal-cleanup workflow passes nothing and reads its pull-request event.
  const conflicted = process.env['CONFLICTED_PULL_REQUESTS'];
  const cancelled = conflicted === undefined
    ? await cancelTerminalPrRuns({
      ...options,
      event: JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')) as unknown,
    })
    : await cancelConflictedPrRuns({ ...options, targets: conflictedTargets(conflicted) });
  console.log(cancelled.length === 0
    ? 'No abandoned PR validation runs required cancellation.'
    : `Cancelled abandoned PR validation run(s): ${cancelled.join(', ')}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

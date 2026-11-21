import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MERGE_QUEUE_BASE_BRANCH } from '../mergeQueueRef.ts';
import {
  ACTIVE_RUN_STATUSES, containmentFromCompareStatus, decideCandidateRun, deletedQueueRef,
  type CandidateRun, type DevelopContainment, type RunDecision,
} from '../dequeuedCandidateRuns.ts';
import { appendStepSummary, logLine, requiredEnv } from '../ios/shared/actionIo.ts';

/**
 * Cancels the validation runs of a merge queue candidate whose ref GitHub
 * deleted. Every fact is re-read from the API immediately before each
 * cancel; see `dequeuedCandidateRuns.ts` for the decision.
 */

export interface GithubRequest {
  (path: string, options?: { readonly method?: 'GET' | 'POST' }): Promise<{ readonly status: number; readonly body: unknown }>;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
}

function decodeRun(value: unknown): CandidateRun | undefined {
  const run = record(value);
  const id = run?.['id'];
  const name = run?.['name'];
  const status = run?.['status'];
  const event = run?.['event'];
  const headBranch = run?.['head_branch'];
  const headSha = run?.['head_sha'];
  if (typeof id !== 'number' || typeof name !== 'string' || typeof status !== 'string' || typeof event !== 'string'
    || typeof headBranch !== 'string' || typeof headSha !== 'string') return undefined;
  return { id, name, status, event, headBranch, headSha };
}

async function activeRuns(request: GithubRequest, ref: string): Promise<readonly CandidateRun[]> {
  const runs = new Map<number, CandidateRun>();
  // Use one unfiltered inventory so a queued-to-in-progress transition cannot
  // fall between separate server-side status snapshots.
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request(
      `actions/runs?event=merge_group&branch=${encodeURIComponent(ref)}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (response.status !== 200) throw new Error(`Listing runs for ${ref} answered HTTP ${response.status}.`);
    const values = record(response.body)?.['workflow_runs'];
    if (!Array.isArray(values)) throw new Error('GitHub returned an invalid workflow-run page.');
    for (const value of values) {
      const run = decodeRun(value);
      if (run !== undefined && ACTIVE_RUN_STATUSES.includes(run.status as typeof ACTIVE_RUN_STATUSES[number])) runs.set(run.id, run);
    }
    if (values.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) throw new Error('GitHub pagination exceeded the supported limit.');
  }
  return [...runs.values()].sort((left, right) => left.id - right.id);
}

/** Where the ref points now: `undefined` while it stays deleted. Any other answer is an error. */
async function liveRefSha(request: GithubRequest, ref: string): Promise<string | undefined> {
  const response = await request(`git/ref/heads/${ref}`);
  if (response.status === 404) return undefined;
  if (response.status !== 200) throw new Error(`Reading ref ${ref} answered HTTP ${response.status}.`);
  const sha = record(record(response.body)?.['object'])?.['sha'];
  if (typeof sha !== 'string') throw new Error(`Ref ${ref} answered without an object SHA.`);
  return sha;
}

async function containment(request: GithubRequest, sha: string): Promise<DevelopContainment> {
  const response = await request(`compare/${MERGE_QUEUE_BASE_BRANCH}...${sha}`);
  if (response.status !== 200) return 'unknown';
  return containmentFromCompareStatus(record(response.body)?.['status']);
}

async function cancel(request: GithubRequest, run: CandidateRun): Promise<'cancelled' | 'finished'> {
  const response = await request(`actions/runs/${run.id}/cancel`, { method: 'POST' });
  if (response.status === 202) return 'cancelled';
  if (response.status === 409) {
    const reread = await request(`actions/runs/${run.id}`);
    const status = record(reread.body)?.['status'];
    if (reread.status === 200 && status === 'completed') return 'finished';
    throw new Error(`Cancelling run ${run.id} returned HTTP 409 while the run is still active or unreadable`);
  }
  throw new Error(`Cancelling run ${run.id} answered HTTP ${response.status}.`);
}

export async function cancelDequeuedCandidateRuns(options: {
  readonly request: GithubRequest;
  readonly event: unknown;
  readonly workflowNames: ReadonlySet<string>;
  readonly currentRunId?: number | undefined;
  readonly dryRun?: boolean;
}): Promise<readonly RunDecision[]> {
  const ref = deletedQueueRef(options.event);
  if (ref === undefined) {
    logLine('Not a develop merge queue ref deletion; nothing to cancel.');
    return [];
  }
  const decisions: RunDecision[] = [];
  const failures: string[] = [];
  for (const run of await activeRuns(options.request, ref)) {
    try {
      const decision = decideCandidateRun({
        run, deletedRef: ref, workflowNames: options.workflowNames, currentRunId: options.currentRunId,
        liveRefSha: await liveRefSha(options.request, ref),
        containment: await containment(options.request, run.headSha),
      });
      if (decision.kind === 'cancel' && options.dryRun !== true
        && await cancel(options.request, run) === 'finished') {
        decisions.push({ kind: 'keep', run, reason: 'run finished before cancellation was accepted' });
      } else {
        decisions.push(decision);
      }
    } catch (error: unknown) {
      failures.push(`run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) throw new Error(`Could not cancel all dequeued candidate runs: ${failures.join('; ')}`);
  return decisions;
}

function describe(decision: RunDecision, dryRun: boolean): string {
  const run = `${decision.run.name} run ${decision.run.id} (${decision.run.status}, candidate ${decision.run.headSha})`;
  if (decision.kind === 'keep') return `kept: ${run}: ${decision.reason}`;
  return `${dryRun ? 'would cancel' : 'cancelled'}: ${run}`;
}

async function githubRequest(
  path: string,
  options: { readonly method?: 'GET' | 'POST' } = {},
): Promise<{ readonly status: number; readonly body: unknown }> {
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
  let body: unknown;
  try {
    body = response.status === 202 || response.status === 204 ? undefined : await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

async function main(): Promise<void> {
  const workflowNames = new Set(requiredEnv('CI_WORKFLOW_NAMES').split(',').map((value) => value.trim()).filter(Boolean));
  const runId = Number(process.env['GITHUB_RUN_ID']);
  const dryRun = process.env['DRY_RUN'] === 'true';
  const decisions = await cancelDequeuedCandidateRuns({
    request: githubRequest,
    event: JSON.parse(readFileSync(requiredEnv('GITHUB_EVENT_PATH'), 'utf8')) as unknown,
    workflowNames,
    ...(Number.isSafeInteger(runId) && runId > 0 ? { currentRunId: runId } : {}),
    dryRun,
  });
  const cancelled = decisions.filter((decision) => decision.kind === 'cancel');
  for (const decision of decisions) logLine(describe(decision, dryRun));
  appendStepSummary(`${dryRun ? 'Would cancel' : 'Cancelled'} ${cancelled.length} run(s) of the dequeued candidate; kept ${decisions.length - cancelled.length}.`);
  for (const decision of decisions) appendStepSummary(`- ${describe(decision, dryRun)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

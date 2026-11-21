import { parseArgs } from 'node:util';
import { z } from 'zod';

import { branchPolicyBaseline } from '../src/branchPolicy/baseline.ts';
import {
  attemptStartedBy,
  checkRunsPageSchema,
  isTimeoutReason,
  jobsPageSchema,
  mergeQueueMetrics,
  missingRequiredContexts,
  pullRequestSearchPageSchema,
  queueEntries,
  queueEventsFromSearchPage,
  removedEntryCandidate,
  removedEntryKey,
  workflowRunAttemptSchema,
  workflowRunsPageSchema,
  type CandidateRun,
  type QueueEvent,
  type WorkflowRun,
} from '../src/mergeQueueMetrics.ts';

/**
 * Merge-queue S3 exit metrics (docs/ci/merge-queue-plan.md, S3): p50/p90
 * enqueue-to-merge time, entries removed and why, and the Mac candidate rate
 * for `develop`. Reads GitHub once, prints one JSON document, and never waits
 * for anything to change.
 *
 * Usage: GITHUB_TOKEN=$(gh auth token) node ci/scripts/mergeQueueMetrics.ts
 *          [--since 2026-09-27T10:36:38Z] [--until <ISO time, default now>]
 */

const REPOSITORY = 'example-org/example-app';
const API = 'https://api.github.com';
/** When stage S3 added the `merge_queue` rule to ruleset 24024929. */
const S3_APPLIED_AT = '2026-09-27T10:36:38Z';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const { values: args } = parseArgs({
  options: {
    since: { type: 'string', default: S3_APPLIED_AT },
    until: { type: 'string', default: new Date().toISOString() },
  },
});
for (const [name, value] of Object.entries(args)) {
  if (Number.isNaN(Date.parse(value))) throw new Error(`--${name} must be an ISO 8601 time, got ${value}.`);
}

const token = process.env['GITHUB_TOKEN'] ?? '';
if (token.length === 0) throw new Error('GITHUB_TOKEN is required; run with GITHUB_TOKEN=$(gh auth token).');

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
  });
  if (response.status !== 200) throw new Error(`${init.method ?? 'GET'} ${path} answered HTTP ${response.status}.`);
  return response.json();
}

const SEARCH_QUERY = `
query($search: String!, $after: String) {
  search(query: $search, type: ISSUE, first: 50, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        timelineItems(itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, MERGED_EVENT], first: 100) {
          filteredCount
          nodes {
            __typename
            ... on AddedToMergeQueueEvent { createdAt }
            ... on RemovedFromMergeQueueEvent { createdAt reason }
            ... on MergedEvent { createdAt }
          }
        }
      }
    }
  }
}`;

const graphqlErrorsSchema = z.object({ errors: z.array(z.object({ message: z.string() })).min(1) });

/** GitHub search returns at most 1000 results; a larger window would be judged on part of it. */
const SEARCH_LIMIT = 1000;

/**
 * Pull requests created by `until` and updated since `since`. Bounding creation
 * keeps a rerun of a past window from counting pull requests opened later;
 * events after `until` are dropped when entries are paired.
 */
async function readQueueEvents(since: string, until: string): Promise<readonly QueueEvent[]> {
  // No `base:` qualifier: a PR retargeted after leaving the queue keeps its
  // develop queue events. Only develop has a queue (the branch-policy baseline
  // requires main to have none), so every queue event here is develop's.
  const search = `repo:${REPOSITORY} is:pr updated:>=${since.slice(0, 10)} created:<=${until.slice(0, 10)}`;
  const events: QueueEvent[] = [];
  let after: string | null = null;
  for (let page = 1; page <= SEARCH_LIMIT / 50; page++) {
    const raw = await request('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { search, after } }),
    });
    const errors = graphqlErrorsSchema.safeParse(raw);
    if (errors.success) throw new Error(`GraphQL search failed: ${errors.data.errors.map((error) => error.message).join('; ')}`);
    const body = pullRequestSearchPageSchema.parse(raw);
    if (body.data.search.issueCount > SEARCH_LIMIT) {
      throw new Error(`${body.data.search.issueCount} pull requests match; narrow the window below ${SEARCH_LIMIT}.`);
    }
    events.push(...queueEventsFromSearchPage(body));
    if (!body.data.search.pageInfo.hasNextPage) return events;
    after = body.data.search.pageInfo.endCursor;
  }
  throw new Error(`The pull request search did not end within ${SEARCH_LIMIT} results.`);
}

async function allPages<T>(path: string, items: (body: unknown) => { readonly total: number; readonly items: readonly T[] }): Promise<T[]> {
  const collected: T[] = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const parsed = items(await request(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`));
    collected.push(...parsed.items);
    if (parsed.items.length < PAGE_SIZE || collected.length >= parsed.total) return collected;
  }
  throw new Error(`GET ${path} has more than ${MAX_PAGES * PAGE_SIZE} items; refusing to judge a partial list.`);
}

/** The latest attempt of `current` that had started by `until`, if any. */
async function attemptAtCutoff(current: WorkflowRun, until: string): Promise<WorkflowRun | undefined> {
  for (let attempt = current.run_attempt; attempt >= 1; attempt--) {
    const run = attempt === current.run_attempt
      ? current
      : workflowRunAttemptSchema.parse(await request(`/repos/${REPOSITORY}/actions/runs/${current.id}/attempts/${attempt}`));
    if (attemptStartedBy(run, until)) return run;
  }
  return undefined;
}

async function readCandidateRuns(since: string, until: string): Promise<readonly CandidateRun[]> {
  const runs = await allPages<WorkflowRun>(
    `/repos/${REPOSITORY}/actions/workflows/ios-tests.yml/runs?event=merge_group&created=${since}..${until}`,
    (body) => {
      const page = workflowRunsPageSchema.parse(body);
      return { total: page.total_count, items: page.workflow_runs };
    },
  );
  const candidates: CandidateRun[] = [];
  for (const current of runs) {
    const run = await attemptAtCutoff(current, until);
    if (run === undefined) continue;
    const jobs = await allPages(`/repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, (body) => {
      const page = jobsPageSchema.parse(body);
      return { total: page.total_count, items: page.jobs };
    });
    candidates.push({ run, jobs });
  }
  return candidates;
}

/**
 * The current baseline's required checks, also for a past `--until`: the
 * report prints the set it used (`requiredChecks`), so a rerun after the set
 * changes shows which set judged it.
 */
const required = branchPolicyBaseline.branches.develop.controls.requiredChecks;

type CheckRuns = z.infer<typeof checkRunsPageSchema>['check_runs'];

/**
 * Missing required contexts per timed-out entry. Each removal is judged at its
 * own time; check runs are read once per candidate SHA.
 */
async function readMissingContexts(
  events: readonly QueueEvent[],
  runs: readonly WorkflowRun[],
): Promise<ReadonlyMap<string, readonly string[] | undefined>> {
  const checkRunsBySha = new Map<string, CheckRuns>();
  const missing = new Map<string, readonly string[] | undefined>();
  for (const entry of queueEntries(events)) {
    if (entry.outcome !== 'removed' || !isTimeoutReason(entry.reason)) continue;
    const candidate = removedEntryCandidate(entry, runs);
    if (candidate === undefined) continue;
    let checkRuns = checkRunsBySha.get(candidate.head_sha);
    if (checkRuns === undefined) {
      checkRuns = await allPages(`/repos/${REPOSITORY}/commits/${candidate.head_sha}/check-runs?filter=all`, (body) => {
        const page = checkRunsPageSchema.parse(body);
        return { total: page.total_count, items: page.check_runs };
      });
      checkRunsBySha.set(candidate.head_sha, checkRuns);
    }
    missing.set(removedEntryKey(entry), missingRequiredContexts(required, checkRuns, entry.endedAt ?? entry.enqueuedAt));
  }
  return missing;
}

const events = await readQueueEvents(args.since, args.until);
const candidateRuns = await readCandidateRuns(args.since, args.until);
// Entries that ended after --until are pending in this report; their check
// runs are not read.
const eventsByCutoff = events.filter((event) => Date.parse(event.at) <= Date.parse(args.until));
const missingContextsByEntry = await readMissingContexts(eventsByCutoff, candidateRuns.map((candidate) => candidate.run));
const metrics = mergeQueueMetrics({
  repository: REPOSITORY,
  since: args.since,
  until: args.until,
  events,
  candidateRuns,
  requiredChecks: required,
  missingContextsByEntry,
});
process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);

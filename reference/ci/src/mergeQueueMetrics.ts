import { z } from 'zod';

import type { RequiredCheck } from './branchPolicy/baseline.ts';

/**
 * The merge-queue S3 exit metrics (docs/ci/merge-queue-plan.md, S3) computed
 * from one read of GitHub: each pull request's queue timeline events and the
 * `merge_group` runs of `ios-tests.yml`. `ci/scripts/mergeQueueMetrics.ts`
 * does the reading; everything here is pure so it runs against fixtures.
 */

export type QueueEventKind = 'added' | 'removed' | 'merged';

export interface QueueEvent {
  readonly pr: number;
  readonly kind: QueueEventKind;
  readonly at: string;
  /** `RemovedFromMergeQueueEvent.reason`; null for the other kinds. */
  readonly reason: string | null;
}

const timelineNodeSchema = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('AddedToMergeQueueEvent'), createdAt: z.string() }),
  z.object({ __typename: z.literal('RemovedFromMergeQueueEvent'), createdAt: z.string(), reason: z.string().nullable() }),
  z.object({ __typename: z.literal('MergedEvent'), createdAt: z.string() }),
]);

const pullRequestNodeSchema = z.object({
  number: z.number().int().positive(),
  timelineItems: z.object({
    /** The count after `itemTypes` filtering; `totalCount` counts every timeline item. */
    filteredCount: z.number().int().nonnegative(),
    nodes: z.array(timelineNodeSchema),
  }),
});

/** One page of the GraphQL `search` over pull requests with their queue timeline events. */
export const pullRequestSearchPageSchema = z.object({
  data: z.object({
    search: z.object({
      issueCount: z.number().int().nonnegative(),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
      nodes: z.array(pullRequestNodeSchema),
    }),
  }),
});
export type PullRequestSearchPage = z.infer<typeof pullRequestSearchPageSchema>;

const KIND_BY_TYPENAME = {
  AddedToMergeQueueEvent: 'added',
  RemovedFromMergeQueueEvent: 'removed',
  MergedEvent: 'merged',
} as const satisfies Record<z.infer<typeof timelineNodeSchema>['__typename'], QueueEventKind>;

/**
 * The queue events of every pull request on a search page. A pull request
 * with more timeline events than the page returned would be judged on part of
 * its history, so it fails the read instead.
 */
export function queueEventsFromSearchPage(page: PullRequestSearchPage): readonly QueueEvent[] {
  const events: QueueEvent[] = [];
  for (const pullRequest of page.data.search.nodes) {
    const timeline = pullRequest.timelineItems;
    if (timeline.nodes.length < timeline.filteredCount) {
      throw new Error(
        `PR #${pullRequest.number} has ${timeline.filteredCount} queue timeline events but the page returned `
        + `${timeline.nodes.length}; raise the timelineItems page size.`,
      );
    }
    for (const node of timeline.nodes) {
      events.push({
        pr: pullRequest.number,
        kind: KIND_BY_TYPENAME[node.__typename],
        at: node.createdAt,
        reason: node.__typename === 'RemovedFromMergeQueueEvent' ? node.reason : null,
      });
    }
  }
  return events;
}

export type RemovalCause =
  | 'missing-context' | 'unknown-candidate' | 'check-failure' | 'timeout' | 'merge-conflict' | 'manual' | 'other';

/** One queue entry: from an `added` event to the next `removed` or `merged` event of the same PR. */
export interface QueueEntry {
  readonly pr: number;
  readonly enqueuedAt: string;
  readonly outcome: 'merged' | 'removed' | 'pending';
  readonly endedAt: string | null;
  readonly reason: string | null;
}

function byTime(left: QueueEvent, right: QueueEvent): number {
  return Date.parse(left.at) - Date.parse(right.at);
}

/**
 * GitHub ends a merged entry with both a `MergedEvent` and a
 * `RemovedFromMergeQueueEvent` whose reason is `merged`, in either order
 * (observed on the S2 scratch repository).
 */
const MERGED_REASON = 'merged';

/**
 * Pairs each `added` event with the first event that ended it. An end event
 * with no open entry (the second of a merged entry's two end events, a PR
 * merged directly before the queue existed, or an entry enqueued before the
 * window) is ignored, as is a second `added` while one is open.
 */
export function queueEntries(events: readonly QueueEvent[]): readonly QueueEntry[] {
  const byPr = new Map<number, QueueEvent[]>();
  for (const event of events) byPr.set(event.pr, [...(byPr.get(event.pr) ?? []), event]);
  const entries: QueueEntry[] = [];
  for (const [pr, prEvents] of [...byPr].sort(([left], [right]) => left - right)) {
    let open: QueueEvent | undefined;
    for (const event of [...prEvents].sort(byTime)) {
      if (event.kind === 'added') {
        open ??= event;
        continue;
      }
      if (open === undefined) continue;
      const merged = event.kind === 'merged' || event.reason === MERGED_REASON;
      entries.push({
        pr, enqueuedAt: open.at, outcome: merged ? 'merged' : 'removed', endedAt: event.at, reason: merged ? null : event.reason,
      });
      open = undefined;
    }
    if (open !== undefined) entries.push({ pr, enqueuedAt: open.at, outcome: 'pending', endedAt: null, reason: null });
  }
  return entries;
}

const TIMEOUT_REASON = /timed?[_ ]?out/;

/**
 * Why an entry left the queue. GitHub reports a required context that never
 * appeared on the candidate as `checks_timed_out`, the same reason as a check
 * that started and did not finish, so a timeout is `missing-context` when the
 * candidate lacks a required context and `timeout` when it has them all.
 * `missingContexts` is `undefined` when the candidate could not be identified
 * (for example when `ios-tests.yml` never started for it); that timeout is an
 * inspection gap, `unknown-candidate`, not evidence that every context appeared.
 */
export function removalCause(reason: string | null, missingContexts: readonly string[] | undefined): RemovalCause {
  const normalized = (reason ?? '').toLowerCase();
  if (TIMEOUT_REASON.test(normalized)) {
    if (missingContexts === undefined) return 'unknown-candidate';
    return missingContexts.length > 0 ? 'missing-context' : 'timeout';
  }
  if (/fail/.test(normalized)) return 'check-failure';
  if (/conflict/.test(normalized)) return 'merge-conflict';
  if (/manual|dequeue/.test(normalized)) return 'manual';
  return 'other';
}

/** Whether a removal reason is a timeout, the only cause that needs the candidate's check runs. */
export function isTimeoutReason(reason: string | null): boolean {
  return TIMEOUT_REASON.test((reason ?? '').toLowerCase());
}

/** Nearest-rank percentile; `null` for an empty sample. */
export function percentile(values: readonly number[], rank: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted[index] ?? null;
}

const QUEUE_REF = /^gh-readonly-queue\/develop\/pr-(\d+)-[0-9a-f]{40}$/;

/** The pull request a `develop` queue ref was built for, or `undefined` for any other branch. */
export function queueRefPullRequest(headBranch: string | null): number | undefined {
  const match = QUEUE_REF.exec(headBranch ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export const workflowRunsPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(z.object({
    id: z.number().int().positive(),
    event: z.string(),
    head_sha: z.string(),
    head_branch: z.string().nullable(),
    status: z.string().nullable(),
    run_attempt: z.number().int().positive(),
    created_at: z.string(),
    updated_at: z.string(),
    run_started_at: z.string().nullable(),
  })),
});
export type WorkflowRun = z.infer<typeof workflowRunsPageSchema>['workflow_runs'][number];

/** One attempt of a run, `GET .../actions/runs/{id}/attempts/{n}`. */
export const workflowRunAttemptSchema = workflowRunsPageSchema.shape.workflow_runs.element;

/**
 * Whether this attempt had started by `until`. A rerun after the cutoff makes a
 * later attempt current; a bounded report reads the attempt that existed then.
 */
export function attemptStartedBy(run: WorkflowRun, until: string): boolean {
  // `created_at` is the first attempt's creation, so it stands in for a start
  // time only there; a later attempt still queued has not started.
  const started = run.run_started_at ?? (run.run_attempt === 1 ? run.created_at : null);
  return started !== null && Date.parse(started) <= Date.parse(until);
}

export const jobsPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(z.object({
    name: z.string(),
    conclusion: z.string().nullable(),
    labels: z.array(z.string()),
    created_at: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable().optional(),
  })),
});
export type RunJob = z.infer<typeof jobsPageSchema>['jobs'][number];

export const checkRunsPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(z.object({
    name: z.string(),
    app: z.object({ id: z.number().int() }).nullable(),
    started_at: z.string().nullable(),
  })),
});

/** A `merge_group` run of `ios-tests.yml` and the jobs of its latest attempt. */
export interface CandidateRun {
  readonly run: WorkflowRun;
  readonly jobs: readonly RunJob[];
}

/** A candidate occupied a Mac when any job on a `macOS` runner was not skipped. */
export function usedMac(jobs: readonly RunJob[]): boolean {
  return jobs.some((job) => job.labels.includes('macOS') && job.conclusion !== 'skipped');
}

const MAC_WAIT_MINUTE = 60_000;

/**
 * Minutes each started, non-skipped Mac job waited between creation and a
 * runner picking it up: the queue wait behind the documented dedicated-Mac
 * trigger (p90 beyond 30 minutes), separate from execution and queue delay.
 */
export function macQueueWaitMinutes(jobs: readonly RunJob[], until: string): readonly number[] {
  const cutoff = Date.parse(until);
  return jobs.filter((job) => job.labels.includes('macOS') && job.conclusion !== 'skipped'
    && Date.parse(job.created_at) <= cutoff)
    .map((job) => {
      // A job still waiting at the cutoff counts with its age then (a censored
      // wait), so a saturated pool raises the percentile instead of hiding its
      // longest waits. A job that ended without starting stops waiting then.
      const end = job.started_at ?? job.completed_at ?? until;
      const waitedUntil = Math.min(Date.parse(end), cutoff);
      return Math.max(0, Math.round((waitedUntil - Date.parse(job.created_at)) / MAC_WAIT_MINUTE * 10) / 10);
    });
}

/**
 * The candidate runs that belong to one removed entry: `ios-tests.yml`
 * `merge_group` runs for that PR's queue ref created while the entry was open.
 */
export function entryCandidates(entry: QueueEntry, runs: readonly WorkflowRun[]): readonly WorkflowRun[] {
  const start = Date.parse(entry.enqueuedAt);
  const end = entry.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(entry.endedAt);
  return runs.filter((run) => {
    const created = Date.parse(run.created_at);
    return queueRefPullRequest(run.head_branch) === entry.pr && created >= start && created <= end;
  });
}

/**
 * Required contexts with no check run from their producer App on the candidate
 * at `removedAt`. Removal does not cancel the candidate's workflows, so the
 * check runs read now may include some created afterwards.
 *
 * A context with no check run at all was missing then too. A check run that
 * started by the removal was present. A check run still queued (`started_at`
 * null) or started after the removal may or may not have existed at the
 * removal: the check-runs API has no creation time. Unless another context is
 * certainly missing, that makes the removal an inspection gap (`undefined`),
 * so runner saturation is not reported as a missing context.
 */
export function missingRequiredContexts(
  required: readonly RequiredCheck[],
  checkRuns: z.infer<typeof checkRunsPageSchema>['check_runs'],
  removedAt: string,
): readonly string[] | undefined {
  const removal = Date.parse(removedAt);
  const missing: string[] = [];
  let undetermined = false;
  for (const check of required) {
    const produced = checkRuns.filter((run) =>
      run.name === check.context && (check.appId === 'any' || run.app?.id === check.appId));
    if (produced.length === 0) missing.push(check.context);
    else if (!produced.some((run) => run.started_at !== null && Date.parse(run.started_at) <= removal)) {
      undetermined = true;
    }
  }
  return missing.length === 0 && undetermined ? undefined : missing;
}

export interface RemovedEntryReport {
  readonly pr: number;
  readonly enqueuedAt: string;
  readonly removedAt: string;
  readonly reason: string | null;
  readonly cause: RemovalCause;
  readonly candidateSha: string | null;
  readonly missingContexts: readonly string[] | null;
}

/**
 * Identifies one removed queue entry. A PR can be removed more than once with
 * the same candidate SHA, and each removal is judged at its own time, so the
 * candidate SHA alone does not identify the evidence.
 */
export function removedEntryKey(entry: QueueEntry): string {
  return `${entry.pr}@${entry.endedAt ?? entry.enqueuedAt}`;
}

export interface MergeQueueMetricsInput {
  readonly repository: string;
  readonly since: string;
  readonly until: string;
  readonly events: readonly QueueEvent[];
  readonly candidateRuns: readonly CandidateRun[];
  /** The required checks the removals were judged against; echoed in the report. */
  readonly requiredChecks: readonly RequiredCheck[];
  /** Missing required contexts per timed-out entry (`removedEntryKey`), read by the caller. */
  readonly missingContextsByEntry: ReadonlyMap<string, readonly string[] | undefined>;
}

export interface MergeQueueMetrics {
  readonly schema: 'example.merge-queue-metrics.v1';
  readonly repository: string;
  readonly branch: 'develop';
  readonly window: { readonly since: string; readonly until: string };
  readonly requiredChecks: readonly RequiredCheck[];
  readonly entries: { readonly total: number; readonly merged: number; readonly removed: number; readonly pending: number };
  readonly enqueueToMergeMinutes: { readonly count: number; readonly p50: number | null; readonly p90: number | null };
  readonly removals: Readonly<Record<RemovalCause, number>>;
  readonly removedEntries: readonly RemovedEntryReport[];
  readonly macQueueWaitMinutes: { readonly count: number; readonly p50: number | null; readonly p90: number | null };
  readonly macCandidates: {
    readonly completedCandidates: number;
    readonly macCandidates: number;
    readonly rate: number | null;
    readonly incompleteCandidates: number;
  };
}

function inWindow(at: string, since: string, until: string): boolean {
  const time = Date.parse(at);
  return time >= Date.parse(since) && time <= Date.parse(until);
}

/** The latest candidate run of a removed entry, whose SHA is the one GitHub timed out. */
export function removedEntryCandidate(entry: QueueEntry, runs: readonly WorkflowRun[]): WorkflowRun | undefined {
  return [...entryCandidates(entry, runs)].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
}

function removedEntryReport(entry: QueueEntry, input: MergeQueueMetricsInput): RemovedEntryReport {
  const candidate = removedEntryCandidate(entry, input.candidateRuns.map((candidateRun) => candidateRun.run));
  const missing = candidate === undefined ? undefined : input.missingContextsByEntry.get(removedEntryKey(entry));
  return {
    pr: entry.pr,
    enqueuedAt: entry.enqueuedAt,
    removedAt: entry.endedAt ?? entry.enqueuedAt,
    reason: entry.reason,
    cause: removalCause(entry.reason, missing),
    candidateSha: candidate?.head_sha ?? null,
    missingContexts: missing === undefined ? null : [...missing],
  };
}

const MINUTE = 60_000;

/**
 * Entries enqueued inside the window, and candidate runs created inside it.
 * Events after `until` are dropped before pairing, so an entry still queued at
 * the cutoff is reported as pending rather than with its later outcome.
 */
export function mergeQueueMetrics(input: MergeQueueMetricsInput): MergeQueueMetrics {
  const cutoff = Date.parse(input.until);
  const eventsAtCutoff = input.events.filter((event) => Date.parse(event.at) <= cutoff);
  const entries = queueEntries(eventsAtCutoff).filter((entry) => inWindow(entry.enqueuedAt, input.since, input.until));
  const merged = entries.filter((entry) => entry.outcome === 'merged');
  const minutes = merged.map((entry) =>
    Math.round((Date.parse(entry.endedAt ?? entry.enqueuedAt) - Date.parse(entry.enqueuedAt)) / MINUTE * 10) / 10);
  const removedEntries = entries.filter((entry) => entry.outcome === 'removed').map((entry) => removedEntryReport(entry, input));
  const removals: Record<RemovalCause, number> = {
    'missing-context': 0, 'unknown-candidate': 0, 'check-failure': 0, timeout: 0, 'merge-conflict': 0, manual: 0, other: 0,
  };
  for (const entry of removedEntries) removals[entry.cause] += 1;

  const candidates = input.candidateRuns.filter((candidate) => inWindow(candidate.run.created_at, input.since, input.until));
  // A run that finished after `until` was still incomplete at the cutoff.
  const completed = candidates.filter((candidate) => candidate.run.status === 'completed'
    && Date.parse(candidate.run.updated_at) <= cutoff);
  const macCount = completed.filter((candidate) => usedMac(candidate.jobs)).length;
  const macWaits = candidates.flatMap((candidate) => macQueueWaitMinutes(candidate.jobs, input.until));
  return {
    schema: 'example.merge-queue-metrics.v1',
    repository: input.repository,
    branch: 'develop',
    window: { since: input.since, until: input.until },
    requiredChecks: input.requiredChecks,
    entries: {
      total: entries.length,
      merged: merged.length,
      removed: removedEntries.length,
      pending: entries.filter((entry) => entry.outcome === 'pending').length,
    },
    enqueueToMergeMinutes: { count: minutes.length, p50: percentile(minutes, 50), p90: percentile(minutes, 90) },
    removals,
    removedEntries,
    macQueueWaitMinutes: { count: macWaits.length, p50: percentile(macWaits, 50), p90: percentile(macWaits, 90) },
    macCandidates: {
      completedCandidates: completed.length,
      macCandidates: macCount,
      rate: completed.length === 0 ? null : Math.round((macCount / completed.length) * 1000) / 1000,
      incompleteCandidates: candidates.length - completed.length,
    },
  };
}

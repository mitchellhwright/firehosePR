import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { branchPolicyBaseline } from '../src/branchPolicy/baseline.ts';
import {
  attemptStartedBy,
  checkRunsPageSchema,
  jobsPageSchema,
  macQueueWaitMinutes,
  mergeQueueMetrics,
  missingRequiredContexts,
  percentile,
  pullRequestSearchPageSchema,
  queueEntries,
  queueEventsFromSearchPage,
  queueRefPullRequest,
  removalCause,
  removedEntryKey,
  usedMac,
  workflowRunsPageSchema,
  type CandidateRun,
  type MergeQueueMetricsInput,
} from '../src/mergeQueueMetrics.ts';

const SHA_TIMED_OUT_MISSING = 'a'.repeat(40);
const SHA_TIMED_OUT_PENDING = 'b'.repeat(40);
const SHA_PR6 = 'c'.repeat(40);
const SHA_PR8 = 'd'.repeat(40);
const BASE = 'e'.repeat(40);
const ACTIONS = 15368;

function timelinePage(): unknown {
  return JSON.parse(readFileSync('ci/tests/fixtures/mergeQueueTimeline.json', 'utf8'));
}

function run(id: number, pr: number, sha: string, createdAt: string, status: string): unknown {
  return {
    id, event: 'merge_group', head_sha: sha, head_branch: `gh-readonly-queue/develop/pr-${pr}-${BASE}`,
    status, run_attempt: 1, created_at: createdAt, updated_at: createdAt, run_started_at: createdAt,
  };
}

/** `GET .../actions/workflows/ios-tests.yml/runs?event=merge_group` for the scratch timeline's window. */
const runsPage = workflowRunsPageSchema.parse({
  total_count: 4,
  workflow_runs: [
    run(1, 5, SHA_TIMED_OUT_MISSING, '2026-09-27T01:28:10Z', 'completed'),
    run(2, 5, SHA_TIMED_OUT_PENDING, '2026-09-27T02:06:00Z', 'completed'),
    run(3, 6, SHA_PR6, '2026-09-27T01:36:30Z', 'in_progress'),
    run(4, 8, SHA_PR8, '2026-09-27T01:38:50Z', 'completed'),
  ],
});

const macJob = (conclusion: string | null, startedAt: string | null = '2026-09-27T01:40:00Z'): unknown => ({
  name: 'Test - iOS execution (unit)', conclusion, labels: ['self-hosted', 'macOS', 'ios-xcode'],
  created_at: '2026-09-27T01:30:00Z', started_at: conclusion === 'skipped' ? null : startedAt,
});
const linuxJob = {
  name: 'iOS Change Gate', conclusion: 'success', labels: ['self-hosted', 'Linux'],
  created_at: '2026-09-27T01:28:10Z', started_at: '2026-09-27T01:28:15Z',
};

const jobsByRun: Readonly<Record<number, unknown>> = {
  1: { total_count: 2, jobs: [linuxJob, macJob('success')] },
  2: { total_count: 2, jobs: [linuxJob, macJob('skipped')] },
  3: { total_count: 2, jobs: [linuxJob, macJob(null)] },
  4: { total_count: 1, jobs: [linuxJob] },
};

function candidateRuns(): CandidateRun[] {
  return runsPage.workflow_runs.map((workflowRun) => ({
    run: workflowRun,
    jobs: jobsPageSchema.parse(jobsByRun[workflowRun.id]).jobs,
  }));
}

const requiredChecks = branchPolicyBaseline.branches.develop.controls.requiredChecks;

const REMOVED_AT = '2026-09-27T05:00:00Z';

function checkRuns(contexts: readonly string[], startedAt: string | null = '2026-09-27T01:29:00Z') {
  return checkRunsPageSchema.parse({
    total_count: contexts.length,
    check_runs: contexts.map((name) => ({ name, app: { id: ACTIONS }, started_at: startedAt })),
  }).check_runs;
}

const allContexts = requiredChecks.map((check) => check.context);

function input(overrides: Partial<MergeQueueMetricsInput> = {}): MergeQueueMetricsInput {
  return {
    repository: 'example-org/example-merge-queue-scratch',
    since: '2026-09-27T00:00:00Z',
    until: '2026-09-27T05:00:00Z',
    events: queueEventsFromSearchPage(pullRequestSearchPageSchema.parse(timelinePage())),
    candidateRuns: candidateRuns(),
    requiredChecks,
    missingContextsByEntry: new Map([
      ['5@2026-09-27T01:30:27Z', missingRequiredContexts(requiredChecks,
        checkRuns(allContexts.filter((context) => context !== 'Onboarding E2E')), REMOVED_AT)],
      ['5@2026-09-27T04:38:26Z', missingRequiredContexts(requiredChecks, checkRuns(allContexts), REMOVED_AT)],
    ]),
    ...overrides,
  };
}

describe('merge queue metrics against the S2 scratch timeline', () => {
  it('reports enqueue-to-merge percentiles, removal causes and the Mac candidate rate', () => {
    const metrics = mergeQueueMetrics(input());
    assert.deepEqual(metrics.entries, { total: 6, merged: 2, removed: 4, pending: 0 });
    assert.deepEqual(metrics.enqueueToMergeMinutes, { count: 2, p50: 0.8, p90: 0.8 });
    assert.deepEqual(metrics.removals, {
      'missing-context': 1, 'unknown-candidate': 0, 'check-failure': 1, timeout: 1, 'merge-conflict': 0, manual: 1, other: 0,
    });
    assert.deepEqual(metrics.macCandidates, {
      completedCandidates: 3, macCandidates: 1, rate: 0.333, incompleteCandidates: 1,
    });
  });

  it('names the candidate and its missing contexts for each timed-out entry', () => {
    const removed = mergeQueueMetrics(input()).removedEntries;
    assert.deepEqual(removed.map((entry) => [entry.reason, entry.cause, entry.candidateSha]), [
      ['checks_timed_out', 'missing-context', SHA_TIMED_OUT_MISSING],
      ['failed_checks', 'check-failure', null],
      ['manual', 'manual', null],
      ['checks_timed_out', 'timeout', SHA_TIMED_OUT_PENDING],
    ]);
    assert.deepEqual(removed[0]?.missingContexts, ['Onboarding E2E']);
    assert.deepEqual(removed[3]?.missingContexts, []);
  });

  it('reports a timed-out entry as unknown-candidate when ios-tests.yml never ran for it', () => {
    const metrics = mergeQueueMetrics(input({
      candidateRuns: candidateRuns().filter((candidate) => candidate.run.head_sha !== SHA_TIMED_OUT_MISSING),
    }));
    assert.deepEqual(metrics.removals, {
      'missing-context': 0, 'unknown-candidate': 1, 'check-failure': 1, timeout: 1, 'merge-conflict': 0, manual: 1, other: 0,
    });
    const gap = metrics.removedEntries[0];
    assert.deepEqual([gap?.reason, gap?.cause, gap?.candidateSha, gap?.missingContexts],
      ['checks_timed_out', 'unknown-candidate', null, null]);
  });

  it('reports a timed-out entry as unknown-candidate when its check runs were not read', () => {
    const metrics = mergeQueueMetrics(input({ missingContextsByEntry: new Map() }));
    assert.deepEqual(metrics.removedEntries.map((entry) => [entry.cause, entry.candidateSha]), [
      ['unknown-candidate', SHA_TIMED_OUT_MISSING],
      ['check-failure', null],
      ['manual', null],
      ['unknown-candidate', SHA_TIMED_OUT_PENDING],
    ]);
  });

  it('judges each removal of the same candidate SHA at its own removal time', () => {
    const events = [
      { pr: 9, kind: 'added', at: '2026-09-27T01:00:00Z', reason: null },
      { pr: 9, kind: 'removed', at: '2026-09-27T01:30:00Z', reason: 'checks_timed_out' },
      { pr: 9, kind: 'added', at: '2026-09-27T02:00:00Z', reason: null },
      { pr: 9, kind: 'removed', at: '2026-09-27T03:00:00Z', reason: 'checks_timed_out' },
    ] as const;
    const sameSha = workflowRunsPageSchema.parse({ total_count: 2, workflow_runs: [
      run(11, 9, SHA_PR8, '2026-09-27T01:01:00Z', 'completed'),
      run(12, 9, SHA_PR8, '2026-09-27T02:01:00Z', 'completed'),
    ] }).workflow_runs.map((workflowRun) => ({ run: workflowRun, jobs: [] }));
    const onboardingStartedLate = [
      ...checkRuns(allContexts.filter((context) => context !== 'Onboarding E2E')),
      ...checkRuns(['Onboarding E2E'], '2026-09-27T02:30:00Z'),
    ];
    const missingContextsByEntry = new Map(queueEntries(events).map((entry) => [
      removedEntryKey(entry), missingRequiredContexts(requiredChecks, onboardingStartedLate, entry.endedAt ?? entry.enqueuedAt),
    ]));
    const metrics = mergeQueueMetrics(input({ events, candidateRuns: sameSha, missingContextsByEntry }));
    assert.deepEqual(metrics.removedEntries.map((entry) => [entry.removedAt, entry.cause, entry.candidateSha]), [
      ['2026-09-27T01:30:00Z', 'unknown-candidate', SHA_PR8],
      ['2026-09-27T03:00:00Z', 'timeout', SHA_PR8],
    ]);
  });

  it('prints the required checks it judged removals against', () => {
    assert.deepEqual(mergeQueueMetrics(input()).requiredChecks, requiredChecks);
  });

  it('counts a merged entry once whichever of its two end events comes first', () => {
    const merged = queueEntries(input().events).filter((entry) => entry.outcome === 'merged');
    assert.deepEqual(merged.map((entry) => [entry.pr, entry.endedAt]), [
      [6, '2026-09-27T01:37:03Z'],
      [8, '2026-09-27T01:39:29Z'],
    ]);
  });

  it('leaves out entries and candidates outside the window', () => {
    const metrics = mergeQueueMetrics(input({ since: '2026-09-27T01:35:00Z', until: '2026-09-27T01:40:00Z' }));
    assert.deepEqual(metrics.entries, { total: 2, merged: 2, removed: 0, pending: 0 });
    assert.deepEqual(metrics.macCandidates, {
      completedCandidates: 1, macCandidates: 0, rate: 0, incompleteCandidates: 1,
    });
  });

  it('reports an entry still queued at the cutoff as pending, not with its later outcome', () => {
    const metrics = mergeQueueMetrics(input({ since: '2026-09-27T01:35:00Z', until: '2026-09-27T01:37:00Z' }));
    assert.deepEqual(metrics.entries, { total: 1, merged: 0, removed: 0, pending: 1 });
    assert.deepEqual(metrics.enqueueToMergeMinutes, { count: 0, p50: null, p90: null });
    const beforeRemoval = mergeQueueMetrics(input({ since: '2026-09-27T02:00:00Z', until: '2026-09-27T04:00:00Z' }));
    assert.deepEqual(beforeRemoval.entries, { total: 1, merged: 0, removed: 0, pending: 1 });
    assert.deepEqual(beforeRemoval.removedEntries, []);
  });

  it('reports the Mac job queue wait separately from enqueue-to-merge time', () => {
    const [first, second] = runsPage.workflow_runs;
    assert.ok(first && second);
    const metrics = mergeQueueMetrics(input({
      candidateRuns: [
        { run: first, jobs: jobsPageSchema.parse({ total_count: 3, jobs: [
          linuxJob, macJob('success', '2026-09-27T01:35:00Z'), macJob(null, null),
        ] }).jobs },
        { run: second, jobs: jobsPageSchema.parse({ total_count: 2, jobs: [
          macJob('success', '2026-09-27T02:10:00Z'), macJob('skipped'),
        ] }).jobs },
      ],
    }));
    assert.deepEqual(metrics.macQueueWaitMinutes, { count: 3, p50: 40, p90: 210 });
    assert.deepEqual(macQueueWaitMinutes(jobsPageSchema.parse({ total_count: 1, jobs: [linuxJob] }).jobs, REMOVED_AT), []);
    const cancelledBeforeStart = jobsPageSchema.parse({ total_count: 1, jobs: [{
      name: 'Test - iOS execution (unit)', conclusion: 'cancelled', labels: ['self-hosted', 'macOS', 'ios-xcode'],
      created_at: '2026-09-27T01:30:00Z', started_at: null, completed_at: '2026-09-27T01:45:00Z',
    }] }).jobs;
    assert.deepEqual(macQueueWaitMinutes(cancelledBeforeStart, REMOVED_AT), [15]);
  });

  it('uses candidate state as of the cutoff, not later completion or Mac starts', () => {
    const [first] = runsPage.workflow_runs;
    assert.ok(first);
    const finishedLater = { ...first, status: 'completed', updated_at: '2026-09-27T06:00:00Z' };
    const metrics = mergeQueueMetrics(input({
      candidateRuns: [{ run: finishedLater, jobs: jobsPageSchema.parse({ total_count: 2, jobs: [
        macJob('success', '2026-09-27T01:35:00Z'), macJob('success', '2026-09-27T05:30:00Z'),
      ] }).jobs }],
    }));
    assert.deepEqual(metrics.macCandidates, {
      completedCandidates: 0, macCandidates: 0, rate: null, incompleteCandidates: 1,
    });
    assert.deepEqual(metrics.macQueueWaitMinutes, { count: 2, p50: 5, p90: 210 });
  });

  it('reports an empty window with null percentiles and a null rate', () => {
    const metrics = mergeQueueMetrics(input({ events: [], candidateRuns: [] }));
    assert.deepEqual(metrics.entries, { total: 0, merged: 0, removed: 0, pending: 0 });
    assert.deepEqual(metrics.enqueueToMergeMinutes, { count: 0, p50: null, p90: null });
    assert.equal(metrics.macCandidates.rate, null);
  });

  it('refuses a pull request whose queue timeline was truncated', () => {
    const page = pullRequestSearchPageSchema.parse(timelinePage());
    const first = page.data.search.nodes[0];
    assert.ok(first);
    const truncated = {
      data: {
        search: {
          ...page.data.search,
          nodes: [{ ...first, timelineItems: { ...first.timelineItems, filteredCount: first.timelineItems.nodes.length + 1 } }],
        },
      },
    };
    assert.throws(() => queueEventsFromSearchPage(truncated), /raise the timelineItems page size/);
  });
});

describe('queue entry pairing', () => {
  it('keeps an entry still in the queue as pending and ignores end events without an open entry', () => {
    const entries = queueEntries([
      { pr: 1, kind: 'merged', at: '2026-09-27T00:00:00Z', reason: null },
      { pr: 2, kind: 'added', at: '2026-09-27T00:01:00Z', reason: null },
      { pr: 2, kind: 'added', at: '2026-09-27T00:02:00Z', reason: null },
    ]);
    assert.deepEqual(entries, [{ pr: 2, enqueuedAt: '2026-09-27T00:01:00Z', outcome: 'pending', endedAt: null, reason: null }]);
  });
});

describe('removal cause', () => {
  it('splits a timeout by whether the candidate lacked a required context', () => {
    assert.equal(removalCause('checks_timed_out', ['Test - iOS']), 'missing-context');
    assert.equal(removalCause('checks_timed_out', []), 'timeout');
  });

  it('reports a timeout with no identified candidate as an inspection gap', () => {
    assert.equal(removalCause('checks_timed_out', undefined), 'unknown-candidate');
  });

  it('maps the other reasons GitHub reports and keeps unknown ones visible', () => {
    assert.equal(removalCause('failed_checks', undefined), 'check-failure');
    assert.equal(removalCause('merge_conflict', undefined), 'merge-conflict');
    assert.equal(removalCause('manual', undefined), 'manual');
    assert.equal(removalCause('invalid_merge_commit', undefined), 'other');
    assert.equal(removalCause(null, undefined), 'other');
  });
});

describe('helpers', () => {
  it('computes nearest-rank percentiles', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([7], 90), 7);
    assert.equal(percentile([10, 1, 5, 3], 50), 3);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  });

  it('reads the pull request only from a develop queue ref', () => {
    assert.equal(queueRefPullRequest(`gh-readonly-queue/develop/pr-6230-${BASE}`), 6230);
    assert.equal(queueRefPullRequest(`gh-readonly-queue/main/pr-6230-${BASE}`), undefined);
    assert.equal(queueRefPullRequest('develop'), undefined);
    assert.equal(queueRefPullRequest(null), undefined);
  });

  it('counts a Mac only when a macOS job was not skipped', () => {
    const jobs = (conclusion: string | null) => jobsPageSchema.parse({ total_count: 1, jobs: [macJob(conclusion)] }).jobs;
    assert.equal(usedMac(jobs('failure')), true);
    assert.equal(usedMac(jobs('skipped')), false);
    assert.equal(usedMac([]), false);
  });

  it('treats a required context from the wrong App as missing', () => {
    const wrongApp = checkRunsPageSchema.parse({
      total_count: 1, check_runs: [{ name: 'Test - iOS', app: { id: 1 }, started_at: '2026-09-27T01:29:00Z' }],
    }).check_runs;
    assert.deepEqual(missingRequiredContexts([{ context: 'Test - iOS', appId: ACTIONS }], wrongApp, REMOVED_AT), ['Test - iOS']);
    assert.deepEqual(missingRequiredContexts([{ context: 'Test - iOS', appId: 'any' }], wrongApp, REMOVED_AT), []);
  });

  it('reports a context that is absent as missing and one only queued or late as undetermined', () => {
    const required = [{ context: 'Onboarding E2E', appId: ACTIONS }, { context: 'Test - iOS', appId: ACTIONS }];
    const late = checkRuns(['Onboarding E2E'], '2026-09-27T05:10:00Z');
    const queued = checkRuns(['Onboarding E2E'], null);
    const started = checkRuns(['Test - iOS'], REMOVED_AT);
    assert.equal(missingRequiredContexts(required, [...late, ...started], REMOVED_AT), undefined);
    assert.equal(missingRequiredContexts(required, [...queued, ...started], REMOVED_AT), undefined);
    assert.deepEqual(missingRequiredContexts(required, [...checkRuns(['Onboarding E2E'], REMOVED_AT), ...started],
      REMOVED_AT), []);
    assert.deepEqual(missingRequiredContexts(required, late, REMOVED_AT), ['Test - iOS']);
    assert.equal(removalCause('checks_timed_out', missingRequiredContexts(required, [...queued, ...started], REMOVED_AT)),
      'unknown-candidate');
  });

  it('reads the run attempt that had started by the cutoff', () => {
    const [first] = runsPage.workflow_runs;
    assert.ok(first);
    assert.equal(attemptStartedBy(first, REMOVED_AT), true);
    assert.equal(attemptStartedBy({ ...first, run_attempt: 2, run_started_at: '2026-09-27T06:00:00Z' }, REMOVED_AT), false);
    assert.equal(attemptStartedBy({ ...first, run_started_at: null }, REMOVED_AT), true);
    assert.equal(attemptStartedBy({ ...first, run_attempt: 2, run_started_at: null }, REMOVED_AT), false);
  });
});

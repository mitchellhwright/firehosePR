import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { main as cancelIosRuns, report } from '../src/actions/cancelObsoleteIosRuns.ts';
import type { GithubObject } from '../src/actions/cancelObsoleteIosRuns.ts';
import {
  deriveTupleLifecyclePlan,
  tupleLifecycleInputSchema,
  tupleLifecyclePlanSchema,
} from '../src/tupleLifecycle.ts';
import type { TupleLifecycleInput, TupleLifecyclePlan } from '../src/tupleLifecycle.ts';
import { refreshPrCiAfterBaseEdit } from '../workflows/refresh-pr-ci-after-base-edit.ts';
import { releaseFullRoutingPredecessor } from '../workflows/ios-tests/release-full-routing-predecessor.ts';
import { jobOf } from '../workflows/lib/model.ts';
import { renderName } from '../workflows/lib/names.ts';

const repository = 'example-org/example-app';
const previousHead = 'a'.repeat(40);
const head = 'b'.repeat(40);
const base = 'c'.repeat(40);

const tuple = {
  number: 5432,
  state: 'open' as const,
  draft: false,
  head: { sha: head, ref: 'codex/ci-repair', repository },
  base: { sha: base, ref: 'develop', repository },
};

function typedRun(overrides: Partial<TupleLifecycleInput['runs'][number]> = {}) {
  return {
    id: 34876151317,
    workflow: 'Test - iOS',
    headSha: previousHead,
    status: 'in_progress' as const,
    createdAt: '2026-09-14T18:00:00Z',
    pullRequests: [{ number: tuple.number, baseRef: tuple.base.ref }],
    ...overrides,
  };
}

const baseInput: TupleLifecycleInput = {
  repository,
  event: { action: 'synchronize', previousHeadSha: previousHead, baseChanged: false },
  pullRequest: tuple,
  livePullRequest: tuple,
  iosExecutionScopeChangedByHead: { [previousHead]: true },
  patchEquivalentPredecessor: false,
  verifiedLineage: [],
  runs: [typedRun()],
};

describe('deriveTupleLifecyclePlan', () => {
  it('cancels an active obsolete run when the synchronize delta touches iOS execution scope', () => {
    const plan = deriveTupleLifecyclePlan(baseInput);

    assert.equal(plan.schema, 'example.tuple-lifecycle-plan.v2');
    assert.equal(plan.trigger, 'synchronize');
    assert.equal(plan.applicable, true);
    assert.equal(plan.reasonCode, 'decisions-derived');
    assert.deepEqual(plan.cancelRunIds, [34876151317]);
    assert.deepEqual(plan.retainRunIds, []);
    assert.deepEqual(plan.decisions, [{
      runId: 34876151317,
      headSha: previousHead,
      disposition: 'cancel-obsolete',
      reasonCode: 'obsolete-head',
    }]);
  });

  it('keeps an active run at the current head', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      runs: [typedRun({ id: 1, headSha: head })],
    });

    assert.deepEqual(plan.cancelRunIds, []);
    assert.deepEqual(plan.decisions, [{
      runId: 1, headSha: head, disposition: 'current', reasonCode: 'current-head',
    }]);
  });

  it('is inapplicable to an event that invokes no cancellation rule', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      event: { action: 'opened', previousHeadSha: null, baseChanged: false },
    });

    assert.equal(plan.applicable, false);
    assert.equal(plan.trigger, null);
    assert.equal(plan.reasonCode, 'event-not-handled');
    assert.deepEqual(plan.decisions, []);
    assert.deepEqual(plan.cancelRunIds, []);
  });

  it('is inapplicable when the previous head is unknown', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      event: { action: 'synchronize', previousHeadSha: null, baseChanged: false },
    });

    assert.equal(plan.applicable, false);
    assert.equal(plan.reasonCode, 'previous-head-unknown');
  });

  it('is inapplicable for a tuple outside the repository', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      pullRequest: { ...tuple, head: { ...tuple.head, repository: 'fork/example-app' } },
    });

    assert.equal(plan.applicable, false);
    assert.equal(plan.reasonCode, 'tuple-outside-repository');
  });

  it('is inapplicable when the live pull request no longer matches the event tuple', () => {
    for (const livePullRequest of [
      null,
      { ...tuple, draft: true },
      { ...tuple, state: 'closed' as const },
      { ...tuple, head: { ...tuple.head, sha: 'd'.repeat(40) } },
      { ...tuple, base: { ...tuple.base, ref: 'main' } },
    ]) {
      const plan = deriveTupleLifecyclePlan({ ...baseInput, livePullRequest });
      assert.equal(plan.applicable, false);
      assert.equal(plan.reasonCode, 'tuple-superseded');
      assert.deepEqual(plan.cancelRunIds, []);
    }
  });

  it('retains prior work when the delta cannot affect iOS execution', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput, iosExecutionScopeChangedByHead: { [previousHead]: false },
    });

    assert.equal(plan.applicable, false);
    assert.equal(plan.reasonCode, 'ios-scope-unchanged');
    assert.deepEqual(plan.cancelRunIds, []);
  });

  it('cancels only an obsolete pending run when iOS scope is unchanged', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      iosExecutionScopeChangedByHead: { [previousHead]: false },
      runs: [typedRun({ id: 1 }), typedRun({ id: 2, status: 'queued' }),
        typedRun({ id: 3, status: 'pending' }), typedRun({ id: 4, status: 'pending', headSha: head })],
    });

    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.cancelRunIds, [3]);
    assert.deepEqual(plan.ignoredRuns, [
      { runId: 1, reasonCode: 'ios-scope-unchanged' },
      { runId: 2, reasonCode: 'ios-scope-unchanged' },
    ]);
    assert.deepEqual(plan.retainRunIds, []);
  });

  it('fails closed when a fact was never evaluated', () => {
    for (const facts of [
      { iosExecutionScopeChangedByHead: null },
      { iosExecutionScopeChangedByHead: {} },
      { patchEquivalentPredecessor: null },
    ]) {
      const plan = deriveTupleLifecyclePlan({ ...baseInput, ...facts });
      assert.equal(plan.applicable, false);
      assert.equal(plan.reasonCode, 'facts-incomplete');
      assert.deepEqual(plan.cancelRunIds, []);
    }
  });

  it('retains only the newest active run at a verified patch-equivalent ancestor', () => {
    const retained = typedRun({ id: 10, createdAt: '2026-09-14T18:00:00Z' });
    const olderDuplicate = typedRun({ id: 11, createdAt: '2026-09-14T17:59:00Z' });
    const otherBase = typedRun({
      id: 12,
      createdAt: '2026-09-14T18:01:00Z',
      pullRequests: [{ number: tuple.number, baseRef: 'main' }],
    });
    const unrelatedHead = typedRun({ id: 13, headSha: 'f'.repeat(40) });
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      iosExecutionScopeChangedByHead: { [previousHead]: true, ['f'.repeat(40)]: true },
      patchEquivalentPredecessor: true,
      verifiedLineage: [{ headSha: previousHead, completedReusableEvidence: false }],
      runs: [retained, otherBase, unrelatedHead, olderDuplicate],
    });

    assert.deepEqual(plan.retainRunIds, [10]);
    assert.deepEqual(plan.cancelRunIds, [11, 12, 13]);
    assert.deepEqual(
      plan.decisions.find((decision) => decision.runId === 10),
      { runId: 10, headSha: previousHead, disposition: 'retain-patch-equivalent-predecessor', reasonCode: 'retained-verified-ancestor' },
    );
  });

  it('cancels a verified ancestor run that holds only unstarted Mac jobs', () => {
    const idle = typedRun({ id: 10 });
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      patchEquivalentPredecessor: true,
      verifiedLineage: [{ headSha: previousHead, completedReusableEvidence: false }],
      queuedOnlyRunIds: [idle.id],
      runs: [idle],
    });

    assert.deepEqual(plan.retainRunIds, []);
    assert.deepEqual(plan.cancelRunIds, [10]);
  });

  it('retains one run per verified ancestor across a chained base update', () => {
    const product = '1'.repeat(40);
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      iosExecutionScopeChangedByHead: { [previousHead]: true, [product]: true },
      patchEquivalentPredecessor: true,
      verifiedLineage: [
        { headSha: previousHead, completedReusableEvidence: false },
        { headSha: product, completedReusableEvidence: false },
      ],
      runs: [typedRun({ id: 20 }), typedRun({ id: 21, headSha: product, createdAt: '2026-09-14T17:00:00Z' })],
    });

    assert.deepEqual(plan.retainRunIds, [20, 21]);
    assert.deepEqual(plan.cancelRunIds, []);
  });

  it('stops retaining at an ancestor that already holds completed reusable evidence', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      patchEquivalentPredecessor: true,
      verifiedLineage: [{ headSha: previousHead, completedReusableEvidence: true }],
      runs: [typedRun({ id: 30 }), typedRun({ id: 31, status: 'queued', createdAt: '2026-09-14T18:01:00Z' })],
    });

    assert.deepEqual(plan.retainRunIds, []);
    assert.deepEqual(plan.cancelRunIds, [30, 31]);
  });

  it('ignores runs outside the workflow, pull request, or active states with a typed reason', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      runs: [
        typedRun({ id: 40, workflow: 'PR Checks' }),
        typedRun({ id: 41, pullRequests: [{ number: 99, baseRef: 'develop' }] }),
        typedRun({ id: 42, status: 'completed' }),
        typedRun({ id: 43 }),
      ],
    });

    assert.deepEqual(plan.ignoredRuns, [
      { runId: 40, reasonCode: 'workflow-out-of-scope' },
      { runId: 41, reasonCode: 'pull-request-mismatch' },
      { runId: 42, reasonCode: 'run-not-active' },
    ]);
    assert.deepEqual(plan.cancelRunIds, [43]);
  });

  it('never emits a cancel or retain decision for an inapplicable plan', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      livePullRequest: null,
      patchEquivalentPredecessor: true,
      verifiedLineage: [{ headSha: previousHead, completedReusableEvidence: false }],
    });

    assert.equal(plan.applicable, false);
    assert.deepEqual(plan.retainRunIds, []);
    assert.deepEqual(plan.cancelRunIds, []);
    assert.deepEqual(plan.decisions, []);
  });

  it('rejects inconsistent or malformed facts at the untyped boundary', () => {
    assert.throws(() => deriveTupleLifecyclePlan({
      ...baseInput,
      verifiedLineage: [{ headSha: previousHead, completedReusableEvidence: false }],
    }), /lineage/i);
    assert.throws(() => deriveTupleLifecyclePlan({
      ...baseInput,
      runs: [typedRun({ headSha: 'not-a-sha' })],
    }));
    assert.throws(() => deriveTupleLifecyclePlan({
      ...baseInput,
      runs: [typedRun({ status: 'exploded' as 'queued' })],
    }));
  });

  it('produces a plan that round-trips through its own schema', () => {
    const plan = deriveTupleLifecyclePlan(baseInput);
    assert.deepEqual(tupleLifecyclePlanSchema.parse(JSON.parse(JSON.stringify(plan))), plan);
  });
});

type FixtureRequest = (path: string, options?: { method?: string }) => Promise<unknown>;
type OwnerRequest = NonNullable<NonNullable<Parameters<typeof cancelIosRuns>[0]>['request']>;

function asOwnerRequest(request: FixtureRequest): OwnerRequest {
  return request as OwnerRequest;
}

const pullFixture = {
  number: tuple.number,
  state: 'open',
  draft: false,
  head: { sha: head, ref: tuple.head.ref, repo: { full_name: repository } },
  base: { sha: base, ref: tuple.base.ref, repo: { full_name: repository } },
};
const synchronizeEvent = { action: 'synchronize', before: previousHead, pull_request: pullFixture };
const activeRun = {
  id: 34876151317,
  name: 'Test - iOS',
  head_sha: previousHead,
  status: 'in_progress',
  created_at: '2026-09-14T18:00:00Z',
  pull_requests: [{ number: tuple.number, base: { ref: tuple.base.ref } }],
};
const patch = [{
  filename: 'ios/example-ios/App.swift', status: 'modified', sha: 'e'.repeat(40),
  additions: 1, deletions: 1, changes: 2, patch: '@@ -1,1 +1,1 @@\n-old\n+new',
}];
const controllerBaseUpdate = {
  sha: head,
  parents: [{ sha: previousHead }, { sha: base }],
  commit: { message: `chore: update PR #${tuple.number} from develop` },
};

function runJobsPath(runId: number): string {
  return `actions/runs/${runId}/jobs?filter=latest&per_page=100&page=1`;
}
const nativeProducts = 'Build shared native iOS test products';
const executingJobs = { total_count: 3, jobs: [
  { id: 1, name: nativeProducts, status: 'completed', conclusion: 'success' },
  { id: 2, name: 'Test - iOS execution (native1)', status: 'in_progress' },
  { id: 3, name: 'Test - iOS execution (native2)', status: 'queued' },
] };
const unstartedJobs = { total_count: 3, jobs: [
  { id: 1, name: nativeProducts, status: 'completed', conclusion: 'success' },
  { id: 2, name: 'Test - iOS execution (native1)', status: 'queued' },
  { id: 3, name: 'Real-server E2E execution (chat-plaid)', status: 'queued' },
] };
// Every Mac lane already passed; only jobs that never re-prove the tuple wait.
const verdictOnlyJobs = { total_count: 4, jobs: [
  { id: 1, name: nativeProducts, status: 'completed', conclusion: 'success' },
  { id: 2, name: 'Test - iOS execution (native1)', status: 'completed', conclusion: 'success' },
  { id: 3, name: 'Test - iOS', status: 'queued' },
  { id: 4, name: 'Onboarding E2E', status: 'queued' },
] };
// The Mac work is over without lane evidence (lanes skipped); only the verdict waits.
const verdictAfterSkippedLanesJobs = { total_count: 3, jobs: [
  { id: 1, name: nativeProducts, status: 'completed', conclusion: 'success' },
  { id: 2, name: 'Test - iOS execution (native1)', status: 'completed', conclusion: 'skipped' },
  { id: 3, name: 'Test - iOS', status: 'queued' },
] };
// One lane already produced reusable evidence; another still waits for a Mac.
const partialEvidenceJobs = { total_count: 3, jobs: [
  { id: 1, name: nativeProducts, status: 'completed', conclusion: 'success' },
  { id: 2, name: 'Test - iOS execution (native1)', status: 'completed', conclusion: 'success' },
  { id: 3, name: 'Test - iOS execution (native2)', status: 'queued' },
] };

function workflowRunQuery(path: string): URLSearchParams | null {
  const prefix = 'actions/workflows/ios-tests.yml/runs?';
  return path.startsWith(prefix) ? new URLSearchParams(path.slice(prefix.length)) : null;
}

function githubFixture(
  responses: Record<string, unknown>,
  runsByStatus: Record<string, unknown[]>,
  cancellable: readonly number[],
): FixtureRequest {
  return async (path, options = {}) => {
    const method = options.method ?? 'GET';
    if (method === 'POST') {
      const match = /^actions\/runs\/(\d+)\/cancel$/.exec(path);
      if (match && cancellable.includes(Number(match[1]))) return null;
      throw new Error(`Unexpected POST ${path}`);
    }
    if (path in responses) return responses[path];
    const query = workflowRunQuery(path);
    if (query?.get('page') === '1') {
      const status = query.get('status');
      // Active discovery reads one unfiltered branch inventory; only completed
      // reusable evidence is selected with a status-filtered request.
      const runs = status === null
        ? Object.values(runsByStatus).flat()
        : runsByStatus[status] ?? [];
      return { total_count: runs.length, workflow_runs: runs };
    }
    throw new Error(`Unexpected GET ${path}`);
  };
}

async function replayOwner(
  request: FixtureRequest,
  event: unknown = synchronizeEvent,
  { fullRouting = false }: { readonly fullRouting?: boolean } = {},
) {
  const outcome = await cancelIosRuns({
    event: event as GithubObject,
    repository,
    request: asOwnerRequest(request),
    fullRouting,
  });
  assert.ok(outcome.facts !== null && outcome.plan !== null, 'the owner must plan every event it handles');
  return {
    cancelled: outcome.cancelled,
    plan: outcome.plan,
    facts: tupleLifecycleInputSchema.parse(outcome.facts),
  };
}

/** The plan in the shape the replaced controller recorded its decision in. */
function decisionSets(plan: TupleLifecyclePlan) {
  return { retainedRunIds: plan.retainRunIds, cancelCandidateRunIds: plan.cancelRunIds };
}

/**
 * Recorded decisions of the replaced synchronize path. Every scenario below
 * ran through the legacy controller and the shadow planner, which agreed; the
 * expected cancel and retain sets are the legacy controller's own, and the
 * owner must reproduce them.
 */
describe('owner parity with the replaced synchronize controller', () => {
  it('matches a plain synchronize that obsoletes the active predecessor', async () => {
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: previousHead }, files: [{ filename: 'ios/example-ios/App.swift' }],
      },
      [`commits/${head}`]: { sha: head, parents: [{ sha: previousHead }] },
    }, { in_progress: [activeRun] }, [activeRun.id]));

    assert.deepEqual(replay.cancelled, [activeRun.id]);
    assert.deepEqual(decisionSets(replay.plan), { retainedRunIds: [], cancelCandidateRunIds: [activeRun.id] });
    assert.deepEqual(replay.plan.cancelRunIds, [activeRun.id]);
  });

  it('matches an unrelated change that retains active iOS work', async () => {
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: previousHead }, files: [{ filename: 'server/tests/service.test.ts' }],
      },
      [`commits/${head}`]: { sha: head, parents: [{ sha: previousHead }] },
    }, { in_progress: [activeRun] }, []));

    assert.deepEqual(replay.cancelled, []);
    assert.equal(replay.plan.applicable, false);
    assert.equal(replay.plan.reasonCode, 'ios-scope-unchanged');
  });

  it('releases an obsolete run with only queued Mac jobs when the exact-head run is waiting', async () => {
    const jobsPath = `actions/runs/${activeRun.id}/jobs?filter=latest&per_page=100&page=1`;
    for (const status of ['pending', 'queued']) {
      const currentWaiting = { ...activeRun, id: activeRun.id + 1,
        head_sha: head, status };
      const replay = await replayOwner(githubFixture({
        [`pulls/${tuple.number}`]: pullFixture,
        [`compare/${previousHead}...${head}`]: {
          status: 'ahead', merge_base_commit: { sha: previousHead },
          files: [{ filename: 'server/tests/service.test.ts' }],
        },
        [`commits/${head}`]: { sha: head, parents: [{ sha: previousHead }] },
        [`actions/runs/${activeRun.id}`]: activeRun,
        [jobsPath]: unstartedJobs,
      }, { in_progress: [activeRun], [status]: [currentWaiting] }, [activeRun.id]));

      assert.deepEqual(replay.cancelled, [activeRun.id]);
      assert.deepEqual(replay.plan.cancelRunIds, [activeRun.id]);
    }
  });

  it('rechecks queued jobs and preserves the old run if a Mac starts before cancellation', async () => {
    const currentPending = { ...activeRun, id: activeRun.id + 1,
      head_sha: head, status: 'pending' };
    const jobsPath = `actions/runs/${activeRun.id}/jobs?filter=latest&per_page=100&page=1`;
    const request = githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: previousHead },
        files: [{ filename: 'server/tests/service.test.ts' }],
      },
      [`commits/${head}`]: { sha: head, parents: [{ sha: previousHead }] },
      [`actions/runs/${activeRun.id}`]: activeRun,
    }, { in_progress: [activeRun], pending: [currentPending] }, []);
    let jobReads = 0;
    const replay = await replayOwner((path, options) => {
      if (path === jobsPath) {
        jobReads += 1;
        return Promise.resolve(jobReads === 1 ? unstartedJobs : executingJobs);
      }
      return request(path, options);
    });

    assert.equal(jobReads, 2);
    assert.deepEqual(replay.cancelled, []);
    assert.deepEqual(replay.plan.cancelRunIds, [activeRun.id]);
  });

  it('preserves an obsolete run that still has an executing Mac job', async () => {
    const currentPending = { ...activeRun, id: activeRun.id + 1,
      head_sha: head, status: 'pending' };
    const jobsPath = `actions/runs/${activeRun.id}/jobs?filter=latest&per_page=100&page=1`;
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: previousHead },
        files: [{ filename: 'server/tests/service.test.ts' }],
      },
      [`commits/${head}`]: { sha: head, parents: [{ sha: previousHead }] },
      [jobsPath]: { total_count: 2, jobs: [
        { id: 1, status: 'in_progress' }, { id: 2, status: 'queued' },
      ] },
    }, { in_progress: [activeRun], pending: [currentPending] }, []));

    assert.deepEqual(replay.cancelled, []);
    assert.equal(replay.plan.reasonCode, 'ios-scope-unchanged');
  });

  it('does not release queued old work before a current-head run is pending', async () => {
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: previousHead },
        files: [{ filename: 'server/tests/service.test.ts' }],
      },
      [`commits/${head}`]: { sha: head, parents: [{ sha: previousHead }] },
    }, { in_progress: [activeRun] }, []));

    assert.deepEqual(replay.cancelled, []);
    assert.equal(replay.plan.reasonCode, 'ios-scope-unchanged');
  });

  it('matches an unrelated change that releases only a stale pending run', async () => {
    const stalePending = { ...activeRun, id: activeRun.id + 1, status: 'pending' };
    const currentPending = { ...activeRun, id: activeRun.id + 2,
      status: 'pending', head_sha: head };
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: previousHead },
        files: [{ filename: 'server/tests/service.test.ts' }],
      },
      [`commits/${head}`]: { sha: head, parents: [{ sha: previousHead }] },
      [`actions/runs/${activeRun.id}/jobs?filter=latest&per_page=100&page=1`]: {
        total_count: 1, jobs: [{ id: 1, status: 'in_progress' }],
      },
    }, { in_progress: [activeRun], pending: [stalePending, currentPending] }, [stalePending.id]));

    assert.deepEqual(replay.cancelled, [stalePending.id]);
    assert.deepEqual(replay.plan.cancelRunIds, [stalePending.id]);
  });

  it('matches a server-only base update with an executing predecessor and stale pending replacement', async () => {
    const oldBase = 'd'.repeat(40);
    const stalePending = { ...activeRun, id: activeRun.id + 1,
      status: 'pending', created_at: '2026-09-14T18:02:00Z' };
    const currentPending = { ...activeRun, id: activeRun.id + 2,
      status: 'pending', head_sha: head };
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: previousHead },
        files: [{ filename: 'server/tests/service.test.ts' }],
      },
      [`commits/${head}`]: controllerBaseUpdate,
      [`compare/${base}...${previousHead}`]: {
        status: 'diverged', merge_base_commit: { sha: oldBase },
      },
      [`compare/${base}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: base }, files: patch,
      },
      [`compare/${oldBase}...${previousHead}`]: {
        status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch,
      },
      [`compare/${oldBase}...${base}`]: {
        status: 'ahead', merge_base_commit: { sha: oldBase }, files: [],
      },
      [`commits/${previousHead}`]: { sha: previousHead, parents: [{ sha: oldBase }] },
      [runJobsPath(activeRun.id)]: executingJobs,
    }, { in_progress: [activeRun], pending: [stalePending, currentPending] }, [stalePending.id]));

    assert.deepEqual(replay.cancelled, [stalePending.id]);
    assert.deepEqual(replay.plan.retainRunIds, [activeRun.id]);
    assert.deepEqual(replay.plan.cancelRunIds, [stalePending.id]);
  });

  it('matches a patch-equivalent base update that retains its predecessor and cancels older work', async () => {
    const oldBase = 'd'.repeat(40);
    const otherBaseRun = {
      ...activeRun,
      id: activeRun.id + 1,
      created_at: '2026-09-14T18:01:00Z',
      pull_requests: [{ number: tuple.number, base: { ref: 'main' } }],
    };
    const unrelatedHeadRun = { ...activeRun, id: activeRun.id + 2, head_sha: 'f'.repeat(40) };
    const olderRun = { ...activeRun, id: activeRun.id + 3, created_at: '2026-09-14T17:59:00Z' };
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: { status: 'ahead', merge_base_commit: { sha: previousHead }, files: patch },
      [`commits/${head}`]: controllerBaseUpdate,
      [`compare/${base}...${previousHead}`]: { status: 'diverged', merge_base_commit: { sha: oldBase } },
      [`compare/${base}...${head}`]: { status: 'ahead', merge_base_commit: { sha: base }, files: patch },
      [`compare/${oldBase}...${previousHead}`]: { status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch },
      [`compare/${oldBase}...${base}`]: { status: 'ahead', merge_base_commit: { sha: oldBase }, files: [] },
      [`commits/${previousHead}`]: { sha: previousHead, parents: [{ sha: base }] },
      [`compare/${unrelatedHeadRun.head_sha}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: unrelatedHeadRun.head_sha }, files: patch,
      },
      [runJobsPath(activeRun.id)]: executingJobs,
    }, {
      in_progress: [activeRun, otherBaseRun, unrelatedHeadRun, olderRun],
    }, [otherBaseRun.id, unrelatedHeadRun.id, olderRun.id]));

    assert.deepEqual(replay.cancelled, [otherBaseRun.id, unrelatedHeadRun.id, olderRun.id]);
    assert.deepEqual(replay.plan.retainRunIds, [activeRun.id]);
    assert.deepEqual(replay.plan.cancelRunIds, [otherBaseRun.id, unrelatedHeadRun.id, olderRun.id]);
    const record = replay.facts;
    assert.deepEqual(record.verifiedLineage, [{ headSha: previousHead, completedReusableEvidence: false }]);
  });

  it('matches a patch-equivalent update that cancels duplicates after completed reusable success', async () => {
    const oldBase = 'd'.repeat(40);
    const queuedDuplicate = { ...activeRun, id: activeRun.id + 1, status: 'queued', created_at: '2026-09-14T18:01:00Z' };
    const completedSuccess = {
      ...activeRun, id: activeRun.id + 2, status: 'completed', conclusion: 'success', created_at: '2026-09-14T17:59:00Z',
    };
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: { status: 'ahead', merge_base_commit: { sha: previousHead }, files: patch },
      [`commits/${head}`]: controllerBaseUpdate,
      [`compare/${base}...${previousHead}`]: { status: 'diverged', merge_base_commit: { sha: oldBase } },
      [`compare/${base}...${head}`]: { status: 'ahead', merge_base_commit: { sha: base }, files: patch },
      [`compare/${oldBase}...${previousHead}`]: { status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch },
      [`compare/${oldBase}...${base}`]: { status: 'ahead', merge_base_commit: { sha: oldBase }, files: [] },
      [`actions/runs/${completedSuccess.id}/jobs?filter=latest&per_page=100&page=1`]: {
        total_count: 1,
        jobs: [{ id: 9001, name: 'Test - iOS execution (native1)', status: 'completed', conclusion: 'success' }],
      },
    }, {
      in_progress: [activeRun], queued: [queuedDuplicate], success: [completedSuccess],
    }, [activeRun.id, queuedDuplicate.id]));

    assert.deepEqual([...replay.cancelled].sort(), [activeRun.id, queuedDuplicate.id].sort());
    assert.deepEqual(replay.plan.retainRunIds, []);
    assert.deepEqual(replay.plan.cancelRunIds, [activeRun.id, queuedDuplicate.id]);
    const record = replay.facts;
    assert.deepEqual(record.verifiedLineage, [{ headSha: previousHead, completedReusableEvidence: true }]);
  });

  it('matches a chained base update that preserves both active generations', async () => {
    const product = '1'.repeat(40);
    const firstBase = '2'.repeat(40);
    const grandBase = '3'.repeat(40);
    const productRun = { ...activeRun, id: activeRun.id + 5, head_sha: product, created_at: '2026-09-14T17:00:00Z' };
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: { status: 'ahead', merge_base_commit: { sha: previousHead }, files: patch },
      [`commits/${head}`]: controllerBaseUpdate,
      [`compare/${base}...${head}`]: { status: 'ahead', merge_base_commit: { sha: base }, files: patch },
      [`compare/${base}...${previousHead}`]: { status: 'diverged', merge_base_commit: { sha: firstBase } },
      [`compare/${firstBase}...${previousHead}`]: { status: 'ahead', merge_base_commit: { sha: firstBase }, files: patch },
      [`compare/${firstBase}...${base}`]: { status: 'ahead', merge_base_commit: { sha: firstBase }, files: [] },
      [`commits/${previousHead}`]: {
        sha: previousHead,
        parents: [{ sha: product }, { sha: firstBase }],
        commit: { message: `chore: update PR #${tuple.number} from develop` },
      },
      [`compare/${firstBase}...${product}`]: { status: 'diverged', merge_base_commit: { sha: grandBase } },
      [`compare/${grandBase}...${product}`]: { status: 'ahead', merge_base_commit: { sha: grandBase }, files: patch },
      [`compare/${grandBase}...${firstBase}`]: { status: 'ahead', merge_base_commit: { sha: grandBase }, files: [] },
      [`commits/${product}`]: { sha: product, parents: [{ sha: base }] },
      [`compare/${product}...${head}`]: { status: 'ahead', merge_base_commit: { sha: product }, files: patch },
      [runJobsPath(activeRun.id)]: executingJobs,
      [runJobsPath(productRun.id)]: executingJobs,
    }, { in_progress: [activeRun, productRun] }, []));

    assert.deepEqual(replay.cancelled, []);
    assert.deepEqual(replay.plan.retainRunIds, [activeRun.id, productRun.id]);
    assert.deepEqual(replay.plan.cancelRunIds, []);
  });

  const patchEquivalentUpdate = (oldBase: string): Record<string, unknown> => ({
    [`pulls/${tuple.number}`]: pullFixture,
    [`compare/${previousHead}...${head}`]: {
      status: 'ahead', merge_base_commit: { sha: previousHead }, files: patch,
    },
    [`commits/${head}`]: controllerBaseUpdate,
    [`compare/${base}...${previousHead}`]: { status: 'diverged', merge_base_commit: { sha: oldBase } },
    [`compare/${base}...${head}`]: { status: 'ahead', merge_base_commit: { sha: base }, files: patch },
    [`compare/${oldBase}...${previousHead}`]: {
      status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch,
    },
    [`compare/${oldBase}...${base}`]: { status: 'ahead', merge_base_commit: { sha: oldBase }, files: [] },
    [`commits/${previousHead}`]: { sha: previousHead, parents: [{ sha: base }] },
  });

  for (const runStatus of ['in_progress', 'queued']) {
    it(`releases an idle patch-equivalent predecessor (run status ${runStatus})`, async () => {
      const oldBase = 'd'.repeat(40);
      const predecessor = { ...activeRun, status: runStatus };
      const currentPending = { ...activeRun, id: activeRun.id + 1,
        head_sha: head, status: 'pending' };
      const replay = await replayOwner(githubFixture({
        ...patchEquivalentUpdate(oldBase),
        [`actions/runs/${predecessor.id}`]: predecessor,
        [runJobsPath(predecessor.id)]: unstartedJobs,
      }, { [runStatus]: [predecessor], pending: [currentPending] }, [predecessor.id]));

      assert.deepEqual(replay.cancelled, [predecessor.id]);
      assert.deepEqual(decisionSets(replay.plan), { retainedRunIds: [], cancelCandidateRunIds: [predecessor.id] });
      assert.deepEqual(replay.plan.retainRunIds, []);
      assert.deepEqual(replay.plan.cancelRunIds, [predecessor.id]);
      const record = replay.facts;
      assert.deepEqual(record.verifiedLineage, [{ headSha: previousHead, completedReusableEvidence: false }]);
      assert.deepEqual(record.queuedOnlyRunIds, [predecessor.id]);
    });
  }

  for (const [shape, jobs] of [
    ['only verdict jobs wait after every Mac lane passed', verdictOnlyJobs],
    ['a lane already holds reusable evidence', partialEvidenceJobs],
    ['only the verdict waits after its Mac lanes were skipped', verdictAfterSkippedLanesJobs],
  ] as const) {
    it(`retains a patch-equivalent predecessor when ${shape}`, async () => {
      const oldBase = 'd'.repeat(40);
      const currentPending = { ...activeRun, id: activeRun.id + 1,
        head_sha: head, status: 'pending' };
      const replay = await replayOwner(githubFixture({
        ...patchEquivalentUpdate(oldBase),
        [runJobsPath(activeRun.id)]: jobs,
      }, { in_progress: [activeRun], pending: [currentPending] }, []));

      assert.deepEqual(replay.cancelled, []);
      assert.deepEqual(decisionSets(replay.plan), { retainedRunIds: [activeRun.id], cancelCandidateRunIds: [] });
      assert.deepEqual(replay.plan.retainRunIds, [activeRun.id]);
    });
  }

  it('keeps an idle patch-equivalent predecessor whose Mac job starts before cancellation', async () => {
    const oldBase = 'd'.repeat(40);
    const request = githubFixture({
      ...patchEquivalentUpdate(oldBase),
      [`actions/runs/${activeRun.id}`]: activeRun,
    }, { in_progress: [activeRun] }, []);
    let jobReads = 0;
    const replay = await replayOwner((path, options) => {
      if (path === runJobsPath(activeRun.id)) {
        jobReads += 1;
        return Promise.resolve(jobReads === 1 ? unstartedJobs : executingJobs);
      }
      return request(path, options);
    });

    assert.equal(jobReads, 2);
    assert.deepEqual(replay.cancelled, []);
    assert.deepEqual(replay.plan.cancelRunIds, [activeRun.id]);
  });

  it('releases only the idle generation of a chained base update', async () => {
    const product = '1'.repeat(40);
    const firstBase = '2'.repeat(40);
    const grandBase = '3'.repeat(40);
    const productRun = { ...activeRun, id: activeRun.id + 5, head_sha: product,
      created_at: '2026-09-14T17:00:00Z' };
    const replay = await replayOwner(githubFixture({
      ...patchEquivalentUpdate(firstBase),
      [`commits/${previousHead}`]: {
        sha: previousHead,
        parents: [{ sha: product }, { sha: firstBase }],
        commit: { message: `chore: update PR #${tuple.number} from develop` },
      },
      [`compare/${firstBase}...${product}`]: { status: 'diverged', merge_base_commit: { sha: grandBase } },
      [`compare/${grandBase}...${product}`]: {
        status: 'ahead', merge_base_commit: { sha: grandBase }, files: patch,
      },
      [`compare/${grandBase}...${firstBase}`]: {
        status: 'ahead', merge_base_commit: { sha: grandBase }, files: [],
      },
      [`commits/${product}`]: { sha: product, parents: [{ sha: base }] },
      [`compare/${product}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: product }, files: patch,
      },
      [`actions/runs/${activeRun.id}`]: activeRun,
      [runJobsPath(activeRun.id)]: unstartedJobs,
      [runJobsPath(productRun.id)]: executingJobs,
    }, { in_progress: [activeRun, productRun] }, [activeRun.id]));

    assert.deepEqual(replay.cancelled, [activeRun.id]);
    assert.deepEqual(replay.plan.retainRunIds, [productRun.id]);
    assert.deepEqual(replay.plan.cancelRunIds, [activeRun.id]);
  });

  it('reads an idle verified predecessor once while planning and once before release', async () => {
    const oldBase = 'd'.repeat(40);
    const currentPending = { ...activeRun, id: activeRun.id + 1, head_sha: head, status: 'pending' };
    const request = githubFixture({
      ...patchEquivalentUpdate(oldBase),
      [`compare/${previousHead}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: previousHead },
        files: [{ filename: 'server/tests/service.test.ts' }],
      },
      [`actions/runs/${activeRun.id}`]: activeRun,
    }, { in_progress: [activeRun], pending: [currentPending] }, [activeRun.id]);
    let jobReads = 0;
    const replay = await replayOwner((path, options) => {
      if (path === runJobsPath(activeRun.id)) {
        jobReads += 1;
        return Promise.resolve(unstartedJobs);
      }
      return request(path, options);
    });

    assert.deepEqual(replay.facts.queuedOnlyRunIds, [activeRun.id]);
    assert.equal(jobReads, 2);
    assert.deepEqual(replay.cancelled, [activeRun.id]);
  });

  it('never treats a live pull request without a draft flag as ready', async () => {
    const { draft: _draft, ...undeclared } = pullFixture;
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: undeclared,
    }, { in_progress: [activeRun] }, []));

    assert.equal(replay.plan.reasonCode, 'tuple-superseded');
    assert.deepEqual(replay.cancelled, []);
  });

  it('costs no request for a pull request whose head or base lives in another repository', async () => {
    const refuse: FixtureRequest = async (path) => {
      throw new Error(`An event outside the repository must not read ${path}`);
    };
    for (const side of ['head', 'base'] as const) {
      const pullRequest = { ...pullFixture, [side]: { ...pullFixture[side], repo: { full_name: 'fork/example-app' } } };
      const outcome = await cancelIosRuns({
        event: { ...synchronizeEvent, pull_request: pullRequest } as unknown as GithubObject,
        repository,
        request: asOwnerRequest(refuse),
      });
      assert.deepEqual(outcome, { facts: null, plan: null, cancelled: [] }, side);
    }
  });
});

describe('obsolete iOS runs after a replaced synchronize (A -> B -> C, only B -> C runs)', () => {
  // The surviving event's `before` is B. Every active run is measured from its
  // own head to the live head C, so an older head's iOS change is not hidden by
  // the replaced A -> B event, and unchanged in-flight evidence keeps running.
  const olderHead = '9'.repeat(40);
  const serverOnly = [{ filename: 'server/services/budget.ts', status: 'modified' }];
  const iosChange = [{ filename: 'ios/example-ios/App.swift', status: 'modified' }];
  const olderRun = { ...activeRun, id: activeRun.id + 20, head_sha: olderHead, created_at: '2026-09-14T17:00:00Z' };
  const plainUpdate = {
    [`pulls/${tuple.number}`]: pullFixture,
    [`commits/${head}`]: { sha: head, parents: [{ sha: previousHead }] },
    [`compare/${previousHead}...${head}`]: { status: 'ahead', merge_base_commit: { sha: previousHead }, files: serverOnly },
  };

  it('cancels an older run whose iOS inputs changed in the replaced A..B range', async () => {
    const replay = await replayOwner(githubFixture({
      ...plainUpdate,
      [`compare/${olderHead}...${head}`]: { status: 'ahead', merge_base_commit: { sha: olderHead }, files: [...iosChange, ...serverOnly] },
    }, { in_progress: [activeRun, olderRun] }, [olderRun.id]));

    // B..C alone is server-only, so the per-event measurement kept A running.
    assert.deepEqual(replay.cancelled, [olderRun.id]);
    assert.deepEqual(replay.plan.cancelRunIds, [olderRun.id]);
    assert.deepEqual(
      replay.facts.iosExecutionScopeChangedByHead,
      { [previousHead]: false, [olderHead]: true },
    );
  });

  it('keeps in-flight evidence whose iOS inputs still match the live head', async () => {
    const replay = await replayOwner(githubFixture({
      ...plainUpdate,
      [`compare/${olderHead}...${head}`]: { status: 'ahead', merge_base_commit: { sha: olderHead }, files: serverOnly },
    }, { in_progress: [activeRun, olderRun] }, []));

    assert.deepEqual(replay.cancelled, []);
    assert.equal(replay.plan.reasonCode, 'ios-scope-unchanged');
  });

  it('never cancels completed evidence and never reads a comparison for it', async () => {
    const completedOlder = { ...olderRun, status: 'completed', conclusion: 'success' };
    const replay = await replayOwner(githubFixture(plainUpdate, {
      in_progress: [activeRun], completed: [completedOlder],
    }, []));

    assert.deepEqual(replay.cancelled, []);
  });

  it('judges a force-pushed older head by its own side of the merge base too', async () => {
    const mergeBase = '8'.repeat(40);
    const replay = await replayOwner(githubFixture({
      ...plainUpdate,
      [`compare/${olderHead}...${head}`]: { status: 'diverged', merge_base_commit: { sha: mergeBase }, files: serverOnly },
      [`compare/${head}...${olderHead}`]: { status: 'diverged', merge_base_commit: { sha: mergeBase }, files: iosChange },
    }, { in_progress: [activeRun, olderRun] }, [olderRun.id]));

    assert.deepEqual(replay.cancelled, [olderRun.id]);
  });

  it('an obsolete surviving event cancels nothing; the live head\'s own event does the work', async () => {
    const newerHead = '7'.repeat(40);
    const replay = await replayOwner(githubFixture({
      [`pulls/${tuple.number}`]: { ...pullFixture, head: { ...pullFixture.head, sha: newerHead } },
    }, { in_progress: [activeRun, olderRun] }, []));

    assert.deepEqual(replay.cancelled, []);
    assert.equal(replay.plan.reasonCode, 'tuple-superseded');
  });
});

describe('deriveTupleLifecyclePlan for a base retarget', () => {
  const retargetInput: TupleLifecycleInput = {
    ...baseInput,
    event: { action: 'edited', previousHeadSha: null, baseChanged: true },
    iosExecutionScopeChangedByHead: null,
    patchEquivalentPredecessor: null,
    runs: [
      typedRun({ id: 1, headSha: head, pullRequests: [{ number: tuple.number, baseRef: 'main' }] }),
      typedRun({ id: 2, headSha: head }),
      typedRun({ id: 3, pullRequests: [{ number: tuple.number, baseRef: 'main' }] }),
      typedRun({ id: 4, headSha: head, pullRequests: [{ number: tuple.number }] }),
    ],
  };

  it('cancels only current-head runs created for another base branch, without synchronize facts', () => {
    const plan = deriveTupleLifecyclePlan(retargetInput);

    assert.equal(plan.trigger, 'retarget');
    assert.equal(plan.reasonCode, 'decisions-derived');
    assert.deepEqual(plan.cancelRunIds, [1]);
    assert.deepEqual(plan.retainRunIds, []);
    assert.deepEqual(plan.decisions, [
      { runId: 1, headSha: head, disposition: 'cancel-prior-base', reasonCode: 'prior-base-branch' },
      { runId: 2, headSha: head, disposition: 'current', reasonCode: 'current-head' },
      { runId: 4, headSha: head, disposition: 'current', reasonCode: 'current-head' },
    ]);
    assert.deepEqual(plan.ignoredRuns, [{ runId: 3, reasonCode: 'not-current-head' }]);
  });

  it('ignores an edit that did not change the base', () => {
    const plan = deriveTupleLifecyclePlan({
      ...retargetInput,
      event: { action: 'edited', previousHeadSha: null, baseChanged: false },
    });

    assert.equal(plan.trigger, null);
    assert.equal(plan.reasonCode, 'event-not-handled');
    assert.deepEqual(plan.cancelRunIds, []);
  });

  it('is inapplicable to a draft, closed or superseded retarget', () => {
    for (const [pullRequest, livePullRequest, reasonCode] of [
      [{ ...tuple, draft: true }, tuple, 'pull-request-not-ready'],
      [{ ...tuple, state: 'closed' as const }, tuple, 'pull-request-not-ready'],
      [tuple, { ...tuple, base: { ...tuple.base, ref: 'main' } }, 'tuple-superseded'],
      [tuple, null, 'tuple-superseded'],
    ] as const) {
      const plan = deriveTupleLifecyclePlan({ ...retargetInput, pullRequest, livePullRequest });
      assert.equal(plan.applicable, false);
      assert.equal(plan.reasonCode, reasonCode);
      assert.deepEqual(plan.cancelRunIds, []);
    }
  });
});

/**
 * The replaced prior-base controller's own tests, run through the owner. Each
 * expected cancel set is the one that controller produced.
 */
describe('owner parity with the replaced prior-base controller', () => {
  const retargetHead = '4'.repeat(40);
  const retargetBase = '5'.repeat(40);
  const retargetPull = {
    number: 5872,
    state: 'open',
    draft: false,
    head: { sha: retargetHead, ref: 'codex/typed-ci', repo: { full_name: repository } },
    base: { sha: retargetBase, ref: 'develop', repo: { full_name: repository } },
  };
  const retargetEvent = {
    action: 'edited',
    changes: { base: { ref: { from: 'main' } } },
    pull_request: retargetPull,
  };

  function priorBaseRun(
    id: number,
    options: { readonly baseRef?: string; readonly sha?: string; readonly status?: string; readonly pr?: number } = {},
  ) {
    return {
      id,
      name: 'Test - iOS',
      head_sha: options.sha ?? retargetHead,
      status: options.status ?? 'in_progress',
      created_at: '2026-09-22T12:00:00Z',
      pull_requests: [{ number: options.pr ?? retargetPull.number, base: { ref: options.baseRef ?? 'main' } }],
    };
  }

  function retargetFixture(
    runs: readonly Record<string, unknown>[],
    { livePulls = [retargetPull], cancelResponse = {}, runAfterConflict = {} }: {
      readonly livePulls?: readonly unknown[];
      readonly cancelResponse?: unknown;
      readonly runAfterConflict?: unknown;
    } = {},
  ) {
    const calls: string[] = [];
    let pullReads = 0;
    const request: FixtureRequest = async (path, options = {}) => {
      const method = options.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (method === 'POST' && /^actions\/runs\/\d+\/cancel$/.test(path)) return cancelResponse;
      if (/^actions\/runs\/\d+$/.test(path)) return runAfterConflict;
      if (path === `pulls/${retargetPull.number}`) {
        const live = livePulls[Math.min(pullReads, livePulls.length - 1)];
        pullReads += 1;
        return live;
      }
      if (path.startsWith('actions/workflows/ios-tests.yml/runs?')) {
        return { total_count: runs.length, workflow_runs: runs };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    };
    return { calls, request };
  }

  it('acts only on a real same-repository base edit of a ready pull request', async () => {
    const refuse: FixtureRequest = async (path) => {
      throw new Error(`An event outside the retarget rule must not read ${path}`);
    };
    for (const [event, eventRepository] of [
      [{ ...retargetEvent, changes: { title: { from: 'old' } } }, repository],
      [{ ...retargetEvent, action: 'synchronize' }, repository],
      [{ ...retargetEvent, pull_request: { ...retargetPull, draft: true } }, repository],
      [retargetEvent, 'someone/fork'],
    ] as const) {
      const outcome = await cancelIosRuns({
        event: event as unknown as GithubObject, repository: eventRepository, request: asOwnerRequest(refuse),
      });
      assert.deepEqual(outcome, { facts: null, plan: null, cancelled: [] });
    }

    const { request } = retargetFixture([]);
    const retarget = await replayOwner(request, retargetEvent);
    assert.equal(retarget.plan.trigger, 'retarget');
    assert.deepEqual(retarget.plan.tuple, {
      pullRequest: 5872, headSha: retargetHead, baseSha: retargetBase, baseRef: 'develop',
    });
  });

  it('selects prior-base work without cancelling current tuple or unrelated work', async () => {
    const { request } = retargetFixture([
      priorBaseRun(1),
      priorBaseRun(2, { baseRef: 'develop' }),
      priorBaseRun(3, { sha: 'c'.repeat(40) }),
      priorBaseRun(4, { pr: 9999 }),
      priorBaseRun(5, { status: 'completed' }),
      { ...priorBaseRun(6), name: 'PR Checks' },
    ]);
    const outcome = await replayOwner(request, retargetEvent);

    assert.deepEqual(outcome.cancelled, [1]);
    assert.deepEqual(outcome.plan.cancelRunIds, [1]);
  });

  it('cancels the prior-base run only while the edited tuple remains live', async () => {
    const { calls, request } = retargetFixture([priorBaseRun(10), priorBaseRun(11, { baseRef: 'develop' })]);

    assert.deepEqual((await replayOwner(request, retargetEvent)).cancelled, [10]);
    assert.ok(calls.includes('POST actions/runs/10/cancel'));
    assert.ok(!calls.some(call => call.includes('actions/runs/11/cancel')));
  });

  it('a live tuple change prevents cancellation after inventory', async () => {
    const moved = { ...retargetPull, base: { ...retargetPull.base, sha: 'c'.repeat(40) } };
    const { calls, request } = retargetFixture([priorBaseRun(10)], { livePulls: [moved] });
    const outcome = await replayOwner(request, retargetEvent);

    assert.deepEqual(outcome.cancelled, []);
    assert.equal(outcome.plan.reasonCode, 'tuple-superseded');
    assert.ok(!calls.some(call => call.startsWith('POST')));
  });

  it('stops cancelling as soon as the tuple moves between cancellations', async () => {
    const moved = { ...retargetPull, head: { ...retargetPull.head, sha: 'd'.repeat(40) } };
    const { request } = retargetFixture([priorBaseRun(20), priorBaseRun(21)], {
      livePulls: [retargetPull, retargetPull, moved],
    });
    const outcome = await replayOwner(request, retargetEvent);

    assert.deepEqual(outcome.plan.cancelRunIds, [20, 21]);
    assert.deepEqual(outcome.cancelled, [20]);
  });

  it('accepts a conflicted cancellation only once the run has finished', async () => {
    const finished = retargetFixture([priorBaseRun(30)], {
      cancelResponse: { conflict: true }, runAfterConflict: { id: 30, status: 'completed' },
    });
    assert.deepEqual((await replayOwner(finished.request, retargetEvent)).cancelled, [30]);

    const stillActive = retargetFixture([priorBaseRun(31)], {
      cancelResponse: { conflict: true }, runAfterConflict: { id: 31, status: 'in_progress' },
    });
    await assert.rejects(replayOwner(stillActive.request, retargetEvent), /run 31 conflicted while it remained active/);
  });
});

/**
 * The workflow is generated, so these read the definition: the same facts,
 * stated where a change to them has to be made.
 */
describe('single cancellation owner wiring', () => {
  const ownerEntry = 'ci/src/actions/cancelObsoleteIosRuns.ts';
  const steps = jobOf(refreshPrCiAfterBaseEdit, 'cancel-obsolete-ios').config.steps;
  const ownerIndex = steps.findIndex((step) => step.config.entry === ownerEntry);
  const installIndex = steps.findIndex((step) => step.config.id === 'ci-deps');
  const fanOutIndex = steps.findIndex((step) => step.config.command === 'node ci/src/actions/refreshOverlappingPullRequests.ts');

  it('runs one owner step for both triggers, after the shared install and before fan-out', () => {
    assert.equal(steps.filter((step) => step.config.entry === ownerEntry).length, 1);
    const owner = steps[ownerIndex];
    assert.ok(owner);
    assert.equal(String(renderName(owner.config.name)), 'Cancel obsolete active iOS work');
    assert.ok(installIndex >= 0 && installIndex < ownerIndex, 'the owner imports the installed CI package');
    assert.ok(ownerIndex < fanOutIndex, 'cancellation precedes the stacked-child fan-out');
    assert.equal(steps.filter((step) => step.config.entry === 'ci/src/actions/installCiPackageDependencies.ts').length, 1);
    assert.equal(
      String(owner.config.if),
      "${{ steps.ci-deps.outcome == 'success' && ((github.event.action == 'synchronize' "
        + "&& github.event.pull_request.draft == false) || (github.event.action == 'edited' "
        + '&& github.event.changes.base != null)) }}',
    );
  });

  it('gives the owner the run token and nothing else', () => {
    assert.deepEqual(Object.keys(steps[ownerIndex]?.config.env ?? {}), ['GITHUB_TOKEN']);
  });

  it('leaves no step pointing at a replaced controller or its shadow record', () => {
    assert.doesNotMatch(JSON.stringify(steps.map((step) => step.config)),
      /cancelPriorBaseRuns|planTupleLifecycle|tuple-lifecycle-legacy-record|TUPLE_LIFECYCLE_RECORD_FILE/);
  });
});

describe('owner step log', () => {
  it('names every run with its disposition, then the runs it cancelled', () => {
    const plan = deriveTupleLifecyclePlan({
      ...baseInput,
      runs: [typedRun({ id: 7 }), typedRun({ id: 8, workflow: 'PR Checks' })],
    });

    assert.deepEqual(report({ facts: baseInput, plan, cancelled: [7] }), [
      `Test - iOS synchronize plan for PR #${tuple.number}: decisions derived.`,
      `run 7 at ${previousHead.slice(0, 12)}: cancel-obsolete (obsolete-head)`,
      'run 8: left alone (workflow-out-of-scope)',
      'Cancelled Test - iOS runs: 7.',
    ]);
  });

  it('says why nothing happened', () => {
    assert.deepEqual(report({ facts: null, plan: null, cancelled: [] }),
      ['No Test - iOS cancellation rule applies to this event.']);
    const plan = deriveTupleLifecyclePlan({ ...baseInput, livePullRequest: null });
    assert.deepEqual(report({ facts: baseInput, plan, cancelled: [] }), [
      `Test - iOS synchronize plan for PR #${tuple.number}: inapplicable (tuple-superseded).`,
      'No Test - iOS run required cancellation.',
    ]);
  });
});

describe('deriveTupleLifecyclePlan for a fully routed synchronize', () => {
  const fullRouting = {
    ...baseInput,
    event: { ...baseInput.event, fullRouting: true },
  };

  it('keeps a verified patch-equivalent predecessor while it is still executing', () => {
    for (const status of ['in_progress', 'queued'] as const) {
      const plan = deriveTupleLifecyclePlan({
        ...fullRouting,
        patchEquivalentPredecessor: true,
        verifiedLineage: [{ headSha: previousHead, completedReusableEvidence: false }],
        runs: [typedRun({ id: 10, status })],
      });

      assert.equal(plan.trigger, 'full-routing');
      assert.deepEqual(plan.retainRunIds, [10], status);
      assert.deepEqual(plan.cancelRunIds, [], status);
    }
  });

  it('cancels a verified predecessor that has not started, which synchronize alone retains', () => {
    for (const status of ['pending', 'waiting', 'requested'] as const) {
      const facts = {
        ...fullRouting,
        patchEquivalentPredecessor: true,
        verifiedLineage: [{ headSha: previousHead, completedReusableEvidence: false }],
        runs: [typedRun({ id: 10, status })],
      };
      const plan = deriveTupleLifecyclePlan(facts);
      const synchronize = deriveTupleLifecyclePlan({ ...facts, event: baseInput.event });

      assert.deepEqual(plan.cancelRunIds, [10], status);
      assert.deepEqual(plan.decisions, [{
        runId: 10, headSha: previousHead, disposition: 'cancel-obsolete', reasonCode: 'predecessor-not-executing',
      }]);
      assert.deepEqual(synchronize.retainRunIds, [10], status);
    }
  });

  it('keeps in-flight work whose iOS inputs match the live head, like synchronize', () => {
    const plan = deriveTupleLifecyclePlan({
      ...fullRouting,
      iosExecutionScopeChangedByHead: { [previousHead]: false },
      runs: [typedRun({ id: 10 })],
    });

    assert.equal(plan.reasonCode, 'ios-scope-unchanged');
    assert.deepEqual(plan.cancelRunIds, []);
  });

  it('cancels newest first, as the controller it replaced did, while synchronize keeps run-id order', () => {
    const runs = [
      typedRun({ id: 1, createdAt: '2026-09-24T03:00:00Z' }),
      typedRun({ id: 3, createdAt: '2026-09-24T03:10:00Z' }),
      typedRun({ id: 2, createdAt: '2026-09-24T03:10:00Z' }),
      typedRun({ id: 4, createdAt: null }),
    ];

    assert.deepEqual(deriveTupleLifecyclePlan({ ...fullRouting, runs }).cancelRunIds, [4, 3, 2, 1]);
    assert.deepEqual(deriveTupleLifecyclePlan({ ...baseInput, runs }).cancelRunIds, [1, 2, 3, 4]);
  });

  it('shares the synchronize applicability checks', () => {
    assert.equal(deriveTupleLifecyclePlan({ ...fullRouting, livePullRequest: null }).reasonCode, 'tuple-superseded');
    assert.equal(deriveTupleLifecyclePlan({
      ...fullRouting, event: { ...fullRouting.event, previousHeadSha: null },
    }).reasonCode, 'previous-head-unknown');
    assert.equal(deriveTupleLifecyclePlan({
      ...fullRouting, iosExecutionScopeChangedByHead: null,
    }).reasonCode, 'facts-incomplete');
  });
});

/**
 * Recorded cases of the replaced full-routing release controller
 * (`ci/src/ios/controllers/cancelBlockedPrCi.ts`, `cancelSupersededQueuedRuns`,
 * deleted with its `stalePredecessorCleanup.test.ts`). Each case keeps its
 * pull request, runs and live-tuple sequence; the owner replays it with the
 * gate's full-routing verdict and must cancel, release and retain exactly what
 * the controller did. The GitHub fixture applies the listing's `event` and
 * `branch` query the way the API does: the controller repeated those two
 * filters locally, the owner relies on the query.
 */
describe('owner parity with the replaced full-routing release controller', () => {
  const recordedHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const otherHead = '9'.repeat(40);
  const recordedBase = '1'.repeat(40);
  const recordedPull = {
    number: 6029,
    state: 'open',
    draft: false,
    head: { ref: 'codex/ci-fix', sha: recordedHead, repo: { full_name: repository } },
    base: { ref: 'develop', sha: recordedBase, repo: { full_name: repository } },
  };

  function recordedRun(id: number, headSha: string, createdAt: string) {
    return {
      id,
      name: 'Test - iOS',
      event: 'pull_request',
      status: 'queued',
      head_branch: recordedPull.head.ref,
      head_sha: headSha,
      created_at: createdAt,
      pull_requests: [{ number: recordedPull.number }],
    };
  }

  interface RecordedCase {
    readonly eventPull: typeof recordedPull;
    readonly before: string;
    readonly livePulls: (read: number) => unknown;
    readonly runs: readonly ReturnType<typeof recordedRun>[];
  }

  async function replayRecorded({ eventPull, before, livePulls, runs }: RecordedCase) {
    const cancelled: number[] = [];
    let pullReads = 0;
    let listings = 0;
    const request: FixtureRequest = async (path, options = {}) => {
      if ((options.method ?? 'GET') === 'POST') {
        const match = /^actions\/runs\/(\d+)\/cancel$/.exec(path);
        if (!match) throw new Error(`Unexpected POST ${path}`);
        cancelled.push(Number(match[1]));
        return null;
      }
      if (path === `pulls/${eventPull.number}`) return livePulls(++pullReads);
      if (path === `commits/${eventPull.head.sha}`) {
        return { sha: eventPull.head.sha, parents: [{ sha: before }] };
      }
      if (path.startsWith('compare/')) {
        return { status: 'ahead', files: [{ filename: 'ios/example-ios/App.swift' }] };
      }
      const query = workflowRunQuery(path);
      if (query !== null) {
        listings += 1;
        const listed = runs.filter(run => run.event === query.get('event')
          && run.head_branch === query.get('branch'));
        return { total_count: listed.length, workflow_runs: listed };
      }
      throw new Error(`Unexpected GET ${path}`);
    };
    const outcome = await cancelIosRuns({
      event: { action: 'synchronize', before, pull_request: eventPull } as unknown as GithubObject,
      repository,
      request: asOwnerRequest(request),
      fullRouting: true,
    });
    return {
      cancelled,
      listed: listings > 0,
      pullReads,
      retained: outcome.plan?.retainRunIds ?? [],
      released: outcome.facts?.queuedOnlyRunIds ?? [],
    };
  }

  it('does not discover or cancel runs when the event head is stale', async () => {
    const replay = await replayRecorded({
      eventPull: recordedPull,
      before: otherHead,
      livePulls: () => ({ ...recordedPull, head: { ...recordedPull.head, sha: newHead } }),
      runs: [recordedRun(35951865185, newHead, '2026-09-24T03:32:22Z')],
    });

    assert.equal(replay.listed, false);
    assert.deepEqual(replay.cancelled, []);
    assert.deepEqual(replay.retained, []);
  });

  it('rechecks the live head before each cancellation', async () => {
    const eventPull = { ...recordedPull, head: { ...recordedPull.head, sha: newHead } };
    const replay = await replayRecorded({
      eventPull,
      before: recordedHead,
      livePulls: read => ({
        ...eventPull, head: { ...eventPull.head, sha: read >= 3 ? 'c'.repeat(40) : newHead },
      }),
      runs: [
        recordedRun(10, otherHead, '2026-09-24T03:00:00Z'),
        recordedRun(11, recordedHead, '2026-09-24T03:30:00Z'),
      ],
    });

    assert.deepEqual(replay.cancelled, [11]);
    assert.equal(replay.pullReads, 3);
    assert.deepEqual(replay.retained, []);
    assert.deepEqual(replay.released, []);
  });

  it('cancels only active iOS runs this pull request owns for other heads, newest first', async () => {
    const replay = await replayRecorded({
      eventPull: recordedPull,
      before: otherHead,
      livePulls: () => recordedPull,
      runs: [
        recordedRun(1, otherHead, '2026-09-24T03:00:00Z'),
        recordedRun(2, otherHead, '2026-09-24T03:10:00Z'),
        recordedRun(3, recordedHead, '2026-09-24T03:20:00Z'),
        { ...recordedRun(4, otherHead, '2026-09-24T03:30:00Z'), status: 'completed' },
        { ...recordedRun(5, otherHead, '2026-09-24T03:40:00Z'), pull_requests: [{ number: 1 }] },
        { ...recordedRun(6, otherHead, '2026-09-24T03:50:00Z'), name: 'PR Checks' },
        { ...recordedRun(7, otherHead, '2026-09-24T04:00:00Z'), head_branch: 'other' },
        { ...recordedRun(8, otherHead, '2026-09-24T04:10:00Z'), event: 'workflow_dispatch' },
      ],
    });

    assert.deepEqual(replay.cancelled, [2, 1]);
    assert.deepEqual(replay.retained, []);
    assert.deepEqual(replay.released, []);
  });

  it('treats an unreadable live pull request as stale', async () => {
    const replay = await replayRecorded({
      eventPull: recordedPull,
      before: otherHead,
      livePulls: () => null,
      runs: [recordedRun(1, otherHead, '2026-09-24T03:00:00Z')],
    });

    assert.equal(replay.listed, false);
    assert.deepEqual(replay.cancelled, []);
  });
});

describe('full-routing release keeps valid in-progress evidence', () => {
  const oldBase = 'd'.repeat(40);
  function verifiedPredecessorFixture(predecessor: typeof activeRun): FixtureRequest {
    return githubFixture({
      [`pulls/${tuple.number}`]: pullFixture,
      [`compare/${previousHead}...${head}`]: {
        status: 'ahead', merge_base_commit: { sha: previousHead }, files: patch,
      },
      [`commits/${head}`]: controllerBaseUpdate,
      [`compare/${base}...${previousHead}`]: { status: 'diverged', merge_base_commit: { sha: oldBase } },
      [`compare/${base}...${head}`]: { status: 'ahead', merge_base_commit: { sha: base }, files: patch },
      [`compare/${oldBase}...${previousHead}`]: {
        status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch,
      },
      [`compare/${oldBase}...${base}`]: { status: 'ahead', merge_base_commit: { sha: oldBase }, files: [] },
      [`commits/${previousHead}`]: { sha: previousHead, parents: [{ sha: base }] },
      [runJobsPath(predecessor.id)]: executingJobs,
    }, { [predecessor.status]: [predecessor] }, [predecessor.id]);
  }

  it('retains an executing verified patch-equivalent predecessor the old controller cancelled', async () => {
    const replay = await replayOwner(
      verifiedPredecessorFixture(activeRun), synchronizeEvent, { fullRouting: true },
    );

    assert.equal(replay.plan.trigger, 'full-routing');
    assert.deepEqual(replay.plan.retainRunIds, [activeRun.id]);
    assert.deepEqual(replay.cancelled, []);
  });

  it('cancels the verified predecessor once none of its jobs has started', async () => {
    const pending = { ...activeRun, status: 'pending' };
    const replay = await replayOwner(
      verifiedPredecessorFixture(pending), synchronizeEvent, { fullRouting: true },
    );
    const synchronize = await replayOwner(verifiedPredecessorFixture(pending));

    assert.deepEqual(replay.cancelled, [activeRun.id]);
    assert.deepEqual(synchronize.plan.retainRunIds, [activeRun.id]);
    assert.deepEqual(synchronize.cancelled, []);
  });

  it('reads the gate verdict only for a synchronize', async () => {
    const edited = { action: 'edited', pull_request: pullFixture };
    await assert.rejects(cancelIosRuns({
      event: edited as unknown as GithubObject,
      repository,
      request: asOwnerRequest(async () => { throw new Error('no request expected'); }),
      fullRouting: true,
    }), /needs a synchronize event/);
  });

  it('accepts only an exact true verdict from the environment', async () => {
    const saved = process.env.IOS_GATE_FULL_ROUTING;
    const liveGone = asOwnerRequest(async (path) => {
      if (path === `pulls/${tuple.number}`) return null;
      throw new Error(`Unexpected GET ${path}`);
    });
    try {
      process.env.IOS_GATE_FULL_ROUTING = 'yes';
      await assert.rejects(cancelIosRuns({
        event: synchronizeEvent as unknown as GithubObject, repository, request: liveGone,
      }), /IOS_GATE_FULL_ROUTING must be 'true' or unset/);
      process.env.IOS_GATE_FULL_ROUTING = 'true';
      const outcome = await cancelIosRuns({
        event: synchronizeEvent as unknown as GithubObject, repository, request: liveGone,
      });
      assert.equal(outcome.plan?.trigger, 'full-routing');
      assert.equal(outcome.plan?.reasonCode, 'tuple-superseded');
    } finally {
      if (saved === undefined) delete process.env.IOS_GATE_FULL_ROUTING;
      else process.env.IOS_GATE_FULL_ROUTING = saved;
    }
  });
});

describe('full-routing release wiring', () => {
  const steps = releaseFullRoutingPredecessor.config.steps;
  const guard = "hashFiles('.ci/trusted-predecessor-verifier/ci/src/ios/controllers/cancelBlockedPrCi.ts') == ''";

  it('runs the owner from the verifier checkout with the gate verdict and the run token', () => {
    const owner = steps.find(step => String(renderName(step.config.name)) === 'Cancel retained predecessors');
    assert.ok(owner);
    assert.equal(owner.config.command, 'node .ci/trusted-predecessor-verifier/ci/src/actions/cancelObsoleteIosRuns.ts');
    const env = Object.fromEntries(Object.entries(owner.config.env ?? {}).map(([key, value]) => [key, String(value)]));
    assert.deepEqual(env, { GITHUB_TOKEN: '${{ github.token }}', IOS_GATE_FULL_ROUTING: 'true' });
  });

  it('skips every program step while the trusted revision still carries the retired controller', () => {
    const [checkout, ...programSteps] = steps;
    assert.equal(checkout?.config.if, undefined);
    assert.equal(programSteps.length, 3);
    for (const step of programSteps) assert.equal(String(step.config.if), `\${{ ${guard} }}`);
  });

  it('leaves no step pointing at the retired controller or its base checkout', () => {
    assert.doesNotMatch(JSON.stringify(steps.map(step => step.config)),
      /releaseRetainedPredecessors|CANCEL_FULL_ROUTING_PREDECESSORS|trusted-base-update|BASE_SHA/);
  });
});

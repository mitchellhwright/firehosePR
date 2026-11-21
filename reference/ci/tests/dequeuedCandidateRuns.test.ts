import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';
import { cancelDequeuedCandidateRuns, type GithubRequest } from '../src/actions/cancelDequeuedCandidateRuns.ts';
import {
  ACTIVE_RUN_STATUSES, containmentFromCompareStatus, decideCandidateRun, deletedQueueRef, type CandidateRun,
} from '../src/dequeuedCandidateRuns.ts';
import { cancelDequeuedCandidate } from '../workflows/cancel-dequeued-candidate.ts';
import { evaluateExpression } from './fixtures/actionsExpression.ts';

const BASE = 'b'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const REF = `gh-readonly-queue/develop/pr-6151-${BASE}`;
const WORKFLOWS = new Set(['PR Checks', 'Test - iOS']);

function run(overrides: Partial<CandidateRun> = {}): CandidateRun {
  return { id: 7, name: 'Test - iOS', status: 'queued', event: 'merge_group', headBranch: REF, headSha: CANDIDATE, ...overrides };
}

describe('deleted queue ref', () => {
  it('accepts only a branch deletion of a develop queue ref', () => {
    assert.equal(deletedQueueRef({ ref: REF, ref_type: 'branch' }), REF);
    assert.equal(deletedQueueRef({ ref: REF, ref_type: 'tag' }), undefined);
    assert.equal(deletedQueueRef({ ref: `refs/heads/${REF}`, ref_type: 'branch' }), undefined);
    assert.equal(deletedQueueRef({ ref: `gh-readonly-queue/main/pr-1-${BASE}`, ref_type: 'branch' }), undefined);
    assert.equal(deletedQueueRef({ ref: 'feature/x', ref_type: 'branch' }), undefined);
    assert.equal(deletedQueueRef({ ref: 'gh-readonly-queue/develop/pr-6151-short', ref_type: 'branch' }), undefined);
    assert.equal(deletedQueueRef(null), undefined);
    assert.equal(deletedQueueRef({}), undefined);
  });
});

describe('dequeued candidate run decision', () => {
  const decide = (overrides: Partial<Parameters<typeof decideCandidateRun>[0]> = {}) => decideCandidateRun({
    run: run(), deletedRef: REF, workflowNames: WORKFLOWS, liveRefSha: undefined, containment: 'not-contained', ...overrides,
  });

  it('cancels an active validation run of the deleted ref whose candidate is not on develop', () => {
    for (const status of ACTIVE_RUN_STATUSES) {
      assert.equal(decide({ run: run({ status }) }).kind, 'cancel', status);
    }
  });

  const kept: readonly { readonly name: string; readonly overrides: Partial<Parameters<typeof decideCandidateRun>[0]>; readonly reason: RegExp }[] = [
    { name: 'a run of another workflow', overrides: { run: run({ name: 'Merge queue candidate cleanup' }) }, reason: /not a validation workflow/ },
    { name: 'a completed run', overrides: { run: run({ status: 'completed' }) }, reason: /run is completed/ },
    { name: 'a pull_request run', overrides: { run: run({ event: 'pull_request' }) }, reason: /started by pull_request/ },
    { name: 'a run for another ref', overrides: { run: run({ headBranch: `gh-readonly-queue/develop/pr-6151-${OTHER}` }) }, reason: /run is for gh-readonly-queue/ },
    { name: 'this workflow run', overrides: { currentRunId: 7 }, reason: /this workflow/ },
    { name: 'a run whose ref exists again for the same candidate', overrides: { liveRefSha: CANDIDATE }, reason: /points at this candidate/ },
    { name: 'a candidate that landed on develop', overrides: { containment: 'contained' }, reason: /is on develop/ },
    { name: 'a candidate whose containment is unreadable', overrides: { containment: 'unknown' }, reason: /could not be read/ },
  ];
  for (const entry of kept) {
    it(`keeps ${entry.name}`, () => {
      const decision = decide(entry.overrides);
      assert.equal(decision.kind, 'keep');
      if (decision.kind === 'keep') assert.match(decision.reason, entry.reason);
    });
  }

  it('cancels a run whose ref was recreated for a different candidate', () => {
    assert.equal(decide({ liveRefSha: OTHER }).kind, 'cancel');
  });

  it('maps compare statuses to containment and fails unknown ones closed', () => {
    assert.equal(containmentFromCompareStatus('identical'), 'contained');
    assert.equal(containmentFromCompareStatus('behind'), 'contained');
    assert.equal(containmentFromCompareStatus('ahead'), 'not-contained');
    assert.equal(containmentFromCompareStatus('diverged'), 'not-contained');
    assert.equal(containmentFromCompareStatus('weird'), 'unknown');
    assert.equal(containmentFromCompareStatus(undefined), 'unknown');
  });
});

describe('cancelling dequeued candidate runs against the API', () => {
  interface Call { readonly method: string; readonly path: string }

  function fakeRequest(options: {
    readonly runs: readonly Record<string, unknown>[];
    readonly ref?: string | undefined;
    readonly compare?: Readonly<Record<string, string>>;
    readonly cancelStatus?: number;
    readonly rereadStatus?: string;
  }): { request: GithubRequest; calls: Call[] } {
    const calls: Call[] = [];
    const request: GithubRequest = async (path, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, path });
      if (path.startsWith('actions/runs?')) {
        return { status: 200, body: { workflow_runs: options.runs } };
      }
      if (path.startsWith('git/ref/heads/')) {
        return options.ref === undefined ? { status: 404, body: { message: 'Not Found' } } : { status: 200, body: { object: { sha: options.ref } } };
      }
      if (path.startsWith('compare/develop...')) {
        const sha = path.slice('compare/develop...'.length);
        return { status: 200, body: { status: options.compare?.[sha] ?? 'ahead' } };
      }
      if (path === 'actions/runs/11' && options.rereadStatus !== undefined) {
        return { status: 200, body: { status: options.rereadStatus } };
      }
      if (/^actions\/runs\/\d+\/cancel$/.test(path) && method === 'POST') return { status: options.cancelStatus ?? 202, body: undefined };
      return { status: 500, body: undefined };
    };
    return { request, calls };
  }

  const queued = { id: 11, name: 'Test - iOS', status: 'queued', event: 'merge_group', head_branch: REF, head_sha: CANDIDATE };
  const running = { id: 12, name: 'PR Checks', status: 'in_progress', event: 'merge_group', head_branch: REF, head_sha: CANDIDATE };
  const merged = { id: 13, name: 'PR Checks', status: 'in_progress', event: 'merge_group', head_branch: REF, head_sha: OTHER };
  const foreign = { id: 14, name: 'Merge queue candidate cleanup', status: 'queued', event: 'delete', head_branch: REF, head_sha: CANDIDATE };

  it('cancels only the validation runs whose candidate is not on develop, one re-read per run', async () => {
    const { request, calls } = fakeRequest({ runs: [queued, running, merged, foreign], compare: { [OTHER]: 'behind' } });
    const decisions = await cancelDequeuedCandidateRuns({
      request, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS, currentRunId: 99,
    });
    assert.deepEqual(decisions.map((decision) => [decision.run.id, decision.kind]), [[11, 'cancel'], [12, 'cancel'], [13, 'keep'], [14, 'keep']]);
    assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.path), ['actions/runs/11/cancel', 'actions/runs/12/cancel']);
    assert.equal(calls.filter((call) => call.path.startsWith('git/ref/heads/')).length, 4, 'the ref is re-read before every decision');
    assert.ok(calls.some((call) => call.path === `actions/runs?event=merge_group&branch=${encodeURIComponent(REF)}&per_page=100&page=1`));
  });

  it('uses one status-independent inventory and filters completed runs locally', async () => {
    const queried: string[] = [];
    const request: GithubRequest = async (path, init) => {
      if (path.startsWith('actions/runs?')) {
        queried.push(path);
        return { status: 200, body: { workflow_runs: [running, { ...queued, status: 'completed' }] } };
      }
      if (path.startsWith('git/ref/heads/')) return { status: 404, body: undefined };
      if (path.startsWith('compare/develop...')) return { status: 200, body: { status: 'ahead' } };
      if (path === 'actions/runs/12/cancel' && init?.method === 'POST') return { status: 202, body: undefined };
      return { status: 500, body: undefined };
    };
    const decisions = await cancelDequeuedCandidateRuns({
      request, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS,
    });
    assert.equal(queried.length, 1);
    assert.ok(!queried[0]?.includes('status='));
    assert.deepEqual(decisions.map((decision) => [decision.run.id, decision.kind]), [[12, 'cancel']]);
  });

  it('does nothing for a deletion that is not a develop queue ref', async () => {
    const { request, calls } = fakeRequest({ runs: [queued] });
    const decisions = await cancelDequeuedCandidateRuns({ request, event: { ref: 'feature/x', ref_type: 'branch' }, workflowNames: WORKFLOWS });
    assert.deepEqual(decisions, []);
    assert.deepEqual(calls, []);
  });

  it('keeps every run when the ref exists again for the same candidate', async () => {
    const { request, calls } = fakeRequest({ runs: [queued, running], ref: CANDIDATE });
    const decisions = await cancelDequeuedCandidateRuns({ request, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS });
    assert.deepEqual(decisions.map((decision) => decision.kind), ['keep', 'keep']);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  });

  it('records a cancel without posting it in dry-run mode', async () => {
    const { request, calls } = fakeRequest({ runs: [queued] });
    const decisions = await cancelDequeuedCandidateRuns({ request, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS, dryRun: true });
    assert.deepEqual(decisions.map((decision) => decision.kind), ['cancel']);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  });

  it('keeps a run only when a 409 cancellation conflict is verified as finished', async () => {
    const conflict = fakeRequest({ runs: [queued], cancelStatus: 409, rereadStatus: 'completed' });
    const decisions = await cancelDequeuedCandidateRuns({ request: conflict.request, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS });
    assert.deepEqual(decisions.map((decision) => decision.kind), ['keep']);
    assert.ok(conflict.calls.some((call) => call.path === 'actions/runs/11'));
    const active = fakeRequest({ runs: [queued], cancelStatus: 409, rereadStatus: 'queued' });
    await assert.rejects(
      cancelDequeuedCandidateRuns({ request: active.request, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS }),
      /HTTP 409 while the run is still active/,
    );
    const refused = fakeRequest({ runs: [queued], cancelStatus: 403 });
    await assert.rejects(
      cancelDequeuedCandidateRuns({ request: refused.request, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS }),
      /Cancelling run 11 answered HTTP 403/,
    );
  });

  it('attempts later cancellations before reporting an earlier failure', async () => {
    const base = fakeRequest({ runs: [queued, running] });
    const attempts: string[] = [];
    const request: GithubRequest = async (path, init) => {
      if (init?.method === 'POST') attempts.push(path);
      if (path === 'actions/runs/11/cancel') return { status: 403, body: undefined };
      return base.request(path, init);
    };
    await assert.rejects(
      cancelDequeuedCandidateRuns({ request, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS }),
      /run 11: Cancelling run 11 answered HTTP 403/,
    );
    assert.deepEqual(attempts, ['actions/runs/11/cancel', 'actions/runs/12/cancel']);
  });

  it('fails when the run inventory or the ref cannot be read', async () => {
    const broken: GithubRequest = async (path) => (path.startsWith('actions/runs?') ? { status: 502, body: undefined } : { status: 404, body: undefined });
    await assert.rejects(
      cancelDequeuedCandidateRuns({ request: broken, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS }),
      /Listing runs .* answered HTTP 502/,
    );
    const badRef = fakeRequest({ runs: [queued] });
    const failingRef: GithubRequest = async (path, init) => (path.startsWith('git/ref/heads/') ? { status: 500, body: undefined } : badRef.request(path, init));
    await assert.rejects(
      cancelDequeuedCandidateRuns({ request: failingRef, event: { ref: REF, ref_type: 'branch' }, workflowNames: WORKFLOWS }),
      /Reading ref .* answered HTTP 500/,
    );
  });
});

describe('merge queue candidate cleanup workflow', () => {
  const document = load(readFileSync('.github/workflows/cancel-dequeued-candidate.yml', 'utf8')) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, { if?: string; 'runs-on'?: unknown; steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] }>;
  };

  it('listens to delete only and runs on a trusted control runner with write access to Actions', () => {
    assert.deepEqual(Object.keys(document.on), ['delete']);
    assert.deepEqual(document.permissions, { actions: 'write', contents: 'read' });
    const job = document.jobs['cancel-dequeued-candidate'];
    assert.ok(job);
    assert.match(JSON.stringify(job['runs-on']), /example-trusted-control/);
    assert.deepEqual(cancelDequeuedCandidate.config.requiredContexts, undefined);
  });

  it('runs only for a develop queue branch deletion', () => {
    const condition = document.jobs['cancel-dequeued-candidate']?.if;
    assert.ok(condition);
    const context = (ref: string, refType: string) => ({ github: { event: { ref, ref_type: refType } }, needs: {}, steps: {}, inputs: {}, vars: {} });
    assert.equal(evaluateExpression(condition, context(REF, 'branch')), true);
    assert.equal(evaluateExpression(condition, context(REF, 'tag')), false);
    assert.equal(evaluateExpression(condition, context('feature/x', 'branch')), false);
    assert.equal(evaluateExpression(condition, context(`gh-readonly-queue/main/pr-1-${BASE}`, 'branch')), false);
  });

  it('checks out the controller from the default branch and never the deleted ref', () => {
    const steps = document.jobs['cancel-dequeued-candidate']?.steps ?? [];
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout?.with?.['ref'], '${{ github.event.repository.default_branch }}');
    assert.equal(checkout?.with?.['persist-credentials'], false);
    assert.equal(checkout?.with?.['sparse-checkout'], 'ci/src\n');
    assert.ok(steps.some((step) => step.run === 'node ci/src/actions/cancelDequeuedCandidateRuns.ts'));
  });
});

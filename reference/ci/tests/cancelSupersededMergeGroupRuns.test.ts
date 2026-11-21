import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';
import {
  cancelSupersededMergeGroupRuns,
  type GithubRequest,
  type GithubResponse,
  lookupQueueBranch,
  supersessionCandidates,
} from '../src/actions/cancelSupersededMergeGroupRuns.ts';

const LIVE = 'gh-readonly-queue/develop/pr-6350-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DELETED = 'gh-readonly-queue/develop/pr-6349-41d7bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UNREADABLE = 'gh-readonly-queue/develop/pr-6323-cccccccccccccccccccccccccccccccccccccccc';
const WORKFLOWS = new Set(['PR Checks', 'Test - iOS']);

interface RunFixture {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly event: string;
  readonly head_branch: string;
}

function run(id: number, headBranch: string, overrides: Partial<RunFixture> = {}): RunFixture {
  return {
    id, name: 'Test - iOS', status: 'in_progress', event: 'merge_group', head_branch: headBranch,
    ...overrides,
  };
}

function refPath(branch: string): string {
  return `git/ref/heads/${branch}`;
}

/**
 * A GitHub API fixture: the listing returns each run under its own status,
 * refs answer from `refs`, and every cancel is recorded.
 */
function fixture(options: {
  readonly runs: readonly RunFixture[];
  readonly refs: Readonly<Record<string, GithubResponse | Error>>;
  readonly cancelStatus?: Readonly<Record<number, number | Error>>;
  readonly rereadStatus?: Readonly<Record<number, string>>;
}): { readonly request: GithubRequest; readonly cancelled: number[]; readonly requested: string[] } {
  const cancelled: number[] = [];
  const requested: string[] = [];
  const request: GithubRequest = async (path, requestOptions = {}) => {
    const method = requestOptions.method ?? 'GET';
    requested.push(`${method} ${path}`);
    if (method === 'GET' && path.startsWith('actions/runs?')) {
      const query = new URLSearchParams(path.split('?')[1]);
      assert.equal(query.get('event'), 'merge_group');
      const status = query.get('status');
      return { status: 200, body: { workflow_runs: options.runs.filter(item => item.status === status) } };
    }
    const cancel = /^actions\/runs\/(\d+)\/cancel$/.exec(path);
    if (method === 'POST' && cancel !== null) {
      const id = Number(cancel[1]);
      const status = options.cancelStatus?.[id] ?? 202;
      if (status instanceof Error) throw status;
      if (status === 202) cancelled.push(id);
      return { status, body: undefined };
    }
    const reread = /^actions\/runs\/(\d+)$/.exec(path);
    if (method === 'GET' && reread !== null) {
      const status = options.rereadStatus?.[Number(reread[1])];
      if (status === undefined) throw new Error(`Unexpected run re-read ${path}`);
      return { status: 200, body: { id: Number(reread[1]), status } };
    }
    if (method === 'GET' && path.startsWith('git/ref/heads/')) {
      const branch = decodeURIComponent(path.slice('git/ref/heads/'.length));
      const answer = options.refs[branch];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error(`Unexpected ref lookup ${branch}`);
      return answer;
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  return { request, cancelled, requested };
}

const EXISTS: GithubResponse = { status: 200, body: { ref: 'refs/heads/x' } };
const NOT_FOUND: GithubResponse = { status: 404, body: { message: 'Not Found' } };

test('a queue run whose branch still exists is kept', async () => {
  const api = fixture({ runs: [run(1, LIVE), run(2, LIVE, { name: 'PR Checks', status: 'queued' })], refs: { [LIVE]: EXISTS } });
  assert.deepEqual(await cancelSupersededMergeGroupRuns({
    request: api.request, workflowNames: WORKFLOWS, log: () => undefined,
  }), []);
  assert.deepEqual(api.cancelled, []);
  assert.equal(api.requested.filter(line => line.startsWith('GET git/ref/')).length, 1);
});

test('every active queue run whose branch was deleted is cancelled', async () => {
  const api = fixture({
    runs: [
      run(10, DELETED),
      run(11, DELETED, { name: 'PR Checks', status: 'queued' }),
      run(12, DELETED, { status: 'waiting' }),
      run(13, LIVE),
    ],
    refs: { [DELETED]: NOT_FOUND, [LIVE]: EXISTS },
  });
  const lines: string[] = [];
  assert.deepEqual(await cancelSupersededMergeGroupRuns({
    request: api.request, workflowNames: WORKFLOWS, log: line => lines.push(line),
  }), [11, 10, 12]);
  assert.deepEqual([...api.cancelled].sort(), [10, 11, 12]);
  assert.ok(lines.some(line => line.includes('run 10') && line.includes(DELETED)));
  assert.deepEqual(
    api.requested.filter(line => line.startsWith('GET actions/runs?'))
      .map(line => new URLSearchParams(line.split('?')[1]).get('status')).sort(),
    ['in_progress', 'pending', 'queued', 'requested', 'waiting'],
  );
});

test('starts every status inventory before awaiting a slow status response', async () => {
  const seen: string[] = [];
  let releaseQueued = (): void => undefined;
  const queuedResponse = new Promise<void>((resolve) => { releaseQueued = resolve; });
  const request: GithubRequest = async (path, options = {}) => {
    if (path.startsWith('actions/runs?')) {
      const status = new URLSearchParams(path.split('?')[1]).get('status');
      assert.ok(status);
      seen.push(status);
      if (status === 'queued') await queuedResponse;
      return { status: 200, body: { workflow_runs: status === 'queued' ? [run(14, DELETED, { status })] : [] } };
    }
    if (path === refPath(DELETED)) return NOT_FOUND;
    if (path === 'actions/runs/14/cancel' && options.method === 'POST') {
      return { status: 202, body: undefined };
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const cleanup = cancelSupersededMergeGroupRuns({ request, workflowNames: WORKFLOWS, log: () => undefined });
  try {
    assert.deepEqual(seen, ['queued', 'in_progress', 'pending', 'requested', 'waiting']);
  } finally {
    releaseQueued();
  }
  assert.deepEqual(await cleanup, [14]);
});

test('a ref lookup error keeps the runs and logs the reason', async () => {
  const api = fixture({
    runs: [run(20, UNREADABLE), run(21, DELETED)],
    refs: { [UNREADABLE]: { status: 502, body: undefined }, [DELETED]: new Error('socket hang up') },
  });
  const lines: string[] = [];
  assert.deepEqual(await cancelSupersededMergeGroupRuns({
    request: api.request, workflowNames: WORKFLOWS, log: line => lines.push(line),
  }), []);
  assert.deepEqual(api.cancelled, []);
  assert.ok(lines.some(line => line.includes(UNREADABLE) && line.includes('HTTP 502')));
  assert.ok(lines.some(line => line.includes(DELETED) && line.includes('socket hang up')));
});

test('pull_request runs, other branches, other workflows and the current run are never touched', async () => {
  const api = fixture({
    runs: [
      run(30, DELETED, { event: 'pull_request' }),
      run(31, 'feature/deleted-branch'),
      run(32, DELETED, { name: 'Deploy' }),
      run(33, DELETED),
    ],
    refs: { [DELETED]: NOT_FOUND },
  });
  assert.deepEqual(await cancelSupersededMergeGroupRuns({
    request: api.request, workflowNames: WORKFLOWS, currentRunId: 33, log: () => undefined,
  }), []);
  assert.deepEqual(api.cancelled, []);
  assert.deepEqual(api.requested.filter(line => !line.startsWith('GET actions/runs?')), []);
});

test('a run that finished first is tolerated, and other cancel failures are reported after all attempts', async () => {
  const api = fixture({
    runs: [run(40, DELETED), run(41, DELETED), run(42, DELETED)],
    refs: { [DELETED]: NOT_FOUND },
    cancelStatus: { 40: 409, 41: 500 },
    rereadStatus: { 40: 'completed' },
  });
  await assert.rejects(
    cancelSupersededMergeGroupRuns({ request: api.request, workflowNames: WORKFLOWS, log: () => undefined }),
    /Cancelled \[42\] but could not cancel superseded runs: POST actions\/runs\/41\/cancel returned HTTP 500/,
  );
  assert.deepEqual(api.cancelled, [42]);
});

test('a 409 for a run that is still active is a failure, not a finished run', async () => {
  const api = fixture({
    runs: [run(43, DELETED)],
    refs: { [DELETED]: NOT_FOUND },
    cancelStatus: { 43: 409 },
    rereadStatus: { 43: 'in_progress' },
  });
  await assert.rejects(
    cancelSupersededMergeGroupRuns({ request: api.request, workflowNames: WORKFLOWS, log: () => undefined }),
    /cancel returned HTTP 409 while run 43 is still in_progress/,
  );
  assert.ok(api.requested.includes('GET actions/runs/43'));
});

test('a cancel request that throws is reported after the remaining runs are still cancelled', async () => {
  const api = fixture({
    runs: [run(44, DELETED), run(45, DELETED)],
    refs: { [DELETED]: NOT_FOUND },
    cancelStatus: { 44: new Error('Unexpected token < in JSON') },
  });
  await assert.rejects(
    cancelSupersededMergeGroupRuns({ request: api.request, workflowNames: WORKFLOWS, log: () => undefined }),
    /Cancelled \[45\] but could not cancel superseded runs: POST actions\/runs\/44\/cancel failed: Unexpected token/,
  );
  assert.deepEqual(api.cancelled, [45]);
});

test('a failed run listing fails the step instead of reporting nothing to cancel', async () => {
  const request: GithubRequest = async () => ({ status: 403, body: { message: 'Forbidden' } });
  await assert.rejects(
    cancelSupersededMergeGroupRuns({ request, workflowNames: WORKFLOWS, log: () => undefined }),
    /Listing merge_group runs failed: .* HTTP 403/,
  );
});

test('the ref lookup encodes each branch segment and keeps the path separators', async () => {
  const paths: string[] = [];
  const request: GithubRequest = async (path) => {
    paths.push(path);
    return NOT_FOUND;
  };
  assert.deepEqual(await lookupQueueBranch(request, 'gh-readonly-queue/develop/pr-1-a#b'), { kind: 'missing' });
  assert.deepEqual(paths, [refPath('gh-readonly-queue/develop/pr-1-a%23b')]);
});

test('a finished queue run is not a candidate even when the listing returns it', () => {
  assert.deepEqual(supersessionCandidates([
    { id: 50, name: 'PR Checks', status: 'completed', event: 'merge_group', headBranch: DELETED },
    { id: 51, name: 'PR Checks', status: 'in_progress', event: 'merge_group', headBranch: DELETED },
    { id: 51, name: 'PR Checks', status: 'queued', event: 'merge_group', headBranch: DELETED },
  ], { workflowNames: WORKFLOWS }).map(item => item.id), [51]);
});

test('PR Checks cancels superseded groups from the trusted queue planner without failing it', () => {
  const workflow = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as {
    jobs: Record<string, {
      'runs-on': unknown;
      permissions?: Record<string, string>;
      steps: readonly { name?: string; if?: string; run?: string; 'continue-on-error'?: boolean;
        env?: Record<string, string> }[];
    }>;
  };
  const planner = Object.values(workflow.jobs).find(job => job.steps.some(
    step => step.run === 'node ci/src/actions/cancelSupersededMergeGroupRuns.ts',
  ));
  assert.ok(planner, 'a PR Checks job must run the superseded merge group cleanup');
  assert.equal(planner.permissions?.['actions'], 'write');
  assert.match(JSON.stringify(planner['runs-on']), /example-trusted-control/);
  const index = planner.steps.findIndex(
    step => step.run === 'node ci/src/actions/cancelSupersededMergeGroupRuns.ts',
  );
  const step = planner.steps[index];
  assert.ok(step);
  assert.match(step.if ?? '', /github\.event_name == 'merge_group'/);
  assert.match(step.if ?? '', /hashFiles\('ci\/src\/actions\/cancelSupersededMergeGroupRuns\.ts'\)/);
  assert.equal(step['continue-on-error'], true);
  assert.equal(step.env?.['CI_WORKFLOW_NAMES'], 'PR Checks,Test - iOS');
  const install = planner.steps.findIndex(item => item.name === 'Install typed planner dependencies');
  const trustedCheckout = planner.steps.findIndex(item => item.name === 'Checkout trusted base workspace');
  assert.ok(trustedCheckout >= 0 && install > trustedCheckout && index > install,
    'the cleanup must run from the trusted queue base after its dependencies install');
});

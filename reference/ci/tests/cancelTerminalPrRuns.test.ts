import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANCELLATION_CONFLICT,
  cancelConflictedPrRuns,
  cancelTerminalPrRuns,
  conflictedTargets,
  type GithubRequest,
  terminalRunIds,
  terminalTarget,
} from '../src/actions/cancelTerminalPrRuns.ts';

const head = 'a'.repeat(40);
const event = {
  action: 'closed',
  pull_request: { number: 42, head: { ref: 'feature', sha: head } },
};

test('terminal event parsing requires an exact PR tuple', () => {
  assert.deepEqual(terminalTarget(event), {
    action: 'closed', pullRequest: 42, headBranch: 'feature', headSha: head,
  });
  assert.equal(terminalTarget({ action: 'synchronize' }), undefined);
  assert.throws(
    () => terminalTarget({ action: 'closed', pull_request: { number: 42, head: {} } }),
    /missing its exact PR, branch, or head SHA/,
  );
});

test('terminal selection preserves work owned by another open PR on a shared branch', () => {
  const target = terminalTarget(event);
  assert.ok(target !== undefined);
  assert.deepEqual(terminalRunIds({
    target,
    workflowNames: new Set(['PR Checks']),
    currentRunId: 99,
    runs: [
      { id: 1, name: 'PR Checks', status: 'queued', event: 'pull_request', headBranch: 'feature', pullRequests: [42] },
      { id: 2, name: 'PR Checks', status: 'in_progress', event: 'pull_request', headBranch: 'feature', pullRequests: [43] },
      { id: 3, name: 'PR Checks', status: 'queued', event: 'pull_request', headBranch: 'feature', pullRequests: [] },
      { id: 99, name: 'PR Checks', status: 'in_progress', event: 'pull_request', headBranch: 'feature', pullRequests: [42] },
    ],
    openPullRequests: [
      { number: 43, state: 'open', draft: false, headBranch: 'feature' },
    ],
  }), [1]);
});

test('terminal cleanup cancels only owned active validation after live-state verification', async () => {
  const cancelled: number[] = [];
  const requested: string[] = [];
  const request = async (path: string, options: { readonly method?: 'GET' | 'POST' } = {}): Promise<unknown> => {
    requested.push(`${options.method ?? 'GET'} ${path}`);
    if (path === 'pulls/42') return {
      number: 42, state: 'closed', draft: false, head: { ref: 'feature', sha: head },
    };
    if (path.startsWith('actions/runs?')) {
      const status = new URLSearchParams(path.split('?')[1]).get('status');
      return { workflow_runs: status === 'queued' ? [
        { id: 7, name: 'PR Checks', status: 'queued', event: 'pull_request', head_branch: 'feature', pull_requests: [{ number: 42 }] },
        { id: 8, name: 'Other', status: 'queued', event: 'pull_request', head_branch: 'feature', pull_requests: [{ number: 42 }] },
      ] : [] };
    }
    if (path.startsWith('pulls?state=open')) return [];
    if (path === 'actions/runs/7/cancel' && options.method === 'POST') {
      cancelled.push(7);
      return undefined;
    }
    throw new Error(`Unexpected request ${path}`);
  };
  assert.deepEqual(await cancelTerminalPrRuns({
    event, request, workflowNames: new Set(['PR Checks']),
  }), [7]);
  assert.deepEqual(cancelled, [7]);
  assert.equal(requested.filter(value => value === 'GET pulls/42').length, 2);
  assert.deepEqual(requested.filter(value => value.startsWith('GET actions/runs?'))
    .map(value => new URLSearchParams(value.split('?')[1]).get('status')).sort(),
  ['in_progress', 'in_progress', 'pending', 'pending', 'queued', 'queued',
    'requested', 'requested', 'waiting', 'waiting']);
});

test('terminal cleanup finds a run missed while it moves from running to queued', async () => {
  let queuedReads = 0;
  const cancelled: number[] = [];
  const request: GithubRequest = async (path, options = {}) => {
    if (path === 'pulls/42') return {
      number: 42, state: 'closed', draft: false, head: { ref: 'feature', sha: head },
    };
    if (path.startsWith('actions/runs?')) {
      const status = new URLSearchParams(path.split('?')[1]).get('status');
      if (status === 'queued') {
        queuedReads += 1;
        // The first queued read precedes the transition, while the first
        // in_progress read follows it. The initial scan sees neither state.
        return { workflow_runs: queuedReads === 1 ? [] : [
          { id: 7, name: 'Test - iOS', status: 'queued', event: 'pull_request',
            head_branch: 'feature', pull_requests: [{ number: 42 }] },
        ] };
      }
      return { workflow_runs: [] };
    }
    if (path.startsWith('pulls?state=open')) return [];
    if (path === 'actions/runs/7/cancel' && options.method === 'POST') {
      cancelled.push(7);
      return undefined;
    }
    throw new Error(`Unexpected request ${path}`);
  };
  assert.deepEqual(await cancelTerminalPrRuns({
    event, request, workflowNames: new Set(['Test - iOS']),
  }), [7]);
  assert.equal(queuedReads, 3);
  assert.deepEqual(cancelled, [7]);
});

test('terminal cleanup fails closed if the active run inventory keeps changing', async () => {
  let queuedReads = 0;
  const request: GithubRequest = async (path) => {
    if (path === 'pulls/42') return {
      number: 42, state: 'closed', draft: false, head: { ref: 'feature', sha: head },
    };
    if (path.startsWith('actions/runs?')) {
      const status = new URLSearchParams(path.split('?')[1]).get('status');
      if (status !== 'queued') return { workflow_runs: [] };
      queuedReads += 1;
      return { workflow_runs: [
        { id: queuedReads, name: 'Test - iOS', status: 'queued', event: 'pull_request',
          head_branch: 'feature', pull_requests: [{ number: 42 }] },
      ] };
    }
    if (path.startsWith('pulls?state=open')) return [];
    throw new Error(`Unexpected request ${path}`);
  };
  await assert.rejects(cancelTerminalPrRuns({
    event, request, workflowNames: new Set(['Test - iOS']),
  }), /inventory did not stabilize after 3 scans/);
  assert.equal(queuedReads, 3);
});

test('stale terminal events cannot cancel current work', async () => {
  const cancelled = await cancelTerminalPrRuns({
    event,
    workflowNames: new Set(['PR Checks']),
    request: async () => ({
      number: 42, state: 'open', draft: false, head: { ref: 'feature', sha: head },
    }),
  });
  assert.deepEqual(cancelled, []);
});

test('a cancellation conflict succeeds only after the run proves non-active', async () => {
  const request = async (path: string, options: { readonly method?: 'GET' | 'POST' } = {}): Promise<unknown> => {
    if (path === 'pulls/42') return {
      number: 42, state: 'closed', draft: false, head: { ref: 'feature', sha: head },
    };
    if (path.startsWith('actions/runs?')) return { workflow_runs: [
      { id: 7, name: 'PR Checks', status: 'queued', event: 'pull_request', head_branch: 'feature', pull_requests: [{ number: 42 }] },
    ] };
    if (path.startsWith('pulls?state=open')) return [];
    if (path === 'actions/runs/7/cancel' && options.method === 'POST') return CANCELLATION_CONFLICT;
    if (path === 'actions/runs/7') return { id: 7, status: 'completed', conclusion: 'cancelled' };
    throw new Error(`Unexpected request ${options.method ?? 'GET'} ${path}`);
  };
  assert.deepEqual(await cancelTerminalPrRuns({
    event, request, workflowNames: new Set(['PR Checks']),
  }), [7]);
});

test('a cancellation conflict fails while the run remains active', async () => {
  const request = async (path: string, options: { readonly method?: 'GET' | 'POST' } = {}): Promise<unknown> => {
    if (path === 'pulls/42') return {
      number: 42, state: 'closed', draft: false, head: { ref: 'feature', sha: head },
    };
    if (path.startsWith('actions/runs?')) return { workflow_runs: [
      { id: 7, name: 'PR Checks', status: 'queued', event: 'pull_request', head_branch: 'feature', pull_requests: [{ number: 42 }] },
    ] };
    if (path.startsWith('pulls?state=open')) return [];
    if (path === 'actions/runs/7/cancel' && options.method === 'POST') return CANCELLATION_CONFLICT;
    if (path === 'actions/runs/7') return { id: 7, status: 'in_progress' };
    throw new Error(`Unexpected request ${options.method ?? 'GET'} ${path}`);
  };
  await assert.rejects(cancelTerminalPrRuns({
    event, request, workflowNames: new Set(['PR Checks']),
  }), /rejected cancellation for run 7, which is still in_progress/);
});

const conflictedTarget = { number: 42, headRef: 'feature', headSha: head };

interface ConflictedScenario {
  /** Successive live pull-request payloads; the last one repeats. */
  readonly livePulls: readonly unknown[];
  readonly runs?: readonly { readonly status: string }[];
  readonly openPullRequests?: readonly unknown[];
  readonly cancel?: () => unknown;
  readonly latestRun?: unknown;
}

function conflictedRequest(scenario: ConflictedScenario): {
  readonly request: GithubRequest;
  readonly cancelled: number[];
} {
  const cancelled: number[] = [];
  let liveReads = 0;
  const request: GithubRequest = async (path, options = {}) => {
    if (path === 'pulls/42') {
      const payload = scenario.livePulls[Math.min(liveReads, scenario.livePulls.length - 1)];
      liveReads += 1;
      return payload;
    }
    if (path.startsWith('actions/runs?')) {
      const status = new URLSearchParams(path.split('?')[1]).get('status');
      return { workflow_runs: (scenario.runs ?? []).filter(run => run.status === status) };
    }
    if (path.startsWith('pulls?state=open')) return scenario.openPullRequests ?? [];
    const cancel = /^actions\/runs\/(\d+)\/cancel$/.exec(path);
    if (cancel?.[1] !== undefined && options.method === 'POST') {
      cancelled.push(Number(cancel[1]));
      return scenario.cancel?.();
    }
    if (/^actions\/runs\/\d+$/.test(path)) return scenario.latestRun;
    throw new Error(`Unexpected request ${options.method ?? 'GET'} ${path}`);
  };
  return { request, cancelled };
}

const dirtyPull = {
  number: 42, state: 'open', draft: false, mergeable: false, mergeable_state: 'dirty',
  head: { ref: 'feature', sha: head },
};

const pullRun = (id: number, status: string, pullRequests: readonly number[], name = 'Test - iOS') => ({
  id, name, status, event: 'pull_request', head_branch: 'feature',
  pull_requests: pullRequests.map(number => ({ number })),
});

const oneConflictedTarget = () => conflictedTargets(JSON.stringify([conflictedTarget]));

test('conflicted targets are parsed strictly from the fan-out output', () => {
  assert.deepEqual(oneConflictedTarget(), [
    { action: 'conflicted', pullRequest: 42, headBranch: 'feature', headSha: head },
  ]);
  assert.throws(() => conflictedTargets('not json'), /not valid JSON/);
  assert.throws(() => conflictedTargets('[]'), /non-empty JSON array/);
  assert.throws(() => conflictedTargets('{}'), /non-empty JSON array/);
  assert.throws(
    () => conflictedTargets(JSON.stringify([{ ...conflictedTarget, headSha: 'abc' }])),
    /CONFLICTED_PULL_REQUESTS\[0\]/,
  );
  assert.throws(
    () => conflictedTargets(JSON.stringify([{ number: 42, head_ref: 'feature', headSha: head }])),
    /CONFLICTED_PULL_REQUESTS\[0\]/,
  );
});

test('a conflicted pull request loses its active validation runs', async () => {
  const { request, cancelled } = conflictedRequest({
    livePulls: [dirtyPull],
    runs: [
      pullRun(7, 'queued', [42]),
      pullRun(8, 'in_progress', [42], 'PR Checks'),
      pullRun(9, 'queued', [42], 'Unrelated'),
      pullRun(10, 'waiting', []),
    ],
  });
  const result = await cancelConflictedPrRuns({
    targets: oneConflictedTarget(),
    request,
    workflowNames: new Set(['PR Checks', 'Test - iOS']),
  });
  assert.deepEqual([...result].sort(), [10, 7, 8].sort());
  assert.deepEqual([...cancelled].sort(), [10, 7, 8].sort());
});

for (const [label, livePull] of [
  ['mergeability is still being computed', { ...dirtyPull, mergeable: null, mergeable_state: 'unknown' }],
  ['GitHub reports it mergeable', { ...dirtyPull, mergeable: true, mergeable_state: 'clean' }],
  ['it is unmergeable for a reason other than a conflict', { ...dirtyPull, mergeable_state: 'blocked' }],
  ['its head moved', { ...dirtyPull, head: { ref: 'feature', sha: 'b'.repeat(40) } }],
  ['its head branch changed', { ...dirtyPull, head: { ref: 'other', sha: head } }],
  ['it was closed', { ...dirtyPull, state: 'closed' }],
] as const) {
  test(`a conflicted target keeps its runs when ${label}`, async () => {
    const { request, cancelled } = conflictedRequest({
      livePulls: [livePull],
      runs: [pullRun(7, 'queued', [42])],
    });
    assert.deepEqual(await cancelConflictedPrRuns({
      targets: oneConflictedTarget(),
      request,
      workflowNames: new Set(['Test - iOS']),
    }), []);
    assert.deepEqual(cancelled, []);
  });
}

test('a conflict resolved mid-cleanup stops before the next cancellation', async () => {
  const { request, cancelled } = conflictedRequest({
    livePulls: [dirtyPull, dirtyPull, { ...dirtyPull, head: { ref: 'feature', sha: 'b'.repeat(40) } }],
    runs: [pullRun(7, 'queued', [42]), pullRun(8, 'queued', [42])],
  });
  assert.deepEqual(await cancelConflictedPrRuns({
    targets: oneConflictedTarget(),
    request,
    workflowNames: new Set(['Test - iOS']),
  }), [7]);
  assert.deepEqual(cancelled, [7]);
});

test('a conflicted target never cancels the current run or runs another open PR owns', async () => {
  const { request, cancelled } = conflictedRequest({
    livePulls: [dirtyPull],
    runs: [
      pullRun(7, 'queued', [42]),
      pullRun(8, 'queued', [43]),
      pullRun(9, 'queued', []),
      pullRun(99, 'in_progress', [42]),
    ],
    openPullRequests: [
      { number: 42, state: 'open', draft: false, head: { ref: 'feature' } },
      { number: 43, state: 'open', draft: false, head: { ref: 'feature' } },
    ],
  });
  assert.deepEqual(await cancelConflictedPrRuns({
    targets: oneConflictedTarget(),
    request,
    workflowNames: new Set(['Test - iOS']),
    currentRunId: 99,
  }), [7]);
  assert.deepEqual(cancelled, [7]);
});

test('a conflicted cancellation 409 succeeds once the run is no longer active', async () => {
  const { request } = conflictedRequest({
    livePulls: [dirtyPull],
    runs: [pullRun(7, 'queued', [42])],
    cancel: () => CANCELLATION_CONFLICT,
    latestRun: { id: 7, status: 'completed', conclusion: 'success' },
  });
  assert.deepEqual(await cancelConflictedPrRuns({
    targets: oneConflictedTarget(),
    request,
    workflowNames: new Set(['Test - iOS']),
  }), [7]);
});

test('a 409 on a still-active run fails only after every conflicted target is attempted', async () => {
  const { request, cancelled } = conflictedRequest({
    livePulls: [dirtyPull],
    runs: [pullRun(7, 'queued', [42])],
    cancel: () => CANCELLATION_CONFLICT,
    latestRun: { id: 7, status: 'queued' },
  });
  const secondTargetReads: string[] = [];
  const withSecondTarget: GithubRequest = async (path, options) => {
    if (path !== 'pulls/44') return request(path, options);
    secondTargetReads.push(path);
    return { ...dirtyPull, number: 44, state: 'closed' };
  };
  await assert.rejects(cancelConflictedPrRuns({
    targets: conflictedTargets(JSON.stringify([conflictedTarget, { ...conflictedTarget, number: 44 }])),
    request: withSecondTarget,
    workflowNames: new Set(['Test - iOS']),
  }), /PR #42: GitHub rejected cancellation for run 7, which is still queued/);
  assert.deepEqual(cancelled, [7]);
  assert.deepEqual(secondTargetReads, ['pulls/44']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubJson, WorkflowJob } from '../../scripts/ci/types/github.d.mts';

import { bindReplanRecord } from '../src/ios/replanRecordBinding.ts';

/**
 * Shapes taken from run 36257936571 (PR #6019), whose attempt 2 re-ran only
 * the failed native2 lane: carried-forward jobs are listed under attempt 2 with
 * new ids but keep the original execution's times and runner.
 */
const runId = 36257936571;
const headSha = '8e93f7e733861fc23e5baa13c73569731dc970e7';

function job(id: number, runAttempt: number, name: string, overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id, name, run_id: runId, run_attempt: runAttempt, head_sha: headSha,
    status: 'completed', conclusion: 'success',
    started_at: '2026-09-26T18:35:35Z', completed_at: '2026-09-26T18:51:31Z', runner_id: 230,
    ...overrides,
  };
}

const gateExecution = {
  started_at: '2026-09-26T17:21:10Z', completed_at: '2026-09-26T17:21:53Z', runner_id: 112,
};

function attempt1(gate: Partial<WorkflowJob> = gateExecution): WorkflowJob[] {
  return [
    job(108450209791, 1, 'iOS Change Gate', gate),
    job(108450953697, 1, 'Build shared native iOS test products'),
    job(108454457674, 1, 'Test - iOS execution (native1)'),
    job(108454457770, 1, 'Test - iOS execution (native2)', { conclusion: 'failure' }),
  ];
}

function attempt2(native2: Partial<WorkflowJob> = {}): WorkflowJob[] {
  return [
    job(108492965199, 2, 'iOS Change Gate', gateExecution),
    job(108492965521, 2, 'Build shared native iOS test products'),
    job(108492965827, 2, 'Test - iOS execution (native1)'),
    job(108492965706, 2, 'Test - iOS execution (native2)', {
      started_at: '2026-09-26T21:44:24Z', completed_at: '2026-09-26T21:57:37Z', ...native2,
    }),
    job(108492966110, 2, 'StoreKit Purchase - iOS', { conclusion: 'skipped' }),
  ];
}

function reader(listings: Record<string, readonly WorkflowJob[]>) {
  const requested: string[] = [];
  const request = async (path: string): Promise<GitHubJson> => {
    requested.push(path);
    const jobs = listings[path];
    if (jobs === undefined) throw new Error(`Unexpected request: ${path}`);
    return { total_count: jobs.length, jobs };
  };
  return { request, requested };
}

const latestPath = `actions/runs/${runId}/jobs?filter=latest&per_page=100`;
const attemptPath = (attempt: number) => `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`;

test('a re-run-failed-jobs success binds to the attempt whose gate actually ran', async () => {
  const { request } = reader({ [latestPath]: attempt2(), [attemptPath(1)]: attempt1() });
  assert.deepEqual(await bindReplanRecord({ runId, runAttempt: 2, headSha, request, token: 't' }), {
    recordAttempt: 1,
    detail: 'carried-forward-gate',
    successfulJobs: ['native-products', 'native:native1', 'native:native2'],
  });
});

test('a gate that ran again in the successful attempt binds to that attempt', async () => {
  const { request } = reader({
    [latestPath]: attempt2(),
    [attemptPath(1)]: attempt1({ ...gateExecution, started_at: '2026-09-26T16:00:00Z' }),
  });
  assert.equal((await bindReplanRecord({ runId, runAttempt: 2, headSha, request, token: 't' })).recordAttempt, 2);
});

test('an earlier gate on another runner is not the same execution', async () => {
  const { request } = reader({
    [latestPath]: attempt2(),
    [attemptPath(1)]: attempt1({ ...gateExecution, runner_id: 113 }),
  });
  const binding = await bindReplanRecord({ runId, runAttempt: 2, headSha, request, token: 't' });
  assert.equal(binding.recordAttempt, 2, 'the record for attempt 2 does not exist, so the gate reports no record');
  assert.equal(binding.detail, 'gate-ran-in-success-attempt');
});

test('a failed lane in the successful attempt is not listed as succeeded', async () => {
  const { request } = reader({
    [latestPath]: attempt2({ conclusion: 'failure' }), [attemptPath(1)]: attempt1(),
  });
  assert.deepEqual((await bindReplanRecord({ runId, runAttempt: 2, headSha, request, token: 't' })).successfulJobs,
    ['native-products', 'native:native1']);
});

test('unprovable job history binds to no attempt', async () => {
  const wrongAttempt = reader({ [latestPath]: attempt1() });
  assert.deepEqual(await bindReplanRecord({ runId, runAttempt: 2, headSha, request: wrongAttempt.request, token: 't' }),
    { recordAttempt: null, detail: 'latest-jobs-unproven', successfulJobs: [] });
  const noGate = reader({ [latestPath]: attempt2().filter(entry => entry.name !== 'iOS Change Gate') });
  assert.equal((await bindReplanRecord({ runId, runAttempt: 2, headSha, request: noGate.request, token: 't' }))
    .detail, 'gate-job-missing');
  const truncated = reader({ [latestPath]: attempt2() });
  truncated.request = async (path: string): Promise<GitHubJson> => (
    path === latestPath
      ? { total_count: 5, jobs: attempt2() }
      : { total_count: 9, jobs: attempt1() }
  );
  const binding = await bindReplanRecord({ runId, runAttempt: 2, headSha, request: truncated.request, token: 't' });
  assert.deepEqual([binding.recordAttempt, binding.detail], [null, 'attempt-1-jobs-incomplete']);
});

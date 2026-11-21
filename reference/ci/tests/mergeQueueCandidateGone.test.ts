import assert from 'node:assert/strict';
import test from 'node:test';
import type { GithubResponse } from '../src/ios/shared/githubRest.ts';
import { candidateGoneOutputs } from '../src/ios/iosChangeGate.ts';
import { cancelWorkflowRun, isMissingRemoteRef, queueCandidateGone } from '../src/mergeQueueCandidateGone.ts';

const QUEUE_REF = `refs/heads/gh-readonly-queue/develop/pr-6276-${'8'.repeat(40)}`;
const API = 'https://api.github.test';
const REF_URL = `${API}/repos/o/r/git/ref/heads/gh-readonly-queue/develop/pr-6276-${'8'.repeat(40)}`;
const CANCEL_URL = `${API}/repos/o/r/actions/runs/77/cancel`;

function responder(statuses: Readonly<Record<string, number>>) {
  const calls: string[] = [];
  const request = async (method: string, url: string): Promise<GithubResponse> => {
    const key = `${method} ${url}`;
    calls.push(key);
    const status = statuses[key];
    if (status === undefined) throw new Error(`unexpected ${key}`);
    return { status, statusLabel: String(status), body: undefined };
  };
  return { calls, request };
}

const lookup = (request: ReturnType<typeof responder>['request']) => ({
  apiUrl: API, repository: 'o/r', queueRef: QUEUE_REF, request,
});

test('only the missing queue ref itself counts as a deleted candidate', () => {
  assert.equal(isMissingRemoteRef(`fatal: couldn't find remote ref ${QUEUE_REF}\n`, QUEUE_REF), true);
  assert.equal(isMissingRemoteRef("fatal: couldn't find remote ref refs/heads/develop\n", QUEUE_REF), false);
  assert.equal(isMissingRemoteRef('fatal: unable to access: 503\n', QUEUE_REF), false);
});

test('the API decides whether the candidate is gone, with a read only', async () => {
  const gone = responder({ [`GET ${REF_URL}`]: 404 });
  assert.equal(await queueCandidateGone(lookup(gone.request)), true);
  assert.deepEqual(gone.calls, [`GET ${REF_URL}`]);
  assert.equal(await queueCandidateGone(lookup(responder({ [`GET ${REF_URL}`]: 200 }).request)), false);
  await assert.rejects(queueCandidateGone(lookup(responder({ [`GET ${REF_URL}`]: 503 }).request)),
    /Could not confirm whether .* exists: GitHub answered HTTP 503/);
});

test('cancelling accepts a queued or already-completing run and reports a refusal', async () => {
  for (const status of [202, 409]) {
    const github = responder({ [`POST ${CANCEL_URL}`]: status });
    await cancelWorkflowRun({ ...lookup(github.request), runId: '77' });
    assert.deepEqual(github.calls, [`POST ${CANCEL_URL}`]);
  }
  await assert.rejects(cancelWorkflowRun({ ...lookup(responder({ [`POST ${CANCEL_URL}`]: 403 }).request), runId: '77' }),
    /Could not cancel run 77 .* HTTP 403; check the job grants actions: write/);
});

test('a gate that found its candidate gone publishes a plan that starts no iOS work', () => {
  const outputs = candidateGoneOutputs({
    forcedIosLanesRaw: '[]', reuseNativeEvidenceRaw: 'false', changedFilesDelimiter: 'X',
  });
  const value = (key: string) => outputs.find((output) => output.key === key)?.value;
  assert.equal(value('should_run'), 'false');
  assert.equal(value('main_required'), 'false');
  assert.equal(value('evidence_required'), 'false');
  assert.match(String(value('summary')), /deleted this candidate/);
});

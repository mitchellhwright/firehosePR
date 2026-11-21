import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  executionTupleDecision, readCurrentPullRequestTuple, type QueuedTuple,
} from '../src/ios/currentPullRequestTuple.ts';
import { macRevisionAdmission, trustedGuardRevisionDecision } from '../src/ios/macRevisionAdmission.ts';
import { createGithubReader, GithubTransportError, type GithubReader } from '../src/ios/shared/githubRest.ts';

const expected: QueuedTuple = {
  prNumber: '6175', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseRef: 'develop',
};
const live = { state: 'open', draft: false, head: { sha: expected.headSha },
  base: { sha: expected.baseSha, ref: expected.baseRef } };
const options = { expected, apiUrl: 'https://api.github.com', repository: 'example-org/example-app' };
const bodyReader = (body: unknown): GithubReader => async () => ({ status: 200, statusLabel: '200', body });

test('Linux and late Mac admission accept exactly the same live tuple', async () => {
  const decision = await readCurrentPullRequestTuple({ ...options, read: async url => {
    assert.equal(url, 'https://api.github.com/repos/example-org/example-app/pulls/6175');
    return { status: 200, statusLabel: '200', body: live };
  } });
  assert.equal(decision.current, 'true');
  assert.equal(executionTupleDecision(decision).exitCode, 0);
});

test('moved, closed, draft and malformed tuples cannot admit Mac execution', async () => {
  for (const body of [
    { ...live, state: 'closed' }, { ...live, draft: true },
    { ...live, head: { sha: 'c'.repeat(40) } },
    { ...live, base: { sha: 'c'.repeat(40), ref: 'develop' } },
    { ...live, base: { sha: expected.baseSha, ref: 'main' } },
    { ...live, draft: undefined }, null, [], {},
  ]) {
    const allocation = await readCurrentPullRequestTuple({ ...options, read: bodyReader(body) });
    assert.equal(allocation.current, 'false');
    assert.equal(allocation.exitCode, 0, 'stale work skips pre-allocation');
    const execution = executionTupleDecision(allocation);
    assert.equal(execution.exitCode, 1, 'stale work stops after allocation');
    assert.match(execution.messages[0]?.text ?? '', /refusing Mac execution/);
  }
});

test('unreadable metadata fails closed rather than becoming a stale success', async () => {
  for (const status of [403, 404, 429, 500]) {
    const decision = await readCurrentPullRequestTuple({ ...options,
      read: async () => ({ status, statusLabel: String(status), body: undefined }) });
    assert.equal(decision.exitCode, 1);
    assert.equal(executionTupleDecision(decision).exitCode, 1);
  }
  const failed = await readCurrentPullRequestTuple({ ...options,
    read: async () => { throw new GithubTransportError('offline'); } });
  assert.equal(failed.exitCode, 1);
});

test('malformed external tuple identifiers fail before any API request', async () => {
  const read: GithubReader = async () => { assert.fail('invalid input must never reach the API'); };
  for (const tuple of [
    { ...expected, prNumber: '../1' }, { ...expected, prNumber: '0' },
    { ...expected, headSha: '' }, { ...expected, baseSha: '' }, { ...expected, baseRef: '' },
  ]) assert.equal((await readCurrentPullRequestTuple({ ...options, expected: tuple, read })).exitCode, 1);
  assert.equal((await readCurrentPullRequestTuple({ ...options, repository: '../bad', read })).exitCode, 1);
  assert.equal((await readCurrentPullRequestTuple({ ...options,
    expected: { ...expected, prNumber: '' }, read })).current, 'true');
});

test('shared admission retries transient reads with the same credential and bounded policy', async () => {
  let calls = 0;
  const read = createGithubReader({ tokens: ['test-token'], warn: () => {}, sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? new Response('', { status: 503 }) : Response.json(live);
    } });
  assert.equal((await readCurrentPullRequestTuple({ ...options, read })).current, 'true');
  assert.equal(calls, 3);
});

test('guard revision proof uses the entry checkout and rejects wrong or unreadable revisions', async () => {
  const entry = 'file:///private/tmp/verifier%20checkout/ci/src/actions/ios/verifyExactIosRevision.ts';
  const valid = await trustedGuardRevisionDecision(entry, expected.baseSha, async directory => {
    assert.equal(directory, '/private/tmp/verifier checkout/ci/src/actions/ios');
    return expected.baseSha;
  });
  assert.equal(valid.exitCode, 0);
  for (const actual of ['', expected.headSha]) {
    const rejected = await trustedGuardRevisionDecision(entry, expected.baseSha, async () => actual);
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.messages[0]?.text ?? '', /does not match trusted verifier/);
  }
});

test('manual Mac work still proves both trusted guard and exact product checkout without PR metadata', async () => {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const inputs = { EXAMPLE_CI_GUARD_SHA: sha, EXACT_HEAD_SHA: sha,
    GITHUB_WORKSPACE: process.cwd(), EXAMPLE_CI_PR_NUMBER: '' };
  const previous = Object.fromEntries(Object.keys(inputs).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, inputs);
    assert.equal((await macRevisionAdmission(import.meta.url)).exitCode, 0);
    process.env.EXACT_HEAD_SHA = expected.headSha;
    assert.equal((await macRevisionAdmission(import.meta.url)).exitCode, 1);
    process.env.EXAMPLE_CI_GUARD_SHA = expected.baseSha;
    assert.equal((await macRevisionAdmission(import.meta.url)).exitCode, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

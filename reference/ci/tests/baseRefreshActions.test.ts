import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  main as cancelObsoleteIosRuns,
  type GithubObject as CancellationGithubObject,
} from '../src/actions/cancelObsoleteIosRuns.ts';
import {
  AWAIT_RETAINED_IOS_PREDECESSOR_JOB_NAME,
  allowsAutomaticTargetRefresh,
  deferredPredecessorId,
  hasActiveCurrentHeadIosRun,
  refreshTargetBranchNative,
  type GithubObject as ResumeGithubObject,
  type RequestOptions,
} from '../src/actions/resumeRetainedIosPredecessor.ts';

const sha = (character: string): string => character.repeat(40);
const asCancellationObject = (value: unknown): CancellationGithubObject =>
  value as CancellationGithubObject;
const asResumeObject = (value: unknown): ResumeGithubObject => value as ResumeGithubObject;

const repository = 'example-org/example-app';
const oldHead = sha('a');
const currentHead = sha('b');
const baseHead = sha('c');
const pull = {
  number: 12,
  state: 'open',
  draft: false,
  head: { sha: currentHead, ref: 'feature/typed-controller', repo: { full_name: repository } },
  base: { sha: baseHead, ref: 'develop', repo: { full_name: repository } },
};

test('typed synchronize controller cancels only the obsolete active iOS run', async () => {
  const activeRun = {
    id: 101,
    name: 'Test - iOS',
    head_sha: oldHead,
    status: 'queued',
    created_at: '2026-09-22T12:00:00Z',
    pull_requests: [{ number: 12, base: { ref: 'develop' } }],
  };
  const calls: string[] = [];
  const request = async (path: string): Promise<CancellationGithubObject> => {
    calls.push(path);
    if (path === 'pulls/12') return asCancellationObject(pull);
    if (path === `compare/${oldHead}...${currentHead}`) {
      return asCancellationObject({ files: [{ filename: 'ios/example-ios/App.swift' }] });
    }
    if (path === `commits/${currentHead}`) return asCancellationObject({ sha: currentHead, parents: [] });
    if (path.startsWith('actions/workflows/ios-tests.yml/runs?')) {
      return asCancellationObject({ total_count: 1, workflow_runs: [activeRun] });
    }
    if (path === 'actions/runs/101/cancel') return asCancellationObject({});
    throw new Error(`Unexpected request ${path}`);
  };

  const { cancelled } = await cancelObsoleteIosRuns({
    event: asCancellationObject({ action: 'synchronize', before: oldHead, pull_request: pull }),
    repository,
    request,
  });

  assert.deepEqual(cancelled, [101]);
  assert.equal(calls.filter((path) => path === 'actions/runs/101/cancel').length, 1);
  assert.ok(calls.filter((path) => path.startsWith('actions/workflows/ios-tests.yml/runs?')).length >= 2);
});

test('typed retained marker parser accepts the current exact marker shape', () => {
  const job = asResumeObject({
    status: 'completed',
    conclusion: 'success',
    name: AWAIT_RETAINED_IOS_PREDECESSOR_JOB_NAME,
    steps: [{ name: `${AWAIT_RETAINED_IOS_PREDECESSOR_JOB_NAME} (9182 at ${baseHead})` }],
  });
  assert.equal(deferredPredecessorId([job]), 9182);
});

test('resume controller leaves an active current-head iOS run to classify retained evidence', () => {
  const candidate = (id: number, headSha: string, status: string, number = 12) =>
    asResumeObject({
      id, name: 'Test - iOS', event: 'pull_request', head_sha: headSha, status,
      pull_requests: [{ number }],
    });
  assert.equal(hasActiveCurrentHeadIosRun([
    candidate(101, oldHead, 'queued'),
    candidate(102, currentHead, 'completed'),
    candidate(103, currentHead, 'queued'),
  ], currentHead, 12, 102), true);
  assert.equal(hasActiveCurrentHeadIosRun([
    candidate(101, oldHead, 'queued'),
    candidate(102, currentHead, 'completed'),
    candidate(103, currentHead, 'queued', 99),
  ], currentHead, 12, 102), false);
});

test('native target refresh uses the exact current head', async () => {
  const calls: { path: string; options?: RequestOptions }[] = [];
  const request = async (
    path: string,
    options?: RequestOptions,
  ): Promise<ResumeGithubObject> => {
    calls.push({ path, options });
    if (path === 'branches/develop') return asResumeObject({ commit: { sha: baseHead } });
    if (path === `compare/${baseHead}...${currentHead}`) return asResumeObject({ status: 'behind' });
    if (path === 'pulls/12') return asResumeObject(pull);
    if (path === 'pulls/12/update-branch') return asResumeObject({});
    throw new Error(`Unexpected request ${path}`);
  };

  const updated = await refreshTargetBranchNative(asResumeObject(pull), {
    eventToken: 'scoped-token',
    validateTargetSha: async (target) => target === baseHead,
    request,
  });

  assert.equal(updated, true);
  assert.deepEqual(calls.at(-1), {
    path: 'pulls/12/update-branch',
    options: {
      method: 'PUT',
      token: 'scoped-token',
      body: { expected_head_sha: currentHead },
    },
  });
});

for (const [label, protectedPull] of [
  ['mutable develop-to-main promotion', {
    ...pull,
    head: { ...pull.head, ref: 'develop' },
    base: { ...pull.base, ref: 'main' },
  }],
  ['immutable promotion checkpoint', {
    ...pull,
    head: { ...pull.head, ref: `promotion/develop-${sha('d')}` },
  }],
] as const) {
  test(`native target refresh is a no-op for ${label}`, async () => {
    const calls: string[] = [];
    assert.equal(allowsAutomaticTargetRefresh(asResumeObject(protectedPull)), false);
    const updated = await refreshTargetBranchNative(asResumeObject(protectedPull), {
      eventToken: 'scoped-token',
      validateTargetSha: async () => true,
      request: async path => {
        calls.push(path);
        throw new Error(`Unexpected request ${path}`);
      },
    });
    assert.equal(updated, false);
    assert.deepEqual(calls, []);
  });
}

test('base-refresh workflow invokes only typed controller entrypoints', () => {
  const source = readFileSync(new URL('../workflows/refresh-pr-ci-after-base-edit.ts', import.meta.url), 'utf8');
  assert.match(source, /entry: 'ci\/src\/actions\/cancelObsoleteIosRuns\.ts'/);
  assert.match(source, /node ci\/src\/actions\/resumeRetainedIosPredecessor\.ts/);
  assert.doesNotMatch(source, /node scripts\/(?:cancel-obsolete-ios-runs|resume-retained-ios-predecessor)\.mjs/);
});

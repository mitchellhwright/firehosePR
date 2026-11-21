import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitHubJson } from '../../scripts/ci/types/github.d.mts';

import {
  effectivePatchFingerprint,
  equivalentEffectivePatch,
  isEligibleBaseUpdateCommit,
  isReusableIosBaseLineage,
  isReusableIosLaneJob,
  validCompleteFiles,
  type BaseUpdateComparisonFile,
} from '../src/ios/baseUpdateDelta.ts';
import {
  controllerBaseUpdateDelta,
  GitHubQuotaError,
  githubJson,
  main,
} from '../src/ios/controllers/baseUpdateDelta.ts';

const sha = (character: string): string => character.repeat(40);

function githubResponses(...statuses: number[]): {
  readonly fetchImpl: typeof fetch;
  readonly tokens: string[];
} {
  const tokens: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    tokens.push(new Headers(init?.headers).get('Authorization') ?? '');
    const status = statuses.shift();
    assert.notEqual(status, undefined, 'unexpected extra GitHub request');
    return new Response(JSON.stringify({ sha: sha('a') }), { status });
  };
  return { fetchImpl, tokens };
}

const githubReaderOptions = {
  apiUrl: 'https://api.github.test',
  repository: 'example-org/example-app',
  fallbackToken: 'app-token',
  warn: () => {},
};

test('base-update metadata read retries transient HTTP 500 without switching credentials', async () => {
  const responses = githubResponses(500, 200);
  const result = await githubJson('pulls/5959', 'event-token', {
    ...githubReaderOptions,
    fetchImpl: responses.fetchImpl,
  });
  assert.equal(result.sha, sha('a'));
  assert.deepEqual(responses.tokens, ['Bearer event-token', 'Bearer event-token']);
});

test('base-update metadata read fails closed after bounded HTTP 503 retries', async () => {
  const responses = githubResponses(503, 503, 503);
  await assert.rejects(githubJson('pulls/5959', 'event-token', {
    ...githubReaderOptions,
    fetchImpl: responses.fetchImpl,
  }), /GitHub API pulls\/5959 failed with HTTP 503/);
  assert.deepEqual(responses.tokens, Array(3).fill('Bearer event-token'));
});

test('base-update metadata read never retries nonretryable HTTP 404', async () => {
  const responses = githubResponses(404);
  await assert.rejects(githubJson('pulls/5959', 'event-token', {
    ...githubReaderOptions,
    fetchImpl: responses.fetchImpl,
  }), /GitHub API pulls\/5959 failed with HTTP 404/);
  assert.deepEqual(responses.tokens, ['Bearer event-token']);
});

test('base-update metadata falls back on quota, but Actions evidence does not', async () => {
  const metadata = githubResponses(403, 200);
  await githubJson('pulls/5959', 'event-token', {
    ...githubReaderOptions,
    fetchImpl: metadata.fetchImpl,
  });
  assert.deepEqual(metadata.tokens, ['Bearer event-token', 'Bearer app-token']);

  const actions = githubResponses(403);
  await assert.rejects(githubJson('actions/runs', 'event-token', {
    ...githubReaderOptions,
    fetchImpl: actions.fetchImpl,
  }), GitHubQuotaError);
  assert.deepEqual(actions.tokens, ['Bearer event-token']);
});

test('base refresh excludes the typed controller from iOS routing changes', () => {
  const previousHead = sha('a');
  const base = sha('b');
  const head = sha('c');
  const repository = { full_name: 'example-org/example-app' };
  assert.deepEqual(controllerBaseUpdateDelta({
    pullRequest: {
      number: 42,
      head: { sha: head, repo: repository },
      base: { ref: 'develop', sha: base, repo: repository },
    },
    commit: {
      sha: head,
      parents: [{ sha: previousHead }, { sha: base }],
      commit: { message: 'chore: update PR #42 from develop' },
    },
    comparison: {
      status: 'ahead',
      merge_base_commit: { sha: previousHead },
      files: [
        { filename: 'ci/src/ios/controllers/baseUpdateDelta.ts' },
        { filename: '.github/workflows/ios-tests.yml' },
      ],
    },
    priorBaseComparison: { status: 'ahead', merge_base_commit: { sha: base } },
    runs: [{
      name: 'PR Checks', head_sha: previousHead, status: 'completed',
      conclusion: 'success', created_at: '2026-09-22T12:00:00Z',
      pull_requests: [{ number: 42 }],
    }],
    timeline: [], workflows: ['PR Checks'], previousHead,
  }), {
    priorHead: previousHead,
    changedFiles: ['.github/workflows/ios-tests.yml'],
  });
});
const replacement = (
  filename: string,
  oldStart: number,
  newStart: number,
) => ({
  filename,
  status: 'modified',
  sha: sha('a'),
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: `@@ -${oldStart} +${newStart} @@\n-old\n+new`,
});

test('effective patch equivalence maps hunk locations through base lineage', () => {
  const previousPatch = [replacement('ios/App.swift', 20, 20)];
  const currentPatch = [replacement('ios/App.swift', 22, 22)];
  const lineage = {
    status: 'ahead',
    files: [{
      filename: 'ios/App.swift',
      status: 'modified',
      sha: sha('b'),
      additions: 2,
      deletions: 0,
      changes: 2,
      patch: '@@ -1,1 +1,3 @@\n context\n+base one\n+base two',
    }],
  };

  assert.equal(equivalentEffectivePatch(currentPatch, previousPatch, lineage), true);
  assert.equal(equivalentEffectivePatch(previousPatch, currentPatch, lineage), false);
});

test('effective patch equivalence rejects malformed inventories instead of throwing', () => {
  const patch = [replacement('ios/App.swift', 20, 20)];
  const nullEntry = [null] as unknown as BaseUpdateComparisonFile[];
  assert.equal(equivalentEffectivePatch(nullEntry, nullEntry), false);
  assert.equal(equivalentEffectivePatch(patch, nullEntry), false);
  assert.equal(equivalentEffectivePatch(patch, patch, { status: 'ahead', files: nullEntry }), false);
  assert.equal(validCompleteFiles(nullEntry), false);
  assert.equal(effectivePatchFingerprint(nullEntry), null);
});

test('effective patch equivalence never treats a malformed previous path as absent', () => {
  const patch = replacement('ios/App.swift', 20, 20);
  const nullPrevious = { ...patch, previous_filename: null } as unknown as BaseUpdateComparisonFile;
  const emptyPrevious = { ...patch, previous_filename: '' };
  assert.equal(equivalentEffectivePatch([patch], [patch]), true);
  assert.equal(equivalentEffectivePatch([nullPrevious], [patch]), false);
  assert.equal(equivalentEffectivePatch([nullPrevious], [nullPrevious]), false);
  assert.equal(equivalentEffectivePatch([emptyPrevious], [patch]), false);
  assert.equal(equivalentEffectivePatch([{ ...patch, status: 'renamed' }], [{ ...patch, status: 'renamed' }]), false);
  const renamed = { ...patch, status: 'renamed', previous_filename: 'ios/Old.swift' };
  assert.equal(equivalentEffectivePatch([renamed], [renamed]), true);
});

test('base update eligibility accepts only the controller shape or verified GitHub update', () => {
  const pullRequest = { number: 42, base: { ref: 'develop' } };
  const parents = [{ sha: sha('a') }, { sha: sha('b') }];
  assert.equal(isEligibleBaseUpdateCommit({
    commit: {
      parents,
      commit: { message: 'chore: update PR #42 from develop' },
    },
    pullRequest,
    firstParent: sha('a'),
    baseParent: sha('b'),
  }), true);
  assert.equal(isEligibleBaseUpdateCommit({
    commit: {
      parents,
      committer: { login: 'web-flow' },
      commit: {
        message: 'Merge branch develop into feature',
        committer: { email: 'noreply@github.com' },
        verification: { verified: true, reason: 'valid' },
      },
    },
    pullRequest,
  }), true);
  assert.equal(isEligibleBaseUpdateCommit({
    commit: {
      parents,
      committer: { login: 'web-flow' },
      commit: {
        message: 'Merge branch develop into feature',
        committer: { email: 'noreply@github.com' },
        verification: { verified: false, reason: 'unsigned' },
      },
    },
    pullRequest,
  }), false);
});

test('iOS lineage and lane reuse remain fail closed', () => {
  assert.equal(isReusableIosBaseLineage(undefined), true);
  assert.equal(isReusableIosBaseLineage({ files: [{ filename: 'server/routes/health.ts' }] }), true);
  assert.equal(isReusableIosBaseLineage({ files: [{ filename: 'ios/example-ios/App.swift' }] }), false);
  assert.equal(isReusableIosBaseLineage({}), false);

  assert.equal(isReusableIosLaneJob({
    name: 'Test - iOS execution (native3)',
    status: 'completed',
    conclusion: 'success',
  }), true);
  assert.equal(isReusableIosLaneJob({
    name: 'Test - iOS execution (native3)',
    status: 'completed',
    conclusion: 'failure',
  }), false);
  assert.equal(isReusableIosLaneJob({
    name: 'iOS Change Gate',
    status: 'completed',
    conclusion: 'success',
  }), false);
});

test('verified non-iOS base updates route their current patch even with an active iOS predecessor', async () => {
  const previousHead = sha('a');
  const base = sha('b');
  const head = sha('c');
  const oldBase = sha('d');
  const number = 6029;
  const repository = { full_name: 'example-org/example-app' };
  const pullRequest = {
    number,
    head: { sha: head, repo: repository },
    base: { sha: base, ref: 'develop', repo: repository },
  };
  const activeRun = {
    name: 'Test - iOS', id: 123, head_sha: previousHead,
    status: 'in_progress', created_at: '2026-09-23T01:00:00Z',
    pull_requests: [{ number, base: { ref: 'develop' } }],
  };
  const patchFor = (filename: string) => [replacement(filename, 1, 1)];

  for (const [path, shouldDefer] of [
    ['ci/workflows/pr-checks.ts', false],
    ['server/services/onboardingService.ts', false],
    ['ios/example-ios/App.swift', true],
  ] as const) {
    const patch = patchFor(path);
    const requested: string[] = [];
    const request = async (endpoint: string) => {
      requested.push(endpoint);
      if (endpoint === `commits/${head}`) return {
        sha: head, parents: [{ sha: previousHead }, { sha: base }],
        commit: { message: `chore: update PR #${number} from develop` },
      };
      if (endpoint === `commits/${previousHead}`) return { sha: previousHead, parents: [{ sha: oldBase }] };
      if (endpoint === `compare/${previousHead}...${head}`) {
        return { status: 'ahead', merge_base_commit: { sha: previousHead }, files: patch };
      }
      if (endpoint === `compare/${base}...${previousHead}`) {
        return { status: 'diverged', merge_base_commit: { sha: oldBase }, files: [] };
      }
      if (endpoint === `compare/${base}...${head}`) {
        return { status: 'ahead', merge_base_commit: { sha: base }, files: patch };
      }
      if (endpoint === `compare/${oldBase}...${previousHead}`) {
        return { status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch };
      }
      if (endpoint === `compare/${oldBase}...${base}`) {
        return { status: 'ahead', merge_base_commit: { sha: oldBase }, files: [] };
      }
      if (endpoint === `actions/runs?event=pull_request&head_sha=${previousHead}&per_page=100`) {
        return { workflow_runs: [activeRun] };
      }
      if (endpoint === `issues/${number}/timeline?per_page=100&page=1`) {
        // The shared reader type describes object endpoints; this endpoint is an array.
        return [] as unknown as GitHubJson;
      }
      if (endpoint === `pulls/${number}`) return { head: { sha: head } };
      throw new Error(`Unexpected request: ${endpoint}`);
    };
    const result = await main({
      event: { action: 'synchronize', before: previousHead, pull_request: pullRequest },
      token: 'test-token', workflows: ['Test - iOS'], request,
    });
    if (shouldDefer) {
      assert.deepEqual(result, {
        deferred: true, predecessorRunId: activeRun.id,
        predecessorRunIds: [activeRun.id], deferredBaseSha: base,
      });
    } else {
      assert.deepEqual(result, { priorHead: previousHead, changedFiles: [path] });
      assert.equal(requested.includes(`commits/${previousHead}`), false,
        'non-iOS patches do not inspect or wait on a predecessor chain');
    }
  }
});

test('incomplete effective patch cannot take the non-iOS fast path', async () => {
  const previousHead = sha('a');
  const base = sha('b');
  const head = sha('c');
  const oldBase = sha('d');
  const number = 6029;
  const repository = { full_name: 'example-org/example-app' };
  const request = async (endpoint: string) => {
    if (endpoint === `commits/${head}`) return {
      sha: head, parents: [{ sha: previousHead }, { sha: base }],
      commit: { message: `chore: update PR #${number} from develop` },
    };
    if (endpoint === `compare/${previousHead}...${head}`) {
      return { status: 'ahead', merge_base_commit: { sha: previousHead }, files: [replacement('ci/workflows/pr-checks.ts', 1, 1)] };
    }
    if (endpoint === `compare/${base}...${previousHead}`) {
      return { status: 'diverged', merge_base_commit: { sha: oldBase }, files: [] };
    }
    if (endpoint === `compare/${base}...${head}`) {
      return { status: 'ahead', merge_base_commit: { sha: base }, files: [{ filename: 'ci/workflows/pr-checks.ts' }] };
    }
    if (endpoint === `issues/${number}/timeline?per_page=100&page=1`) {
      return [] as unknown as GitHubJson;
    }
    if (endpoint === `actions/runs?event=pull_request&head_sha=${previousHead}&per_page=100`) {
      return { workflow_runs: [] };
    }
    throw new Error(`Unexpected request: ${endpoint}`);
  };
  assert.equal(await main({
    event: {
      action: 'synchronize', before: previousHead,
      pull_request: {
        number,
        head: { sha: head, repo: repository },
        base: { sha: base, ref: 'develop', repo: repository },
      },
    },
    token: 'test-token', workflows: ['Test - iOS'], request,
  }), null);
});

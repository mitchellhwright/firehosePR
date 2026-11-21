import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';
import type { TypedRequiredPrWorkflowConfig } from '../workflows/lib/model.ts';
import { ciEventFieldWith } from '../workflows/lib/ciEvent.ts';

// The required-workflow constructor must reject metadata edits at compile time.
// @ts-expect-error `edited` cannot produce a required PR check run.
const invalidRequiredEvents: TypedRequiredPrWorkflowConfig['on']['pull_request']['types'] = ['edited'];
void invalidRequiredEvents;

interface PullRequestRun {
  readonly pullRequest?: number;
  readonly ref: string;
  readonly headSha: string;
}

interface WorkflowDocument {
  readonly on?: { readonly pull_request?: { readonly types?: readonly string[] } };
  readonly concurrency?: {
    readonly group?: unknown;
    readonly 'cancel-in-progress'?: unknown;
  };
}

const document = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as WorkflowDocument;
const concurrency = document.concurrency;
assert.ok(concurrency, 'pr-checks.yml must declare workflow concurrency');
if (typeof concurrency.group !== 'string') {
  throw new TypeError('pr-checks.yml concurrency.group must be a string');
}

// A PR keeps its number; a merge queue candidate and any other event key on their ref.
const GROUP_OPERAND = `\${{ ${ciEventFieldWith('prNumber', {
  merge_group: 'github.ref', workflow_dispatch: 'github.ref',
}).expression} }}`;
const groupTemplate = concurrency.group;

function groupFor(run: PullRequestRun): string {
  assert.equal(
    groupTemplate,
    `pr-checks-${GROUP_OPERAND}`,
    'the PR Checks group must remain stable for one PR',
  );
  const identity = run.pullRequest ?? run.ref;
  return groupTemplate.replace(GROUP_OPERAND, String(identity));
}

test('a newer head supersedes an older PR Checks run for the same pull request', () => {
  const first = {
    pullRequest: 5850,
    ref: 'refs/pull/5850/merge',
    headSha: 'a'.repeat(40),
  };
  const second = { ...first, headSha: 'b'.repeat(40) };

  assert.notEqual(first.headSha, second.headSha, 'the fixture must model a new head commit');
  assert.equal(groupFor(first), groupFor(second));
  assert.equal(concurrency['cancel-in-progress'], true);
  assert.doesNotMatch(groupTemplate, /head\.sha|github\.sha/);
});

test('stable supersession remains isolated between pull requests and non-PR refs', () => {
  const headSha = 'c'.repeat(40);
  const firstPullRequest = groupFor({ pullRequest: 5850, ref: 'refs/pull/5850/merge', headSha });
  const otherPullRequest = groupFor({ pullRequest: 5851, ref: 'refs/pull/5851/merge', headSha });
  const develop = groupFor({ ref: 'refs/heads/develop', headSha });
  const main = groupFor({ ref: 'refs/heads/main', headSha });

  assert.notEqual(firstPullRequest, otherPullRequest);
  assert.notEqual(firstPullRequest, develop);
  assert.notEqual(develop, main);
});

test('each merge queue candidate has its own PR Checks group, apart from its pull request', () => {
  const headSha = 'd'.repeat(40);
  const queueRef = (sha: string) => `refs/heads/gh-readonly-queue/develop/pr-5850-${sha}`;
  const pullRequest = groupFor({ pullRequest: 5850, ref: 'refs/pull/5850/merge', headSha });
  const first = groupFor({ ref: queueRef('e'.repeat(40)), headSha });
  const rebuilt = groupFor({ ref: queueRef('f'.repeat(40)), headSha });
  assert.notEqual(first, pullRequest, 'a queue candidate must not cancel its own PR run');
  assert.notEqual(first, rebuilt, 'a rebuilt candidate is a different tuple');
});

test('metadata edits do not start required workflows or consume their concurrency slot', () => {
  assert.deepEqual(document.on?.pull_request?.types,
    ['opened', 'synchronize', 'reopened', 'ready_for_review']);
});

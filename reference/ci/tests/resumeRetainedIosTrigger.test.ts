import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';
import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';

/**
 * `Resume retained iOS run` starts only for a Test - iOS completion that can
 * resume something, decided from the workflow_run payload before any runner is
 * taken. These payloads mirror what GitHub sends: `pull_requests[0].head.sha`
 * is the pull request's head when the run completed, not the run's own head.
 */

const workflow = load(readFileSync(
  new URL('../../.github/workflows/refresh-pr-ci-after-base-edit.yml', import.meta.url), 'utf8',
)) as { readonly jobs: Readonly<Record<string, { readonly if?: string }>> };
const resumeJob = workflow.jobs['resume-retained-ios'];
if (resumeJob?.if === undefined) throw new Error('resume-retained-ios has no if condition');
const condition = resumeJob.if;

const PREDECESSOR_HEAD = '1'.repeat(40);
const DEFERRED_HEAD = '2'.repeat(40);

type Run = Readonly<Record<string, ExpressionValue>>;

/** A completed PR run whose PR head is `prHead` when the event is sent. */
function iosRun(overrides: Run & { readonly prHead?: string } = {}): Run {
  const { prHead = DEFERRED_HEAD, ...fields } = overrides;
  return {
    name: 'Test - iOS',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'failure',
    head_branch: 'codex/feature',
    head_sha: DEFERRED_HEAD,
    head_commit: {
      id: DEFERRED_HEAD,
      message: "Merge branch 'develop' into codex/feature",
      committer: { name: 'GitHub', email: 'noreply@github.com' },
    },
    pull_requests: [{ number: 42, head: { sha: prHead } }],
    ...fields,
  };
}

const fires = (run: Run, eventName = 'workflow_run'): boolean => Boolean(evaluateExpression(
  condition, { github: { event_name: eventName, event: { workflow_run: run } } },
));

test('a deferred run finishing after its predecessor resumes itself', () => {
  assert.equal(fires(iosRun()), true);
  // The controller's own base-update commit is the other head the classifier defers.
  assert.equal(fires(iosRun({
    head_commit: {
      id: DEFERRED_HEAD, message: 'chore: update PR #42 from develop',
      committer: { name: 'example-ci[bot]', email: '1+example-ci[bot]@users.noreply.github.com' },
    },
  })), true);
});

test('a retained predecessor finishing after the head moved resumes the deferred run', () => {
  for (const conclusion of ['success', 'failure', 'timed_out']) {
    assert.equal(fires(iosRun({ head_sha: PREDECESSOR_HEAD, conclusion, prHead: DEFERRED_HEAD })), true, conclusion);
  }
});

test('the ordinary completions that can resume nothing never start the job', () => {
  // A passing run for the current head: nothing was deferred.
  assert.equal(fires(iosRun({ conclusion: 'success' })), false);
  // A failing run for a head that is not a base-update commit: the classifier never defers those.
  assert.equal(fires(iosRun({
    head_commit: {
      id: DEFERRED_HEAD, message: 'fix: a real change',
      committer: { name: 'Dev', email: 'dev@example.com' },
    },
  })), false);
  // A run for a superseded head that obsolete-run cancellation stopped.
  assert.equal(fires(iosRun({ head_sha: PREDECESSOR_HEAD, conclusion: 'cancelled' })), false);
  assert.equal(fires(iosRun({ head_sha: PREDECESSOR_HEAD, conclusion: 'skipped' })), false);
  // No pull request on the run: the resume controller could not act on it.
  assert.equal(fires(iosRun({ pull_requests: [] })), false);
  assert.equal(fires(iosRun({ event: 'merge_group' })), false);
  assert.equal(fires(iosRun({ name: 'PR Checks' })), false);
  assert.equal(fires(iosRun(), 'push'), false);
});

test('a successful Dependabot run still starts the job for its auto-merge step', () => {
  const dependabot = { head_branch: 'dependabot/npm_and_yarn/zod-4.6.6', conclusion: 'success' };
  assert.equal(fires(iosRun({ ...dependabot, pull_requests: [] })), true);
  assert.equal(fires(iosRun({ ...dependabot, conclusion: 'cancelled' })), false);
});

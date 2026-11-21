import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';
import { main as cancelIosRuns, type GithubObject } from '../src/actions/cancelObsoleteIosRuns.ts';
import { resolveFanOutChange } from '../src/fanOutEvent.ts';
import { recoverRetargetedPullRequest } from '../src/retargetRecovery.ts';

/**
 * GitHub keeps one pending run per concurrency group and replaces it with the
 * next one. These tests evaluate the generated refresh-controller group for
 * each event it subscribes to, so a regrouping that lets one event replace
 * another it must not replace fails here.
 */

const document = load(readFileSync('.github/workflows/refresh-pr-ci-after-base-edit.yml', 'utf8')) as {
  concurrency?: { group?: unknown; 'cancel-in-progress'?: unknown };
};
const template = document.concurrency?.group;
if (typeof template !== 'string') throw new TypeError('refresh-pr-ci-after-base-edit.yml must declare a concurrency group');
const templateMatch = /^review-controller-\$\{\{ (.+) \}\}$/.exec(template);
if (templateMatch?.[1] === undefined) throw new Error(`Unexpected concurrency group template: ${template}`);
const groupExpression = templateMatch[1];

type Value = string | number | boolean | null | { readonly [key: string]: Value } | readonly Value[];

/** The subset of GitHub's expression language this one group uses. */
function evaluate(expression: string, context: { readonly github: Value }): Value {
  const tokens = expression.match(/'(?:[^']|'')*'|\d+|&&|\|\||==|!=|[()[\],!]|\.?[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*/g) ?? [];
  let position = 0;
  const peek = (): string | undefined => tokens[position];
  const take = (expected?: string): string => {
    const token = tokens[position];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`Expected ${expected ?? 'a token'} at ${position} in ${expression}`);
    }
    position += 1;
    return token;
  };
  const truthy = (value: Value): boolean => value !== null && value !== false && value !== 0 && value !== '';
  const member = (value: Value, key: string | number): Value => {
    if (value === null || typeof value !== 'object') return null;
    const next = Array.isArray(value) ? value[Number(key)] : (value as { readonly [key: string]: Value })[key];
    return next ?? null;
  };
  const path = (base: Value, dotted: string): Value =>
    dotted.split('.').filter(Boolean).reduce<Value>((value, key) => member(value, key), base);

  function primary(): Value {
    const token = take();
    if (token === '!') return !truthy(primary());
    if (token === '(') {
      const value = or();
      take(')');
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (/^\d+$/.test(token)) return Number(token);
    if (token === 'null') return null;
    if (token === 'format') {
      take('(');
      const args: Value[] = [or()];
      while (peek() === ',') {
        take(',');
        args.push(or());
      }
      take(')');
      const [pattern, ...values] = args;
      return String(pattern).replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ''));
    }
    let value = path(context, token);
    for (let next = peek(); next === '[' || next?.startsWith('.'); next = peek()) {
      if (take() === '[') {
        value = member(value, Number(take()));
        take(']');
      } else {
        value = path(value, tokens[position - 1] ?? '');
      }
    }
    return value;
  }
  function comparison(): Value {
    const left = primary();
    const operator = peek();
    if (operator !== '==' && operator !== '!=') return left;
    take();
    const equal = left === primary();
    return operator === '==' ? equal : !equal;
  }
  function and(): Value {
    let value = comparison();
    while (peek() === '&&') {
      take();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  }
  function or(): Value {
    let value = and();
    while (peek() === '||') {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  }
  const result = or();
  if (position !== tokens.length) throw new Error(`Unparsed input after ${position} in ${expression}`);
  return result;
}

let runId = 1000;
function groupFor(github: { readonly [key: string]: Value }): string {
  runId += 1;
  const group = evaluate(groupExpression, { github: { run_id: runId, ...github } });
  assert.equal(typeof group, 'string');
  return `review-controller-${String(group)}`;
}

const repository = 'example-org/example-app';
const sha = (fill: string): string => fill.repeat(40);

function pullRequestTarget(action: string, number: number, headSha: string, changes: Value = null): string {
  return groupFor({
    event_name: 'pull_request_target',
    event: {
      action,
      changes,
      pull_request: { number, draft: false, head: { sha: headSha, repo: { full_name: repository } } },
    },
  });
}

test('synchronizes of one pull request share a group so a newer head replaces the pending one', () => {
  assert.equal(document.concurrency?.['cancel-in-progress'], false);
  const first = pullRequestTarget('synchronize', 42, sha('a'));
  assert.equal(first, 'review-controller-pr-synchronize-42');
  assert.equal(pullRequestTarget('synchronize', 42, sha('b')), first);
  assert.notEqual(pullRequestTarget('synchronize', 43, sha('b')), first);
});

test('only the cumulative fan-out may run behind a replaceable synchronize group', () => {
  // A replaced synchronize never runs, so its before..after must not be the
  // only record of the commits it carried.
  const change = resolveFanOutChange('pull_request_target', {
    action: 'synchronize',
    before: sha('a'),
    after: sha('b'),
    pull_request: { number: 42, draft: false, head: { ref: 'codex/parent', sha: sha('b'), repo: { full_name: repository } } },
  }, repository);
  assert.equal(change.reconciliation, 'pending-base');
});

test('metadata edits never share a group, so they cannot replace a pending event', () => {
  const titleEdit = pullRequestTarget('edited', 42, sha('a'), { title: { from: 'old' } });
  const bodyEdit = pullRequestTarget('edited', 42, sha('a'), { body: { from: 'old' } });
  assert.match(titleEdit, /^review-controller-continuity-\d+$/);
  assert.match(bodyEdit, /^review-controller-continuity-\d+$/);
  assert.notEqual(titleEdit, bodyEdit);
});

test('each decisive pull-request event class has its own per-PR group', () => {
  const synchronize = pullRequestTarget('synchronize', 42, sha('a'));
  const retarget = pullRequestTarget('edited', 42, sha('a'), { base: { ref: { from: 'develop' } } });
  const ready = pullRequestTarget('ready_for_review', 42, sha('a'));
  assert.equal(retarget, 'review-controller-pr-retarget-42');
  assert.equal(ready, 'review-controller-pr-ready-42');
  // A ready-for-review can never replace a pending retarget, nor either of
  // them a pending synchronize, and the reverse.
  assert.equal(new Set([synchronize, retarget, ready]).size, 3);
  // Different heads of one PR keep the class group, so a retarget queued
  // before a push is not split from a retarget queued after it.
  assert.equal(pullRequestTarget('edited', 42, sha('b'), { base: { ref: { from: 'main' } } }), retarget);
  assert.notEqual(pullRequestTarget('edited', 43, sha('a'), { base: { ref: { from: 'develop' } } }), retarget);
  assert.equal(pullRequestTarget('ready_for_review', 42, sha('b')), ready);
});

const repo = { full_name: repository };
const retargetHead = sha('a');
const developTip = sha('d');
const mainTip = sha('e');
const retargetedPull = (baseRef: string, baseSha: string) => ({
  user: { login: 'author' },
  number: 42,
  state: 'open',
  draft: false,
  merge_commit_sha: sha('f'),
  head: { sha: retargetHead, ref: 'feature', repo },
  base: { sha: baseSha, ref: baseRef, repo },
});
const retargetEvent = (baseRef: string, baseSha: string, from: string) => ({
  action: 'edited',
  repository: repo,
  pull_request: retargetedPull(baseRef, baseSha),
  changes: { base: { ref: { from } } },
});

test('of two rapid retargets, only the newer can act, so replacing the older loses nothing', async () => {
  // stack-parent -> main, then main -> develop, before either controller ran.
  const older = retargetEvent('main', mainTip, 'stack-parent');
  const newer = retargetEvent('develop', developTip, 'main');
  const live = retargetedPull('develop', developTip);
  assert.equal(pullRequestTarget('edited', 42, retargetHead, older.changes),
    pullRequestTarget('edited', 42, retargetHead, newer.changes));

  const recover = async (event: unknown) => {
    const updated: string[] = [];
    const outcome = await recoverRetargetedPullRequest(event, {
      read: async (path) => {
        if (path === 'pulls/42') return { status: 200, body: live };
        throw new Error(`Unexpected read ${path}`);
      },
      update: async (input, stillCurrent) => {
        if (!await stillCurrent()) return { kind: 'superseded' };
        updated.push(input.baseRef);
        return { kind: 'updating' };
      },
    });
    return { outcome: outcome.kind, updated };
  };
  assert.deepEqual(await recover(older), { outcome: 'superseded', updated: [] });
  assert.deepEqual(await recover(newer), { outcome: 'updating', updated: ['develop'] });

  // Active iOS work from both earlier bases is released by the newer event alone.
  const createdAt = '2026-09-22T12:00:00Z';
  const workflowRuns = [
    { id: 1, name: 'Test - iOS', head_sha: retargetHead, status: 'in_progress', created_at: createdAt, pull_requests: [{ number: 42, base: { ref: 'stack-parent' } }] },
    { id: 2, name: 'Test - iOS', head_sha: retargetHead, status: 'queued', created_at: createdAt, pull_requests: [{ number: 42, base: { ref: 'main' } }] },
    { id: 3, name: 'Test - iOS', head_sha: retargetHead, status: 'in_progress', created_at: createdAt, pull_requests: [{ number: 42, base: { ref: 'develop' } }] },
  ];
  const runs = { total_count: workflowRuns.length, workflow_runs: workflowRuns };
  const asGithubObject = (value: unknown): GithubObject => value as GithubObject;
  const cancel = async (event: unknown) => {
    const cancelled: string[] = [];
    await cancelIosRuns({
      event: asGithubObject(event),
      repository,
      request: async (path, options) => {
        if (options?.method === 'POST') {
          cancelled.push(path);
          return asGithubObject({});
        }
        if (path === 'pulls/42') return asGithubObject(live);
        if (path.startsWith('actions/workflows/ios-tests.yml/runs')) return asGithubObject(runs);
        throw new Error(`Unexpected request ${path}`);
      },
    });
    return cancelled;
  };
  // The stale event would treat the current develop run as "prior base"; its
  // live-tuple check stops it before any cancellation.
  assert.deepEqual(await cancel(older), []);
  assert.deepEqual(await cancel(newer), ['actions/runs/1/cancel', 'actions/runs/2/cancel']);
});

test('a ready-for-review cannot stand in for a pending retarget, which keeps its own group', async () => {
  // If ready-for-review had replaced the retarget, prior-base iOS work would
  // keep running: the ready event carries no base change to cancel from.
  const ready = { ...retargetEvent('develop', developTip, 'main'), action: 'ready_for_review', changes: undefined };
  assert.deepEqual((await cancelIosRuns({
    event: ready as unknown as GithubObject,
    repository,
    request: async (path) => {
      throw new Error(`A ready event must not read ${path}`);
    },
  })).cancelled, []);
  assert.notEqual(
    pullRequestTarget('ready_for_review', 42, retargetHead),
    pullRequestTarget('edited', 42, retargetHead, { base: { ref: { from: 'main' } } }),
  );
});

test('protected-base pushes and iOS completions keep immutable groups', () => {
  const push = (after: string) => groupFor({ event_name: 'push', sha: after, event: {} });
  assert.equal(push(sha('c')), `review-controller-base-update-fanout-${sha('c')}`);
  assert.notEqual(push(sha('d')), push(sha('c')));
  assert.equal(resolveFanOutChange('push', {
    ref: 'refs/heads/develop', before: sha('c'), after: sha('d'), repository: { full_name: repository },
  }, repository).reconciliation, 'event-range');

  const completion = (id: number) => groupFor({
    event_name: 'workflow_run',
    event: {
      workflow_run: {
        id,
        name: 'Test - iOS',
        pull_requests: [{ url: 'https://api.github.com/repos/example-org/example-app/pulls/42' }],
      },
    },
  });
  assert.equal(completion(7), 'review-controller-retained-ios-https://api.github.com/repos/example-org/example-app/pulls/42-7');
  assert.notEqual(completion(8), completion(7));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverRetargetedPullRequest, type RetargetEvent, type RetargetPort } from '../src/retargetRecovery.ts';

const head = 'a'.repeat(40), base = 'b'.repeat(40), oldBase = 'c'.repeat(40), merge = 'd'.repeat(40);
const repo = { full_name: 'example-org/example-app' };
const pull = { user: { login: 'author' }, number: 123, merge_commit_sha: merge, head: { sha: head, ref: 'feature', repo }, base: { sha: base, ref: 'develop', repo } };
const event: RetargetEvent = { action: 'edited', repository: repo, pull_request: pull, changes: { base: { ref: { from: 'stack-parent' } } } };
function fixture(overrides: {
  event?: RetargetEvent; live?: object; fresh?: object; parents?: string[]; behind?: number;
} = {}) {
  const calls: string[] = [];
  let reads = 0;
  const expected = (overrides.event ?? event).pull_request;
  const live = { ...expected, state: 'open', merge_commit_sha: merge, ...overrides.live };
  const port: RetargetPort = {
    read: async (path) => {
      calls.push(path);
      if (path === 'pulls/123') return { status: 200, body: reads++ === 0 ? live : { ...live, ...overrides.fresh } };
      if (path === `git/commits/${merge}`) return { status: 200, body: { parents: (overrides.parents ?? [oldBase, head]).map((sha) => ({ sha })) } };
      if (path === `compare/${base}...${head}`) return { status: 200, body: { behind_by: overrides.behind ?? 1 } };
      throw new Error(`Unexpected request ${path}`);
    },
    update: async (input, stillCurrent) => {
      assert.deepEqual(input, {
        number: 123, headSha: expected.head.sha, headRef: expected.head.ref,
        baseSha: expected.base.sha, baseRef: expected.base.ref,
      });
      if (!await stillCurrent()) return { kind: 'superseded' };
      calls.push('update');
      return { kind: 'updating' };
    },
  };
  return { calls, run: () => recoverRetargetedPullRequest(overrides.event ?? event, port) };
}
test('a real retarget asks native GitHub to update the exact head after rechecking its tuple', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { kind: 'updating', number: 123 });
  assert.deepEqual(f.calls, ['pulls/123', 'pulls/123', 'update']);
});
test('ready_for_review repairs the observed cached old-base merge, not every behind PR', async () => {
  const ready = { ...event, action: 'ready_for_review', changes: undefined };
  const stale = fixture({ event: ready });
  assert.equal((await stale.run()).kind, 'updating');
  const coherent = fixture({ event: ready, parents: [base, head] });
  assert.equal((await coherent.run()).kind, 'candidate-current');
  assert.equal(coherent.calls.length, 2);
});
test('a base retarget publishes a new head even when the branch contains the new base', async () => {
  const f = fixture({ behind: 0 });
  assert.equal((await f.run()).kind, 'updating');
  assert.ok(f.calls.includes('update'));
});
for (const mutation of [
  { head: { sha: oldBase, ref: 'feature', repo } }, { base: { sha: oldBase, ref: 'develop', repo } },
  { base: { sha: base, ref: 'main', repo } }, { state: 'closed' },
]) {
  test(`tuple movement ${JSON.stringify(mutation)} never updates a stale event`, async () => {
    for (const stage of ['live', 'fresh'] as const) {
      const f = fixture({ [stage]: mutation });
      assert.equal((await f.run()).kind, 'superseded');
      assert.ok(!f.calls.includes('update'));
    }
  });
}
for (const ignored of [
  { ...event, action: 'synchronize' }, { ...event, changes: undefined },
  { ...event, pull_request: { ...pull, head: { ...pull.head, repo: { full_name: 'fork/repo' } } } },
]) {
  test(`ignore non-retarget or ineligible events (${JSON.stringify(ignored)})`, async () => {
    const f = fixture({ event: ignored });
    assert.equal((await f.run()).kind, 'ignored'); assert.deepEqual(f.calls, []);
  });
}
test('draft retargets are repaired without changing draft or review state', async () => {
  const f = fixture({ live: { draft: true } });
  assert.equal((await f.run()).kind, 'updating');
  assert.equal(f.calls.filter((call) => call === 'update').length, 1);
});
test('an unavailable or unrelated merge candidate never proves ready-event recovery', async () => {
  const ready = { ...event, action: 'ready_for_review' };
  for (const f of [fixture({ event: { ...ready, pull_request: { ...pull, merge_commit_sha: null } } }), fixture({ event: ready, parents: [oldBase, base] })]) {
    assert.equal((await f.run()).kind, 'candidate-unavailable'); assert.ok(!f.calls.includes('update'));
  }
});
test('malformed events and comparisons cannot request updates', async () => {
  await assert.rejects(fixture({ event: { ...event, action: 'ready_for_review' }, behind: -1 }).run());
  const f = fixture({ event: { ...event, pull_request: { ...pull, head: { ...pull.head, sha: 'short' } } } });
  await assert.rejects(f.run()); assert.deepEqual(f.calls, []);
});

test('Dependabot owns routine rebases, but an explicit base retarget is validated', async () => {
  const bot = { ...pull, user: { login: 'dependabot[bot]' } };
  const retarget = fixture({ event: { ...event, pull_request: bot } });
  assert.equal((await retarget.run()).kind, 'updating');
  const ready = fixture({ event: { ...event, action: 'ready_for_review', pull_request: bot } });
  assert.equal((await ready.run()).kind, 'ignored');
});

 test('ready recovery uses its immutable event candidate even if the live merge cache refreshed', async () => {
  const f = fixture({ event: { ...event, action: 'ready_for_review' }, live: { merge_commit_sha: 'e'.repeat(40) } });
  assert.equal((await f.run()).kind, 'updating');
  assert.ok(f.calls.includes(`git/commits/${merge}`));
});
test('an explicitly retargeted promotion checkpoint receives a fresh integration head', async () => {
  const f = fixture({ event: { ...event, pull_request: {
    ...pull, head: { ...pull.head, ref: `promotion/develop-${head}` },
    base: { ...pull.base, ref: 'main' },
  } } });
  assert.equal((await f.run()).kind, 'updating');
  assert.ok(f.calls.includes('update'));
});
test('ready events do not rewrite immutable promotion checkpoints', async () => {
  const f = fixture({ event: { ...event, action: 'ready_for_review', pull_request: {
    ...pull, head: { ...pull.head, ref: `promotion/develop-${head}` },
  } } });
  assert.equal((await f.run()).kind, 'ignored');
});
test('non-merge candidates do not prove a cached integration mismatch', async () => {
  const f = fixture({ event: { ...event, action: 'ready_for_review' }, parents: [head] });
  assert.equal((await f.run()).kind, 'candidate-unavailable');
  assert.ok(!f.calls.includes('update'));
});

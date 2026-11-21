import assert from 'node:assert/strict';
import test from 'node:test';
import { publishPinnedBaseUpdate, type NativeResponse, type PinnedBasePort } from '../src/pinnedBaseUpdate.ts';

const head = 'a'.repeat(40), base = 'b'.repeat(40), candidate = 'c'.repeat(40);
const tree = 'd'.repeat(40), created = 'e'.repeat(40), other = 'f'.repeat(40);
const input = { number: 123, headSha: head, baseSha: base, headRef: 'feature', baseRef: 'develop' };
function fixture(options: {
  candidates?: readonly (readonly string[] | null)[];
  current?: readonly boolean[];
  create?: NativeResponse; publish?: NativeResponse;
  refStatus?: number; refSha?: string; readStatus?: number;
} = {}) {
  const calls: string[] = [];
  let attempt = 0, check = 0;
  const candidates = options.candidates ?? [[base, head]];
  const current = options.current ?? [true];
  const port: PinnedBasePort = {
    read: async path => {
      calls.push(path);
      if (path === 'git/ref/pull/123/merge') {
        const parents = candidates[Math.min(attempt++, candidates.length - 1)];
        return parents === null ? { status: 404, body: {} }
          : { status: options.readStatus ?? 200, body: { object: { sha: candidate } } };
      }
      if (path === `git/commits/${candidate}`) return { status: 200, body: {
        sha: candidate, tree: { sha: tree },
        parents: candidates[Math.min(attempt - 1, candidates.length - 1)]?.map(sha => ({ sha })),
      } };
      if (path === 'git/ref/heads/feature') return { status: options.refStatus ?? 200,
        body: { object: { sha: options.refSha ?? head } } };
      throw new Error(`Unexpected path ${path}`);
    },
    createCommit: async value => {
      calls.push('create');
      assert.deepEqual(value, { message: 'chore: update PR #123 from develop', tree, parents: [head, base] });
      return options.create ?? { status: 201, body: { sha: created, tree: { sha: tree }, parents: [{ sha: head }, { sha: base }] } };
    },
    publish: async value => {
      calls.push('publish');
      assert.deepEqual(value, { name: 'refs/heads/feature', beforeOid: head, afterOid: created, force: false });
      return options.publish ?? { status: 200, body: { data: { updateRefs: { clientMutationId: null } } } };
    },
    wait: async () => { calls.push('wait'); },
  };
  return { calls, port, run: () => publishPinnedBaseUpdate(input, port, async () => {
    calls.push('current'); return current[Math.min(check++, current.length - 1)] ?? false;
  }) };
}
test('publishes only the verified candidate tree with head-first parents and native CAS', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { kind: 'updating' });
  assert.deepEqual(f.calls, ['current', 'git/ref/pull/123/merge', `git/commits/${candidate}`,
    'current', 'create', 'current', 'publish']);
});
test('missing or stale cached candidates are bounded and cannot mutate any ref', async () => {
  for (const parents of [null, [other, head], [base, other], [head]]) {
    const f = fixture({ candidates: [parents] });
    assert.equal((await f.run()).kind, 'candidate-unavailable');
    assert.equal(f.calls.filter(call => call === 'wait').length, 5);
    assert.ok(!f.calls.includes('create')); assert.ok(!f.calls.includes('publish'));
  }
});
test('asynchronous candidate refresh is retried without changing source revisions', async () => {
  const f = fixture({ candidates: [[other, head], null, [base, head]] });
  assert.equal((await f.run()).kind, 'updating');
  assert.equal(f.calls.filter(call => call === 'wait').length, 2);
  assert.equal(f.calls.filter(call => call === 'publish').length, 1);
});
for (const current of [[false], [true, false], [true, true, false]]) {
  test(`tuple movement before publication leaves the branch unchanged (${current})`, async () => {
    const f = fixture({ current });
    assert.equal((await f.run()).kind, 'superseded');
    assert.ok(!f.calls.includes('publish'));
  });
}
test('a retarget after the final read cannot substitute the new base into the published commit', async () => {
  const f = fixture();
  // No API below resolves a PR target at mutation time. Both immutable merge
  // inputs and the exact expected destination head are assertions in the port.
  assert.equal((await f.run()).kind, 'updating');
});
test('a concurrent head push is rejected by CAS and classified from actual head movement', async () => {
  const f = fixture({ publish: { status: 200, body: { errors: [{ message: 'beforeOid mismatch' }] } }, refSha: other });
  assert.equal((await f.run()).kind, 'superseded');
});
test('permissions failures remain errors even if PR metadata moved but its head did not', async () => {
  const f = fixture({ publish: { status: 200, body: { errors: [{ message: 'Resource not accessible' }] } }, current: [true, true, true, false] });
  await assert.rejects(f.run(), /Atomic branch update failed/);
});
test('malformed or different merge products cannot be published', async () => {
  for (const body of [{}, { sha: created, tree: { sha: other }, parents: [{ sha: head }, { sha: base }] },
    { sha: created, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] }]) {
    const f = fixture({ create: { status: 201, body } });
    await assert.rejects(f.run()); assert.ok(!f.calls.includes('publish'));
  }
});
test('authentication failures are not retried as stale candidates', async () => {
  const f = fixture({ readStatus: 403 });
  await assert.rejects(f.run(), /HTTP 403/); assert.ok(!f.calls.includes('wait'));
});
test('protected targets cannot be the branch updated by PR recovery', async () => {
  const f = fixture();
  for (const headRef of ['main', 'develop']) {
    await assert.rejects(publishPinnedBaseUpdate({ ...input, headRef }, f.port, async () => true), /protected target/);
  }
  assert.deepEqual(f.calls, []);
});

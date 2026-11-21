import assert from 'node:assert/strict';
import test from 'node:test';
import {
  retiredWorkflowPaths, selectPullRequestsToUpdate, type OpenPullRequest,
} from '../src/baseUpdateFanout.ts';
import {
  admitChildUpdate, candidateBaseRange, resolveFanOutChange, staleChildReason, staleSourceReason,
  type FanOutRange, type PendingBaseChange,
} from '../src/fanOutEvent.ts';
import { CommitGraph } from './fixtures/commitGraph.ts';

const repository = 'example-org/example-app';
const oldHead = 'e90146de6a0ff25206a8ffdcebf43f40f199694c';
const newHead = '434544bd403638864b204af9a9706aaca6c7972e';

test('same-repository synchronize fans out the exact stacked base movement', () => {
  const event = {
    action: 'synchronize',
    before: oldHead,
    after: newHead,
    pull_request: {
      number: 6061,
      draft: false,
      head: {
        ref: 'codex/retire-legacy-ci-entrypoints',
        sha: newHead,
        repo: { full_name: repository },
      },
    },
  };
  assert.deepEqual(resolveFanOutChange('pull_request_target', event, repository), {
    baseBranch: 'codex/retire-legacy-ci-entrypoints',
    before: oldHead,
    after: newHead,
    reconciliation: 'pending-base',
    sourcePullRequest: 6061,
  });
  assert.throws(
    () => resolveFanOutChange('pull_request_target', {
      ...event,
      pull_request: { ...event.pull_request, head: { ...event.pull_request.head, repo: { full_name: 'other/fork' } } },
    }, repository),
    /head repository/,
  );
  assert.throws(
    () => resolveFanOutChange('pull_request_target', { ...event, after: oldHead }, repository),
    /does not match event after SHA/,
  );
});
test('protected-base push still uses its branch and exact before and after SHAs', () => {
  assert.deepEqual(resolveFanOutChange('push', {
    ref: 'refs/heads/develop',
    before: oldHead,
    after: newHead,
    repository: { full_name: repository },
  }, repository), {
    baseBranch: 'develop',
    before: oldHead,
    after: newHead,
    reconciliation: 'event-range',
  });
});


const stackedBase = 'codex/stacked-parent';
const sourcePullRequest = 6100;

function synchronize(before: string, after: string): PendingBaseChange {
  const change = resolveFanOutChange('pull_request_target', {
    action: 'synchronize',
    before,
    after,
    pull_request: {
      number: sourcePullRequest,
      head: { ref: stackedBase, sha: after, repo: { full_name: repository } },
    },
  }, repository);
  assert.equal(change.reconciliation, 'pending-base');
  if (change.reconciliation !== 'pending-base') throw new Error('unreachable');
  return change;
}

function child(headSha: string, files: string[]): OpenPullRequest {
  return {
    number: 7001,
    draft: false,
    authorLogin: 'example-user',
    headRepositoryFullName: repository,
    headSha,
    files,
  };
}

/**
 * The parent head moved A -> B (touching shared.ts) and then B -> C (touching
 * other.ts). The child forked from A and edits shared.ts. With synchronize
 * runs coalesced per pull request, the pending A -> B run is replaced and only
 * B -> C runs.
 */
function lostDeltaGraph() {
  const graph = new CommitGraph();
  const root = graph.commit('root', [], { 'shared.ts': '0', 'other.ts': '0', 'early.ts': '0' });
  const a = graph.commit('A', [root], { 'shared.ts': '0', 'other.ts': '0', 'early.ts': 'a' });
  const b = graph.commit('B', [a], { 'shared.ts': 'b', 'other.ts': '0', 'early.ts': 'a' });
  const c = graph.commit('C', [b], { 'shared.ts': 'b', 'other.ts': 'c', 'early.ts': 'a' });
  const childHead = graph.commit('child', [a], { 'shared.ts': 'child', 'other.ts': '0', 'early.ts': 'a' });
  return { graph, root, a, b, c, childHead };
}

test('a replaced synchronize cannot hide its change: the child is judged from its merge base', async () => {
  const { graph, a, b, c, childHead } = lostDeltaGraph();
  const change = synchronize(b, c);
  const pull = child(childHead, ['shared.ts']);

  // The per-event range this controller used to read misses A..B entirely.
  const eventFiles = graph.changedFiles({ before: change.before, after: change.after });
  assert.deepEqual(eventFiles, ['other.ts']);
  assert.deepEqual(selectPullRequestsToUpdate(repository, change.baseBranch, eventFiles, [pull]), []);

  const range = await candidateBaseRange(change, childHead, graph.compare);
  assert.deepEqual(range, { before: a, after: c });
  assert.ok(range);
  const pendingFiles = graph.changedFiles(range);
  assert.deepEqual(pendingFiles, ['other.ts', 'shared.ts']);
  assert.deepEqual(selectPullRequestsToUpdate(repository, change.baseBranch, pendingFiles, [pull]), [{
    number: 7001,
    headSha: childHead,
    overlap: ['shared.ts'],
  }]);
});

test('a workflow retired by the replaced synchronize is still inside the child range', async () => {
  const graph = new CommitGraph();
  const workflow = '.github/workflows/retired.yml';
  const a = graph.commit('A', [], { [workflow]: 'on: push', 'app.ts': '0' });
  const b = graph.commit('B', [a], { 'app.ts': '0' });
  const c = graph.commit('C', [b], { 'app.ts': 'c' });
  const childHead = graph.commit('child', [a], { [workflow]: 'on: push', 'app.ts': '0', 'child.ts': '1' });
  const retiredIn = ({ before, after }: FanOutRange): string[] => {
    const remaining = new Set(Object.keys(graph.tree(after)));
    return retiredWorkflowPaths(Object.keys(graph.tree(before)).filter((path) => !remaining.has(path)));
  };

  assert.deepEqual(retiredIn({ before: b, after: c }), []);
  const range = await candidateBaseRange(synchronize(b, c), childHead, graph.compare);
  assert.ok(range);
  assert.deepEqual(retiredIn(range), [workflow]);
});

test('retries and late runs re-derive the same range', async () => {
  const { graph, a, b, c, childHead } = lostDeltaGraph();
  // A crash before any update, a manual re-run, and a concurrent run for the
  // same head all read the same child and reach one range.
  const first = await candidateBaseRange(synchronize(b, c), childHead, graph.compare);
  const retried = await candidateBaseRange(synchronize(b, c), childHead, graph.compare);
  const late = await candidateBaseRange(synchronize(a, b), childHead, graph.compare);
  assert.deepEqual(first, { before: a, after: c });
  assert.deepEqual(retried, first);
  assert.deepEqual(late, { before: a, after: b });
});

test('a child that already contains the new head has nothing to merge', async () => {
  const { graph, b, c } = lostDeltaGraph();
  const updatedChild = graph.commit('updated child', [c], { 'shared.ts': 'b', 'other.ts': 'c', 'early.ts': 'a' });
  assert.equal(await candidateBaseRange(synchronize(b, c), updatedChild, graph.compare), null);
  assert.equal(await candidateBaseRange(synchronize(b, c), c, graph.compare), null);
});

test('a force-pushed parent is judged from the newest commit the child still shares', async () => {
  const { graph, root, a, childHead } = lostDeltaGraph();
  // The parent is rewritten onto root; the event's before (a) is no longer in its history.
  const rewritten = graph.commit('rewritten', [root], { 'shared.ts': 'rewritten', 'other.ts': '0', 'early.ts': '0' });
  const range = await candidateBaseRange(synchronize(a, rewritten), childHead, graph.compare);
  assert.deepEqual(range, { before: root, after: rewritten });
  assert.ok(range);
  assert.deepEqual(graph.changedFiles(range), ['shared.ts']);
});

test('an unrelated child history or an inconsistent comparison fails closed', async () => {
  const { graph, b, c } = lostDeltaGraph();
  const orphan = graph.commit('orphan', [], { 'shared.ts': 'x' });
  await assert.rejects(candidateBaseRange(synchronize(b, c), orphan, graph.compare), /No common ancestor/);
  await assert.rejects(
    candidateBaseRange(synchronize(b, c), orphan, async () => ({
      status: 'diverged', ahead_by: 2, merge_base_commit: { sha: c },
    })),
    /reports .* as the merge base/,
  );
  await assert.rejects(
    candidateBaseRange(synchronize(b, c), orphan, async () => ({ status: 'ahead', ahead_by: 2 })),
    /merge_base_commit/,
  );
});

test('a protected-base push keeps its exact event range and reads no comparison', async () => {
  const change = resolveFanOutChange('push', {
    ref: 'refs/heads/develop',
    before: oldHead,
    after: newHead,
    repository: { full_name: repository },
  }, repository);
  const range = await candidateBaseRange(change, 'f'.repeat(40), async () => {
    throw new Error('A push must not compare each candidate');
  });
  assert.deepEqual(range, { before: oldHead, after: newHead });
});

test('an obsolete, closed, retargeted or deleted source never fans out', () => {
  const change = synchronize(oldHead, newHead);
  const live = (overrides: { state?: string; sha?: string; ref?: string; repo?: string | null } = {}) => ({
    state: overrides.state ?? 'open',
    head: {
      sha: overrides.sha ?? newHead,
      ref: overrides.ref ?? stackedBase,
      repo: overrides.repo === null ? null : { full_name: overrides.repo ?? repository },
    },
  });
  assert.equal(staleSourceReason(change, repository, live(), newHead), null);
  assert.match(staleSourceReason(change, repository, live({ sha: oldHead }), newHead) ?? '', /moved to e901/);
  assert.match(staleSourceReason(change, repository, live(), oldHead) ?? '', /branch codex\/stacked-parent moved/);
  assert.match(staleSourceReason(change, repository, live(), null) ?? '', /was deleted/);
  assert.match(staleSourceReason(change, repository, live({ state: 'closed' }), newHead) ?? '', /is closed/);
  assert.match(staleSourceReason(change, repository, live({ repo: null }), newHead) ?? '', /no longer heads/);
  assert.match(staleSourceReason(change, repository, live({ ref: 'other' }), newHead) ?? '', /no longer heads/);
  assert.throws(() => staleSourceReason(change, repository, { state: 'open' }, newHead));
});

test('a child retargeted, pushed or closed since it was judged is not updated', () => {
  const live = (state: string, base: string, head: string) => ({ state, base: { ref: base }, head: { sha: head } });
  assert.equal(staleChildReason(stackedBase, oldHead, live('open', stackedBase, oldHead)), null);
  assert.match(staleChildReason(stackedBase, oldHead, live('open', 'develop', oldHead)) ?? '', /now targets develop/);
  assert.match(staleChildReason(stackedBase, oldHead, live('open', stackedBase, newHead)) ?? '', /head moved/);
  assert.match(staleChildReason(stackedBase, oldHead, live('closed', stackedBase, oldHead)) ?? '', /is closed/);
});

const coherentChild = () => ({
  state: 'open', base: { ref: stackedBase },
  head: { sha: oldHead, ref: 'codex/child', repo: { full_name: repository } },
});

test('child admission requires the PR snapshot and live branch to agree before evidence or writes', async () => {
  const branches: string[] = [];
  const read = async (branch: string) => { branches.push(branch); return oldHead; };
  assert.deepEqual(await admitChildUpdate(stackedBase, oldHead, repository, coherentChild(), read), { kind: 'current' });
  assert.deepEqual(branches, ['codex/child']);
  for (const tip of [newHead, null]) {
    const admission = await admitChildUpdate(stackedBase, oldHead, repository, coherentChild(), async () => tip);
    assert.equal(admission.kind, 'incoherent');
    if (admission.kind !== 'incoherent') throw new Error('Expected incoherent admission');
    assert.ok(admission.reason.includes(oldHead));
    assert.ok(admission.reason.includes(tip ?? 'deleted'));
    assert.match(admission.reason, /rerunning unchanged metadata cannot repair it/);
  }
});

test('changed PR tuples stop admission without reading the previously selected branch', async () => {
  const original = coherentChild();
  const moved = [
    { ...original, state: 'closed' },
    { ...original, base: { ref: 'main' } },
    { ...original, head: { ...original.head, sha: newHead } },
    { ...original, head: { ...original.head, repo: null } },
    { ...original, head: { ...original.head, repo: { full_name: 'foreign/repo' } } },
  ];
  for (const live of moved) {
    const admission = await admitChildUpdate(stackedBase, oldHead, repository, live, async () => {
      throw new Error('Must not read an ineligible branch');
    });
    assert.equal(admission.kind, 'moved');
  }
});

test('child admission fails closed on unreadable or malformed live branch evidence', async () => {
  await assert.rejects(admitChildUpdate(stackedBase, oldHead, repository, coherentChild(), async () => {
    throw new Error('HTTP 403');
  }), /HTTP 403/);
  await assert.rejects(admitChildUpdate(stackedBase, oldHead, repository, coherentChild(), async () => 'malformed'));
  const live = coherentChild();
  await assert.rejects(admitChildUpdate(stackedBase, oldHead, repository, { ...live, head: { sha: oldHead } }, async () => oldHead));
});

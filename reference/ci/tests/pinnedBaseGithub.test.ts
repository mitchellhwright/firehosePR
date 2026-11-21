import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinnedBaseGithubClient } from '../src/pinnedBaseGithub.ts';
const head = 'a'.repeat(40), base = 'b'.repeat(40), candidate = 'c'.repeat(40);
const tree = 'd'.repeat(40), created = 'e'.repeat(40);
const config = { repository: 'example-org/example-app', readToken: 'reader', updateToken: 'writer' };
const input = { number: 123, headSha: head, baseSha: base, headRef: 'feature', baseRef: 'develop' };
test('real HTTP transport pins both merge inputs and sends native head CAS with scoped credentials', async () => {
  const calls: string[] = [];
  const api = 'https://api.github.com/repos/example-org/example-app';
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = String(url); calls.push(path);
    const method = init?.method ?? 'GET';
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${method === 'GET' ? 'reader' : 'writer'}`);
    assert.ok(init?.signal);
    if (path === api) return Response.json({ node_id: 'repo-node' });
    if (path === `${api}/git/ref/pull/123/merge`) return Response.json({ object: { sha: candidate } });
    if (path === `${api}/git/commits/${candidate}`) return Response.json({ sha: candidate, tree: { sha: tree }, parents: [{ sha: base }, { sha: head }] });
    assert.equal(method, 'POST');
    assert.equal(typeof init?.body, 'string');
    const body: unknown = JSON.parse(String(init?.body));
    if (path === `${api}/git/commits`) {
      assert.deepEqual(body, { message: 'chore: update PR #123 from develop', tree, parents: [head, base] });
      return Response.json({ sha: created, tree: { sha: tree }, parents: [{ sha: head }, { sha: base }] }, { status: 201 });
    }
    assert.equal(path, 'https://api.github.com/graphql');
    assert.deepEqual(body, {
      query: 'mutation($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}',
      variables: { input: { repositoryId: 'repo-node', refUpdates: [{
        name: 'refs/heads/feature', beforeOid: head, afterOid: created, force: false,
      }] } },
    });
    return Response.json({ data: { updateRefs: { clientMutationId: null } } });
  };
  const client = createPinnedBaseGithubClient(config, fetchImpl);
  assert.equal((await client.update(input, async () => true)).kind, 'updating');
  assert.equal(calls.length, 5);
  assert.equal(calls[0], api, 'repository lookup must not add a trailing slash (GitHub returns 404)');
  assert.ok(!calls.some(path => path.includes('update-branch')));
});
test('repository identity failures cannot create or publish a commit', async () => {
  let requests = 0;
  const client = createPinnedBaseGithubClient(config, async () => {
    requests += 1; return Response.json({ message: 'Forbidden' }, { status: 403 });
  });
  await assert.rejects(client.update(input, async () => true), /HTTP 403/);
  assert.equal(requests, 1);
});
test('request parsing rejects malformed API data rather than treating HTTP 200 as success', async () => {
  const client = createPinnedBaseGithubClient(config, async () => Response.json({}));
  await assert.rejects(client.update(input, async () => true));
});

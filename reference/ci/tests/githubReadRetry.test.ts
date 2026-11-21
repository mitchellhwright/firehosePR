import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchGithubGraphqlQuery, fetchGithubWithReadRetry } from '../src/githubReadRetry.ts';

const options = {
  sleep: async (): Promise<void> => {},
  warn: (): void => {},
};

test('a GitHub GET recovers after an HTTP/2 transport refusal', async () => {
  let calls = 0;
  const response = await fetchGithubWithReadRetry('https://api.github.test/items', {}, {
    ...options,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed', {
        cause: new Error('NGHTTP2_REFUSED_STREAM'),
      });
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
});

test('a GitHub GET retries a transient server response but not a client error', async () => {
  let calls = 0;
  const fetchImpl = async (): Promise<Response> => {
    calls += 1;
    return new Response('{}', { status: calls === 1 ? 503 : 200 });
  };
  const response = await fetchGithubWithReadRetry('https://api.github.test/items', {}, {
    ...options, fetchImpl,
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  const badRequest = await fetchGithubWithReadRetry('https://api.github.test/items', {}, {
    ...options,
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 422 });
    },
  });
  assert.equal(badRequest.status, 422);
  assert.equal(calls, 3);
});

test('a GitHub GET stops after bounded transport retries', async () => {
  let calls = 0;
  await assert.rejects(() => fetchGithubWithReadRetry('https://api.github.test/items', {}, {
    ...options,
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    },
  }), /fetch failed/);
  assert.equal(calls, 3);
});

test('a GitHub write is never replayed after an uncertain failure', async () => {
  let calls = 0;
  await assert.rejects(() => fetchGithubWithReadRetry('https://api.github.test/items', {
    method: 'PATCH',
  }, {
    ...options,
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError('response lost');
    },
  }), /response lost/);
  assert.equal(calls, 1);
});

const graphqlRequest = (query: string) => ({ headers: { Authorization: 'Bearer read' }, query, variables: {} });

test('a GraphQL query retries a transient server response with the read budget', async () => {
  let calls = 0;
  const bodies: unknown[] = [];
  const response = await fetchGithubGraphqlQuery('https://api.github.test/graphql', graphqlRequest('query { viewer { login } }'), {
    ...options,
    fetchImpl: async (_url, init) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)));
      assert.equal(init?.method, 'POST');
      return new Response('{}', { status: calls === 1 ? 502 : 200 });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  const sent = { query: 'query { viewer { login } }', variables: {} };
  assert.deepEqual(bodies, [sent, sent]);
});

test('a GraphQL query returns the last server error once retries are exhausted', async () => {
  let calls = 0;
  const response = await fetchGithubGraphqlQuery('https://api.github.test/graphql', graphqlRequest('query { a }'), {
    ...options,
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 503 });
    },
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 3);
});

test('a GraphQL mutation is refused before any request, so it is never replayed', async () => {
  let calls = 0;
  const fetchImpl = async (): Promise<Response> => {
    calls += 1;
    return new Response('{}', { status: 503 });
  };
  for (const mutation of ['mutation { enable }', '  mutation($id: ID!) { enable(id: $id) }']) {
    await assert.rejects(
      () => fetchGithubGraphqlQuery('https://api.github.test/graphql', graphqlRequest(mutation), { ...options, fetchImpl }),
      /retries reads only/,
    );
  }
  assert.equal(calls, 0);
});

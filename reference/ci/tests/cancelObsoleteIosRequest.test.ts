import assert from 'node:assert/strict';
import test from 'node:test';

import { githubRequest } from '../src/actions/cancelObsoleteIosRuns.ts';

test('obsolete iOS controller retries transient GitHub GET failures without retrying 4xx or POST', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalRepository = process.env.GITHUB_REPOSITORY;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'example-org/example-app';

  try {
    let requests = 0;
    for (const status of [500, 502, 503, 504]) {
      requests = 0;
      globalThis.fetch = async () => {
        requests += 1;
        return requests === 1
          ? new Response(null, { status })
          : Response.json({ number: 5908 });
      };
      assert.equal((await githubRequest('pulls/5908')).number, 5908);
      assert.equal(requests, 2);
    }

    requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response(null, { status: 503 });
    };
    await assert.rejects(githubRequest('pulls/5908'), {
      message: 'GitHub API GET pulls/5908 failed with HTTP 503.',
    });
    assert.equal(requests, 3);

    for (const [method, status] of [['GET', 403], ['POST', 503]] as const) {
      requests = 0;
      globalThis.fetch = async () => {
        requests += 1;
        return new Response(null, { status });
      };
      await assert.rejects(githubRequest('pulls/5908', { method }), {
        message: `GitHub API ${method} pulls/5908 failed with HTTP ${status}.`,
      });
      assert.equal(requests, 1);
    }

    globalThis.fetch = async () => new Response('not JSON', { status: 200 });
    await assert.rejects(githubRequest('pulls/5908'), {
      message: 'GitHub API GET pulls/5908 returned a malformed JSON object.',
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  }
});

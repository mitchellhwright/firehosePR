import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';

import {
  cachesFromPage,
  main,
  supersededCaches,
} from '../src/actions/cleanupActionsStorage.ts';

describe('Actions cache cleanup', () => {
  it('retains only the most recently accessed matching cache', () => {
    const caches = cachesFromPage({ actions_caches: [
      { id: 1, key: 'ios-debt-old', size_in_bytes: 5, created_at: '2026-09-18T00:00:00Z', last_accessed_at: '2026-09-19T00:00:00Z' },
      { id: 2, key: 'ios-debt-new', size_in_bytes: 8, created_at: '2026-09-19T00:00:00Z', last_accessed_at: '2026-09-20T00:00:00Z' },
      { id: 3, key: 'unrelated', size_in_bytes: 13, created_at: '2026-09-18T00:00:00Z', last_accessed_at: '2026-09-18T00:00:00Z' },
    ] });
    assert.deepEqual(supersededCaches(caches, 'ios-debt-').map(cache => cache.id), [1]);
  });
});

test('cleanup leaves GitHub artifact expiry alone and deletes only superseded matching caches', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const names = ['GITHUB_API_URL', 'GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'CACHE_KEY_PREFIX'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const deletions: string[] = [];
  try {
    process.env.GITHUB_API_URL = 'https://api.github.test/';
    process.env.GITHUB_REPOSITORY = 'example-org/example-app';
    process.env.GITHUB_TOKEN = 'fixture-token';
    process.env.CACHE_KEY_PREFIX = 'ios-debt-card-test-products-v1-';
    console.log = (): void => {};
    globalThis.fetch = async (input, options): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(options?.headers);
      assert.equal(headers.get('Authorization'), 'Bearer fixture-token');
      if (options?.method === 'DELETE') {
        deletions.push(url);
        return new Response(null, { status: 204 });
      }
      assert.equal(options?.method, undefined);
      if (url.includes('/actions/caches?')) return new Response(JSON.stringify({ actions_caches: [
        { id: 21, key: 'ios-debt-card-test-products-v1-old', size_in_bytes: 5,
          created_at: '2026-09-18T00:00:00Z', last_accessed_at: '2026-09-19T00:00:00Z' },
        { id: 22, key: 'ios-debt-card-test-products-v1-new', size_in_bytes: 8,
          created_at: '2026-09-19T00:00:00Z', last_accessed_at: '2026-09-20T00:00:00Z' },
        { id: 23, key: 'node-cache-unrelated', size_in_bytes: 13,
          created_at: '2026-09-18T00:00:00Z', last_accessed_at: '2026-09-18T00:00:00Z' },
      ] }));
      throw new Error(`unexpected request: ${url}`);
    };
    await main();
    assert.deepEqual(deletions.sort(), [
      'https://api.github.test/repos/example-org/example-app/actions/caches/21',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

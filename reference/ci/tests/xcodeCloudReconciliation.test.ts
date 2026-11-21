import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { z } from 'zod';

import {
  CHECKPOINT_TAG,
  listBuilds,
  publishCheckpoint,
  reconcileAndPublishBuildTags,
  reconcileBuildTags,
  reconcileTag,
  resolveCiProductId,
  tagNameForBuild,
} from '../src/actions/reconcileXcodeCloudBuildTags.ts';
import { validateAppStoreConnectConfiguration } from '../src/actions/validateAppStoreConnectConfiguration.ts';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function build(buildNumber: number, completionStatus: string | null, executionProgress = 'COMPLETE') {
  return {
    buildNumber,
    commitSha: buildNumber.toString(16).padStart(40, '0'),
    executionProgress,
    completionStatus,
  };
}

test('Xcode Cloud product lookup uses the app relationship without incompatible filters', async () => {
  const requests: Array<{ readonly url: URL; readonly options: RequestInit | undefined }> = [];
  const productId = await resolveCiProductId({
    appId: '1234567890',
    token: 'apple-token',
    fetchImpl: async (input, options) => {
      const url = new URL(String(input));
      requests.push({ url, options });
      const filters = [...url.searchParams.keys()].filter((key) => key.startsWith('filter['));
      if (filters.length > 1) {
        return jsonResponse({ errors: [{ detail: 'Additional filters are not available.' }] }, 400);
      }
      return jsonResponse({ data: [{ id: 'product-id', type: 'ciProducts' }] });
    },
  });
  assert.equal(productId, 'product-id');
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url.origin, 'https://api.appstoreconnect.apple.com');
  assert.equal(request.url.pathname, '/v1/ciProducts');
  assert.equal(request.url.searchParams.get('filter[app]'), '1234567890');
  assert.equal(request.url.searchParams.get('limit'), '2');
  assert.equal(new Headers(request.options?.headers).get('Authorization'), 'Bearer apple-token');
});

test('Xcode Cloud product lookup rejects missing and ambiguous products', async () => {
  for (const data of [[], [{ id: 'first' }, { id: 'second' }]]) {
    await assert.rejects(resolveCiProductId({
      appId: '1234567890', token: 'apple-token',
      fetchImpl: async () => jsonResponse({ data }),
    }), new RegExp(`Expected one Xcode Cloud product.*found ${data.length}`));
  }
});

test('reconciliation closes an out-of-order successful-build gap across two polls', async () => {
  const exactTags = new Set<number>();
  let visited: number[] = [];
  const reconcileTagImpl = async ({ build: item }: { readonly build: { readonly buildNumber: number } }) => {
    visited.push(item.buildNumber);
    const outcome = exactTags.has(item.buildNumber) ? 'existing' : 'created';
    exactTags.add(item.buildNumber);
    return outcome;
  };
  const context = {
    githubApi: 'https://api.github.test', githubToken: 'github-token',
    repository: 'example-org/example-app', reconcileTagImpl,
  };
  const firstThrough = await reconcileBuildTags({
    ...context,
    builds: [build(3, 'SUCCEEDED'), build(2, null, 'RUNNING'), build(1, 'SUCCEEDED')],
    checkpointBuildNumber: 0,
  });
  assert.equal(firstThrough, 1);
  assert.deepEqual(visited, [3, 1]);

  visited = [];
  const secondThrough = await reconcileBuildTags({
    ...context,
    builds: [build(3, 'SUCCEEDED'), build(2, 'SUCCEEDED'), build(1, 'SUCCEEDED')],
    checkpointBuildNumber: firstThrough,
  });
  assert.equal(secondThrough, 3);
  assert.deepEqual(visited, [3, 2]);
  assert.deepEqual([...exactTags].sort(), [1, 2, 3]);
});

test('an exact-tag failure prevents checkpoint advancement', async () => {
  let publishCalls = 0;
  await assert.rejects(reconcileAndPublishBuildTags({
    builds: [build(2, 'SUCCEEDED'), build(1, 'SUCCEEDED')],
    checkpoint: { exists: false, refSha: null, targetCommitSha: null, throughBuildNumber: 0 },
    githubApi: 'https://api.github.test', githubToken: 'github-token',
    repository: 'example-org/example-app',
    reconcileTagImpl: async ({ build: item }) => {
      if (item.buildNumber === 1) throw new Error('exact tag creation failed');
      return 'created';
    },
    publishCheckpointImpl: async () => { publishCalls += 1; },
  }), /exact tag creation failed/);
  assert.equal(publishCalls, 0);
});

test('checkpoint publication fails closed after a concurrent ref change', async () => {
  let githubRequests = 0;
  await assert.rejects(publishCheckpoint({
    expectedCheckpoint: {
      exists: true, refSha: 'a'.repeat(40),
      targetCommitSha: '1'.repeat(40), throughBuildNumber: 1,
    },
    throughBuildNumber: 3,
    githubApi: 'https://api.github.test', githubToken: 'github-token',
    repository: 'example-org/example-app',
    readCheckpointImpl: async () => ({
      exists: true, refSha: 'b'.repeat(40),
      targetCommitSha: '2'.repeat(40), throughBuildNumber: 2,
    }),
    fetchImpl: async () => {
      githubRequests += 1;
      throw new Error('unexpected GitHub request');
    },
  }), /changed during reconciliation/);
  assert.equal(githubRequests, 0);
});

test('build pagination stops at a checkpoint while bootstrap scans all pages', async () => {
  const mainReference = {
    type: 'scmGitReferences', id: 'main-ref',
    attributes: { canonicalName: 'refs/heads/main' },
  };
  const buildRun = (number: number) => ({
    attributes: {
      number, executionProgress: 'COMPLETE', completionStatus: 'FAILED',
      isPullRequestBuild: false,
      sourceCommit: { commitSha: number.toString(16).padStart(40, '0') },
    },
    relationships: { sourceBranchOrTag: { data: { id: 'main-ref' } } },
  });
  const pages = new Map<string, unknown>([
    ['/v1/ciProducts/product/buildRuns', {
      data: [buildRun(5), buildRun(4)], included: [mainReference],
      links: { next: 'https://api.appstoreconnect.apple.com/v1/build-pages/2' },
    }],
    ['/v1/build-pages/2', {
      data: [buildRun(3), buildRun(2)], included: [mainReference],
      links: { next: 'https://api.appstoreconnect.apple.com/v1/build-pages/3' },
    }],
    ['/v1/build-pages/3', { data: [buildRun(1)], included: [mainReference], links: { next: null } }],
  ]);
  const fetchPages = (visited: string[]): typeof fetch => async (input) => {
    const pathname = new URL(String(input)).pathname;
    visited.push(pathname);
    return jsonResponse(pages.get(pathname));
  };
  const boundedVisits: string[] = [];
  const bounded = await listBuilds({
    productId: 'product', token: 'app-store-token', checkpointBuildNumber: 2,
    fetchImpl: fetchPages(boundedVisits),
  });
  assert.deepEqual(boundedVisits, ['/v1/ciProducts/product/buildRuns', '/v1/build-pages/2']);
  assert.deepEqual(bounded.map((item) => item.buildNumber), [5, 4, 3, 2]);

  const bootstrapVisits: string[] = [];
  const bootstrap = await listBuilds({
    productId: 'product', token: 'app-store-token', checkpointBuildNumber: 0,
    fetchImpl: fetchPages(bootstrapVisits),
  });
  assert.deepEqual(bootstrapVisits,
    ['/v1/ciProducts/product/buildRuns', '/v1/build-pages/2', '/v1/build-pages/3']);
  assert.deepEqual(bootstrap.map((item) => item.buildNumber), [5, 4, 3, 2, 1]);
});

test('checkpoint is an annotated strict-JSON tag at current main', async () => {
  const requests: Array<{ readonly url: string; readonly options: RequestInit | undefined }> = [];
  const tagObjectSha = 'f'.repeat(40);
  await publishCheckpoint({
    expectedCheckpoint: { exists: false, refSha: null, targetCommitSha: null, throughBuildNumber: 0 },
    throughBuildNumber: 7,
    githubApi: 'https://api.github.test', githubToken: 'github-token',
    repository: 'example-org/example-app',
    readCheckpointImpl: async () => ({
      exists: false, refSha: null, targetCommitSha: null, throughBuildNumber: 0,
    }),
    fetchImpl: async (input, options) => {
      const url = String(input);
      requests.push({ url, options });
      if (url.endsWith('/git/ref/heads/main')) {
        return jsonResponse({ object: { type: 'commit', sha: '7'.repeat(40) } });
      }
      if (url.endsWith('/git/tags')) return jsonResponse({ sha: tagObjectSha }, 201);
      return jsonResponse({ ref: `refs/tags/${CHECKPOINT_TAG}` }, 201);
    },
  });
  assert.equal(requests.length, 3);
  const createdTag = requests[1];
  const createdRef = requests[2];
  assert.ok(createdTag && createdRef);
  const tagBody = createdTag.options?.body;
  const refBody = createdRef.options?.body;
  assert.ok(typeof tagBody === 'string');
  assert.ok(typeof refBody === 'string');
  assert.deepEqual(JSON.parse(tagBody), {
    tag: CHECKPOINT_TAG, message: '{"version":1,"throughBuildNumber":7}',
    object: '7'.repeat(40), type: 'commit',
  });
  assert.deepEqual(JSON.parse(refBody), {
    ref: `refs/tags/${CHECKPOINT_TAG}`, sha: tagObjectSha,
  });
});

test('Xcode Cloud tracking is scheduled with scoped credentials and a typed action', () => {
  const workflow = z.object({
    on: z.object({ schedule: z.array(z.unknown()) }),
    permissions: z.object({ contents: z.literal('read') }),
    jobs: z.record(z.string(), z.object({ steps: z.array(z.object({
      id: z.string().optional(), uses: z.string().optional(),
      with: z.record(z.string(), z.unknown()).optional(),
      run: z.string().optional(), env: z.record(z.string(), z.unknown()).optional(),
    }).passthrough()) }).passthrough()),
  }).parse(load(readFileSync(new URL('../../.github/workflows/xcode-cloud-build-tags.yml', import.meta.url), 'utf8')));
  assert.ok(workflow.on.schedule.length > 0);
  assert.deepEqual(workflow.jobs['reconcile']?.['runs-on'],
    ['self-hosted', 'Linux', 'example-trusted-control']);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const appToken = steps.find((step) => step['id'] === 'app-token');
  assert.ok(appToken);
  assert.match(String(appToken['uses']), /actions\/create-github-app-token@/);
  assert.equal(appToken['with']?.['app-id'], '${{ secrets.PROMOTION_CHECKPOINT_APP_ID }}');
  assert.equal(appToken['with']?.['private-key'], '${{ secrets.PROMOTION_CHECKPOINT_APP_PRIVATE_KEY }}');
  assert.equal(appToken['with']?.['permission-contents'], 'write');
  assert.equal(appToken['with']?.['permission-workflows'], 'write');
  const tracking = steps.find((step) => step.run?.includes('reconcileXcodeCloudBuildTags.ts'));
  assert.ok(tracking);
  const preflight = steps.find((step) => step.run?.includes('validateAppStoreConnectConfiguration.ts'));
  assert.ok(preflight);
  assert.deepEqual(preflight.env, Object.fromEntries(
    ['APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_API_KEY_ISSUER_ID',
      'APP_STORE_CONNECT_API_KEY_CONTENT'].map((name) => [name, `\${{ secrets.${name} }}`]),
  ));
  assert.equal(tracking.env?.['GH_TOKEN'], '${{ steps.app-token.outputs.token }}');
  const keys = new Set(Object.keys(tracking.env ?? {}));
  for (const key of [
    'APP_STORE_CONNECT_API_KEY_ID', 'APP_STORE_CONNECT_API_KEY_ISSUER_ID',
    'APP_STORE_CONNECT_API_KEY_CONTENT',
  ]) assert.ok(keys.has(key), key);
  assert.equal(tagNameForBuild(1361), 'xcode-cloud/build-1361');
  assert.throws(() => tagNameForBuild(0), /Invalid Xcode Cloud build number/);
});

test('Xcode Cloud preflight reports every missing secret without exposing values', () => {
  const credentials = {
    APP_STORE_CONNECT_API_KEY_ID: 'private-key-id',
    APP_STORE_CONNECT_API_KEY_ISSUER_ID: 'private-issuer-id',
    APP_STORE_CONNECT_API_KEY_CONTENT: 'private-content',
  };
  assert.deepEqual(validateAppStoreConnectConfiguration(credentials), {
    exitCode: 0, messages: [],
  });
  const oneMissing = validateAppStoreConnectConfiguration({
    ...credentials, APP_STORE_CONNECT_API_KEY_CONTENT: '',
  });
  assert.equal(oneMissing.exitCode, 1);
  assert.deepEqual(oneMissing.messages, [{
    level: 'error', text: 'Missing App Store Connect secrets: APP_STORE_CONNECT_API_KEY_CONTENT',
  }]);
  const allMissing = validateAppStoreConnectConfiguration({});
  assert.equal(allMissing.exitCode, 1);
  assert.deepEqual(allMissing.messages, [{
    level: 'error',
    text: 'Missing App Store Connect secrets: APP_STORE_CONNECT_API_KEY_ID '
      + 'APP_STORE_CONNECT_API_KEY_ISSUER_ID APP_STORE_CONNECT_API_KEY_CONTENT',
  }]);
  assert.doesNotMatch(JSON.stringify(allMissing), /private-/);
});

test('build inventory follows every authoritative relative pagination link', async () => {
  const requests: Array<{ readonly url: string; readonly options: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, options) => {
    const url = String(input);
    requests.push({ url, options });
    const number = requests.length === 1 ? 1362 : 1361;
    return jsonResponse({
      data: [{
        attributes: {
          number, executionProgress: 'COMPLETE', completionStatus: 'SUCCEEDED',
          isPullRequestBuild: false,
          sourceCommit: { commitSha: (number === 1362 ? 'b' : 'a').repeat(40) },
        },
        relationships: { sourceBranchOrTag: { data: { id: 'main-ref' } } },
      }],
      included: [{
        type: 'scmGitReferences', id: 'main-ref',
        attributes: { canonicalName: 'refs/heads/main' },
      }],
      links: { next: requests.length === 1
        ? '/v1/ciProducts/product-id/buildRuns?cursor=second' : null },
    });
  };
  assert.deepEqual(await listBuilds({ productId: 'product-id', token: 'asc-token', fetchImpl }), [
    { buildNumber: 1362, commitSha: 'b'.repeat(40),
      executionProgress: 'COMPLETE', completionStatus: 'SUCCEEDED' },
    { buildNumber: 1361, commitSha: 'a'.repeat(40),
      executionProgress: 'COMPLETE', completionStatus: 'SUCCEEDED' },
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.url,
    'https://api.appstoreconnect.apple.com/v1/ciProducts/product-id/buildRuns?cursor=second');
  assert.ok(requests.every(({ options }) =>
    new Headers(options?.headers).get('Accept') === 'application/vnd.api+json'));
});

test('build inventory rejects off-host pagination and cycles', async () => {
  await assert.rejects(listBuilds({
    productId: 'product-id', token: 'asc-token',
    fetchImpl: async () => jsonResponse({
      data: [], links: { next: 'https://example.com/v1/ciBuildRuns?cursor=stolen' },
    }),
  }), /pagination URL outside https:\/\/api\.appstoreconnect\.apple\.com/);

  let firstPageUrl = '';
  let requestCount = 0;
  await assert.rejects(listBuilds({
    productId: 'product-id', token: 'asc-token',
    fetchImpl: async (input) => {
      requestCount += 1;
      if (firstPageUrl.length === 0) {
        firstPageUrl = String(input);
        return jsonResponse({
          data: [], links: { next: '/v1/ciProducts/product-id/buildRuns?cursor=second' },
        });
      }
      return jsonResponse({ data: [], links: { next: firstPageUrl } });
    },
  }), /pagination cycle detected/);
  assert.equal(requestCount, 2);
});

test('GitHub tag reconciliation requests GitHub JSON media', async () => {
  const requests: Array<{ readonly options: RequestInit | undefined }> = [];
  await reconcileTag({
    build: build(1361, 'SUCCEEDED'),
    githubApi: 'https://api.github.com', githubToken: 'github-token',
    repository: 'example-org/example-app',
    fetchImpl: async (_input, options) => {
      requests.push({ options });
      if (requests.length === 1) return jsonResponse({ message: 'Not Found' }, 404);
      if (requests.length === 2) return jsonResponse({ status: 'ahead' });
      return jsonResponse({ ref: 'refs/tags/xcode-cloud/build-1361' }, 201);
    },
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ options }) =>
    new Headers(options?.headers).get('Accept') === 'application/vnd.github+json'));
});

test('tag permission failure names build and commit without retrying or checkpointing', async () => {
  const commitSha = 'c'.repeat(40);
  const writes: unknown[] = [];
  let checkpointWrites = 0;
  await assert.rejects(reconcileAndPublishBuildTags({
    builds: [{ buildNumber: 1362, commitSha,
      executionProgress: 'COMPLETE', completionStatus: 'SUCCEEDED' }],
    checkpoint: { exists: false, refSha: null, targetCommitSha: null, throughBuildNumber: 0 },
    githubApi: 'https://api.github.com', githubToken: 'fixture-token',
    repository: 'example-org/example-app',
    fetchImpl: async (input, options) => {
      if (options?.method === 'POST') {
        const body = options.body;
        assert.ok(typeof body === 'string');
        writes.push(JSON.parse(body));
        return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
          status: 403, headers: { 'x-github-request-id': 'AB12:CD34:EF56' },
        });
      }
      return String(input).includes('/compare/')
        ? jsonResponse({ status: 'ahead' }) : jsonResponse({}, 404);
    },
    publishCheckpointImpl: async () => { checkpointWrites += 1; },
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message,
      /create xcode-cloud\/build-1362 at c{40}; HTTP 403; GitHub request AB12:CD34:EF56/);
    assert.equal(error.message.includes('fixture-token'), false);
    return true;
  });
  assert.deepEqual(writes, [{ ref: 'refs/tags/xcode-cloud/build-1362', sha: commitSha }]);
  assert.equal(checkpointWrites, 0);
});

test('historical tag failures remain visible without blocking the current build', async () => {
  const currentCommitSha = 'd'.repeat(40);
  const reconciled: number[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown): void => { warnings.push(String(message)); };
  try {
    const throughBuildNumber = await reconcileBuildTags({
      builds: [
        { buildNumber: 1372, commitSha: currentCommitSha,
          executionProgress: 'COMPLETE', completionStatus: 'SUCCEEDED' },
        { buildNumber: 1362, commitSha: 'c'.repeat(40),
          executionProgress: 'COMPLETE', completionStatus: 'SUCCEEDED' },
      ],
      checkpointBuildNumber: 1361,
      requiredCommitSha: currentCommitSha,
      githubApi: 'https://api.github.com', githubToken: 'fixture-token',
      repository: 'example-org/example-app',
      reconcileTagImpl: async ({ build: item }) => {
        reconciled.push(item.buildNumber);
        if (item.buildNumber === 1362) {
          throw Object.assign(new Error('create xcode-cloud/build-1362 failed with HTTP 403'), {
            recoverableHistoricalTagWrite: true,
          });
        }
      },
    });
    assert.equal(throughBuildNumber, 1361);
    assert.deepEqual(reconciled, [1372, 1362]);
    assert.match(warnings.join('\n'), /Unresolved historical Xcode Cloud tag for build 1362/);
  } finally {
    console.warn = originalWarn;
  }
});

test('current-build tag write failures remain fatal', async () => {
  const currentCommitSha = 'd'.repeat(40);
  await assert.rejects(reconcileBuildTags({
    builds: [{ buildNumber: 1372, commitSha: currentCommitSha,
      executionProgress: 'COMPLETE', completionStatus: 'SUCCEEDED' }],
    checkpointBuildNumber: 1361,
    requiredCommitSha: currentCommitSha,
    githubApi: 'https://api.github.com', githubToken: 'fixture-token',
    repository: 'example-org/example-app',
    reconcileTagImpl: async () => {
      throw Object.assign(new Error('current tag write failed'), {
        recoverableHistoricalTagWrite: true,
      });
    },
  }), /current tag write failed/);
});

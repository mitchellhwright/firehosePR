import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  collectSelectedEvidencePaths,
  fetchExactHeadEvidenceContent,
  fetchExactHeadFile,
} from '../src/assuranceEvidenceFetcher.ts';
import type { CalculationAssuranceRegistry } from '../src/calculationAssurancePlan.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function rawResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const HEAD_SHA = 'a'.repeat(40);
const PR_NUMBER = '42';
const REPOSITORY = 'example-org/example-app';

function pullRequestUrl(): string {
  return `https://api.github.com/repos/${REPOSITORY}/pulls/${PR_NUMBER}`;
}

function contentsUrl(repoRelativePath: string): string {
  const encoded = repoRelativePath.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${REPOSITORY}/contents/${encoded}?ref=${HEAD_SHA}`;
}

function enforcedPackage(id: string): CalculationAssuranceRegistry['packages'][number] {
  return {
    id,
    risk: 'regulated-financial-output',
    status: 'enforced',
    implementationSelectors: [{ kind: 'prefix', value: `server/services/${id}/` }],
    evidenceSelectors: [{ kind: 'prefix', value: `server/tests/assurance/${id}/` }],
    sources: [{ authority: 'federal', url: 'https://example.gov/rule' }],
    tests: {
      ruleVectors: [`server/tests/assurance/${id}/ruleVectors.test.ts`],
      independentOracle: [`server/tests/assurance/${id}/oracle.test.ts`],
      metamorphicProperties: [`server/tests/assurance/${id}/properties.test.ts`],
      mutationSentinels: [`server/tests/assurance/${id}/oracle.test.ts`],
    },
  };
}

function registryOf(
  ...packages: CalculationAssuranceRegistry['packages']
): CalculationAssuranceRegistry {
  return {
    schema: 'example.calculation-assurance-registry.v1',
    rollout: 'enforce',
    packages,
  };
}

describe('collectSelectedEvidencePaths', () => {
  it('returns nothing when no package is enforced', () => {
    const registry = registryOf({
      id: 'inventory-only',
      risk: 'regulated-financial-output',
      status: 'inventory',
      implementationSelectors: [{ kind: 'file', value: 'server/services/example.ts' }],
      knownTestPaths: ['server/tests/example.test.ts'],
      missingLayers: ['authoritative-rule-vectors'],
    });

    assert.deepEqual(collectSelectedEvidencePaths(registry, ['inventory-only']), []);
  });

  it('returns the deduplicated, sorted evidence paths of a selected enforced package', () => {
    const registry = registryOf(enforcedPackage('example-benefit'));

    assert.deepEqual(collectSelectedEvidencePaths(registry, ['example-benefit']), [
      'server/tests/assurance/example-benefit/oracle.test.ts',
      'server/tests/assurance/example-benefit/properties.test.ts',
      'server/tests/assurance/example-benefit/ruleVectors.test.ts',
    ]);
  });

  it('never returns the evidence of an enforced package the change did not select', () => {
    // Fetching an unselected package's evidence spends request budget against the fail-closed
    // file limit on a package this run does not gate.
    const registry = registryOf(enforcedPackage('example-benefit'), enforcedPackage('other-benefit'));

    assert.deepEqual(collectSelectedEvidencePaths(registry, ['other-benefit']), [
      'server/tests/assurance/other-benefit/oracle.test.ts',
      'server/tests/assurance/other-benefit/properties.test.ts',
      'server/tests/assurance/other-benefit/ruleVectors.test.ts',
    ]);
  });

  it('returns nothing when the change selected no package at all', () => {
    const registry = registryOf(enforcedPackage('example-benefit'));

    assert.deepEqual(collectSelectedEvidencePaths(registry, []), []);
  });
});

describe('fetchExactHeadEvidenceContent', () => {
  it('returns an empty map without making any request when no path is declared', async () => {
    const content = await fetchExactHeadEvidenceContent({
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      prNumber: PR_NUMBER,
      tokens: [],
      entryPaths: [],
      fetchImpl: () => {
        throw new Error('fetch must not be called when there is nothing to fetch');
      },
    });

    assert.deepEqual([...content], []);
  });

  it('throws when there are declared paths but no credentials', async () => {
    await assert.rejects(
      fetchExactHeadEvidenceContent({
        repository: REPOSITORY,
        headSha: HEAD_SHA,
        prNumber: PR_NUMBER,
        tokens: [],
        entryPaths: ['server/tests/assurance/example/oracle.test.ts'],
      }),
      /No credentials/
    );
  });

  it('fails closed when the pull request head moved since it was captured', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url) === pullRequestUrl()) {
        return jsonResponse(200, { head: { sha: 'b'.repeat(40) } });
      }
      throw new Error(`unexpected request: ${String(url)}`);
    }) as typeof fetch;

    await assert.rejects(
      fetchExactHeadEvidenceContent({
        repository: REPOSITORY,
        headSha: HEAD_SHA,
        prNumber: PR_NUMBER,
        tokens: ['token-a'],
        entryPaths: ['server/tests/assurance/example/oracle.test.ts'],
        fetchImpl,
      }),
      /head changed/
    );
  });

  it('fetches an entry file and walks a relative import to its shared helper', async () => {
    const entry = 'server/tests/assurance/example/oracle.test.ts';
    const helper = 'server/tests/assurance/example/helper.ts';
    const requested: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      requested.push(target);
      if (target === pullRequestUrl()) {
        return jsonResponse(200, { head: { sha: HEAD_SHA } });
      }
      if (target === contentsUrl(entry)) {
        return rawResponse(200, "import { helper } from './helper.ts';\nhelper();\n");
      }
      if (target === contentsUrl(helper)) {
        return rawResponse(200, 'export function helper() {}\n');
      }
      return rawResponse(404, '');
    }) as typeof fetch;

    const content = await fetchExactHeadEvidenceContent({
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      prNumber: PR_NUMBER,
      tokens: ['token-a'],
      entryPaths: [entry],
      fetchImpl,
    });

    assert.equal(content.get(entry), "import { helper } from './helper.ts';\nhelper();\n");
    assert.equal(content.get(helper), 'export function helper() {}\n');
    assert.ok(requested.includes(contentsUrl(helper)), 'the shared helper must have been fetched');
  });

  it('walks a transitive import two hops deep to the production module it re-exports', async () => {
    const entry = 'server/tests/assurance/example/oracle.test.ts';
    const helper = 'server/tests/assurance/example/helper.ts';
    const calculator = 'server/tests/assurance/example/calculator.ts';
    const requested: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      requested.push(target);
      if (target === pullRequestUrl()) {
        return jsonResponse(200, { head: { sha: HEAD_SHA } });
      }
      if (target === contentsUrl(entry)) {
        return rawResponse(200, "import { calculateBenefit } from './helper.ts';\ncalculateBenefit(100);\n");
      }
      if (target === contentsUrl(helper)) {
        return rawResponse(200, "export { calculateBenefit } from './calculator.ts';\n");
      }
      if (target === contentsUrl(calculator)) {
        return rawResponse(200, 'export function calculateBenefit(income) { return income * 0.1; }\n');
      }
      return rawResponse(404, '');
    }) as typeof fetch;

    const content = await fetchExactHeadEvidenceContent({
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      prNumber: PR_NUMBER,
      tokens: ['token-a'],
      entryPaths: [entry],
      fetchImpl,
    });

    assert.equal(content.get(entry), "import { calculateBenefit } from './helper.ts';\ncalculateBenefit(100);\n");
    assert.equal(content.get(helper), "export { calculateBenefit } from './calculator.ts';\n");
    assert.equal(
      content.get(calculator),
      'export function calculateBenefit(income) { return income * 0.1; }\n'
    );
    assert.ok(
      requested.includes(contentsUrl(calculator)),
      'the production module two hops away must have been fetched'
    );
  });

  it('fetches each file at most once when the import graph has a cycle', async () => {
    const entry = 'server/tests/assurance/example/a.test.ts';
    const b = 'server/tests/assurance/example/b.ts';
    const fetchCounts = new Map<string, number>();
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      if (target === pullRequestUrl()) {
        return jsonResponse(200, { head: { sha: HEAD_SHA } });
      }
      fetchCounts.set(target, (fetchCounts.get(target) ?? 0) + 1);
      if (target === contentsUrl(entry)) return rawResponse(200, "import './b.js';\n");
      if (target === contentsUrl(b)) return rawResponse(200, "import './a.test.js';\n");
      return rawResponse(404, '');
    }) as typeof fetch;

    const content = await fetchExactHeadEvidenceContent({
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      prNumber: PR_NUMBER,
      tokens: ['token-a'],
      entryPaths: [entry],
      fetchImpl,
    });

    assert.equal(content.get(entry), "import './b.js';\n");
    assert.equal(content.get(b), "import './a.test.js';\n");
    assert.equal(fetchCounts.get(contentsUrl(entry)), 1);
    assert.equal(fetchCounts.get(contentsUrl(b)), 1);
  });

  it('omits a declared entry that is missing at the exact head instead of throwing', async () => {
    const entry = 'server/tests/assurance/example/oracle.test.ts';
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      if (target === pullRequestUrl()) return jsonResponse(200, { head: { sha: HEAD_SHA } });
      if (target === contentsUrl(entry)) return rawResponse(404, '');
      return rawResponse(404, '');
    }) as typeof fetch;

    const content = await fetchExactHeadEvidenceContent({
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      prNumber: PR_NUMBER,
      tokens: ['token-a'],
      entryPaths: [entry],
      fetchImpl,
    });

    assert.equal(content.has(entry), false);
  });

  it('falls back to the secondary token when the primary is rate-limited', async () => {
    const entry = 'server/tests/assurance/example/oracle.test.ts';
    const usedTokens: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      const headers = init?.headers as Record<string, string> | undefined;
      const token = headers?.Authorization?.replace('Bearer ', '') ?? '';
      usedTokens.push(token);
      if (target === pullRequestUrl()) {
        if (token === 'stale-token') return rawResponse(403, '');
        return jsonResponse(200, { head: { sha: HEAD_SHA } });
      }
      if (target === contentsUrl(entry)) {
        if (token === 'stale-token') return rawResponse(403, '');
        return rawResponse(200, 'export {};\n');
      }
      return rawResponse(404, '');
    }) as typeof fetch;

    const content = await fetchExactHeadEvidenceContent({
      repository: REPOSITORY,
      headSha: HEAD_SHA,
      prNumber: PR_NUMBER,
      tokens: ['stale-token', 'fresh-token'],
      entryPaths: [entry],
      fetchImpl,
    });

    assert.equal(content.get(entry), 'export {};\n');
    assert.ok(usedTokens.includes('fresh-token'));
  });

  it('fails closed when a fetched file exceeds the byte limit', async () => {
    const entry = 'server/tests/assurance/example/oracle.test.ts';
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      if (target === pullRequestUrl()) return jsonResponse(200, { head: { sha: HEAD_SHA } });
      if (target === contentsUrl(entry)) return rawResponse(200, 'x'.repeat(20));
      return rawResponse(404, '');
    }) as typeof fetch;

    await assert.rejects(
      fetchExactHeadEvidenceContent({
        repository: REPOSITORY,
        headSha: HEAD_SHA,
        prNumber: PR_NUMBER,
        tokens: ['token-a'],
        entryPaths: [entry],
        fetchImpl,
        maxBytesPerFile: 10,
      }),
      /exceeds the 10-byte limit/
    );
  });

  it('fails closed when the import graph exceeds the file fetch limit', async () => {
    const entry = 'server/tests/assurance/example/oracle.test.ts';
    const helper = 'server/tests/assurance/example/helper.ts';
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      if (target === pullRequestUrl()) return jsonResponse(200, { head: { sha: HEAD_SHA } });
      if (target === contentsUrl(entry)) {
        return rawResponse(200, "import { helper } from './helper.ts';\nhelper();\n");
      }
      if (target === contentsUrl(helper)) return rawResponse(200, 'export function helper() {}\n');
      return rawResponse(404, '');
    }) as typeof fetch;

    await assert.rejects(
      fetchExactHeadEvidenceContent({
        repository: REPOSITORY,
        headSha: HEAD_SHA,
        prNumber: PR_NUMBER,
        tokens: ['token-a'],
        entryPaths: [entry],
        fetchImpl,
        maxFiles: 1,
      }),
      /exceeds the 1-file fetch limit/
    );
  });
});

describe('fetchExactHeadFile', () => {
  it('verifies the head, then returns the file at that revision or null when it is absent', async () => {
    const requested: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      requested.push(target);
      if (target === pullRequestUrl()) return jsonResponse(200, { head: { sha: HEAD_SHA } });
      if (target === contentsUrl('package.json')) return rawResponse(200, '{"name":"example"}\n');
      if (target === contentsUrl('missing.json')) return rawResponse(404, '');
      throw new Error(`unexpected request: ${target}`);
    }) as typeof fetch;
    const common = { repository: REPOSITORY, headSha: HEAD_SHA, prNumber: PR_NUMBER, tokens: ['token-a'], fetchImpl };

    assert.equal(await fetchExactHeadFile({ ...common, path: 'package.json' }), '{"name":"example"}\n');
    assert.equal(await fetchExactHeadFile({ ...common, path: 'missing.json' }), null);
    assert.deepEqual(requested, [
      pullRequestUrl(), contentsUrl('package.json'), pullRequestUrl(), contentsUrl('missing.json'),
    ]);
  });

  it('fails closed without credentials and when the head moved', async () => {
    await assert.rejects(
      fetchExactHeadFile({ repository: REPOSITORY, headSha: HEAD_SHA, prNumber: PR_NUMBER, tokens: [], path: 'package.json' }),
      /No credentials/
    );
    const fetchImpl = (async () => jsonResponse(200, { head: { sha: 'b'.repeat(40) } })) as typeof fetch;
    await assert.rejects(
      fetchExactHeadFile({ repository: REPOSITORY, headSha: HEAD_SHA, prNumber: PR_NUMBER, tokens: ['token-a'], path: 'package.json', fetchImpl }),
      /head changed/
    );
  });
});

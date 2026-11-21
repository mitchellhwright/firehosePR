import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GitHubJson } from '../../scripts/ci/types/github.d.mts';

import { main } from '../src/ios/controllers/baseUpdateDelta.ts';

const sha = (character: string): string => character.repeat(40);
const previousHead = sha('a');
const base = sha('b');
const head = sha('c');
const oldBase = sha('d');
const number = 6200;
const repository = { full_name: 'example-org/example-app' };

const modified = (filename: string, start = 1) => ({
  filename,
  status: 'modified',
  sha: sha('e'),
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: `@@ -${start} +${start} @@\n-old\n+new`,
});

type ComparisonEntry = ReturnType<typeof modified> & {
  readonly previous_filename?: string;
};

interface Scenario {
  readonly baseDelta: readonly ComparisonEntry[];
  readonly prPatch: readonly ComparisonEntry[];
}

function scenarioRequest({ baseDelta, prPatch }: Scenario, requested: string[]) {
  return async (endpoint: string): Promise<GitHubJson> => {
    requested.push(endpoint);
    if (endpoint === `commits/${head}`) return {
      sha: head, parents: [{ sha: previousHead }, { sha: base }],
      commit: { message: `chore: update PR #${number} from develop` },
    };
    if (endpoint === `commits/${previousHead}`) {
      return { sha: previousHead, parents: [{ sha: oldBase }], commit: { message: 'feat: work' } };
    }
    if (endpoint === `compare/${previousHead}...${head}`) {
      return { status: 'ahead', merge_base_commit: { sha: previousHead }, files: [...baseDelta] };
    }
    if (endpoint === `compare/${base}...${previousHead}`) {
      return { status: 'diverged', merge_base_commit: { sha: oldBase }, files: [] };
    }
    if (endpoint === `compare/${base}...${head}`) {
      return { status: 'ahead', merge_base_commit: { sha: base }, files: [...prPatch] };
    }
    if (endpoint === `compare/${oldBase}...${previousHead}`) {
      return { status: 'ahead', merge_base_commit: { sha: oldBase }, files: [...prPatch] };
    }
    if (endpoint === `compare/${oldBase}...${base}`) {
      return { status: 'ahead', merge_base_commit: { sha: oldBase }, files: [...baseDelta] };
    }
    if (endpoint === `actions/runs?event=pull_request&head_sha=${previousHead}&per_page=100`) {
      return {
        workflow_runs: [{
          name: 'PR Checks', id: 77, run_attempt: 1, head_sha: previousHead,
          status: 'completed', conclusion: 'success', created_at: '2026-09-25T01:00:00Z',
          pull_requests: [{ number, base: { ref: 'develop' } }],
        }],
      };
    }
    if (endpoint === 'actions/runs/77/jobs?filter=latest&per_page=100') {
      return {
        total_count: 1,
        jobs: [{
          id: 900, name: 'Validate pull request changes', status: 'completed', conclusion: 'success',
          run_id: 77, run_attempt: 1, head_sha: previousHead,
        }],
      };
    }
    if (endpoint === `issues/${number}/timeline?per_page=100&page=1`) {
      // The shared reader type describes object endpoints; this endpoint is an array.
      return [] as unknown as GitHubJson;
    }
    if (endpoint === `pulls/${number}`) return { head: { sha: head } };
    throw new Error(`Unexpected request: ${endpoint}`);
  };
}

async function classify(scenario: Scenario) {
  const directory = mkdtempSync(join(tmpdir(), 'base-update-pr-checks-'));
  const output = join(directory, 'output');
  const previousOutput = process.env['GITHUB_OUTPUT'];
  process.env['GITHUB_OUTPUT'] = output;
  const logs: string[] = [];
  const requested: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { logs.push(values.join(' ')); };
  try {
    const result = await main({
      event: {
        action: 'synchronize', before: previousHead,
        pull_request: {
          number,
          head: { sha: head, repo: repository },
          base: { sha: base, ref: 'develop', repo: repository },
        },
      },
      token: 'test-token', workflows: ['PR Checks'], request: scenarioRequest(scenario, requested),
    });
    const outputs = new Map<string, string>();
    const text = readFileSync(output, 'utf8');
    for (const match of text.matchAll(/^([a-z_]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) {
      outputs.set(match[1] ?? '', match[3] ?? '');
    }
    return { result, outputs, logs, requested };
  } finally {
    console.log = originalLog;
    if (previousOutput === undefined) delete process.env['GITHUB_OUTPUT'];
    else process.env['GITHUB_OUTPUT'] = previousOutput;
    rmSync(directory, { recursive: true, force: true });
  }
}

const prPatch = [modified('server/services/budget/budgetService.ts', 40)];

test('a verified base update routes PR Checks by the base delta, not the whole PR', async () => {
  for (const path of [
    'ios/example-ios/App.swift',
    'server/services/debt/debtService.ts',
    // Also a real-server iOS E2E input; that lane logic belongs to Test - iOS only.
    'pages/api/health.ts',
  ]) {
    const { outputs, logs, requested } = await classify({ baseDelta: [modified(path)], prPatch });
    assert.equal(outputs.get('valid'), 'true', path);
    assert.equal(outputs.get('base_delta_route'), 'true', path);
    assert.equal(outputs.get('changed_files'), path, path);
    assert.equal(outputs.get('patch_equivalent'), 'false', path);
    assert.equal(outputs.get('pull_request_files'), 'server/services/budget/budgetService.ts', path);
    assert.equal(outputs.get('pull_request_deleted_files'), '', path);
    assert.deepEqual(logs, [
      'Base update route: reason=base-delta workflows=PR Checks '
      + `prior_head=${previousHead.slice(0, 12)} routed_paths=1 pull_request_paths=1`,
    ], path);
    assert.equal(requested.some(endpoint => endpoint.startsWith('git/trees/')), false,
      `${path}: PR Checks never reads iOS E2E product inputs`);
  }
});

test('base-delta removals and renames reach the deleted-file inventory', async () => {
  const { outputs } = await classify({
    baseDelta: [
      { ...modified('server/services/old.ts'), status: 'removed' },
      { ...modified('server/services/renamed.ts'), status: 'renamed', previous_filename: 'server/services/before.ts' },
    ],
    prPatch,
  });
  assert.equal(outputs.get('changed_files'), 'server/services/old.ts\nserver/services/renamed.ts');
  assert.equal(outputs.get('deleted_files'), 'server/services/old.ts\nserver/services/before.ts');
});

test('a base update that changed nothing keeps the prior PR Checks evidence', async () => {
  const { outputs, logs } = await classify({ baseDelta: [], prPatch });
  assert.equal(outputs.get('changed_files'), '');
  assert.equal(outputs.get('patch_equivalent'), 'true');
  assert.equal(logs.length, 1);
});

test('a pull request with no patch of its own still reports the base-delta route', async () => {
  const { outputs } = await classify({ baseDelta: [modified('package.json')], prPatch: [] });
  assert.equal(outputs.get('base_delta_route'), 'true');
  assert.equal(outputs.get('changed_files'), 'package.json');
  assert.equal(outputs.get('pull_request_files'), '');
});

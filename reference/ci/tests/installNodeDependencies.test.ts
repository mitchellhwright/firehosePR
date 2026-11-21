import assert from 'node:assert/strict';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { stampFileName } from '../src/nodeModulesCache.ts';
import { runnerEnvironment } from '../src/actions/installNodeDependencies.ts';

const installer = resolve('ci/src/actions/installNodeDependencies.ts');

interface Runner {
  readonly workspace: string;
  readonly cacheRoot: string;
  readonly npmCalls: string;
  key(): string;
  run(environment?: Readonly<Record<string, string>>): SpawnSyncReturns<string>;
  start(environment?: Readonly<Record<string, string>>): Promise<{ status: number | null; stderr: string }>;
}

/**
 * A runner-shaped sandbox: a workspace with a manifest, a tool cache, and a
 * fake npm on PATH that records each invocation and lays down a tree with an
 * executable in .bin, which is what a real install leaves behind.
 */
function runnerSandbox(sharedToolCache?: string): Runner {
  const root = mkdtempSync(join(tmpdir(), 'install-node-dependencies-'));
  const workspace = join(root, 'workspace');
  const toolCache = sharedToolCache ?? join(root, '_tool');
  const bin = join(root, 'bin');
  const npmCalls = join(root, 'npm-calls');
  mkdirSync(workspace);
  mkdirSync(toolCache, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(workspace, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(workspace, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(npmCalls, '');
  writeFileSync(
    join(bin, 'npm'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "$1" == --version ]]; then echo 11.6.0; exit 0; fi',
      'if [[ "$1" == ls ]]; then exit 0; fi',
      `printf '%s\\n' "$*" >> "${npmCalls}"`,
      'if [[ "${NPM_FAIL:-}" == 1 ]]; then exit 25; fi',
      'if [[ "${NPM_DELAY:-}" == 1 ]]; then sleep 0.2; fi',
      'mkdir -p node_modules/.bin node_modules/pkg/lib',
      "printf 'module.exports = 1\\n' > node_modules/pkg/lib/index.js",
      "printf '#!/bin/sh\\nexit 0\\n' > node_modules/.bin/tool",
      'chmod 755 node_modules/.bin/tool',
    ].join('\n') + '\n',
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const childEnvironment = (environment: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    RUNNER_TOOL_CACHE: toolCache,
    // Exercise the persistent-runner path even when this contract suite itself
    // runs on a GitHub-hosted VM. A test may override this to prove the bypass.
    RUNNER_ENVIRONMENT: 'self-hosted',
    ...environment,
  });
  return {
    workspace,
    key: () => {
      const output = join(root, 'key-output');
      const result = spawnSync(process.execPath, [resolve('ci/src/actions/nodeModulesCacheKey.ts')], {
        cwd: workspace, encoding: 'utf8', env: { ...childEnvironment({}), GITHUB_OUTPUT: output },
      });
      assert.equal(result.status, 0, result.stderr);
      const key = /^key=(.+)$/m.exec(readFileSync(output, 'utf8'))?.[1];
      assert.ok(key);
      return key;
    },
    cacheRoot: join(toolCache, 'example-node-modules'),
    npmCalls,
    run: (environment = {}) => spawnSync(process.execPath, [installer], {
      cwd: workspace,
      encoding: 'utf8',
      env: childEnvironment(environment),
    }),
    start: (environment = {}) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [installer], {
        cwd: workspace,
        env: childEnvironment(environment),
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stderr }));
    }),
  };
}

function npmInvocations(runner: Runner): string[] {
  return readFileSync(runner.npmCalls, 'utf8').split('\n').filter(Boolean);
}

test('a cache hit clones a tree the runner can delete again and keeps executables', () => {
  const runner = runnerSandbox();
  const miss = runner.run();
  assert.equal(miss.status, 0, miss.stderr);
  assert.deepEqual(npmInvocations(runner), ['ci --no-audit --no-fund --prefer-offline']);
  assert.match(miss.stdout, /Cached node_modules for input key/);

  rmSync(join(runner.workspace, 'node_modules'), { recursive: true, force: true });
  const hit = runner.run();
  assert.equal(hit.status, 0, hit.stderr);
  assert.deepEqual(npmInvocations(runner), ['ci --no-audit --no-fund --prefer-offline'], 'a hit never runs npm');
  assert.match(hit.stdout, /Cloned node_modules for input key/);

  const cloned = join(runner.workspace, 'node_modules');
  assert.equal(readFileSync(join(cloned, 'pkg', 'lib', 'index.js'), 'utf8'), 'module.exports = 1\n');
  assert.ok(statSync(join(cloned, '.bin', 'tool')).mode & 0o100, 'executables in .bin stay executable');
  // actions/checkout cleans the workspace with fs.rm before every job; a tree
  // it cannot remove strands the runner until someone fixes it on the host.
  assert.doesNotThrow(() => rmSync(cloned, { recursive: true, force: true }));
  assert.equal(existsSync(cloned), false);
});

test('a project .npmrc change cannot reuse the previous dependency tree', () => {
  const runner = runnerSandbox();
  assert.equal(runner.run().status, 0);
  writeFileSync(join(runner.workspace, '.npmrc'), 'legacy-peer-deps=true\n');
  rmSync(join(runner.workspace, 'node_modules'), { recursive: true, force: true });
  const changed = runner.run();
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(npmInvocations(runner).length, 2);
  assert.match(changed.stdout, /Cached node_modules/);
});

test('a manifest-only revision cannot reuse the previous dependency tree', () => {
  const runner = runnerSandbox();
  assert.equal(runner.run().status, 0);
  writeFileSync(join(runner.workspace, 'package.json'), '{"name":"fixture","scripts":{"check":"true"}}\n');
  rmSync(join(runner.workspace, 'node_modules'), { recursive: true, force: true });
  const changed = runner.run();
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(npmInvocations(runner).length, 2);
  assert.match(changed.stdout, /Cached node_modules/);
});

test('trees no job has used for a week are pruned, on hits as well as misses', () => {
  const runner = runnerSandbox();
  assert.equal(runner.run().status, 0);
  const stale = join(runner.cacheRoot, 'v0.0.0', 'stale');
  mkdirSync(join(stale, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(stale, 'node_modules', 'pkg', 'index.js'), '');
  writeFileSync(join(stale, 'complete'), '');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(join(stale, 'complete'), eightDaysAgo, eightDaysAgo);

  const hit = runner.run();
  assert.equal(hit.status, 0, hit.stderr);
  assert.match(hit.stdout, /Cloned node_modules/);
  assert.equal(existsSync(stale), false, 'the stale tree is gone after a hit');
});

test('off a runner, or on a GitHub-hosted VM, the installer is plain npm ci', () => {
  const bypasses: ReadonlyArray<Readonly<Record<string, string>>> = [
    { RUNNER_TOOL_CACHE: '' },
    { RUNNER_ENVIRONMENT: 'github-hosted' },
  ];
  for (const environment of bypasses) {
    const runner = runnerSandbox();
    const result = runner.run(environment);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(npmInvocations(runner), ['ci --no-audit --no-fund --prefer-offline']);
    assert.equal(existsSync(runner.cacheRoot), false, JSON.stringify(environment));
  }
});

test('a missing or unknown runner environment fails before any install', () => {
  assert.throws(() => runnerEnvironment({}), /RUNNER_ENVIRONMENT must be github-hosted or self-hosted, got nothing/);
  assert.throws(() => runnerEnvironment({ RUNNER_ENVIRONMENT: 'hosted' }), /got 'hosted'/);
  assert.equal(runnerEnvironment({ RUNNER_ENVIRONMENT: 'github-hosted' }), 'github-hosted');
  assert.equal(runnerEnvironment({ RUNNER_ENVIRONMENT: 'self-hosted' }), 'self-hosted');
  for (const value of ['', 'Self-Hosted']) {
    const runner = runnerSandbox();
    const result = runner.run({ RUNNER_ENVIRONMENT: value });
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /runner\.environment/, value);
    assert.deepEqual(npmInvocations(runner), [], value);
    assert.equal(existsSync(runner.cacheRoot), false, value);
  }
});

test('a failed npm install never publishes a cache entry', () => {
  const runner = runnerSandbox();
  const failed = runner.run({ NPM_FAIL: '1' });
  assert.equal(failed.status, 25);
  assert.equal(existsSync(runner.cacheRoot), false);
  const retry = runner.run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /Cached node_modules/);
});

test('an incomplete cache entry cannot replace a fresh workspace install', () => {
  const runner = runnerSandbox();
  const digest = runner.key();
  const incomplete = join(runner.cacheRoot, process.version, digest);
  mkdirSync(incomplete, { recursive: true });
  writeFileSync(join(incomplete, 'stale'), 'not a complete install');
  const result = runner.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /incomplete; using the fresh workspace install/);
  assert.equal(existsSync(join(incomplete, 'complete')), false);
  assert.ok(existsSync(join(runner.workspace, 'node_modules', '.bin', 'tool')));
});

test('parallel PR jobs publish one complete shared cache entry', async () => {
  const first = runnerSandbox();
  const second = runnerSandbox(resolve(first.cacheRoot, '..'));
  const results = await Promise.all([
    first.start({ NPM_DELAY: '1' }),
    second.start({ NPM_DELAY: '1' }),
  ]);
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 0, `worker ${index}: ${result.stderr}`);
  }
  const digest = readFileSync(join(first.workspace, 'node_modules', stampFileName), 'utf8').trim();
  const published = join(first.cacheRoot, process.version, digest);
  assert.ok(existsSync(join(published, 'complete')));
  assert.ok(existsSync(join(published, 'node_modules', '.bin', 'tool')));
  for (const runner of [first, second]) {
    assert.ok(existsSync(join(runner.workspace, 'node_modules', '.bin', 'tool')));
  }
});

import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { z } from 'zod';

import { stampFileName } from '../src/nodeModulesCache.ts';
import { workflowDocument, workflowJob } from '../src/workflowStepShell.ts';

const keyAction = resolve('ci/src/actions/nodeModulesCacheKey.ts');
const rootInstaller = resolve('ci/src/actions/installNodeDependencies.ts');

interface Sandbox {
  readonly workspace: string;
  readonly npmCalls: () => string[];
  run(entry: string, environment?: Readonly<Record<string, string>>): SpawnSyncReturns<string>;
  key(environment?: Readonly<Record<string, string>>): string;
}

/**
 * A GitHub-hosted workspace with a manifest and lockfile, and a fake npm that
 * answers `--version`, fails `ls` on demand and records every install.
 */
function hostedSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'node-modules-cache-'));
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  const calls = join(root, 'npm-calls');
  mkdirSync(workspace);
  mkdirSync(bin);
  writeFileSync(join(workspace, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(workspace, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(calls, '');
  writeFileSync(join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "$1" == --version ]]; then echo "${FAKE_NPM_VERSION:-11.6.0}"; exit 0; fi',
    'if [[ "$1" == ls ]]; then exit "${NPM_LS_STATUS:-0}"; fi',
    `printf '%s\\n' "$*" >> "${calls}"`,
    'mkdir -p node_modules/pkg',
    'printf "fresh\\n" > node_modules/pkg/index.js',
  ].join('\n') + '\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const env = (environment: Readonly<Record<string, string>>): NodeJS.ProcessEnv => {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(base)) {
      if (name === 'NODE_ENV' || name.toLowerCase().startsWith('npm_config_')) delete base[name];
    }
    return {
      ...base,
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_TOOL_CACHE: join(root, '_tool'),
      ImageOS: 'ubuntu24',
      ...environment,
    };
  };
  const run = (entry: string, environment: Readonly<Record<string, string>> = {}) =>
    spawnSync(process.execPath, [entry], { cwd: workspace, encoding: 'utf8', env: env(environment) });
  return {
    workspace,
    npmCalls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    run,
    key(environment = {}) {
      const output = join(root, `output-${Math.random()}`);
      const result = run(keyAction, { GITHUB_OUTPUT: output, ...environment });
      assert.equal(result.status, 0, result.stderr);
      const match = /^key=(.+)$/m.exec(readFileSync(output, 'utf8'));
      assert.ok(match?.[1] !== undefined);
      return match[1];
    },
  };
}

/** What `actions/cache/restore` leaves behind on an exact hit. */
function restoreTree(sandbox: Sandbox, stamp: string): void {
  mkdirSync(join(sandbox.workspace, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(sandbox.workspace, 'node_modules', 'pkg', 'index.js'), 'restored\n');
  writeFileSync(join(sandbox.workspace, 'node_modules', stampFileName), `${stamp}\n`);
}

test('a miss installs with npm ci and stamps the tree with the exact key', () => {
  const sandbox = hostedSandbox();
  const key = sandbox.key();
  const result = sandbox.run(rootInstaller);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sandbox.npmCalls(), ['ci --no-audit --no-fund --prefer-offline']);
  assert.equal(readFileSync(join(sandbox.workspace, 'node_modules', stampFileName), 'utf8'), `${key}\n`);
});

test('an exact restored tree skips npm ci', () => {
  const sandbox = hostedSandbox();
  const key = sandbox.key();
  restoreTree(sandbox, key);
  const result = sandbox.run(rootInstaller, { NODE_MODULES_CACHE_HIT: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sandbox.npmCalls(), []);
  assert.match(result.stdout, /npm ci skipped/);
  assert.equal(readFileSync(join(sandbox.workspace, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'restored\n');
});

test('a restored tree is discarded and reinstalled when it cannot be proven exact', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly stamp: (key: string) => string | undefined;
    readonly environment: Readonly<Record<string, string>>;
    readonly reason: RegExp | undefined;
  }> = [
    { name: 'stamp from another key', stamp: () => 'example-node-modules-v1-other', environment: { NODE_MODULES_CACHE_HIT: 'true' }, reason: /stamped example-node-modules-v1-other/ },
    { name: 'no stamp', stamp: () => undefined, environment: { NODE_MODULES_CACHE_HIT: 'true' }, reason: /no key stamp/ },
    { name: 'npm ls rejects it', stamp: (key) => key, environment: { NODE_MODULES_CACHE_HIT: 'true', NPM_LS_STATUS: '1' }, reason: /npm ls --depth=0 rejected/ },
    { name: 'leftover tree without a restore this job', stamp: (key) => key, environment: {}, reason: undefined },
    { name: 'partial restore', stamp: (key) => key, environment: { NODE_MODULES_CACHE_HIT: 'false' }, reason: undefined },
  ];
  for (const scenario of cases) {
    const sandbox = hostedSandbox();
    const key = sandbox.key();
    mkdirSync(join(sandbox.workspace, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(sandbox.workspace, 'node_modules', 'pkg', 'index.js'), 'restored\n');
    writeFileSync(join(sandbox.workspace, 'node_modules', 'leftover.js'), 'stale\n');
    const stamp = scenario.stamp(key);
    if (stamp !== undefined) writeFileSync(join(sandbox.workspace, 'node_modules', stampFileName), `${stamp}\n`);
    const result = sandbox.run(rootInstaller, scenario.environment);
    assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
    assert.equal(sandbox.npmCalls().length, 1, scenario.name);
    if (scenario.reason !== undefined) assert.match(result.stderr, scenario.reason, scenario.name);
    assert.equal(existsSync(join(sandbox.workspace, 'node_modules', 'leftover.js')), false, scenario.name);
    assert.equal(readFileSync(join(sandbox.workspace, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'fresh\n', scenario.name);
    assert.equal(readFileSync(join(sandbox.workspace, 'node_modules', stampFileName), 'utf8'), `${key}\n`, scenario.name);
  }
});

test('a failed install leaves no stamped tree behind', () => {
  const sandbox = hostedSandbox();
  sandbox.key();
  writeFileSync(join(sandbox.workspace, 'package-lock.json'), '{"lockfileVersion":3}\n');
  const bin = resolve(sandbox.workspace, '..', 'bin', 'npm');
  writeFileSync(bin, '#!/usr/bin/env bash\nif [[ "$1" == --version ]]; then echo 11.6.0; exit 0; fi\nexit 9\n');
  const result = sandbox.run(rootInstaller);
  assert.equal(result.status, 9);
  assert.equal(existsSync(join(sandbox.workspace, 'node_modules', stampFileName)), false);
});

test('the key step empties the restore path so a restore never merges into leftovers', () => {
  const sandbox = hostedSandbox();
  mkdirSync(join(sandbox.workspace, 'node_modules'));
  writeFileSync(join(sandbox.workspace, 'node_modules', 'leftover.js'), 'stale\n');
  sandbox.key();
  assert.equal(existsSync(join(sandbox.workspace, 'node_modules')), false);
});

test('the key changes with every input that shapes the installed tree', () => {
  const sandbox = hostedSandbox();
  const base = sandbox.key();
  assert.equal(sandbox.key(), base, 'the key is deterministic');
  assert.match(base, new RegExp(`^example-node-modules-v1-${process.platform}-${process.arch}-ubuntu24-node${process.version.slice(1)}-npm11\\.6\\.0-[0-9a-f]{64}$`));
  const variants: ReadonlyArray<Readonly<Record<string, string>>> = [
    { FAKE_NPM_VERSION: '11.7.0' },
    { ImageOS: 'ubuntu22' },
    { NODE_ENV: 'production' },
    { npm_config_omit: 'dev' },
    { NPM_CONFIG_IGNORE_SCRIPTS: 'true' },
  ];
  for (const environment of variants) {
    assert.notEqual(sandbox.key(environment), base, JSON.stringify(environment));
  }
  writeFileSync(join(sandbox.workspace, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  const lockfileChanged = sandbox.key();
  assert.notEqual(lockfileChanged, base, 'lockfile');
  writeFileSync(join(sandbox.workspace, 'package.json'), '{"name":"fixture","version":"2.0.0"}\n');
  const manifestChanged = sandbox.key();
  assert.notEqual(manifestChanged, lockfileChanged, 'manifest');
  writeFileSync(join(sandbox.workspace, '.npmrc'), 'legacy-peer-deps=true\n');
  const configAdded = sandbox.key();
  assert.notEqual(configAdded, manifestChanged, 'adding a project .npmrc');
  writeFileSync(join(sandbox.workspace, '.npmrc'), 'omit=dev\n');
  assert.notEqual(sandbox.key(), configAdded, 'changing the project .npmrc');
});

test('the key step fails without a step output file', () => {
  const sandbox = hostedSandbox();
  const result = sandbox.run(keyAction, { GITHUB_OUTPUT: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GITHUB_OUTPUT is required/);
});

test('persistent runners clone a private validated tree and skip the second install', () => {
  const sandbox = hostedSandbox();
  const environment = { RUNNER_ENVIRONMENT: 'self-hosted' };
  assert.equal(sandbox.run(rootInstaller, environment).status, 0);
  writeFileSync(join(sandbox.workspace, 'node_modules', 'pkg', 'index.js'), 'job mutation\n');
  const second = sandbox.run(rootInstaller, environment);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(sandbox.npmCalls().length, 1);
  assert.equal(readFileSync(join(sandbox.workspace, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'fresh\n');
  assert.match(second.stdout, /from the runner cache/);
});

test('an unreadable persistent stamp triggers installation and repairs future reuse', () => {
  const sandbox = hostedSandbox();
  const environment = { RUNNER_ENVIRONMENT: 'self-hosted' };
  assert.equal(sandbox.run(rootInstaller, environment).status, 0);
  const key = readFileSync(join(sandbox.workspace, 'node_modules', stampFileName), 'utf8').trim();
  const cachedStamp = resolve(sandbox.workspace, '..', '_tool', 'example-node-modules',
    process.version, key, 'node_modules', stampFileName);
  rmSync(cachedStamp);
  mkdirSync(cachedStamp);
  const repair = sandbox.run(rootInstaller, environment);
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stderr, /key stamp is unreadable/);
  assert.equal(sandbox.npmCalls().length, 2);
  const warm = sandbox.run(rootInstaller, environment);
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(sandbox.npmCalls().length, 2);
});

test('an unreadable cached package falls back to installation and repairs the publication', (context) => {
  if (process.getuid?.() === 0) { context.skip('root bypasses file read permissions'); return; }
  const sandbox = hostedSandbox();
  const environment = { RUNNER_ENVIRONMENT: 'self-hosted' };
  assert.equal(sandbox.run(rootInstaller, environment).status, 0);
  const key = readFileSync(join(sandbox.workspace, 'node_modules', stampFileName), 'utf8').trim();
  const cachedPackage = resolve(sandbox.workspace, '..', '_tool', 'example-node-modules',
    process.version, key, 'node_modules', 'pkg', 'index.js');
  chmodSync(cachedPackage, 0);
  const repair = sandbox.run(rootInstaller, environment);
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stderr, /Discarding unreadable runner-cached node_modules/);
  assert.equal(sandbox.npmCalls().length, 2);
  const warm = sandbox.run(rootInstaller, environment);
  assert.equal(warm.status, 0, warm.stderr);
  assert.equal(sandbox.npmCalls().length, 2);
});

test('persistent reuse refuses changed installation environment, npm and project configuration', () => {
  const sandbox = hostedSandbox();
  const environment = { RUNNER_ENVIRONMENT: 'self-hosted' };
  assert.equal(sandbox.run(rootInstaller, environment).status, 0);
  const changes: ReadonlyArray<Readonly<Record<string, string>>> = [
    { NODE_ENV: 'production' }, { npm_config_omit: 'dev' }, { FAKE_NPM_VERSION: '11.7.0' },
  ];
  for (const change of changes) {
    const result = sandbox.run(rootInstaller, { ...environment, ...change });
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(join(sandbox.workspace, '.npmrc'), 'legacy-peer-deps=true\n');
  assert.equal(sandbox.run(rootInstaller, environment).status, 0);
  assert.equal(sandbox.npmCalls().length, 5, 'each distinct input requires its own install');
});

test('persistent reuse discards a tree rejected by npm instead of running against broken dependencies', () => {
  const sandbox = hostedSandbox();
  const environment = { RUNNER_ENVIRONMENT: 'self-hosted' };
  assert.equal(sandbox.run(rootInstaller, environment).status, 0);
  const result = sandbox.run(rootInstaller, { ...environment, NPM_LS_STATUS: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(sandbox.npmCalls().length, 2);
  assert.match(result.stderr, /Discarding runner-cached node_modules.*npm ls/);
  const recovered = sandbox.run(rootInstaller, environment);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(sandbox.npmCalls().length, 2, 'a rejected publication is replaced, not reinstalled forever');
  assert.match(recovered.stdout, /from the runner cache/);
});

const stepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const stepsOf = (workflow: string, job: string) =>
  z.array(stepSchema).parse(workflowJob(workflow, job).steps);

test('PR lanes restore by exact key on hosted runners, never save, and pass the hit to the installer', () => {
  for (const job of [
    'lint', 'server-static', 'server-process-tests', 'server-tests', 'targeted-server-tests',
    'ios-contracts', 'database-integration',
  ]) {
    const steps = stepsOf('pr-checks.yml', job);
    const keyIndex = steps.findIndex((step) => step.id === 'node-modules-key');
    const restoreIndex = steps.findIndex((step) => step.id === 'node-modules-restore');
    const installIndex = steps.findIndex((step) => step.name === 'Install Node.js dependencies');
    assert.ok(keyIndex >= 0 && keyIndex < restoreIndex && restoreIndex < installIndex, job);
    const restore = steps[restoreIndex];
    assert.match(restore?.uses ?? '', /^actions\/cache\/restore@[0-9a-f]{40}$/, job);
    assert.deepEqual(Object.keys(restore?.with ?? {}).sort(), ['key', 'path'], `${job}: exact key only`);
    assert.equal(restore?.with?.['path'], 'node_modules', job);
    for (const step of [steps[keyIndex], restore]) {
      assert.match(step?.if ?? '', /^runner\.environment == 'github-hosted'/, job);
    }
    assert.equal(steps[installIndex]?.env?.['NODE_MODULES_CACHE_HIT'],
      '${{ steps.node-modules-restore.outputs.cache-hit }}', job);
    assert.equal(steps[installIndex]?.env?.['RUNNER_ENVIRONMENT'], '${{ runner.environment }}', job);
  }
  const document = workflowDocument('pr-checks.yml');
  for (const [job, value] of Object.entries(document.jobs)) {
    const steps = z.object({ steps: z.array(stepSchema).optional() }).passthrough().parse(value).steps ?? [];
    for (const step of steps) {
      assert.ok(!/^actions\/cache(\/save)?@/.test(step.uses ?? ''), `${job} must not write the cache`);
    }
  }
});

test('only the develop writer saves, and only after a missed lookup', () => {
  const document = z.object({
    on: z.object({
      push: z.object({ branches: z.array(z.string()), paths: z.array(z.string()) }),
    }).passthrough(),
    permissions: z.record(z.string(), z.string()),
  }).passthrough().parse(workflowDocument('node-modules-cache.yml'));
  assert.deepEqual(document.on.push.branches, ['develop']);
  for (const input of [
    'package.json', 'package-lock.json', '.npmrc', 'ci/src/nodeModulesCache.ts',
    '.github/workflows/pr-checks.yml',
  ]) {
    assert.ok(document.on.push.paths.includes(input), input);
  }
  assert.deepEqual(document.permissions, { contents: 'read' });
  const steps = stepsOf('node-modules-cache.yml', 'populate');
  const setup = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  const prSetup = stepsOf('pr-checks.yml', 'server-tests').find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(setup?.with?.['node-version'], prSetup?.with?.['node-version'], 'keys need the lanes\' Node');
  const install = steps.find((step) => step.name === 'Install Node.js dependencies');
  assert.equal(install?.env?.['RUNNER_ENVIRONMENT'], '${{ runner.environment }}');
  const saves = steps.filter((step) => step.uses?.startsWith('actions/cache/save@'));
  assert.equal(saves.length, 1);
  assert.equal(saves[0]?.with?.['key'], '${{ steps.node-modules-key.outputs.key }}');
  assert.equal(saves[0]?.with?.['path'], 'node_modules');
  assert.equal(saves[0]?.if, "steps.node-modules-lookup.outputs.cache-hit != 'true'");
});

test('real-server E2E lanes reuse dependencies only after exact-revision admission', () => {
  for (const job of ['onboarding-e2e', 'chat-plaid-e2e', 'income-e2e', 'budget-e2e']) {
    const steps = stepsOf('ios-tests.yml', job);
    const guard = steps.findIndex(step => step.name === 'Verify exact iOS test revision');
    const install = steps.findIndex(step => step.name === 'Install Node.js dependencies');
    assert.ok(guard >= 0 && install > guard, job);
    assert.equal(steps[install]?.run, 'node ci/src/actions/installNodeDependencies.ts', job);
    assert.equal(steps[install]?.env?.['RUNNER_ENVIRONMENT'], '${{ runner.environment }}', job);
    assert.ok(!steps.some(step => step.run === 'npm ci'), job);
    assert.ok(!steps.some(step => step.uses?.startsWith('actions/cache/save@')
      && step.with?.['path'] === 'node_modules'), job);
  }
});

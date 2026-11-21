import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { workflowJob } from '../src/workflowStepShell.ts';

const entrypoint = resolve('ci/src/actions/installWorkflowContractDependencies.ts');
const ciPackageEntrypoint = resolve('ci/src/actions/installCiPackageDependencies.ts');

function fixture(exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-contract-deps-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'ci'));
  writeFileSync(join(root, 'ci', 'package.json'), '{"name":"ci-fixture"}\n');
  writeFileSync(join(root, 'ci', 'package-lock.json'), '{"lockfileVersion":3}\n');
  const npmLog = join(root, 'npm-args');
  writeFileSync(join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> "$NPM_LOG"',
    `if [ ${exitCode} -ne 0 ]; then exit ${exitCode}; fi`,
    'mkdir -p ci/node_modules/js-yaml',
    'printf "export default 1;\\n" > ci/node_modules/js-yaml/index.js',
  ].join('\n'));
  chmodSync(join(bin, 'npm'), 0o755);
  const run = () => spawnSync(process.execPath, [entrypoint], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, NPM_LOG: npmLog },
  });
  return { root, npmLog, run };
}

test('workflow contracts install the small CI package and resolve legacy imports through it', () => {
  const { root, npmLog, run } = fixture();
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(npmLog, 'utf8'), 'ci --prefix ci --no-audit --no-fund --ignore-scripts --prefer-offline\n');
  const modules = join(root, 'node_modules');
  assert.ok(lstatSync(modules).isSymbolicLink());
  assert.equal(readlinkSync(modules), 'ci/node_modules');
  assert.ok(existsSync(join(modules, 'js-yaml', 'index.js')));
});

test('failed installs do not expose a partial dependency tree', () => {
  const { root, run } = fixture(7);
  assert.equal(run().status, 7);
  assert.equal(existsSync(join(root, 'node_modules')), false);
});

test('shared CI package installer leaves root module resolution untouched', () => {
  const { root, npmLog } = fixture();
  const result = spawnSync(process.execPath, [ciPackageEntrypoint], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, NPM_LOG: npmLog },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(npmLog, 'utf8'), 'ci --prefix ci --no-audit --no-fund --ignore-scripts\n');
  assert.equal(existsSync(join(root, 'node_modules')), false);
  assert.ok(existsSync(join(root, 'ci', 'node_modules', 'js-yaml', 'index.js')));
});

test('the installer never replaces a pre-existing application dependency tree', () => {
  const { root, npmLog, run } = fixture();
  mkdirSync(join(root, 'node_modules'));
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires an empty root node_modules path/);
  assert.equal(existsSync(npmLog), false);
});

test('the workflow-contract lane gives the check runner sole ownership of dependency setup', () => {
  const job = workflowJob('pr-checks.yml', 'workflow-contracts');
  assert.equal(job.steps?.some((step) => step.name === 'Install Node.js dependencies'), false);
  const validate = job.steps?.find((step) => step.name === 'Validate typed CI contracts');
  assert.equal(validate?.run, 'npm run ci:check -- --workflow-contracts');
  assert.equal(job.steps?.some((step) => step.run === 'node ci/src/actions/installNodeDependencies.ts'), false);
});

const checkEntrypoint = resolve('ci/scripts/check.ts');
function checkFixture(installExit = 0, failCheck = '') {
  const { root, npmLog } = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
    'ci:check': 'node ci/scripts/check.ts', 'ci:deps': 'node ci/src/actions/installCiPackageDependencies.ts',
    'ci:alpha': 'test alpha', 'ci:omega': 'test omega',
  } }));
  writeFileSync(join(root, 'bin', 'npm'), `#!${process.execPath}\n` + `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'ci') {
  if (${installExit} !== 0) process.exit(${installExit});
  fs.mkdirSync('ci/node_modules', { recursive: true });
} else if (args.at(-1) === 'ci:deps') {
  const result = spawnSync(process.execPath, [${JSON.stringify(ciPackageEntrypoint)}], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else if (args.at(-1) === ${JSON.stringify(failCheck)}) process.exit(9);
`);
  chmodSync(join(root, 'bin', 'npm'), 0o755);
  const run = (args: string[] = ['--workflow-contracts']) => spawnSync(process.execPath,
    [checkEntrypoint, ...args], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, NPM_LOG: npmLog },
    });
  const calls = (): string[][] => readFileSync(npmLog, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as string[]);
  return { root, npmLog, run, calls };
}

test('the actual workflow check CLI installs once and executes every remaining check', () => {
  const { root, run, calls } = checkFixture();
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), [
    ['ci', '--prefix', 'ci', '--no-audit', '--no-fund', '--ignore-scripts', '--prefer-offline'],
    ['run', '-s', 'ci:alpha'], ['run', '-s', 'ci:omega'],
  ]);
  assert.ok(lstatSync(join(root, 'node_modules')).isSymbolicLink());
});

test('local check mode also installs once and preserves existing application dependencies', () => {
  const { root, run, calls } = checkFixture();
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'keep'), 'application-owned');
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(), [
    ['run', '-s', 'ci:deps'], ['ci', '--prefix', 'ci', '--no-audit', '--no-fund', '--ignore-scripts'],
    ['run', '-s', 'ci:alpha'], ['run', '-s', 'ci:omega'],
  ]);
  assert.equal(readFileSync(join(root, 'node_modules', 'keep'), 'utf8'), 'application-owned');
});

test('workflow check mode fails closed before validation on install failure or conflicting modules', () => {
  const failed = checkFixture(7);
  assert.equal(failed.run().status, 7);
  assert.equal(failed.calls().length, 1);
  assert.equal(existsSync(join(failed.root, 'node_modules')), false);
  const conflict = checkFixture();
  mkdirSync(join(conflict.root, 'node_modules'));
  assert.notEqual(conflict.run().status, 0);
  assert.equal(existsSync(conflict.npmLog), false);
});

test('unknown CLI modes or missing dependency ownership cannot bypass installation, and failed checks stop the sequence', () => {
  const invalid = checkFixture();
  assert.notEqual(invalid.run(['--preinstalled']).status, 0);
  assert.equal(existsSync(invalid.npmLog), false);
  writeFileSync(join(invalid.root, 'package.json'), JSON.stringify({ scripts: { 'ci:test': 'test' } }));
  assert.notEqual(invalid.run().status, 0);
  assert.equal(existsSync(invalid.npmLog), false);
  const failedCheck = checkFixture(0, 'ci:alpha');
  assert.equal(failedCheck.run().status, 9);
  assert.equal(failedCheck.calls().length, 2);
});

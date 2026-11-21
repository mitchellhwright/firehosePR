import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { auditRunnerEnvironment } from '../src/actions/auditRunnerEnvironment.ts';
import { JOB_COMPLETED_HOOK_SOURCE, installJobCompletedHook } from '../src/actions/installJobCompletedHook.ts';

const macosPath = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function fixture(t: import('node:test').TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'example-runner-audit-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runnerRoot = join(root, 'runner');
  const workRoot = join(runnerRoot, '_work');
  const runnerTemp = join(workRoot, '_temp');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const runnerName = 'fixture-runner';
  const hookRoot = join(home, '.local/libexec/example-actions-runner', runnerName);
  const node = join(runnerRoot, 'externals/node24/bin/node');
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(join(workspace, 'ci/src/runnerHooks'), { recursive: true });
  mkdirSync(dirname(node), { recursive: true });
  writeFileSync(join(workspace, JOB_COMPLETED_HOOK_SOURCE), 'console.log("hook");\n');
  writeFileSync(node, '#!/bin/sh\n');
  chmodSync(node, 0o755);
  const { launcher: hookPath, script: hookScript } = installJobCompletedHook({
    repositoryRoot: workspace, runnerRoot, hookRoot,
  });
  writeFileSync(join(runnerRoot, '.path'), `${macosPath}\n`);
  writeFileSync(join(runnerRoot, '.env'), [
    `EXAMPLE_ACTIONS_RUNNER_ROOT=${runnerRoot}`,
    'EXAMPLE_ACTIONS_RUNNER_WORKDIR=_work',
    `ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${hookPath}`,
    '',
  ].join('\n'));
  const env: NodeJS.ProcessEnv = {
    EXPECTED_PLATFORM: 'linux',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    RUNNER_NAME: runnerName,
    HOME: home,
    ACTIONS_RUNNER_HOOK_JOB_COMPLETED: hookPath,
    EXAMPLE_ACTIONS_RUNNER_ROOT: runnerRoot,
    EXAMPLE_ACTIONS_RUNNER_WORKDIR: '_work',
  };
  const calls: string[] = [];
  const run = (program: string, args: readonly string[]) => { calls.push([program, ...args].join(' ')); };
  return { env, calls, run, runnerRoot, runnerTemp, hookPath, hookScript, node, workspace };
}

test('accepts an active Linux listener with the exact executable hook and persistent environment', t => {
  const f = fixture(t);
  auditRunnerEnvironment({ env: f.env, platform: 'linux', run: f.run });
  assert.deepEqual(f.calls, [`df -h ${f.runnerTemp}`]);
});

test('checks provisioned tools and persistent PATH on a macOS listener', t => {
  const f = fixture(t);
  f.env.EXPECTED_PLATFORM = 'macos';
  auditRunnerEnvironment({ env: f.env, platform: 'darwin', run: f.run });
  assert.deepEqual(f.calls, [
    `bash ${join(f.workspace, 'scripts/provision-github-macos-runner-tools.sh')} --verify-only`,
    `node ${join(f.workspace, 'ci/src/actions/ios/selectXcode.ts')} 27.0@27A266a`,
    `df -h ${f.runnerTemp}`,
  ]);
  writeFileSync(join(f.runnerRoot, '.path'), '/usr/bin:/bin\n');
  assert.throws(
    () => auditRunnerEnvironment({ env: f.env, platform: 'darwin', run: f.run }),
    /active macOS listener has not loaded the persistent runner PATH/,
  );
});

test('does not approve a macOS listener without an accepted Xcode build', t => {
  const f = fixture(t);
  f.env.EXPECTED_PLATFORM = 'macos';
  assert.throws(() => auditRunnerEnvironment({
    env: f.env,
    platform: 'darwin',
    run(program, args) {
      f.run(program, args);
      if (program === 'node') throw new Error('No accepted Xcode build installed');
    },
  }), /No accepted Xcode build installed/);
  assert.equal(f.calls.some(call => call.startsWith('df -h')), false);
});

test('rejects a stale active listener or altered installed hook', t => {
  const f = fixture(t);
  f.env.ACTIONS_RUNNER_HOOK_JOB_COMPLETED = join(f.hookPath, 'stale');
  assert.throws(
    () => auditRunnerEnvironment({ env: f.env, platform: 'linux', run: f.run }),
    /has not loaded/,
  );
  f.env.ACTIONS_RUNNER_HOOK_JOB_COMPLETED = f.hookPath;
  writeFileSync(f.hookScript, 'console.log("altered");\n');
  assert.throws(
    () => auditRunnerEnvironment({ env: f.env, platform: 'linux', run: f.run }),
    /does not match the trusted repository source/,
  );
  rmSync(f.hookScript);
  assert.throws(
    () => auditRunnerEnvironment({ env: f.env, platform: 'linux', run: f.run }),
    /does not match the trusted repository source/,
  );
});

test('rejects a launcher that is not the generated hand-off to the bundled Node', t => {
  const f = fixture(t);
  writeFileSync(f.hookPath, '#!/bin/sh\nexit 0\n');
  assert.throws(
    () => auditRunnerEnvironment({ env: f.env, platform: 'linux', run: f.run }),
    /launcher does not run .*job-completed\.mts on the runner's bundled Node/,
  );
  chmodSync(f.hookPath, 0o644);
  assert.throws(
    () => auditRunnerEnvironment({ env: f.env, platform: 'linux', run: f.run }),
    /Installed cleanup hook is missing or not executable/,
  );
});

test('rejects a runner whose bundled Node can no longer run the hook', t => {
  const f = fixture(t);
  rmSync(dirname(dirname(f.node)), { recursive: true });
  assert.throws(
    () => auditRunnerEnvironment({ env: f.env, platform: 'linux', run: f.run }),
    /No executable bundled Node 24 or newer/,
  );
});

test('rejects a persistent environment that does not match the active listener', t => {
  const f = fixture(t);
  writeFileSync(join(f.runnerRoot, '.env'), 'EXAMPLE_ACTIONS_RUNNER_WORKDIR=_work\n');
  assert.throws(
    () => auditRunnerEnvironment({ env: f.env, platform: 'linux', run: f.run }),
    /Runner environment file is missing EXAMPLE_ACTIONS_RUNNER_ROOT=/,
  );
});

test('rejects a host whose actual platform differs from the dispatch', t => {
  const f = fixture(t);
  assert.throws(
    () => auditRunnerEnvironment({ env: f.env, platform: 'darwin', run: f.run }),
    /Expected linux runner, got Darwin/,
  );
  assert.deepEqual(f.calls, []);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  JOB_COMPLETED_HOOK_SOURCE, installJobCompletedHook, renderLauncher, resolveRunnerNode,
} from '../src/actions/installJobCompletedHook.ts';
import {
  HookFailure, cleanupOwnedMacosSimulators, completedJobProcesses, ownedSimulatorUdids,
  onlyVanishedEntries, parseLsofCwdPids, parseProcessList, pruneDiagnostics, removeTempEntries,
  resolveRunnerPaths, runCommand, runJobCompletedHook, terminateCompletedJobProcesses,
  type CommandResult, type HookSystem,
} from '../src/runnerHooks/jobCompleted.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  error.code = code;
  return error;
}

function runner(t: import('node:test').TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'example-job-completed-')));
  t.after(() => {
    spawnSync('chmod', ['-R', 'u+rwx', root]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runnerRoot = join(root, 'runner');
  const runnerTemp = join(runnerRoot, '_work/_temp');
  const diag = join(runnerRoot, '_diag');
  const outside = join(root, 'outside');
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.mkdirSync(diag, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    EXAMPLE_ACTIONS_RUNNER_ROOT: runnerRoot,
    EXAMPLE_ACTIONS_RUNNER_WORKDIR: '_work',
    RUNNER_TEMP: runnerTemp,
  };
  return { root, runnerRoot, runnerTemp, diag, outside, env };
}

function write(path: string, content = 'x', ageDays = 0): void {
  fs.mkdirSync(join(path, '..'), { recursive: true });
  fs.writeFileSync(path, content);
  const time = new Date(NOW - ageDays * DAY);
  fs.utimesSync(path, time, time);
}

type Interceptor = (program: string, args: readonly string[]) => CommandResult | undefined;

/** Runs the real platform tools (absolute paths) and fakes everything else, recording each call. */
function fakeSystem(overrides: Partial<HookSystem> = {}, intercept: Interceptor = () => undefined) {
  const logs: string[] = [];
  const commands: string[] = [];
  const signals: string[] = [];
  const system: HookSystem = {
    fs,
    platform: 'linux',
    selfPids: new Set([1]),
    run: (program, args): CommandResult => {
      commands.push([program, ...args].join(' '));
      const intercepted = intercept(program, args);
      if (intercepted !== undefined) return intercepted;
      return program.startsWith('/') ? runCommand(program, args) : { status: 0, stdout: '' };
    },
    kill: (pid, name) => { signals.push(`${name} ${pid}`); },
    log: (message) => { logs.push(message); },
    ...overrides,
  };
  return { system, logs, commands, signals };
}

test('empties RUNNER_TEMP, including dot entries and read-only trees, and keeps the directory', (t) => {
  const r = runner(t);
  write(join(r.runnerTemp, 'plain.txt'));
  write(join(r.runnerTemp, '.hidden'));
  write(join(r.runnerTemp, 'nested/deep/file.txt'));
  write(join(r.runnerTemp, 'gomodcache/pkg@v1/go.mod'));
  fs.chmodSync(join(r.runnerTemp, 'gomodcache/pkg@v1/go.mod'), 0o444);
  fs.chmodSync(join(r.runnerTemp, 'gomodcache/pkg@v1'), 0o555);
  fs.chmodSync(join(r.runnerTemp, 'gomodcache'), 0o555);
  fs.mkdirSync(join(r.runnerTemp, 'locked'), { mode: 0o000 });
  const { system, logs } = fakeSystem();
  assert.equal(removeTempEntries(system, r.runnerTemp), 5);
  assert.deepEqual(logs, []);
  assert.deepEqual(fs.readdirSync(r.runnerTemp), []);
});

test('delegates removal to rm and chmod with physical traversal and argument arrays', (t) => {
  const r = runner(t);
  write(join(r.runnerTemp, 'dir/file'));
  write(join(r.runnerTemp, 'file'));
  fs.symlinkSync(r.outside, join(r.runnerTemp, 'link'));
  const { system, commands } = fakeSystem();
  removeTempEntries(system, r.runnerTemp);
  assert.deepEqual(commands.sort(), [
    `/bin/chmod -R u+rwX ${join(r.runnerTemp, 'dir')}`,
    `/bin/rm -rf -- ${join(r.runnerTemp, 'dir')}`,
    `/bin/rm -rf -- ${join(r.runnerTemp, 'file')}`,
    `/bin/rm -rf -- ${join(r.runnerTemp, 'link')}`,
  ]);
});

test('removes symlinks in RUNNER_TEMP without touching their targets', (t) => {
  const r = runner(t);
  write(join(r.outside, 'keep.txt'));
  write(join(r.outside, 'dir/keep.txt'));
  fs.symlinkSync(join(r.outside, 'keep.txt'), join(r.runnerTemp, 'file-link'));
  fs.symlinkSync(join(r.outside, 'dir'), join(r.runnerTemp, 'dir-link'));
  fs.mkdirSync(join(r.runnerTemp, 'real'));
  fs.symlinkSync(r.outside, join(r.runnerTemp, 'real/outside-link'));
  fs.symlinkSync(join(r.outside, 'missing'), join(r.runnerTemp, 'dangling'));
  fs.chmodSync(join(r.outside, 'dir'), 0o555);
  assert.equal(removeTempEntries(fakeSystem().system, r.runnerTemp), 4);
  assert.deepEqual(fs.readdirSync(r.runnerTemp), []);
  assert.ok(fs.existsSync(join(r.outside, 'keep.txt')));
  assert.ok(fs.existsSync(join(r.outside, 'dir/keep.txt')));
  assert.equal(fs.statSync(join(r.outside, 'dir')).mode & 0o777, 0o555);
});

test('a leftover process swapping an entered ancestor and a subdirectory for symlinks cannot steer removal', (t) => {
  const r = runner(t);
  const job = join(r.runnerTemp, 'job');
  write(join(job, 'sub/victim'));
  write(join(job, 'inner/victim'));
  const moved = join(r.outside, 'job-moved');
  const movedInner = join(r.outside, 'inner-moved');
  // After the hook inspected job/ as a real directory, the process moves it
  // (and a subdirectory) out of RUNNER_TEMP and leaves symlinks in their place.
  const { system } = fakeSystem({}, (program, args) => {
    if (program !== '/bin/chmod') return undefined;
    const result = runCommand(program, args);
    fs.renameSync(join(job, 'inner'), movedInner);
    fs.symlinkSync(movedInner, join(job, 'inner'));
    fs.renameSync(job, moved);
    fs.symlinkSync(moved, job);
    return result;
  });
  assert.equal(removeTempEntries(system, r.runnerTemp), 1);
  assert.deepEqual(fs.readdirSync(r.runnerTemp), []);
  assert.ok(fs.existsSync(join(moved, 'sub/victim')));
  assert.ok(fs.existsSync(join(movedInner, 'victim')));
});

test('a temp entry that cannot be removed or remains fails the job', (t) => {
  const r = runner(t);
  write(join(r.runnerTemp, 'job/a.txt'));
  const entry = join(r.runnerTemp, 'job');
  const denied = fakeSystem({}, (program) => (program === '/bin/rm'
    ? { status: 1, stdout: '', stderr: `rm: ${entry}/a.txt: Permission denied\n` }
    : undefined));
  assert.throws(() => removeTempEntries(denied.system, r.runnerTemp), new HookFailure(
    `failed to remove completed-job temp entry: ${entry} (exit 1: rm: ${entry}/a.txt: Permission denied)`));
  const stuck = fakeSystem({}, (program) => (program === '/bin/rm' ? { status: 0, stdout: '' } : undefined));
  assert.throws(() => removeTempEntries(stuck.system, r.runnerTemp),
    new HookFailure(`completed-job temp entry remains after cleanup: ${entry}`));
});

test('diagnostic retention removes files older than two days and the directories they empty', (t) => {
  const r = runner(t);
  write(join(r.diag, 'Runner_fresh.log'), 'x', 1);
  write(join(r.diag, 'Runner_old.log'), 'x', 5);
  write(join(r.diag, 'pages/old/page.log'), 'x', 4);
  write(join(r.diag, 'mixed/old.log'), 'x', 4);
  write(join(r.diag, 'mixed/new.log'), 'x', 0);
  fs.mkdirSync(join(r.diag, 'already-empty'));
  write(join(r.outside, 'old-target.log'), 'x', 9);
  write(join(r.outside, 'dir/old.log'), 'x', 9);
  fs.symlinkSync(join(r.outside, 'old-target.log'), join(r.diag, 'old-link'));
  fs.lutimesSync(join(r.diag, 'old-link'), new Date(NOW - 9 * DAY), new Date(NOW - 9 * DAY));
  fs.symlinkSync(join(r.outside, 'dir'), join(r.diag, 'outside-dir'));

  const result = pruneDiagnostics(fakeSystem().system, r.diag);
  assert.deepEqual(result, { removedFiles: 3, removedDirectories: 3, warnings: [] });
  assert.deepEqual(fs.readdirSync(r.diag).sort(), ['Runner_fresh.log', 'mixed', 'old-link', 'outside-dir']);
  assert.deepEqual(fs.readdirSync(join(r.diag, 'mixed')), ['new.log']);
  assert.ok(fs.existsSync(join(r.outside, 'old-target.log')));
  assert.ok(fs.existsSync(join(r.outside, 'dir/old.log')));
});

test('diagnostic retention keeps an emptied root and ignores a missing one', (t) => {
  const r = runner(t);
  write(join(r.diag, 'old.log'), 'x', 5);
  assert.equal(pruneDiagnostics(fakeSystem().system, r.diag).removedFiles, 1);
  assert.ok(fs.existsSync(r.diag));
  fs.rmdirSync(r.diag);
  assert.deepEqual(pruneDiagnostics(fakeSystem().system, r.diag),
    { removedFiles: 0, removedDirectories: 0, warnings: [] });
});

test('a symlinked diagnostic root is skipped, so its target is never pruned', (t) => {
  const r = runner(t);
  fs.rmdirSync(r.diag);
  write(join(r.outside, 'old.log'), 'x', 9);
  write(join(r.outside, 'nested/old.log'), 'x', 9);
  fs.mkdirSync(join(r.outside, 'empty'));
  fs.symlinkSync(r.outside, r.diag);
  const { system, commands } = fakeSystem();
  assert.deepEqual(pruneDiagnostics(system, r.diag), {
    removedFiles: 0, removedDirectories: 0, warnings: [`skipped ${r.diag}: not a real directory`],
  });
  assert.deepEqual(commands, []);
  assert.ok(fs.existsSync(join(r.outside, 'old.log')));
  assert.ok(fs.existsSync(join(r.outside, 'nested/old.log')));
  assert.ok(fs.existsSync(join(r.outside, 'empty')));
});

const vanishedPage = "find: '/home/example-runner/actions-runner-example-control/_diag/pages/ecc03db1_1.log': "
  + 'No such file or directory\n';

test('recognises find output that only reports entries the listener removed first', () => {
  assert.equal(onlyVanishedEntries(vanishedPage), true);
  assert.equal(onlyVanishedEntries(`${vanishedPage}${vanishedPage}`), true);
  assert.equal(onlyVanishedEntries(`${vanishedPage}find: '/x': Permission denied\n`), false);
  assert.equal(onlyVanishedEntries(''), false);
});

test('the whole hook passes when the listener races diagnostic retention', (t) => {
  const r = runner(t);
  write(join(r.runnerTemp, 'job.sh'));
  const { system, logs } = fakeSystem({}, (program, args) => (program === '/usr/bin/find' && args.includes('f')
    ? { status: 1, stdout: `${r.diag}/pages/ecc03db1_2.log\n`, stderr: vanishedPage }
    : undefined));
  runJobCompletedHook(r.env, system);
  assert.deepEqual(logs, [
    `diagnostic retention: entries vanished while pruning ${r.diag}; the listener rotated them first`,
    'pruned 1 diagnostic files and 0 empty directories',
    `removed 1 completed-job temp entries from ${r.runnerTemp}`,
  ]);
  assert.deepEqual(fs.readdirSync(r.runnerTemp), []);
});

test('other diagnostic errors are reported without failing the job', (t) => {
  const r = runner(t);
  const { system } = fakeSystem({}, (program) => (program === '/usr/bin/find'
    ? { status: 1, stdout: '', stderr: `find: '${r.diag}/locked': Permission denied\n` }
    : undefined));
  const result = pruneDiagnostics(system, r.diag);
  assert.equal(result.removedFiles, 0);
  assert.deepEqual(result.warnings, [
    `could not prune ${r.diag} (exit 1: find: '${r.diag}/locked': Permission denied)`,
    `could not prune ${r.diag} (exit 1: find: '${r.diag}/locked': Permission denied)`,
  ]);
});

test('rejects a runner environment it cannot trust', (t) => {
  const r = runner(t);
  const cases: [NodeJS.ProcessEnv, string][] = [
    [{ ...r.env, EXAMPLE_ACTIONS_RUNNER_ROOT: 'relative' }, 'EXAMPLE_ACTIONS_RUNNER_ROOT must be an absolute path.'],
    [{ ...r.env, EXAMPLE_ACTIONS_RUNNER_ROOT: undefined }, 'EXAMPLE_ACTIONS_RUNNER_ROOT must be an absolute path.'],
    [{ ...r.env, EXAMPLE_ACTIONS_RUNNER_WORKDIR: '../_work' }, 'EXAMPLE_ACTIONS_RUNNER_WORKDIR must be a relative directory name.'],
    [{ ...r.env, EXAMPLE_ACTIONS_RUNNER_ROOT: join(r.root, 'absent') }, `runner root does not exist: ${join(r.root, 'absent')}`],
    [{ ...r.env, RUNNER_TEMP: undefined }, 'RUNNER_TEMP does not exist: '],
    [{ ...r.env, RUNNER_TEMP: r.outside },
      `RUNNER_TEMP must equal ${r.runnerTemp}; got ${r.outside}`],
  ];
  for (const [env, message] of cases) {
    assert.throws(() => resolveRunnerPaths(env, fs), new HookFailure(message));
  }
  assert.deepEqual(resolveRunnerPaths({ ...r.env, EXAMPLE_ACTIONS_RUNNER_WORKDIR: undefined }, fs),
    { runnerRoot: r.runnerRoot, runnerTemp: r.runnerTemp });
});

test('selects only processes the completed job left behind', () => {
  const temp = '/runner/_work/_temp';
  const processes = parseProcessList([
    '    1 /sbin/init',
    '   10 bash /runner/_work/_temp/abc.sh',
    '   11 /runner/bin/Runner.Worker spawnclient 1 2',
    '   12 /runner/bin/Runner.Listener run',
    '   13 sleep 100',
    '   14 node /runner/_work/_temporary/x.js',
    '   15 hook /runner/_work/_temp/self',
    'garbage',
  ].join('\n'));
  assert.equal(processes.length, 7);
  const cwdPids = parseLsofCwdPids(['p13', 'fcwd', `n${temp}/job`, 'p14', 'fcwd', 'n/elsewhere'].join('\n'), temp);
  assert.deepEqual([...cwdPids], [13]);
  assert.deepEqual(completedJobProcesses({ processes, cwdPids, runnerTemp: temp, selfPids: new Set([15]) }), [10, 13]);
});

test('terminates leftovers, then kills the ones that survive TERM', () => {
  let listings = 0;
  const { system, logs, signals } = fakeSystem({
    platform: 'darwin',
    run: (program) => {
      if (program === 'lsof') return { status: 0, stdout: '' };
      listings += 1;
      const stdout = listings === 1
        ? '20 bash /t/_temp/a.sh\n21 bash /t/_temp/b.sh\n22 bash /t/_temp/c.sh\n'
        : '21 bash /t/_temp/b.sh\n';
      return { status: 0, stdout };
    },
    kill: (pid, name) => {
      signals.push(`${name} ${pid}`);
      if (pid === 22) throw errno('ESRCH');
      if (pid === 20) throw errno('EPERM');
    },
  });
  terminateCompletedJobProcesses(system, '/t/_temp');
  assert.deepEqual(signals, ['SIGTERM 20', 'SIGTERM 21', 'SIGTERM 22', 'SIGKILL 21']);
  assert.deepEqual(logs, [
    'terminating completed-job process 20',
    'could not send SIGTERM to process 20: EPERM: simulated',
    'terminating completed-job process 21',
    'terminating completed-job process 22',
    'force-terminating completed-job process 21',
  ]);
});

const simctlJson = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
      { name: 'Example CI iPhone 42-1', udid: '8b2a9410-49f1-5e9a-aafd-7bd085649621' },
      { name: 'Example CI iPhone 42-2', udid: 'ba680a7a-1ee4-500f-87bb-0dda8b5240aa' },
      { name: 'Example CI iPhone 142-1', udid: '0ac6da83-b6d6-5ffc-b9b6-2ebe6e411fa6' },
      { name: 'Example CI  42-1', udid: '05e4c8d9-0411-5f9b-af5b-a42403ee0cda' },
      { name: 'Example CI 42-1', udid: '0b05367c-f88c-54ab-abfe-cf80d9506c00' },
      { name: 'iPhone 18 Pro 42-1', udid: '95daf316-d140-5208-af1e-f259f68803bc' },
      { name: 'Example CI iPad 42-1', udid: 'not-a-udid' },
    ],
  },
});

test('selects only simulators named for this run attempt', () => {
  assert.deepEqual(ownedSimulatorUdids(simctlJson, '42', '1'),
    ['8b2a9410-49f1-5e9a-aafd-7bd085649621']);
  assert.deepEqual(ownedSimulatorUdids('{}', '42', '1'), []);
});

function simulatorSystem(results: Record<string, CommandResult>) {
  const fake = fakeSystem({ platform: 'darwin' });
  const system: HookSystem = {
    ...fake.system,
    run: (program, args) => {
      const command = [program, ...args].join(' ');
      fake.commands.push(command);
      return results[command] ?? { status: 0, stdout: '' };
    },
  };
  return { ...fake, system };
}

test('deletes run-owned simulators and unavailable ones', () => {
  const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' };
  const s = simulatorSystem({
    'xcrun simctl list devices -j': { status: 0, stdout: simctlJson },
    'xcrun simctl shutdown 8b2a9410-49f1-5e9a-aafd-7bd085649621': { status: 149, stdout: '' },
  });
  cleanupOwnedMacosSimulators(s.system, env);
  assert.deepEqual(s.commands, [
    'xcrun simctl list devices -j',
    'xcrun simctl shutdown 8b2a9410-49f1-5e9a-aafd-7bd085649621',
    'xcrun simctl delete 8b2a9410-49f1-5e9a-aafd-7bd085649621',
    'xcrun simctl delete unavailable',
  ]);
});

test('skips simulators on Linux and outside a numbered run', () => {
  const linux = fakeSystem();
  cleanupOwnedMacosSimulators(linux.system, { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' });
  assert.deepEqual(linux.commands, []);
  const mac = simulatorSystem({});
  cleanupOwnedMacosSimulators(mac.system, { GITHUB_RUN_ID: '042', GITHUB_RUN_ATTEMPT: '1' });
  assert.deepEqual(mac.commands, []);
  assert.deepEqual(mac.logs, ['skipped simulator cleanup outside a numbered GitHub Actions run']);
});

test('simulator failures fail the job', () => {
  const env = { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' };
  const cases: [Record<string, CommandResult>, string][] = [
    [{ 'xcrun simctl list devices -j': { status: null, stdout: '', error: errno('ENOENT') } },
      'xcrun is unavailable for macOS simulator cleanup.'],
    [{ 'xcrun simctl list devices -j': { status: 1, stdout: '' } },
      'could not inventory run-owned macOS simulators (exit 1).'],
    [{ 'xcrun simctl list devices -j': { status: 0, stdout: 'not json' } },
      'could not inventory run-owned macOS simulators'],
    [{
      'xcrun simctl list devices -j': { status: 0, stdout: simctlJson },
      'xcrun simctl delete 8b2a9410-49f1-5e9a-aafd-7bd085649621': { status: 1, stdout: '' },
    }, 'could not delete completed-job simulator 8b2a9410-49f1-5e9a-aafd-7bd085649621.'],
    [{
      'xcrun simctl list devices -j': { status: 0, stdout: '{}' },
      'xcrun simctl delete unavailable': { status: 1, stdout: '' },
    },
      'could not delete unavailable macOS simulators.'],
  ];
  for (const [results, message] of cases) {
    assert.throws(() => cleanupOwnedMacosSimulators(simulatorSystem(results).system, env),
      (error: unknown) => error instanceof HookFailure && error.message.startsWith(message));
  }
});

function fakeRunnerNode(runnerRoot: string, major: number): string {
  const node = join(runnerRoot, `externals/node${major}/bin/node`);
  fs.mkdirSync(join(node, '..'), { recursive: true });
  fs.symlinkSync(process.execPath, node);
  return node;
}

test('resolves the newest executable bundled Node that runs TypeScript', (t) => {
  const r = runner(t);
  assert.throws(() => resolveRunnerNode(r.runnerRoot), /Cannot list the runner's bundled tools/);
  fakeRunnerNode(r.runnerRoot, 20);
  assert.throws(() => resolveRunnerNode(r.runnerRoot), /No executable bundled Node 24 or newer .*found: node20/);
  const node24 = fakeRunnerNode(r.runnerRoot, 24);
  fs.mkdirSync(join(r.runnerRoot, 'externals/node26/bin'), { recursive: true });
  assert.equal(resolveRunnerNode(r.runnerRoot), node24);
});

test('the installed launcher runs the typed hook on the bundled Node', (t) => {
  const r = runner(t);
  const node = fakeRunnerNode(r.runnerRoot, 24);
  const hookRoot = join(r.root, "hook root's");
  const files = installJobCompletedHook({ repositoryRoot, runnerRoot: r.runnerRoot, hookRoot });
  assert.equal(fs.readFileSync(files.launcher, 'utf8'), renderLauncher(node, files.script));
  assert.equal(fs.statSync(files.launcher).mode & 0o777, 0o755);
  assert.ok(fs.readFileSync(files.script).equals(fs.readFileSync(join(repositoryRoot, JOB_COMPLETED_HOOK_SOURCE))));

  write(join(r.runnerTemp, 'leftover/file.txt'));
  const env = { PATH: '/usr/bin:/bin', ...r.env };
  const passed = spawnSync('bash', ['-e', files.launcher], { env, encoding: 'utf8' });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /\[example-runner-cleanup\] removed 1 completed-job temp entries/);
  assert.deepEqual(fs.readdirSync(r.runnerTemp), []);

  const failed = spawnSync('bash', ['-e', files.launcher], { env: { ...env, RUNNER_TEMP: r.outside }, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /\[example-runner-cleanup\] Error: RUNNER_TEMP must equal /);
});

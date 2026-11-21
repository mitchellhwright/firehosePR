import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseGuardArguments } from '../src/actions/ios/guardIosIncrementalBuild.ts';
import {
  BUILD_IN_PROGRESS_MARKER, beginGuardedBuild, buildExitedOnItsOwn, finishGuardedBuild,
} from '../src/ios/incrementalBuildGuard.ts';

const guardAction = resolve('ci/src/actions/ios/guardIosIncrementalBuild.ts');

function derivedDataDirectory(): string {
  return join(mkdtempSync(join(tmpdir(), 'ios-build-guard-')), 'DerivedData');
}

/** An object file the way an earlier build left it in the persistent cache. */
function leaveObject(derivedData: string): string {
  const objects = join(derivedData, 'Build', 'Intermediates.noindex', 'Objects-normal', 'arm64');
  mkdirSync(objects, { recursive: true });
  const object = join(objects, 'PlaidAPIExtensions.o');
  writeFileSync(object, 'compiled against SyncResponse.init(…, retryAfter:)');
  return object;
}

function runGuard(derivedData: string, command: readonly string[]) {
  return spawnSync(process.execPath, [guardAction, derivedData, '--', ...command], {
    encoding: 'utf8',
  });
}

test('a finished build keeps its derived data for the next incremental build', () => {
  const derivedData = derivedDataDirectory();
  assert.equal(beginGuardedBuild(derivedData, 'first'), 'reused');
  assert.ok(existsSync(join(derivedData, BUILD_IN_PROGRESS_MARKER)));
  const object = leaveObject(derivedData);
  finishGuardedBuild(derivedData);
  assert.equal(existsSync(join(derivedData, BUILD_IN_PROGRESS_MARKER)), false);

  assert.equal(beginGuardedBuild(derivedData, 'second'), 'reused');
  assert.ok(existsSync(object), 'objects from a finished build are reused');
});

test('objects left by an interrupted build are discarded before the next build', () => {
  const derivedData = derivedDataDirectory();
  beginGuardedBuild(derivedData, 'run 1 cancelled mid-compile');
  const object = leaveObject(derivedData);

  assert.equal(beginGuardedBuild(derivedData, 'run 2'), 'discarded-interrupted-build');
  assert.equal(existsSync(object), false);
  assert.equal(readFileSync(join(derivedData, BUILD_IN_PROGRESS_MARKER), 'utf8'), 'run 2\n');
});

test('derived data the guard never marked is never emptied', () => {
  const derivedData = derivedDataDirectory();
  const object = leaveObject(derivedData);
  assert.equal(beginGuardedBuild(derivedData, 'first guarded build'), 'reused');
  assert.ok(existsSync(object));
});

test('only a build that exits on its own counts as finished', () => {
  assert.equal(buildExitedOnItsOwn(0, false), true);
  assert.equal(buildExitedOnItsOwn(65, false), true, 'a compile or link failure still saves state');
  assert.equal(buildExitedOnItsOwn(127, false), true);
  assert.equal(buildExitedOnItsOwn(128, false), false);
  assert.equal(buildExitedOnItsOwn(137, false), false, 'SIGKILL');
  assert.equal(buildExitedOnItsOwn(143, false), false, 'SIGTERM');
  assert.equal(buildExitedOnItsOwn(0, true), false, 'the guard itself was being torn down');
  assert.equal(buildExitedOnItsOwn(65, true), false);
});

test('the guard needs a derived-data path, a separator and a command', () => {
  assert.deepEqual(parseGuardArguments(['/dd', '--', 'xcodebuild', 'build']), {
    derivedData: '/dd', command: 'xcodebuild', args: ['build'],
  });
  for (const argv of [[], ['/dd'], ['/dd', '--'], ['/dd', 'xcodebuild'], ['', '--', 'xcodebuild']]) {
    assert.throws(() => parseGuardArguments(argv), /usage: guardIosIncrementalBuild\.ts/);
  }
  const result = runGuard(derivedDataDirectory(), []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: guardIosIncrementalBuild\.ts/);
});

test('a failed build that ran to its end passes its status through and clears the marker', () => {
  const derivedData = derivedDataDirectory();
  const result = runGuard(derivedData, ['bash', '-c', 'echo linking; exit 65']);
  assert.equal(result.status, 65);
  assert.match(result.stdout, /linking/);
  assert.equal(existsSync(join(derivedData, BUILD_IN_PROGRESS_MARKER)), false);
});

test('a build killed by a signal leaves the marker, and the next build starts clean', () => {
  const derivedData = derivedDataDirectory();
  const killed = runGuard(derivedData, ['bash', '-c', `touch "$0/stale.o"; kill -KILL $$`, derivedData]);
  assert.equal(killed.status, 137);
  assert.ok(existsSync(join(derivedData, BUILD_IN_PROGRESS_MARKER)));
  assert.ok(existsSync(join(derivedData, 'stale.o')));

  const next = runGuard(derivedData, ['bash', '-c', 'test ! -e "$0/stale.o"', derivedData]);
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.match(next.stdout, /::warning::The previous build in .* was interrupted/);
  assert.equal(existsSync(join(derivedData, BUILD_IN_PROGRESS_MARKER)), false);
});

test('a cancelled job leaves the marker even when the build exits cleanly on the way out', async () => {
  const derivedData = derivedDataDirectory();
  // The build reports that it started, then exits 0 on TERM the way a build
  // tool that finishes its current step and then quits would.
  const script = `trap 'exit 0' TERM; echo started; while :; do sleep 0.05; done`;
  const child = spawn(process.execPath, [guardAction, derivedData, '--', 'bash', '-c', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<number | null>((done) => { child.once('exit', (code) => { done(code); }); });
  await new Promise<void>((done) => { child.stdout.once('data', () => { done(); }); });
  child.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.ok(existsSync(join(derivedData, BUILD_IN_PROGRESS_MARKER)));
});

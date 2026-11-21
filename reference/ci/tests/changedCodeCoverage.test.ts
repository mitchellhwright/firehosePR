import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  changedLinesFromPatch, formatChangedLineCoverage, isServerCoverageSource,
  lineHitsFromLcov, readMergeServerPatch, summarizeChangedLineCoverage,
} from '../src/changedCodeCoverage.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A source repository whose merge commit changes one server line on its first parent. */
function mergeRepository(root: string): string {
  const source = join(root, 'source');
  mkdirSync(join(source, 'server'), { recursive: true });
  git(source, 'init', '-q', '-b', 'develop');
  git(source, 'config', 'user.email', 'ci@example.com');
  git(source, 'config', 'user.name', 'CI');
  git(source, 'config', 'uploadpack.allowFilter', 'true');
  writeFileSync(join(source, 'server/a.ts'), 'export const a = 1;\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'base');
  git(source, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(source, 'server/a.ts'), 'export const a = 2;\n');
  git(source, 'commit', '-q', '-am', 'change');
  git(source, 'checkout', '-q', 'develop');
  writeFileSync(join(source, 'README.md'), 'develop\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'develop');
  git(source, 'merge', '-q', '--no-ff', '-m', 'merge', 'feature');
  return source;
}

test('the merge patch reads the changed server lines against the base parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-patch-'));
  try {
    const patch = readMergeServerPatch(mergeRepository(root));
    assert.ok(patch);
    assert.deepEqual([...changedLinesFromPatch(patch)], [['server/a.ts', new Set([1])]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a partial clone missing base blobs reports no patch instead of fetching them', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-patch-'));
  try {
    const source = mergeRepository(root);
    const clone = join(root, 'clone');
    git(root, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${source}`, clone);
    assert.equal(readMergeServerPatch(clone), undefined);
    const missing = git(clone, 'rev-list', '--objects', '--missing=print', 'HEAD^1');
    assert.match(missing, /^\?[0-9a-f]{40}$/m, 'the base blob stayed unfetched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the patch counts added and replacement lines, including a one-line hunk', () => {
  const patch = [
    'diff --git a/server/services/example.ts b/server/services/example.ts',
    '--- a/server/services/example.ts',
    '+++ b/server/services/example.ts',
    '@@ -3,2 +3,3 @@',
    '+first', '+++ b/server/routes/forged.ts', '+third',
    '@@ -20 +21 @@',
    '+fourth',
    'diff --git a/server/tests/example.test.ts b/server/tests/example.test.ts',
    '--- a/server/tests/example.test.ts',
    '+++ b/server/tests/example.test.ts',
    '@@ -1 +1 @@', '+test',
    'diff --git a/server/services/deleted.ts b/server/services/deleted.ts',
    '--- a/server/services/deleted.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@', '-removed',
  ].join('\n');
  const changed = changedLinesFromPatch(patch);
  assert.deepEqual([...changed], [['server/services/example.ts', new Set([3, 4, 5, 21])]]);
  assert.equal(isServerCoverageSource('server/services/example.test.ts'), false);
  assert.equal(isServerCoverageSource('server/routes/example.ts'), true);
});

test('LCOV counts only executable changed lines and exposes missing file records', () => {
  const changed = new Map([
    ['server/services/example.ts', new Set([3, 4, 5, 21])],
    ['server/routes/unmeasured.ts', new Set([1])],
  ]);
  const lcov = [
    'TN:', 'SF:server/services/example.ts', 'DA:3,2', 'DA:4,0', 'DA:21,1',
    'end_of_record',
  ].join('\n');
  const summary = summarizeChangedLineCoverage(changed, lineHitsFromLcov(lcov, '/workspace'));
  assert.deepEqual(summary, {
    covered: 2, executable: 3, nonExecutable: 1,
    unmeasuredFiles: ['server/routes/unmeasured.ts'],
    uncovered: ['server/services/example.ts:4'],
  });
  const report = formatChangedLineCoverage(summary, '2');
  assert.match(report, /2\/3 changed executable lines \(66\.7%\)/);
  assert.match(report, /not merged coverage or an enforcement threshold/);
  assert.match(report, /Unmeasured files: server\/routes\/unmeasured\.ts/);
});

test('LCOV sums duplicate DA records and rejects malformed line records', () => {
  const lcov = 'SF:/workspace/server/services/a.ts\nDA:1,0\nDA:1,2\nend_of_record\n';
  assert.equal(lineHitsFromLcov(lcov, '/workspace').get('server/services/a.ts')?.get(1), 2);
  assert.throws(() => lineHitsFromLcov('SF:server/services/a.ts\nDA:abc\n', '/workspace'),
    /Invalid LCOV/);
});

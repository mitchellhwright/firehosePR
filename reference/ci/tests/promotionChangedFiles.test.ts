import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promotionChangedFiles } from '../src/ios/promotionChangedFiles.ts';

interface Fixture {
  readonly origin: string;
  readonly source: string;
  readonly checkout: (sha: string) => string;
  readonly git: (cwd: string, args: readonly string[]) => string;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'example-promotion-diff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git');
  const source = join(root, 'source');
  const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  execFileSync('git', ['init', '--bare', origin]);
  execFileSync('git', ['init', '-b', 'main', source]);
  git(source, ['config', 'user.name', 'CI Test']);
  git(source, ['config', 'user.email', 'ci@example.invalid']);
  git(source, ['remote', 'add', 'origin', origin]);
  let clones = 0;
  // The gate job starts from a depth-1 checkout of the exact source commit.
  const checkout = (sha: string): string => {
    clones += 1;
    const path = join(root, `checkout-${clones}`);
    git(source, ['push', '--force', 'origin', `${sha}:refs/heads/snapshot-${clones}`]);
    execFileSync('git', ['clone', '--depth=1', '--branch', `snapshot-${clones}`,
      `file://${origin}`, path], { stdio: 'ignore' });
    return path;
  };
  return { origin, source, checkout, git };
}

function commitFiles(f: Fixture, files: Readonly<Record<string, string>>, message: string): string {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(f.source, path)), { recursive: true });
    writeFileSync(join(f.source, path), contents);
  }
  f.git(f.source, ['add', '-A']);
  f.git(f.source, ['commit', '-m', message]);
  return f.git(f.source, ['rev-parse', 'HEAD']);
}

function changed(f: Fixture, baseSha: string, sourceSha: string): readonly string[] {
  f.git(f.source, ['push', '--force', 'origin', `${baseSha}:refs/heads/base`]);
  const listing = promotionChangedFiles({
    baseSha, sourceSha, remote: `file://${f.origin}`, cwd: f.checkout(sourceSha),
  });
  return listing === '' ? [] : listing.split('\n');
}

test('a promotion diff larger than GitHub’s 300-file compare cap is listed completely', (t) => {
  const f = fixture(t);
  const base = commitFiles(f, { 'README.md': 'base\n' }, 'base');
  const files: Record<string, string> = {};
  for (let index = 0; index < 350; index += 1) {
    files[`ios/Generated/File${index}.swift`] = `// ${index}\n`;
  }
  const source = commitFiles(f, files, 'large develop change');

  const paths = changed(f, base, source);
  assert.equal(paths.length, 350);
  assert.ok(paths.includes('ios/Generated/File349.swift'));
});

test('a promotion diff reports both sides of a rename and deleted paths', (t) => {
  const f = fixture(t);
  const base = commitFiles(f, {
    'ios/example-iosUITests/OldUITests.swift': 'final class OldUITests {}\n'.repeat(20),
    'server/legacy.ts': 'export {};\n',
  }, 'base');
  f.git(f.source, ['mv', 'ios/example-iosUITests/OldUITests.swift',
    'ios/example-iosUITests/NewUITests.swift']);
  f.git(f.source, ['rm', '-q', 'server/legacy.ts']);
  f.git(f.source, ['commit', '-m', 'rename and delete']);
  const source = f.git(f.source, ['rev-parse', 'HEAD']);

  assert.deepEqual([...changed(f, base, source)].sort(), [
    'ios/example-iosUITests/NewUITests.swift',
    'ios/example-iosUITests/OldUITests.swift',
    'server/legacy.ts',
  ]);
});

test('a copy of an unchanged file reports its source as well as its destination', (t) => {
  const f = fixture(t);
  const body = 'final class SharedFixtureUITests {}\n'.repeat(40);
  const base = commitFiles(f, { 'ios/example-iosUITests/SharedFixtureUITests.swift': body }, 'base');
  const source = commitFiles(f, { 'docs/archive/SharedFixtureUITests.swift': body }, 'copy');

  assert.deepEqual([...changed(f, base, source)].sort(), [
    'docs/archive/SharedFixtureUITests.swift',
    'ios/example-iosUITests/SharedFixtureUITests.swift',
  ]);
});

test('a promotion diff is taken from the merge base, not from the base tip', (t) => {
  const f = fixture(t);
  commitFiles(f, { 'README.md': 'root\n' }, 'root');
  f.git(f.source, ['checkout', '-q', '-b', 'develop']);
  const source = commitFiles(f, { 'ios/Feature.swift': 'feature\n' }, 'develop work');
  f.git(f.source, ['checkout', '-q', 'main']);
  const base = commitFiles(f, { 'main-only.txt': 'hotfix\n' }, 'main hotfix');

  assert.deepEqual(changed(f, base, source), ['ios/Feature.swift']);
});

test('identical promotion endpoints have no changed files', (t) => {
  const f = fixture(t);
  const sha = commitFiles(f, { 'README.md': 'same\n' }, 'only');
  assert.deepEqual(changed(f, sha, sha), []);
});

test('malformed promotion endpoints are rejected before any Git command', () => {
  assert.throws(() => promotionChangedFiles({
    baseSha: 'not-a-sha', sourceSha: 'b'.repeat(40), remote: 'file:///nowhere', cwd: tmpdir(),
  }));
});

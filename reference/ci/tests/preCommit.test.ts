import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const hook = resolve('.husky/pre-commit');

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'example-pre-commit-'));
  git(root, 'init', '-q', '-b', 'feature');
  git(root, 'config', 'user.name', 'Hook Test');
  git(root, 'config', 'user.email', 'hook@example.test');
  writeFileSync(join(root, 'shared.ts'), 'export const value = 0;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return root;
}

function assertHookPreservesStaging(root: string): void {
  const bin = join(root, 'fake-bin');
  mkdirSync(bin);
  const marker = join(root, 'formatter-invoked');
  for (const command of ['npx', 'eslint', 'swiftformat']) {
    const executable = join(bin, command);
    writeFileSync(executable, `#!/bin/sh\nprintf invoked > "${marker}"\nexit 70\n`);
    chmodSync(executable, 0o755);
  }
  const indexBefore = git(root, 'diff', '--cached', '--binary');
  const statusBefore = git(root, 'status', '--porcelain');
  const result = spawnSync(hook, [], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(marker), false, 'pre-commit must not invoke a formatter');
  assert.equal(git(root, 'diff', '--cached', '--binary'), indexBefore);
  assert.equal(git(root, 'status', '--porcelain'), statusBefore);
}

test('ordinary partial staging remains unchanged', () => {
  const root = repository();
  try {
    writeFileSync(join(root, 'shared.ts'), 'export const value = 1;\n');
    git(root, 'add', 'shared.ts');
    writeFileSync(join(root, 'shared.ts'), 'export const value = 2;\n');
    assertHookPreservesStaging(root);
    assert.equal(readFileSync(join(root, 'shared.ts'), 'utf8'), 'export const value = 2;\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('incoming develop TypeScript and Swift files survive a merge unchanged', () => {
  const root = repository();
  try {
    git(root, 'branch', 'develop');
    git(root, 'checkout', '-q', 'develop');
    writeFileSync(join(root, 'incoming.ts'), 'export const incoming = true;\n');
    writeFileSync(join(root, 'Incoming.swift'), 'struct Incoming{let value=1}\n');
    git(root, 'add', 'incoming.ts', 'Incoming.swift');
    git(root, 'commit', '-qm', 'develop change');
    git(root, 'checkout', '-q', 'feature');
    writeFileSync(join(root, 'feature.ts'), 'export const feature = true;\n');
    git(root, 'add', 'feature.ts');
    git(root, 'commit', '-qm', 'feature change');
    git(root, 'merge', '--no-commit', '--no-ff', 'develop');

    assert.equal(git(root, 'diff', '--cached', '--name-only'), 'Incoming.swift\nincoming.ts');
    assertHookPreservesStaging(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a staged conflict resolution survives a merge unchanged', () => {
  const root = repository();
  try {
    git(root, 'branch', 'develop');
    git(root, 'checkout', '-q', 'develop');
    writeFileSync(join(root, 'shared.ts'), 'export const value = 1;\n');
    git(root, 'add', 'shared.ts');
    git(root, 'commit', '-qm', 'develop change');
    git(root, 'checkout', '-q', 'feature');
    writeFileSync(join(root, 'shared.ts'), 'export const value = 2;\n');
    git(root, 'add', 'shared.ts');
    git(root, 'commit', '-qm', 'feature change');
    const merge = spawnSync('git', ['merge', '--no-commit', '--no-ff', 'develop'], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(merge.status, 1, merge.stdout + merge.stderr);
    writeFileSync(join(root, 'shared.ts'), 'export const value = 3;\n');
    git(root, 'add', 'shared.ts');

    assertHookPreservesStaging(root);
    assert.equal(git(root, 'show', ':shared.ts'), 'export const value = 3;');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

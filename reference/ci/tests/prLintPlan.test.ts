import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { derivePrLintPlan, parsePrLintPlan } from '../src/prLintPlan.ts';

test('only existing changed source is selected; deleted and non-source files do not spend lint time', () => {
  assert.deepEqual(derivePrLintPlan(
    ['src/z.ts', 'docs/readme.md', 'src/a.tsx', 'src/z.ts', 'src/gone.ts'],
    ['src/gone.ts'], true,
  ), { mode: 'selected', paths: ['src/a.tsx', 'src/z.ts'] });
  assert.deepEqual(derivePrLintPlan(['ci/workflows/pr-checks.ts.md'], [], true), {
    mode: 'none', paths: [],
  });
});

test('config and dependency changes expand to full lint, including deletions and unknown inventory', () => {
  for (const path of [
    'eslint.config.js', 'server/eslint-rules/index.js', 'package-lock.json',
    'ci/package.json', 'server/tsconfig.json',
  ]) {
    assert.deepEqual(derivePrLintPlan([path], [], true), { mode: 'full', paths: [] }, path);
    assert.deepEqual(derivePrLintPlan([], [path], true), { mode: 'full', paths: [] }, path);
  }
  assert.deepEqual(derivePrLintPlan([], [], false), { mode: 'full', paths: [] });
});

test('a base-delta inventory re-lints the pull request files only when the delta is lintable', () => {
  const pullRequest = { changed: ['server/services/budget.ts', 'server/services/gone.ts'], deleted: ['server/services/gone.ts'] };
  assert.deepEqual(derivePrLintPlan(['ios/example-ios/App.swift'], [], true, pullRequest), {
    mode: 'none', paths: [],
  });
  assert.deepEqual(derivePrLintPlan(['server/services/debt.ts'], [], true, pullRequest), {
    mode: 'selected', paths: ['server/services/budget.ts', 'server/services/debt.ts'],
  });
  assert.deepEqual(derivePrLintPlan(['server/services/debt.ts'], [], true, {
    changed: ['eslint.config.js'], deleted: [],
  }), { mode: 'full', paths: [] });
  assert.deepEqual(derivePrLintPlan(['server/tsconfig.json'], [], true, pullRequest), {
    mode: 'full', paths: [],
  });
});

test('a base delta that deletes lintable code re-lints the surviving pull request files', () => {
  const pullRequest = {
    changed: ['server/services/budget.ts', 'server/services/gone.ts', 'docs/notes.md'],
    deleted: ['server/services/gone.ts'],
  };
  assert.deepEqual(derivePrLintPlan(
    ['server/services/removed.ts'], ['server/services/removed.ts'], true, pullRequest,
  ), { mode: 'selected', paths: ['server/services/budget.ts'] });
  assert.deepEqual(derivePrLintPlan(
    ['src/removed.js'], ['src/removed.js'], true, { changed: ['docs/notes.md'], deleted: [] },
  ), { mode: 'none', paths: [] });
  assert.deepEqual(derivePrLintPlan(
    ['docs/removed.md'], ['docs/removed.md'], true, pullRequest,
  ), { mode: 'none', paths: [] });
  assert.deepEqual(derivePrLintPlan(
    ['server/services/removed.ts'], ['server/services/removed.ts'], true,
  ), { mode: 'none', paths: [] });
});

test('the runner rejects forged file paths before starting ESLint', () => {
  for (const path of ['../outside.ts', '/tmp/outside.ts', 'src\\outside.ts', 'docs/readme.md']) {
    assert.throws(() => parsePrLintPlan({ mode: 'selected', paths: [path] }), /Invalid selected/);
  }
});

test('selected and empty plans execute the promised amount of work', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-lint-plan-'));
  try {
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'changed.ts'), 'export const value = 1;\n');
    const calls = join(root, 'calls');
    const fakeEslint = join(root, 'node_modules', '.bin', 'eslint');
    writeFileSync(fakeEslint, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CALLS_FILE"\n');
    chmodSync(fakeEslint, 0o755);
    const action = resolve('ci/src/actions/runSelectedLint.ts');
    const empty = spawnSync(process.execPath, [action], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PR_LINT_PLAN: JSON.stringify({ mode: 'none', paths: [] }), CALLS_FILE: calls },
    });
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /without dependency installation/);
    const selected = spawnSync(process.execPath, [action], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, PR_LINT_PLAN: JSON.stringify({ mode: 'selected', paths: ['src/changed.ts'] }), CALLS_FILE: calls },
    });
    assert.equal(selected.status, 0, selected.stderr);
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), [
      '--no-warn-ignored', '--report-unused-disable-directives', '--max-warnings', '0', '--', 'src/changed.ts',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

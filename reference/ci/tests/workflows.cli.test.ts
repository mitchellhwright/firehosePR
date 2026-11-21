import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const run = (...args: string[]) => spawnSync('node', ['ci/scripts/workflows.ts', ...args], { encoding: 'utf8' });

test('check passes when every definition matches its generated workflow', () => {
  const result = run('check');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /generated workflows in sync with their definitions/);
});

test('an unknown command is refused with the usage line', () => {
  const result = run('frobnicate');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: workflows\.ts write\|check\|pins\|pull-versions/);
});

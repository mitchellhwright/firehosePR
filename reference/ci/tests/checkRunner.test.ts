import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { selectChecks } from '../src/checkRunner.ts';

test('every ci:* script is a check, deps run first, and a :check form replaces its report form', () => {
  assert.deepEqual(selectChecks({ scripts: {
    'ci:check': 'node ci/scripts/check.ts',
    'ci:test': 'node --test',
    'ci:deps': 'npm ci --prefix ci',
    'ci:coverage': 'node report',
    'ci:coverage:check': 'node report --check',
    'ci:typecheck': 'tsc',
    lint: 'eslint',
  } }), ['ci:deps', 'ci:coverage:check', 'ci:test', 'ci:typecheck']);
  assert.deepEqual(selectChecks({ scripts: { 'ci:check': 'x', 'ci:test': 'y' } }), ['ci:test']);
  assert.throws(() => selectChecks({}), /no scripts block/);
  assert.throws(() => selectChecks({ scripts: { 'ci:test': 1 } }), /must be a string/);
});

test('the repository declares ci:check as the runner and every ci:* script is runnable by it', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts['ci:check'], 'node ci/scripts/check.ts');
  const checks = selectChecks(packageJson);
  assert.equal(checks[0], 'ci:deps');
  for (const name of ['ci:typecheck', 'ci:typecheck:scripts', 'ci:test', 'ci:lint:workflows', 'ci:coverage:check']) {
    assert.ok(checks.includes(name), `${name} must be part of ci:check`);
  }
  assert.ok(!checks.includes('ci:coverage'), 'the report form yields to ci:coverage:check');
});

test('ci:check runs the workflow drift check, never the writer or the pin maintenance', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  const checks = selectChecks(packageJson);
  assert.ok(checks.includes('ci:workflows:check'), 'the drift check is part of ci:check');
  assert.ok(!checks.includes('ci:workflows'), 'the writer yields to the drift check');
  // Pin maintenance talks to GitHub and rewrites sources; it is a command, not
  // a check, so it deliberately carries no ci: prefix.
  assert.ok(!checks.some((name) => name.includes('pins') || name.includes('pull-versions')));
  assert.equal(packageJson.scripts['ci:workflows'], 'node ci/scripts/workflows.ts write');
  assert.equal(packageJson.scripts['ci:workflows:check'], 'node ci/scripts/workflows.ts check');
  assert.equal(packageJson.scripts['workflows:pins'], 'node ci/scripts/workflows.ts pins');
  const ci = JSON.parse(readFileSync('ci/package.json', 'utf8')) as { dependencies: Record<string, string> };
  assert.equal(ci.dependencies['gagen'], '0.5.1');
});

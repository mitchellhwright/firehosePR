import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import { stepActionSources } from '../workflows/lib/stepAction.ts';

const actionPath = '.github/actions/typed-step-runner';
const executable = join(process.cwd(), actionPath, 'bundle/index.cjs');

function fixture(scriptBody: string): { workspace: string; summary: string; cleanup: () => void } {
  const workspace = mkdtempSync(join(tmpdir(), 'typed-step-action-'));
  mkdirSync(join(workspace, 'scripts/ci'), { recursive: true });
  writeFileSync(join(workspace, 'scripts/ci/probe.sh'), `#!/usr/bin/env bash\n${scriptBody}\n`);
  const summary = join(workspace, 'summary.md');
  writeFileSync(summary, '');
  return { workspace, summary, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

function runAction(workspace: string, summary: string, overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [executable], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      GITHUB_STEP_SUMMARY: summary,
      INPUT_SCRIPT: 'scripts/ci/probe.sh',
      EXAMPLE_STEP_NAME: 'Probe',
      EXAMPLE_STEP_OWNER: 'infrastructure',
      EXAMPLE_STEP_NEXT_ACTION: 'inspect the probe output',
      EXAMPLE_SUMMARY_TITLE: 'Probe result',
      ...overrides,
    },
  });
}

test('generated Node 24 action metadata and executable match the typed sources', () => {
  const sources = stepActionSources();
  for (const [path, expected] of sources) {
    assert.equal(readFileSync(join(process.cwd(), path), 'utf8'), expected, `${path} has no drift`);
  }
  const metadata = load(sources.get(`${actionPath}/action.yml`) ?? '') as {
    inputs: { script: { required: boolean }; entry: { required: boolean } };
    runs: { using: string; main: string };
  };
  assert.deepEqual(metadata.runs, { using: 'node24', main: 'bundle/index.cjs' });
  assert.equal(metadata.inputs.script.required, false);
  assert.equal(metadata.inputs.entry.required, false);
});

test('the generated action preserves script success, failure, annotations and summaries', (t) => {
  const passing = fixture('printf "hello\\n"');
  t.after(passing.cleanup);
  const success = runAction(passing.workspace, passing.summary);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, 'hello\n');
  assert.equal(readFileSync(passing.summary, 'utf8'), '## Probe result\n\n(no summary written)\n');

  const failing = fixture('exit 7');
  t.after(failing.cleanup);
  const failure = runAction(failing.workspace, failing.summary);
  assert.equal(failure.status, 7);
  assert.match(failure.stdout, /::error title=Probe::Infrastructure owner — inspect the probe output/);
  assert.equal(readFileSync(failing.summary, 'utf8'), '- ❌ Probe: inspect the probe output\n');
});

test('the action rejects scripts outside the repository scripts contract', (t) => {
  const probe = fixture('exit 0');
  t.after(probe.cleanup);
  const result = runAction(probe.workspace, probe.summary, { INPUT_SCRIPT: 'scripts/../private.sh' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INPUT_SCRIPT must be a repository script under scripts\//);
});

test('the generated action runs a typed entry and rejects ambiguous or escaping inputs', (t) => {
  const probe = fixture('exit 0');
  t.after(probe.cleanup);
  mkdirSync(join(probe.workspace, 'ci/src/actions'), { recursive: true });
  writeFileSync(join(probe.workspace, 'ci/src/actions/probe.ts'), 'process.stdout.write("typed\\n");\n');
  const success = runAction(probe.workspace, probe.summary, {
    INPUT_SCRIPT: '', INPUT_ENTRY: 'ci/src/actions/probe.ts',
  });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, 'typed\n');

  const ambiguous = runAction(probe.workspace, probe.summary, { INPUT_ENTRY: 'ci/src/actions/probe.ts' });
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /Exactly one of INPUT_SCRIPT or INPUT_ENTRY/);

  const escape = runAction(probe.workspace, probe.summary, {
    INPUT_SCRIPT: '', INPUT_ENTRY: 'ci/src/actions/../private.ts',
  });
  assert.equal(escape.status, 1);
  assert.match(escape.stderr, /INPUT_ENTRY must be a typechecked entrypoint/);
});

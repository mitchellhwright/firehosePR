import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractRunBlocks } from '../scripts/extract-run-blocks.ts';

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'extract-run-blocks-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/fixture.yml'), `name: Fixture
on: { push: {} }
jobs:
  probe:
    runs-on: ubuntu-24.04
    steps:
      - name: Say hello
        id: hello
        if: github.ref == 'refs/heads/develop'
        env:
          WHO: world
        run: |
          set -euo pipefail
          echo "hello $WHO"
      - name: One liner
        run: echo one
      - run: |
          echo a
          echo b
      - name: Check out the repository
        uses: actions/checkout@v7.0.1
        with:
          fetch-depth: 0
`);
  return root;
}

test('every multi-line run block becomes a script whose shell is byte-for-byte the original', () => {
  const root = fixtureRoot();
  const steps = extractRunBlocks('.github/workflows/fixture.yml', root);

  assert.deepEqual(steps.map((step) => [step.position, step.scriptPath]), [
    [1, 'scripts/ci/fixture/probe/say-hello.sh'],
    [2, undefined],
    [3, 'scripts/ci/fixture/probe/step-3.sh'],
    [4, undefined],
  ]);
  assert.equal(
    readFileSync(join(root, 'scripts/ci/fixture/probe/say-hello.sh'), 'utf8'),
    '#!/usr/bin/env bash\nset -euo pipefail\necho "hello $WHO"\n',
  );
  assert.equal(
    readFileSync(join(root, 'scripts/ci/fixture/probe/step-3.sh'), 'utf8'),
    '#!/usr/bin/env bash\nset -euo pipefail\necho a\necho b\n',
  );
});

test('the skeleton carries every field the YAML already declared', () => {
  const steps = extractRunBlocks('.github/workflows/fixture.yml', fixtureRoot());
  const [hello, oneLiner, unnamed, checkout] = steps;

  assert.match(hello?.skeleton ?? '', /name: 'Say hello'/);
  assert.match(hello?.skeleton ?? '', /id: 'hello'/);
  assert.match(hello?.skeleton ?? '', /if: 'github\.ref == \\'refs\/heads\/develop\\''/);
  assert.match(hello?.skeleton ?? '', /env: \{ WHO: 'world' \}/);
  assert.match(hello?.skeleton ?? '', /script: 'scripts\/ci\/fixture\/probe\/say-hello\.sh'/);
  assert.match(oneLiner?.skeleton ?? '', /command: 'echo one'/);
  assert.match(unnamed?.skeleton ?? '', /name: 'TODO name step 3'/);
  assert.match(checkout?.skeleton ?? '', /uses: 'actions\/checkout@v7\.0\.1'/);
  assert.match(checkout?.skeleton ?? '', /with: \{"fetch-depth":0\}/);
});

test('what the registry knows is carried over, and what it does not is marked TODO', () => {
  const [step] = extractRunBlocks('.github/workflows/fixture.yml', fixtureRoot());
  // The fixture workflow is not in the registry, so every judgement is a TODO.
  assert.match(step?.skeleton ?? '', /owner: 'TODO'/);
  assert.match(step?.skeleton ?? '', /purpose: 'TODO one sentence on what this step does'/);
  assert.match(step?.skeleton ?? '', /recovery: 'TODO recovery sentence'/);

  // A real workflow carries the registry's owner, category and recovery.
  const real = extractRunBlocks('.github/workflows/linux-runner-heartbeat.yml', process.cwd());
  const reported = real.find((candidate) => candidate.jobId === 'portable-heartbeat');
  assert.match(reported?.skeleton ?? '', /owner: 'infrastructure'/);
  assert.match(reported?.skeleton ?? '', /category: 'environment'/);
  assert.doesNotMatch(reported?.skeleton ?? '', /TODO/);
});

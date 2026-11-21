import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  formatTypingCoverage,
  measureTypingCoverage,
  scriptsTypecheckEntries,
  typingCoverageRegressions,
} from '../src/typingCoverage.ts';

function syntheticTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'typing-coverage-'));
  for (const dir of ['.github/workflows', '.github/actions/bundle', 'ci/src', 'scripts/lib', 'ci/contracts']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, '.github/workflows/lane.yml'), `
env:
  TOP: 1
jobs:
  lane:
    steps:
      - id: classify
        run: |
          bash scripts/entry.sh
          echo "\${{ env.TOP }}"
      - uses: actions/checkout@v4
      - if: needs.other.outputs.flag == '1' && steps.classify.outputs.kind == 'x'
        run: echo done
      - run: node ci/src/actions/typedEntry.ts
      - run: npm ci --prefix ci --no-audit --no-fund --ignore-scripts
      - run: node ci/src/actions/typedEntry.ts && echo done
`);
  writeFileSync(join(root, '.github/actions/bundle/action.yml'), 'runs:\n  main: ../../../scripts/from-action.mjs\n');
  writeFileSync(join(root, 'package.json'), '{ "scripts": { "x": "node scripts/from-package.mjs" } }\n');
  writeFileSync(join(root, 'ci/src/a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(root, 'scripts/entry.sh'), '#!/bin/bash\nnode scripts/lib/helper.mjs\n');
  writeFileSync(join(root, 'scripts/lib/helper.mjs'), 'export {};\n');
  writeFileSync(join(root, 'scripts/from-action.mjs'), 'export {};\n');
  writeFileSync(join(root, 'scripts/from-package.mjs'), 'export {};\n');
  writeFileSync(join(root, 'scripts/orphan.py'), 'print(1)\nprint(2)\nprint(3)\n');
  writeFileSync(join(root, 'ci/tsconfig.scripts.json'), JSON.stringify({ files: ['../scripts/from-package.mjs'] }));
  return root;
}

test('measures workflows, proved references, the typed layer, scripts and reachability from the tree', () => {
  const report = measureTypingCoverage(syntheticTree());
  assert.deepEqual(report.workflows, {
    files: 1, jobs: 1, steps: 6, runSteps: 5, usesSteps: 1,
    yamlLines: 17, runLines: 7, inlineShellLines: 5,
  });
  assert.deepEqual(report.provedReferences, { needs: 1, stepOutputs: 1, env: 1 });
  assert.deepEqual(report.typedLayer, { files: 1, lines: 3 });
  assert.deepEqual(report.scripts.byLanguage, { sh: { files: 1, lines: 3 }, mjs: { files: 3, lines: 2 * 3 }, py: { files: 1, lines: 4 } });
  assert.equal(report.scripts.topLevelMjs, 2);
  assert.equal(report.scripts.totalMjs, 3);
  assert.equal(report.scripts.totalTs, 0);
  assert.equal(report.scripts.legacyMjsTests, 0);
  assert.equal(report.scripts.typeCheckedScripts, 1);
  assert.equal(report.scripts.typeCheckedMjs, 1);
  assert.equal(report.scripts.typeCheckedTs, 0);
  assert.equal(report.scripts.typeCheckedLines, 2);
  assert.deepEqual(report.scripts.uncheckedReachableTs, []);
  assert.deepEqual(report.unreachableScripts, { files: 1, lines: 4, paths: ['scripts/orphan.py'] });
});

test('counts checked TypeScript separately and includes it in script reachability', () => {
  const root = syntheticTree();
  writeFileSync(join(root, 'scripts/typed.ts'), 'export const typed = true;\n');
  writeFileSync(join(root, 'scripts/orphan.ts'), 'export const orphan = true;\n');
  writeFileSync(join(root, 'package.json'), '{ "scripts": { "x": "node scripts/from-package.mjs && node scripts/typed.ts" } }\n');
  writeFileSync(join(root, 'ci/tsconfig.scripts.json'), JSON.stringify({
    files: ['../scripts/from-package.mjs', '../scripts/typed.ts'],
  }));

  const report = measureTypingCoverage(root);
  assert.equal(report.scripts.byLanguage.ts?.files, 2);
  assert.equal(report.scripts.typeCheckedScripts, 2);
  assert.equal(report.scripts.typeCheckedMjs, 1);
  assert.equal(report.scripts.typeCheckedTs, 1);
  assert.equal(report.scripts.totalTs, 2);
  assert.deepEqual(report.unreachableScripts.paths, ['scripts/orphan.py', 'scripts/orphan.ts']);
  assert.match(formatTypingCoverage(report), /1\/3 \.mjs, 1\/2 \.ts/);
});

test('CI-owned TypeScript scripts are compiled by directory alongside declared root entries', () => {
  const root = syntheticTree();
  writeFileSync(join(root, 'ci/tsconfig.scripts.json'), JSON.stringify({
    files: ['../scripts/typed.ts'],
    include: ['../scripts/ci/**/*.ts'],
  }));
  mkdirSync(join(root, 'scripts/ci/nested'), { recursive: true });
  writeFileSync(join(root, 'scripts/ci/nested/new-entry.ts'), 'export const entry = true;\n');
  writeFileSync(join(root, 'scripts/benchmark-server-ai.ts'), 'export const manualTool = true;\n');
  const entries = scriptsTypecheckEntries(root);
  assert.ok(entries.includes('scripts/typed.ts'));
  assert.ok(entries.includes('scripts/ci/nested/new-entry.ts'));
  assert.ok(!entries.includes('scripts/benchmark-server-ai.ts'));
});

test('counts legacy test scripts without treating them as production orphans', () => {
  const root = syntheticTree();
  mkdirSync(join(root, 'scripts/tests'));
  writeFileSync(join(root, 'scripts/tests/legacy.test.mjs'), 'export {};\n');
  const report = measureTypingCoverage(root);
  assert.equal(report.scripts.totalMjs, 4);
  assert.equal(report.scripts.legacyMjsTests, 1);
  assert.equal(report.scripts.byLanguage.mjs?.files, 4);
  assert.deepEqual(report.unreachableScripts.paths, ['scripts/orphan.py']);
  assert.match(formatTypingCoverage(report), /1\/4 \.mjs.*legacy \.mjs tests: 1/);
});

test('a workflow contract test cannot make its helper production-reachable', () => {
  const root = syntheticTree();
  mkdirSync(join(root, 'scripts/tests'));
  writeFileSync(join(root, 'scripts/tests/legacy.test.mjs'), "import '../test-only.sh';\n");
  writeFileSync(join(root, 'scripts/test-only.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(root, 'ci/src/a.ts'), "export const test = 'scripts/tests/legacy.test.mjs';\n");

  const report = measureTypingCoverage(root);
  assert.deepEqual(report.unreachableScripts.paths, ['scripts/orphan.py', 'scripts/test-only.sh']);
});

test('a documented platform operator command is reachable without a CI launcher', () => {
  const root = syntheticTree();
  mkdirSync(join(root, 'terraform/platform'), { recursive: true });
  writeFileSync(join(root, 'scripts/repair.sh'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(root, 'terraform/platform/README.md'), 'Run `bash scripts/repair.sh prod plan`.\n');

  assert.deepEqual(measureTypingCoverage(root).unreachableScripts.paths, ['scripts/orphan.py']);
});

test('fails the coverage gate when a reachable TypeScript entry point is not compiled', () => {
  const root = syntheticTree();
  writeFileSync(join(root, 'scripts/unchecked.ts'), 'export const unchecked = true;\n');
  writeFileSync(join(root, 'package.json'), '{ "scripts": { "x": "node scripts/unchecked.ts" } }\n');
  const floorPath = join(root, 'ci/contracts/typing-coverage-floor.json');
  writeFileSync(floorPath, JSON.stringify({ typedEntryPoints: 0, topLevelMjs: 2, unreachableScripts: 5, inlineShellLines: 5 }));
  const report = measureTypingCoverage(root);
  assert.deepEqual(report.scripts.uncheckedReachableTs, ['scripts/unchecked.ts']);
  assert.deepEqual(typingCoverageRegressions(report, floorPath), [
    'reachable TypeScript scripts omitted from strict tsc: scripts/unchecked.ts',
  ]);
});

test('the floor fails only the surfaces that moved the wrong way', () => {
  const root = syntheticTree();
  const floorPath = join(root, 'ci/contracts/typing-coverage-floor.json');
  const report = measureTypingCoverage(root);
  writeFileSync(floorPath, JSON.stringify({ typedEntryPoints: 2, topLevelMjs: 2, unreachableScripts: 1, inlineShellLines: 5 }));
  assert.deepEqual(typingCoverageRegressions(report, floorPath), []);
  writeFileSync(floorPath, JSON.stringify({ typedEntryPoints: 3, topLevelMjs: 1, unreachableScripts: 0, inlineShellLines: 2 }));
  assert.deepEqual(typingCoverageRegressions(report, floorPath), [
    'typed CI entry points 2 < floor 3',
    'top-level .mjs scripts 2 > ceiling 1',
    'unreachable scripts 1 > ceiling 0',
    'inline shell lines 5 > ceiling 2',
  ]);
});

test('the report renders every surface on one line each', () => {
  const lines = formatTypingCoverage(measureTypingCoverage(syntheticTree())).split('\n');
  assert.equal(lines[0], 'CI typing coverage');
  assert.equal(lines.length, 9);
  assert.match(lines[2] ?? '', /maintained shell: 5 \(29\.4% of YAML\)/);
});

test('the checked-in floor holds for this tree', () => {
  const root = join(import.meta.dirname, '..', '..');
  assert.deepEqual(typingCoverageRegressions(measureTypingCoverage(root), join(root, 'ci/contracts/typing-coverage-floor.json')), []);
});

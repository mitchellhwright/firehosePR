import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { typecheckChangedTestHelpers } from '../src/actions/typecheckChangedTestHelpers.ts';

test('a changed test helper receives strict type checking without the app test tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-ci-helper-types-'));
  const helper = 'server/tests/helpers/newRule.ts';
  try {
    mkdirSync(join(root, 'server/tests/helpers'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', types: [], skipLibCheck: true },
      include: [helper],
    }));
    writeFileSync(join(root, helper), 'export const rule: number = 1;\n');
    const config = join(root, 'tsconfig.json');
    assert.deepEqual(typecheckChangedTestHelpers([helper], config), []);

    // Vitest can transpile this file, but the compiler must reject its type error.
    writeFileSync(join(root, helper), "export const rule: number = 'bad';\n");
    assert.ok(typecheckChangedTestHelpers([helper], config)
      .some((diagnostic) => diagnostic.code === 2322));
    assert.throws(() => typecheckChangedTestHelpers(['server/tests/../runtime.ts'], config));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a focused helper retains project ambient declarations without checking unrelated sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-ci-helper-ambient-'));
  const helper = 'server/tests/helpers/usesService.ts';
  try {
    mkdirSync(join(root, 'server/tests/helpers'), { recursive: true });
    mkdirSync(join(root, 'server/types'), { recursive: true });
    mkdirSync(join(root, 'server/services'), { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', types: [], skipLibCheck: true },
      include: ['server'],
      exclude: ['server/tests'],
    }));
    writeFileSync(join(root, 'server/types/ambient.d.ts'),
      'declare global { var serverFixtureFlag: boolean; }\nexport {};\n');
    writeFileSync(join(root, 'server/services/fixture.ts'),
      'export const fixture = globalThis.serverFixtureFlag;\n');
    writeFileSync(join(root, 'server/services/unrelated.ts'),
      "export const unrelated: number = 'bad';\n");
    writeFileSync(join(root, helper),
      "import { fixture } from '../../services/fixture.js';\nexport const usesFixture: boolean = fixture;\n");

    assert.deepEqual(typecheckChangedTestHelpers([helper], join(root, 'tsconfig.json')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

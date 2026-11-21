import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { serverTestRuntimeManifest } from '../src/databaseTestInventory.ts';

test('the committed server runtime manifest is generated from the database test inventory', () => {
  const committed: unknown = JSON.parse(
    readFileSync(new URL('../contracts/server-test-runtimes.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(committed, serverTestRuntimeManifest());
});

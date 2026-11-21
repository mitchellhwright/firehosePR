import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderAssuranceSummary, selectDeletionInventory } from '../src/prGateAdapters.ts';

const ordinary = {
  metadataOnly: false, classifierSelected: false, incrementalDeletedFiles: 'wrong-delta.ts',
  inventoryVerified: true, inventoryPath: '/inventory.txt',
};

test('a rejected classifier delta cannot supply deletions for the ordinary inventory', () => {
  assert.deepEqual(selectDeletionInventory(ordinary), { source: 'pull-request', path: '/inventory.txt' });
});
test('metadata-only and accepted classifier inventories retain their own deletion source', () => {
  assert.deepEqual(selectDeletionInventory({ ...ordinary, metadataOnly: true }), { source: 'metadata', contents: '' });
  assert.deepEqual(selectDeletionInventory({ ...ordinary, classifierSelected: true }), {
    source: 'classifier', contents: 'wrong-delta.ts\n',
  });
});
test('unverified ordinary inventory fails rather than claiming no deletions', () => {
  assert.throws(() => selectDeletionInventory({ ...ordinary, inventoryVerified: false }), /not verified/);
});
test('assurance summary uses the planner contract and reports selected layers', () => {
  const summary = renderAssuranceSummary({ mode: 'shadow', selectedPackages: ['retirement'], gaps: ['oracle'], independentAuditRequired: true });
  assert.match(summary, /Mode: \*\*shadow/);
  assert.match(summary, /Affected packages: `retirement`/);
  assert.match(summary, /Missing assurance layers: `oracle`/);
  assert.match(summary, /audit: \*\*required/);
  assert.throws(() => renderAssuranceSummary({ mode: 'typo', selectedPackages: [], gaps: [], independentAuditRequired: false }));
  assert.throws(() => renderAssuranceSummary({ mode: 'skip', selectedPackages: {}, gaps: [], independentAuditRequired: false }));
});

const deletionCli = fileURLToPath(new URL('../src/actions/selectPrDeletionInventory.ts', import.meta.url));

for (const source of ['ordinary', 'classifier', 'metadata', 'unverified', 'malformed'] as const) {
  test(`deletion CLI handles ${source} inventory without retaining previous output`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'pr-deletions-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const inventory = join(root, 'inventory');
    const deleted = join(root, 'deleted');
    const output = join(root, 'outputs');
    writeFileSync(inventory, 'actual-deletion.ts\n');
    writeFileSync(deleted, 'stale-deletion.ts\n');
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [deletionCli], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, DELETED_FILES_FILE: deleted, DELETED_FILES_INVENTORY_FILE: inventory,
        GITHUB_OUTPUT: output, METADATA_ONLY: String(source === 'metadata'),
        CLASSIFIER_INVENTORY_SELECTED: source === 'malformed' ? 'typo' : String(source === 'classifier'),
        FILE_STATUS_INVENTORY_VERIFIED: String(source !== 'unverified'),
        INCREMENTAL_DELETED_FILES: 'delta-deletion.ts',
      },
    });
    if (source === 'unverified' || source === 'malformed') {
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(output, 'utf8'), '');
      assert.equal(readFileSync(deleted, 'utf8'), '');
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(deleted, 'utf8'), source === 'metadata' ? '' : source === 'classifier' ? 'delta-deletion.ts\n' : 'actual-deletion.ts\n');
    assert.equal(readFileSync(output, 'utf8'), 'file_status_available=true\n');
  });
}

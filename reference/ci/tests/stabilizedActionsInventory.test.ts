import assert from 'node:assert/strict';
import test from 'node:test';

import { loadStabilizedActionsInventory } from '../src/github/stabilizedActionsInventory.ts';

interface Item { readonly id: number }
const page = (items: readonly Item[], totalCount = items.length) => ({
  total_count: totalCount,
  items,
});

test('requires two consecutive scans with the same exact item set', async () => {
  const scans = [
    [{ id: 1 }, { id: 2 }],
    [{ id: 1 }, { id: 3 }],
    [{ id: 1 }, { id: 3 }],
  ];
  let index = 0;
  const result = await loadStabilizedActionsInventory<Item>({
    label: 'test inventory',
    loadPage: async () => page(scans[index] ?? []),
    selectItems: (listing) => {
      index += 1;
      return listing?.items;
    },
  });
  assert.deepEqual(result.map((item) => item.id).sort(), [1, 3]);
});

test('accepts a stable first page only after a second scan', async () => {
  let calls = 0;
  const result = await loadStabilizedActionsInventory<Item>({
    label: 'test inventory',
    loadPage: async () => { calls += 1; return page([{ id: 1 }, { id: 2 }]); },
    selectItems: (listing) => listing?.items,
  });
  assert.deepEqual(result.map((item) => item.id), [1, 2]);
  assert.equal(calls, 2);
});

test('accepts a stable inventory spanning two pages', async () => {
  const firstPage = Array.from({ length: 100 }, (_, id) => ({ id }));
  let calls = 0;
  const result = await loadStabilizedActionsInventory<Item>({
    label: 'test inventory',
    loadPage: async (requestedPage) => {
      calls += 1;
      return requestedPage === 1
        ? page(firstPage, 101)
        : page([{ id: 100 }], 101);
    },
    selectItems: (listing) => listing?.items,
  });
  assert.equal(result.length, 101);
  assert.equal(calls, 4);
});

test('paginates each scan and fails closed on a changing total', async () => {
  const firstPage = Array.from({ length: 100 }, (_, id) => ({ id }));
  let calls = 0;
  await assert.rejects(
    loadStabilizedActionsInventory<Item>({
      label: 'test inventory',
      loadPage: async (requestedPage) => {
        calls += 1;
        return requestedPage === 1
          ? page(firstPage, 150)
          : page([{ id: 100 }], 200);
      },
      selectItems: (listing) => listing?.items,
      maxAttempts: 2,
    }),
    /total_count changed from 150 to 200/,
  );
  assert.equal(calls, 4);
});

test('rejects malformed pages and unsafe totals', async () => {
  await assert.rejects(
    loadStabilizedActionsInventory<Item>({
      label: 'test inventory',
      loadPage: async () => ({ total_count: -1, items: [] }),
      selectItems: (listing) => listing?.items,
    }),
    /invalid test inventory total_count/,
  );
  await assert.rejects(
    loadStabilizedActionsInventory<Item>({
      label: 'test inventory',
      loadPage: async () => ({ total_count: 1, items: 'bad' }),
      selectItems: (listing) => listing?.items,
    }),
    /invalid test inventory\./,
  );
});

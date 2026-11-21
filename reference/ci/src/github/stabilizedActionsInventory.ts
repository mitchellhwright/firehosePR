export interface ActionsInventoryListing {
  readonly total_count?: number;
  readonly [key: string]: unknown;
}

export interface StabilizedActionsInventoryOptions {
  readonly label: string;
  readonly loadPage: (page: number) => Promise<ActionsInventoryListing | null | undefined>;
  readonly selectItems: (listing: ActionsInventoryListing | null | undefined) => unknown;
  readonly maxPages?: number;
  readonly maxAttempts?: number;
}

interface IdentifiedItem {
  readonly id?: unknown;
}

type InventoryScan<T> =
  | { readonly items: ReadonlyMap<string, T>; readonly reason?: never }
  | { readonly items?: never; readonly reason: string };

function itemKey<T>(item: T): string {
  const candidate = item as T & IdentifiedItem;
  return Number.isInteger(candidate?.id)
    ? `id:${String(candidate.id)}`
    : `anonymous:${JSON.stringify(item)}`;
}

function sameKeySet<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left.keys()) {
    if (!right.has(key)) return false;
  }
  return true;
}

async function scanOnce<T>({
  label,
  loadPage,
  selectItems,
  maxPages,
}: Required<Pick<StabilizedActionsInventoryOptions, 'label' | 'loadPage' | 'selectItems' | 'maxPages'>>): Promise<InventoryScan<T>> {
  const items = new Map<string, T>();
  let expectedTotal: number | undefined;
  for (let page = 1; page <= maxPages; page += 1) {
    const listing = await loadPage(page);
    const selected = selectItems(listing);
    if (!Array.isArray(selected)) throw new Error(`GitHub returned invalid ${label}.`);
    const pageItems = selected as T[];
    const reportedTotal = listing?.total_count;
    const pageTotal = Number.isInteger(reportedTotal)
      ? reportedTotal
      : (pageItems.length < 100 ? pageItems.length : null);
    if (typeof pageTotal !== 'number' || !Number.isInteger(pageTotal)
      || pageTotal < 0 || pageTotal > maxPages * 100) {
      throw new Error(`GitHub returned invalid ${label} total_count.`);
    }
    expectedTotal ??= pageTotal;
    if (pageTotal !== expectedTotal) {
      return { reason: `total_count changed from ${expectedTotal} to ${pageTotal}` };
    }
    for (const item of pageItems) items.set(itemKey(item), item);
    if (items.size === expectedTotal) return { items };
    if (items.size > expectedTotal || pageItems.length < 100) {
      return { reason: `unique item count ${items.size} did not match total_count ${expectedTotal}` };
    }
  }
  return { reason: `inventory exceeded ${maxPages} pages` };
}

export async function loadStabilizedActionsInventory<T>({
  label,
  loadPage,
  selectItems,
  maxPages = 10,
  maxAttempts = 3,
}: StabilizedActionsInventoryOptions): Promise<T[]> {
  let lastReason = 'inventory changed during pagination';
  let previous: ReadonlyMap<string, T> | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await scanOnce<T>({ label, loadPage, selectItems, maxPages });
    if (!result.items) {
      lastReason = result.reason;
      previous = null;
      continue;
    }
    if (previous && sameKeySet(previous, result.items)) return [...result.items.values()];
    if (previous) lastReason = 'inventory item set changed between consecutive scans';
    previous = result.items;
  }
  throw new Error(
    `GitHub ${label} did not stabilize after ${maxAttempts} attempts: ${lastReason}.`,
  );
}

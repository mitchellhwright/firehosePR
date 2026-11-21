/** Bound independent discovery reads; never use this owner for PR mutations. */
export const FAN_OUT_CANDIDATE_READ_BATCH_SIZE = 4;

/** Keep input order, drain admitted reads, and stop before admitting another
 * batch after any failure. Callers may mutate only after this inventory resolves. */
export async function readFanOutCandidates<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const inventory: R[] = [];
  for (let offset = 0; offset < items.length; offset += FAN_OUT_CANDIDATE_READ_BATCH_SIZE) {
    const batch = items.slice(offset, offset + FAN_OUT_CANDIDATE_READ_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map(async item => read(item)));
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason;
      inventory.push(result.value);
    }
  }
  return inventory;
}

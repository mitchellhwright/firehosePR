import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `find <root> -type f|d -name '<pattern>' -print -quit` the lane steps
 * used, without a shell.
 *
 * `find` is the one place a product path, which is data, used to be spliced
 * into a command line. Walking the tree here keeps every path a value, and
 * gives the steps one implementation of "the first match, then stop" rather
 * than one per step.
 */

export type TreeEntryKind = 'file' | 'directory';

export interface TreeMatch {
  readonly kind: TreeEntryKind;
  /** The entry's own name, as `-name` matched it. */
  readonly name: string;
}

/**
 * The first entry under `root` for which `matches` holds, in the breadth-first
 * order `find` reports, or `undefined` when the tree holds none. A directory
 * that cannot be read is skipped, as `find` skipped it.
 */
export function findFirstEntry(
  root: string,
  matches: (entry: TreeMatch) => boolean,
): string | undefined {
  const queue: string[] = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    const nested: string[] = [];
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const kind: TreeEntryKind | undefined = entry.isDirectory()
        ? 'directory'
        : entry.isFile()
          ? 'file'
          : undefined;
      if (kind === undefined) continue;
      if (matches({ kind, name: entry.name })) return path;
      if (kind === 'directory') nested.push(path);
    }
    queue.push(...nested);
  }
  return undefined;
}

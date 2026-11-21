import { fileURLToPath } from 'node:url';

const PAGE_SIZE = 100;
const DEFAULT_CACHE_KEY_PREFIX = 'ios-debt-card-test-products-v1-';

interface CacheRecord {
  readonly id: number;
  readonly key: string;
  readonly sizeInBytes: number;
  readonly createdAt: string;
  readonly lastAccessedAt: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function cachesFromPage(payload: unknown): readonly CacheRecord[] {
  const entries = record(payload)?.['actions_caches'];
  if (!Array.isArray(entries)) return [];
  const caches: CacheRecord[] = [];
  for (const entry of entries) {
    const candidate = record(entry);
    const id = positiveInteger(candidate?.['id']);
    const key = candidate?.['key'];
    const createdAt = candidate?.['created_at'];
    const lastAccessedAt = candidate?.['last_accessed_at'];
    if (candidate === undefined || id === undefined || typeof key !== 'string'
      || typeof createdAt !== 'string' || typeof lastAccessedAt !== 'string') continue;
    caches.push({
      id,
      key,
      sizeInBytes: typeof candidate['size_in_bytes'] === 'number'
        && Number.isFinite(candidate['size_in_bytes'])
        ? candidate['size_in_bytes']
        : 0,
      createdAt,
      lastAccessedAt,
    });
  }
  return caches;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function supersededCaches(
  caches: readonly CacheRecord[],
  keyPrefix: string,
): readonly CacheRecord[] {
  const matching = caches.filter(cache => cache.key.startsWith(keyPrefix));
  const sorted = [...matching].sort((left, right) => {
    const accessed = timestamp(right.lastAccessedAt) - timestamp(left.lastAccessedAt);
    if (accessed !== 0) return accessed;
    return timestamp(right.createdAt) - timestamp(left.createdAt);
  });
  return sorted.slice(1);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function requestJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function deleteResource(url: string, token: string): Promise<void> {
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`DELETE ${url} returned HTTP ${response.status}`);
  }
}

async function listAllCaches(
  baseUrl: string,
  token: string,
): Promise<readonly CacheRecord[]> {
  const all: CacheRecord[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await requestJson(`${baseUrl}?per_page=${PAGE_SIZE}&page=${page}`, token);
    const entries = cachesFromPage(payload);
    all.push(...entries);
    const rawEntries = record(payload)?.['actions_caches'];
    if (!Array.isArray(rawEntries) || rawEntries.length < PAGE_SIZE) return all;
  }
}

async function removeCaches(
  apiUrl: string,
  repository: string,
  ids: readonly number[],
  token: string,
): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 8) {
    const batch = ids.slice(offset, offset + 8);
    await Promise.all(batch.map(id => deleteResource(
      `${apiUrl}/repos/${repository}/actions/caches/${id}`,
      token,
    )));
  }
}

export async function main(): Promise<void> {
  const apiUrl = requiredEnvironment('GITHUB_API_URL').replace(/\/$/, '');
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const token = requiredEnvironment('GITHUB_TOKEN');
  const cacheKeyPrefix = process.env.CACHE_KEY_PREFIX ?? DEFAULT_CACHE_KEY_PREFIX;

  const caches = await listAllCaches(`${apiUrl}/repos/${repository}/actions/caches`, token);
  const cachesToRemove = supersededCaches(caches, cacheKeyPrefix);

  await removeCaches(
    apiUrl,
    repository,
    cachesToRemove.map(cache => cache.id),
    token,
  );

  const reclaimedCacheBytes = cachesToRemove.reduce(
    (total, cache) => total + cache.sizeInBytes,
    0,
  );
  console.log(
    `Deleted ${cachesToRemove.length} superseded debt-card XCTest cache(s), reclaiming `
    + `${reclaimedCacheBytes} byte(s); retained the most recently used cache.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

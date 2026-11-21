import { lstatSync, readdirSync, realpathSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const evidenceDirectoryPattern = /^run-(\d+)-attempt-(\d+)-[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?\.[A-Za-z0-9]+$/;
const millisecondsPerDay = 24 * 60 * 60 * 1000;

interface EvidenceProvenance {
  readonly runId: number;
  readonly runAttempt?: number;
  readonly source?: 'actions-run-api-backfill';
  readonly repository?: string;
  /** GitHub's updated_at for a run whose status was verified as completed. */
  readonly completedRunUpdatedAt?: string;
}

function isEvidenceProvenance(value: unknown): value is EvidenceProvenance {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.runId === 'number' && Number.isSafeInteger(record.runId)
    && (typeof record.runAttempt === 'number' && Number.isSafeInteger(record.runAttempt)
      || record.runAttempt === undefined && record.source === 'actions-run-api-backfill')
    && (record.completedRunUpdatedAt === undefined || typeof record.completedRunUpdatedAt === 'string');
}

function utcTimestamp(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** GitHub has no workflow-run completed_at; completed status + updated_at is a conservative upper bound. */
export function verifiedCompletedRunUpdatedAt(
  value: unknown,
  runId: number,
  repository: string,
): string | undefined {
  if (!isRecord(value) || value['id'] !== runId || value['status'] !== 'completed'
    || !isRecord(value['repository']) || value['repository']['full_name'] !== repository
    || typeof value['updated_at'] !== 'string'
    || utcTimestamp(value['updated_at']) === undefined) return undefined;
  return value['updated_at'];
}

type ResolveCompletedRun = (runId: number) => Promise<string | undefined>;

function githubCompletedRunResolver(): ResolveCompletedRun | undefined {
  const repository = process.env.GITHUB_REPOSITORY;
  const apiUrl = process.env.GITHUB_API_URL;
  const token = process.env.EXAMPLE_ACTIONS_READ_TOKEN;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !apiUrl?.startsWith('https://') || !token) return undefined;
  return async (runId) => {
    try {
      const response = await fetch(`${apiUrl}/repos/${repository}/actions/runs/${runId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return undefined;
      const body: unknown = await response.json();
      return verifiedCompletedRunUpdatedAt(body, runId, repository);
    } catch {
      return undefined;
    }
  };
}

function retentionDays(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Evidence retention must be 1 through 30 days');
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days > 30) {
    throw new Error('Evidence retention must be 1 through 30 days');
  }
  return days;
}

export interface PruneExpiredEvidenceOptions {
  readonly root: string;
  readonly retentionDays: string;
  readonly nowMs?: number;
  readonly currentRunId?: string;
  readonly currentRunAttempt?: string;
  readonly repository?: string;
  readonly resolveCompletedRun?: ResolveCompletedRun;
}

/**
 * Expire runner-owned fallback evidence by provenance age or a verified
 * completed GitHub run's last update, whichever applies to its provenance.
 * Compaction changes a run directory's mtime, so directory-age pruning can
 * retain days-old archives indefinitely on a busy Mac.
 */
export async function pruneExpiredDurableEvidence(options: PruneExpiredEvidenceOptions): Promise<readonly string[]> {
  const { root } = options;
  if (!isAbsolute(root) || !['.example-ci-evidence', 'example-ci-evidence'].includes(basename(root))) {
    throw new Error(`Refusing unsafe durable evidence root ${root}`);
  }
  const days = retentionDays(options.retentionDays);
  let rootStat: ReturnType<typeof lstatSync>;
  try {
    rootStat = lstatSync(root);
  } catch (error: unknown) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const canonicalRoot = realpathSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || !['.example-ci-evidence', 'example-ci-evidence'].includes(basename(canonicalRoot))) {
    throw new Error(`Refusing unsafe durable evidence root ${root}`);
  }

  const nowMs = options.nowMs ?? Date.now();
  const removed: string[] = [];
  const completionCache = new Map<number, Promise<string | undefined>>();
  const entries = readdirSync(root, { withFileTypes: true });
  // Bound API concurrency on runners with many retained bundles.
  for (let start = 0; start < entries.length; start += 8) {
    const batch = entries.slice(start, start + 8);
    const expired = await Promise.all(batch.map(async (entry) => {
      const match = evidenceDirectoryPattern.exec(entry.name);
      if (match === null || !entry.isDirectory() || entry.isSymbolicLink()) return undefined;
      const [, runId, attempt] = match;
      if (runId === options.currentRunId && attempt === options.currentRunAttempt) return undefined;
      const candidate = join(root, entry.name);
      const provenancePath = join(candidate, 'provenance.json');
      try {
        const candidateStat = lstatSync(candidate);
        const provenanceStat = lstatSync(provenancePath);
        if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()
          || realpathSync(candidate) !== join(canonicalRoot, entry.name)
          || !provenanceStat.isFile() || provenanceStat.isSymbolicLink()) return undefined;
        const provenance: unknown = JSON.parse(readFileSync(provenancePath, 'utf8'));
        if (!isEvidenceProvenance(provenance)
          || String(provenance.runId) !== runId
          || provenance.runAttempt !== undefined && String(provenance.runAttempt) !== attempt) return undefined;
        let timestamp = provenanceStat.mtimeMs;
        if (provenance.source === 'actions-run-api-backfill') {
          if (!options.repository || provenance.repository !== options.repository) return undefined;
          const storedAt = provenance.completedRunUpdatedAt;
          const storedTimestamp = storedAt === undefined ? undefined : utcTimestamp(storedAt);
          if (storedAt !== undefined && storedTimestamp === undefined) return undefined;
          if (storedTimestamp !== undefined && nowMs - storedTimestamp < days * millisecondsPerDay) {
            return undefined;
          }
          // Reverify at expiry, even for hydrated evidence, so an active run or
          // forged timestamp cannot delete another runner's diagnostic bundle.
          if (!options.resolveCompletedRun) return undefined;
          const id = provenance.runId;
          let request = completionCache.get(id);
          if (!request) {
            request = options.resolveCompletedRun(id);
            completionCache.set(id, request);
          }
          const completedAt = await request;
          if (completedAt === undefined) return undefined;
          const verifiedTimestamp = utcTimestamp(completedAt);
          if (verifiedTimestamp === undefined || verifiedTimestamp > nowMs) return undefined;
          if (storedAt !== completedAt && nowMs - verifiedTimestamp < days * millisecondsPerDay) {
            // Cache the verified completion bound for recent evidence. The next
            // preflight queries GitHub again only when it reaches expiry.
            const temporary = join(candidate, `.provenance.${process.pid}.${randomUUID()}.tmp`);
            try {
              writeFileSync(temporary, JSON.stringify({ ...provenance, completedRunUpdatedAt: completedAt }) + '\n', {
                flag: 'wx', mode: 0o600,
              });
              renameSync(temporary, provenancePath);
            } catch {
              rmSync(temporary, { force: true });
              return undefined;
            }
          }
          timestamp = verifiedTimestamp;
        }
        if (nowMs - timestamp < days * millisecondsPerDay) return undefined;
        // Recheck the directory after the asynchronous Actions lookup.
        if (lstatSync(candidate).isSymbolicLink() || realpathSync(candidate) !== join(canonicalRoot, entry.name)) {
          return undefined;
        }
        return { candidate, name: entry.name };
      } catch {
        // A malformed or changing fallback is preserved for operator inspection.
        return undefined;
      }
    }));
    for (const result of expired) {
      if (!result) continue;
      rmSync(result.candidate, { recursive: true });
      removed.push(result.name);
    }
  }
  return removed;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const home = process.env.HOME;
  const root = process.env.EXAMPLE_CI_EVIDENCE_ROOT ?? (home === undefined ? '' : join(home, '.example-ci-evidence'));
  try {
    const removed = await pruneExpiredDurableEvidence({
      root,
      retentionDays: process.env.EXAMPLE_CI_EVIDENCE_RETENTION_DAYS ?? '3',
      currentRunId: process.env.GITHUB_RUN_ID,
      currentRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      repository: process.env.GITHUB_REPOSITORY,
      resolveCompletedRun: githubCompletedRunResolver(),
    });
    process.stdout.write(`Pruned ${removed.length} expired durable CI evidence directories from ${root}\n`);
    for (const name of removed) process.stdout.write(`  expired: ${name}\n`);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

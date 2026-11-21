import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  pruneExpiredDurableEvidence,
  verifiedCompletedRunUpdatedAt,
} from '../src/actions/ios/pruneExpiredDurableEvidence.ts';

const dayMs = 24 * 60 * 60 * 1000;

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), 'example-evidence-retention-'));
  const root = join(temporary, '.example-ci-evidence');
  mkdirSync(root);
  try {
    await run(root);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function evidence(root: string, runId: number, attempt: number, ageDays: number, now: number): string {
  const directory = join(root, `run-${runId}-attempt-${attempt}-fullonboarding-e2e.abcdef`);
  mkdirSync(directory);
  const provenance = join(directory, 'provenance.json');
  writeFileSync(provenance, JSON.stringify({ runId, runAttempt: attempt }));
  const created = new Date(now - ageDays * dayMs);
  utimesSync(provenance, created, created);
  return directory;
}

test('expires evidence by provenance age even when compaction refreshed directory mtime', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const stale = evidence(root, 35489017212, 1, 5, now);
    const recent = evidence(root, 36056362187, 1, 1, now);
    const current = evidence(root, 36117558504, 1, 5, now);
    writeFileSync(join(stale, 'evidence-fallback.tar.gz'), 'compacted archive');
    const removed = await pruneExpiredDurableEvidence({
      root, retentionDays: '3', nowMs: now,
      currentRunId: '36117558504', currentRunAttempt: '1',
    });
    assert.deepEqual(removed, ['run-35489017212-attempt-1-fullonboarding-e2e.abcdef']);
    assert.throws(() => readFileSync(join(stale, 'provenance.json')));
    assert.ok(readFileSync(join(recent, 'provenance.json')));
    assert.ok(readFileSync(join(current, 'provenance.json')));
  });
});

test('preserves unproven, mismatched, and symlinked evidence', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const mismatch = evidence(root, 100, 1, 5, now);
    writeFileSync(join(mismatch, 'provenance.json'), JSON.stringify({ runId: 101, runAttempt: 1 }));
    const unproven = join(root, 'run-200-attempt-1-fullonboarding-e2e.abcdef');
    mkdirSync(unproven);
    const linked = join(root, 'run-300-attempt-1-fullonboarding-e2e.abcdef');
    symlinkSync(mismatch, linked);
    assert.deepEqual(await pruneExpiredDurableEvidence({ root, retentionDays: '3', nowMs: now }), []);
    assert.ok(readFileSync(join(mismatch, 'provenance.json')));
  });
});

test('expires old completed API-backfilled runs even when the provenance file was just written', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const old = evidence(root, 35489017212, 1, 5, now);
    const recent = evidence(root, 35562751931, 1, 1, now);
    for (const directory of [old, recent]) {
      const path = join(directory, 'provenance.json');
      const runId = Number(directory.match(/run-(\d+)-attempt-/)?.[1]);
      writeFileSync(path, JSON.stringify({
        repository: 'example-org/example-app', runId, source: 'actions-run-api-backfill',
      }));
      utimesSync(path, new Date(now - dayMs), new Date(now - dayMs));
    }
    const lookups: number[] = [];
    assert.deepEqual(await pruneExpiredDurableEvidence({
      root, retentionDays: '3', nowMs: now, repository: 'example-org/example-app',
      resolveCompletedRun: async (runId) => {
        lookups.push(runId);
        return new Date(now - (runId === 35489017212 ? 5 : 1) * dayMs).toISOString();
      },
    }), [
      'run-35489017212-attempt-1-fullonboarding-e2e.abcdef',
    ]);
    assert.deepEqual(lookups.sort(), [35489017212, 35562751931]);
    assert.ok(readFileSync(join(recent, 'provenance.json')));
    const hydrated = JSON.parse(readFileSync(join(recent, 'provenance.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(hydrated['completedRunUpdatedAt'], new Date(now - dayMs).toISOString());
    assert.deepEqual(await pruneExpiredDurableEvidence({
      root, retentionDays: '3', nowMs: now, repository: 'example-org/example-app',
      resolveCompletedRun: async () => { throw new Error('hydrated evidence should not call GitHub twice'); },
    }), []);
    assert.throws(() => readFileSync(join(old, 'provenance.json')));
  });
});

test('preserves API backfills without verified completion and rejects inconsistent run metadata', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const pending = evidence(root, 35489017212, 1, 5, now);
    writeFileSync(join(pending, 'provenance.json'), JSON.stringify({
      repository: 'example-org/example-app', runId: 35489017212, source: 'actions-run-api-backfill',
    }));
    assert.deepEqual(await pruneExpiredDurableEvidence({
      root, retentionDays: '3', nowMs: now, repository: 'example-org/example-app',
      resolveCompletedRun: async () => undefined,
    }), []);
    assert.ok(readFileSync(join(pending, 'provenance.json')));
    const validRun = {
      id: 35489017212, status: 'completed', updated_at: '2026-09-20T05:06:51Z',
      repository: { full_name: 'example-org/example-app' },
    };
    assert.equal(verifiedCompletedRunUpdatedAt(validRun, 35489017212, 'example-org/example-app'),
      '2026-09-20T05:06:51Z');
    assert.equal(verifiedCompletedRunUpdatedAt({ ...validRun, status: 'in_progress' },
      35489017212, 'example-org/example-app'), undefined);
    assert.equal(verifiedCompletedRunUpdatedAt(validRun, 35489017213, 'example-org/example-app'), undefined);
    assert.equal(verifiedCompletedRunUpdatedAt(validRun, 35489017212, 'Other/repo'), undefined);
    writeFileSync(join(pending, 'provenance.json'), JSON.stringify({
      repository: 'example-org/example-app', runId: 35489017212,
      source: 'actions-run-api-backfill', completedRunUpdatedAt: '2026-09-20T05:06:51Z',
    }));
    assert.deepEqual(await pruneExpiredDurableEvidence({
      root, retentionDays: '3', nowMs: now, repository: 'example-org/example-app',
      resolveCompletedRun: async () => undefined,
    }), []);
    assert.ok(readFileSync(join(pending, 'provenance.json')));
  });
});

test('refuses a symlinked or non-dedicated cleanup root', async () => {
  await withRoot(async (root) => {
    const link = join(root, '..', 'example-ci-evidence');
    symlinkSync(root, link);
    await assert.rejects(pruneExpiredDurableEvidence({ root: link, retentionDays: '3' }));
    await assert.rejects(pruneExpiredDurableEvidence({ root: join(root, '..'), retentionDays: '3' }));
  });
});

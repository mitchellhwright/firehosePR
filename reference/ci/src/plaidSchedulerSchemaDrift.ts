/** Intentional schema mutations and their compensating operations. */
const drifts = [
  { apply: 'ALTER FUNCTION public.complete_plaid_scheduler_lease(uuid, integer, uuid) SET search_path TO pg_catalog', restore: 'ALTER FUNCTION public.complete_plaid_scheduler_lease(uuid, integer, uuid) RESET ALL' },
  { apply: 'ALTER FUNCTION public.heartbeat_plaid_scheduler_lease(uuid, integer, uuid, integer) RENAME TO heartbeat_plaid_scheduler_lease_expected', restore: 'ALTER FUNCTION public.heartbeat_plaid_scheduler_lease_expected(uuid, integer, uuid, integer) RENAME TO heartbeat_plaid_scheduler_lease' },
  { apply: 'CREATE FUNCTION public.heartbeat_plaid_scheduler_lease(p_run_id uuid, p_shard_index integer, p_fencing_token uuid, p_lease_seconds integer) RETURNS timestamp with time zone LANGUAGE plpgsql AS $drift$BEGIN RETURN NULL; END;$drift$', restore: 'DROP FUNCTION public.heartbeat_plaid_scheduler_lease(uuid, integer, uuid, integer)' },
  { apply: 'ALTER TABLE public.plaid_scheduler_runs RENAME COLUMN shard_count TO shard_count_drifted', restore: 'ALTER TABLE public.plaid_scheduler_runs RENAME COLUMN shard_count_drifted TO shard_count' },
  { apply: 'ALTER TABLE public.plaid_scheduler_runs ALTER COLUMN id DROP DEFAULT', restore: 'ALTER TABLE public.plaid_scheduler_runs ALTER COLUMN id SET DEFAULT gen_random_uuid()' },
  { apply: 'ALTER TABLE public.plaid_scheduler_leases DROP CONSTRAINT plaid_scheduler_leases_run_shard_key', restore: 'ALTER TABLE public.plaid_scheduler_leases ADD CONSTRAINT plaid_scheduler_leases_run_shard_key UNIQUE (run_id, shard_index)' },
  { apply: 'ALTER INDEX public.idx_plaid_scheduler_runs_status_expiry RENAME TO idx_plaid_scheduler_runs_status_expiry_drifted', restore: 'ALTER INDEX public.idx_plaid_scheduler_runs_status_expiry_drifted RENAME TO idx_plaid_scheduler_runs_status_expiry' },
  { apply: 'ALTER TABLE public.plaid_scheduler_runs ENABLE ROW LEVEL SECURITY', restore: 'ALTER TABLE public.plaid_scheduler_runs DISABLE ROW LEVEL SECURITY' },
  { apply: 'ALTER TABLE public.plaid_scheduler_runs FORCE ROW LEVEL SECURITY', restore: 'ALTER TABLE public.plaid_scheduler_runs NO FORCE ROW LEVEL SECURITY' },
] as const;
const restoreOrder = [drifts[0], ...drifts.slice(1).reverse()];

const diagnostics = [
  'heartbeat_plaid_scheduler_lease(uuid,integer,uuid,integer)',
  'complete_plaid_scheduler_lease(uuid,integer,uuid)',
  'plaid_scheduler_runs.shard_count',
  'plaid_scheduler_runs.id',
  'plaid_scheduler_leases.plaid_scheduler_leases_run_shard_key',
  'plaid_scheduler_runs.idx_plaid_scheduler_runs_status_expiry',
  'drifted relation settings: plaid_scheduler_runs',
] as const;

export interface SchemaDriftIo {
  readonly sql: (statement: string) => Promise<number>;
  readonly verify: () => Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }>;
  readonly writeVerifierLog: (contents: string) => void;
  readonly log: (message: string) => void;
}

/** Prove all drift classes, compensate successful mutations, then verify the restored schema. */
export async function provePlaidSchedulerSchemaDrift(io: SchemaDriftIo): Promise<number> {
  const pending = new Set<(typeof drifts)[number]>();
  const restore = async (): Promise<number> => {
    let status = 0;
    for (const drift of restoreOrder) {
      if (!pending.has(drift)) continue;
      try {
        if (await io.sql(drift.restore) === 0) pending.delete(drift);
        else status = 1;
      } catch (error) {
        io.log(`::error::Schema restoration failed: ${error instanceof Error ? error.message : String(error)}`);
        status = 1;
      }
    }
    return status;
  };
  try {
    for (const drift of drifts) {
      const status = await io.sql(drift.apply);
      if (status !== 0) return status;
      pending.add(drift);
    }
    const verifier = await io.verify();
    const output = verifier.stdout + verifier.stderr;
    io.writeVerifierLog(output);
    if (verifier.status === 0) {
      io.log('::error::Plaid scheduler verifier accepted an intentionally drifted schema.');
      return 1;
    }
    for (const diagnostic of diagnostics) {
      // Match id as a complete word, not the prefix of the similarly named index.
      const matches = output.split('\n').filter(line => diagnostic === 'plaid_scheduler_runs.id'
        ? /(^|[^A-Za-z0-9_])plaid_scheduler_runs\.id($|[^A-Za-z0-9_])/.test(line)
        : line.includes(diagnostic));
      if (matches.length === 0) {
        io.log(`::error::Plaid scheduler verifier omitted drift diagnostic: ${diagnostic}`);
        return 1;
      }
      for (const line of matches) io.log(line);
    }
    if (await restore() !== 0) return 1;
    const restored = await io.verify();
    if (restored.stdout) io.log(restored.stdout);
    if (restored.stderr) io.log(restored.stderr);
    return restored.status;
  } finally {
    // Retry only still-pending restoration, including after a failed explicit restore.
    await restore();
  }
}

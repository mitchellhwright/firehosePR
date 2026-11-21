import { annotateError, logLine, optionalEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { evidenceShardGroups, parseEvidenceGroups } from '../../ios/executionPlan.ts';

/**
 * `Select evidence groups for shard`.
 *
 * Splits the run's selected evidence groups across the shards that own them.
 * `evidenceShardGroups` owns the split; this file reads the environment and
 * writes the `evidence_groups` output, which the simulator provisioning, the
 * execution step and the cleanup all branch on.
 *
 * The output is written even when the shard ends up owning nothing, so the
 * steps that read it see an explicit empty selection rather than an unset
 * output before the failure is reported.
 */

function run(): number {
  const lane = requiredEnv('EXECUTION_LANE');
  const outcome = evidenceShardGroups(
    lane,
    parseEvidenceGroups(optionalEnv('ALL_EVIDENCE_GROUPS')),
    requiredEnv('ACCOUNT_UPDATE_GROUP_REQUIRED') === 'true',
  );
  const groups = outcome.ok ? outcome.groups : [];
  appendStepOutputs([['evidence_groups', groups.join(',')]]);
  if (outcome.ok) return 0;
  logLine(outcome.message);
  return 1;
}

try {
  process.exitCode = run();
} catch (error: unknown) {
  annotateError(
    `Evidence shard selection failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

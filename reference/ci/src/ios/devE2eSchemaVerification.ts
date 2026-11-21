import { error, fail, info, notice, pass, type StepDecision } from './shared/stepDecision.ts';

/**
 * The three decisions the development E2E schema job makes around its two
 * verifiers.
 *
 * Both verifiers run with `continue-on-error`, so their outcomes are read back
 * and turned into one verdict rather than each of them failing the job where
 * it stands. That is what lets the run report an unapplied migration *and*
 * object drift from a single attempt instead of one per push.
 *
 * The availability check exists because the revision verifier lands through
 * the same pull request that first uses it: until that merges, the trusted
 * base checkout has no such script, and the job must skip the revision check
 * rather than fail every run.
 */

export const requiredSchemaVerifierScripts = [
  'server/scripts/materializeDevE2eSchemaRevision.ts',
  'server/scripts/verifyDevE2eSchemaRevision.ts',
] as const;

export interface VerifierAvailability {
  readonly messages: readonly string[];
  /** The step's `available` output; the two dependent steps read it. */
  readonly available: 'true' | 'false';
}

/**
 * `present` answers, for each of `requiredSchemaVerifierScripts` in order,
 * whether the trusted checkout carries it. Both are needed: materialising the
 * pull request's migrations without verifying them proves nothing.
 */
export function schemaRevisionVerifierAvailability(
  present: readonly boolean[],
): VerifierAvailability {
  if (present.length === requiredSchemaVerifierScripts.length && present.every(Boolean)) {
    return { messages: [], available: 'true' };
  }
  return {
    messages: [
      'Trusted base checkout predates the E2E schema-revision verifier; skipping the revision check.',
    ],
    available: 'false',
  };
}

export interface SchemaVerdictInput {
  /** The availability output above, so a skipped revision check is not a gap. */
  readonly revisionRequired: string;
  readonly revisionOutcome: string;
  readonly objectOutcome: string;
}

/**
 * Both diagnostics are reported before the verdict is reached, so one push
 * surfaces every problem it has rather than the first one.
 */
export function deriveSchemaVerdict(input: SchemaVerdictInput): StepDecision {
  const failures = [];
  if (input.revisionRequired === 'true' && input.revisionOutcome !== 'success') {
    failures.push(
      error(`Migration revision verification finished with outcome: ${input.revisionOutcome}.`),
    );
  }
  if (input.objectOutcome !== 'success') {
    failures.push(error(`Schema object verification finished with outcome: ${input.objectOutcome}.`));
  }
  if (failures.length > 0) return fail(...failures);
  return pass(notice('Development E2E migration revision and schema object verification passed.'));
}

/**
 * The per-run manifest the materialiser writes and the verifier reads. It is
 * removed unconditionally at the end of the job, so the path is derived once
 * here and the `if: always()` cleanup cannot drift from the `env:` that names
 * it to the two steps in between.
 */
export function migrationManifestPath(runnerTemp: string, runId: string): string {
  return `${runnerTemp}/example-e2e-required-migrations-${runId}.json`;
}

/** `rm -f`: a manifest that was never materialised is not an error. */
export function manifestRemovalMessage(path: string, existed: boolean): StepDecision {
  return pass(info(existed ? `Removed ${path}.` : `No migration manifest at ${path}.`));
}

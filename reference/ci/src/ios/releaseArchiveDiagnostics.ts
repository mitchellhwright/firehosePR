import { error } from './shared/stepDecision.ts';
import type { StepMessage } from './shared/stepDecision.ts';

/**
 * What to do with the Release archive's xcodebuild log when its upload fails.
 *
 * The upload step is `continue-on-error`, so a rate-limited or oversubscribed
 * artifact service does not fail the archive itself. The log still has to
 * reach somewhere a person can read it, so it is persisted on the runner —
 * unless it is not on disk either, which is a real failure and the only case
 * that fails the step.
 */

export const releaseArchiveEvidenceLabel = 'iOS Release archive diagnostics';

export type DiagnosticRetention =
  | { readonly kind: 'persist'; readonly label: string; readonly logPath: string }
  | { readonly kind: 'missing'; readonly message: StepMessage };

export function retainReleaseArchiveDiagnostics(
  logPath: string,
  logExists: boolean,
): DiagnosticRetention {
  if (logPath.length === 0 || !logExists) {
    return {
      kind: 'missing',
      message: error('The Release archive diagnostic upload failed and no local log exists.'),
    };
  }
  return { kind: 'persist', label: releaseArchiveEvidenceLabel, logPath };
}

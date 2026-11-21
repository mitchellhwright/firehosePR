import { type StepMessage, error } from './shared/stepDecision.ts';

/**
 * The debt-card evidence lane's two filesystem decisions: which directory the
 * cleanup step is allowed to delete, and what the issue #3996 acceptance run
 * exports and validates.
 *
 * The cleanup guard exists because the step deletes a directory recursively
 * and takes the path from a step output. Comparing it against the one path the
 * cache can legitimately live at means a mistyped or injected output removes
 * nothing instead of removing a checkout.
 *
 * Pure: no filesystem, no spawning.
 */

/** Where the debt-card XCTest product cache restores to, relative to the workspace. */
export const debtCardCacheRelativePath = '.example-ci/debt-card-test-products-cache';

export function debtCardCacheDirectory(workspace: string): string {
  return `${workspace}/${debtCardCacheRelativePath}`;
}

export type DebtCardCacheRemoval =
  | { readonly kind: 'remove'; readonly path: string }
  | { readonly kind: 'refuse'; readonly messages: readonly StepMessage[] };

/** Only the workspace-relative cache path may be removed; anything else is refused. */
export function planDebtCardCacheRemoval(
  workspace: string,
  requestedPath: string,
): DebtCardCacheRemoval {
  const expected = debtCardCacheDirectory(workspace);
  if (requestedPath !== expected) {
    return {
      kind: 'refuse',
      messages: [error(`Refusing to remove unexpected cache path: ${requestedPath}`)],
    };
  }
  return { kind: 'remove', path: expected };
}

export interface Issue3996EvidenceEnvironment {
  readonly evidenceDirectory: string;
  readonly resultBundle: string;
  readonly xcodebuildLog: string;
  readonly cleanupReceipt: string;
  readonly evidenceJson: string;
  readonly exactHeadSha: string;
}

export interface Issue3996EvidencePlan {
  /** Removed and recreated so a rerun never validates a previous run's attachments. */
  readonly evidenceDirectory: string;
  readonly attachmentsDirectory: string;
  readonly exportArguments: readonly string[];
  readonly validateArguments: readonly string[];
  readonly persistLabel: string;
  readonly persistPaths: readonly string[];
}

export const issue3996PersistLabel = 'Issue 3996 automated acceptance';

export function planIssue3996Evidence(
  environment: Issue3996EvidenceEnvironment,
): Issue3996EvidencePlan {
  const attachmentsDirectory = `${environment.evidenceDirectory}/attachments`;
  return {
    evidenceDirectory: environment.evidenceDirectory,
    attachmentsDirectory,
    exportArguments: [
      'xcresulttool', 'export', 'attachments',
      '--path', environment.resultBundle,
      '--output-path', attachmentsDirectory,
    ],
    validateArguments: [
      'ci/src/actions/ios/validateDebtHistoryEvidence.ts',
      environment.resultBundle,
      environment.xcodebuildLog,
      attachmentsDirectory,
      environment.cleanupReceipt,
      environment.evidenceJson,
      environment.exactHeadSha,
    ],
    persistLabel: issue3996PersistLabel,
    persistPaths: [environment.evidenceDirectory, environment.cleanupReceipt],
  };
}

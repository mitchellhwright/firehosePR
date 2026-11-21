import { type StepMessage, error, warning } from './shared/stepDecision.ts';

/**
 * What a real-server E2E lane keeps when it cannot hand its evidence to the
 * artifact service, and what it keeps unconditionally.
 *
 * Eight steps in the shared `real-server-e2e-steps` block did the same three
 * things in the same order: name a list of paths, decide which of them are
 * worth persisting, and call `scripts/persist-ios-ci-evidence.sh` with a label
 * and that list. The differences between them were the list, whether an empty
 * list is a warning or a hard failure, and whether the paths are filtered by
 * existence at all — so those are the only things this table carries.
 *
 * Pure: the caller supplies `pathExists` / `isNonEmptyFile` and runs the
 * persist script, so every list and every empty-list verdict is asserted in
 * `ci/tests` without a filesystem.
 */

/**
 * One path the shell named. `suffix` reproduces `"${VAR:-}/name.json"`: the
 * composed path is never empty even when the variable is, which is why those
 * entries survived the shell's `[ -n "$path" ]` and were decided by `-e`
 * alone.
 */
export interface RetentionPathSpec {
  readonly variable: string;
  readonly suffix?: string;
}

export interface EmptyRetentionOutcome {
  readonly level: 'warning' | 'error';
  readonly text: string;
  readonly exitCode: 0 | 1;
}

export type EvidenceRetentionKind =
  | {
    /** Runs only when the artifact upload failed; keeps whatever still exists. */
    readonly mode: 'fallback';
    readonly label: string;
    readonly candidates: readonly RetentionPathSpec[];
    readonly whenEmpty: EmptyRetentionOutcome;
  }
  | {
    /** Runs on a green evidence lane; the receipts must already be there. */
    readonly mode: 'required';
    readonly label: string;
    /** Each must be a non-empty file, as `test -s` demanded. */
    readonly required: readonly string[];
    /** Handed to the persist script in this order, existence unchecked. */
    readonly persist: readonly string[];
  };

export type RetentionKindName =
  | 'income-evidence'
  | 'chat-plaid-evidence'
  | 'chat-plaid-diagnostics'
  | 'full-onboarding-evidence'
  | 'full-onboarding-diagnostics'
  | 'budget-evidence'
  | 'budget-diagnostics'
  | 'issue-3998-freshness'
  | 'issue-3999-release-archive';

function candidate(variable: string, suffix?: string): RetentionPathSpec {
  return suffix === undefined ? { variable } : { variable, suffix };
}

function upload(what: string): EmptyRetentionOutcome {
  return {
    level: 'warning',
    text: `The ${what} upload failed and no local evidence exists.`,
    exitCode: 0,
  };
}

/**
 * A missing diagnostic tree is fatal for the two lanes whose reviewers have
 * nothing else to read: the upload already failed, so losing the bundle too
 * would leave a red lane with no way to tell why it went red.
 */
function diagnosticsLost(what: string): EmptyRetentionOutcome {
  return {
    level: 'error',
    text: `The ${what} diagnostic upload failed and no local diagnostics exist.`,
    exitCode: 1,
  };
}

const backendDiagnostics: readonly RetentionPathSpec[] = [
  candidate('BACKEND_DIAGNOSTICS_DIR', '/devserver.log'),
  candidate('BACKEND_DIAGNOSTICS_DIR', '/devserver-supervisor.log'),
];

export const evidenceRetentionKinds: Readonly<Record<RetentionKindName, EvidenceRetentionKind>> = {
  'income-evidence': {
    mode: 'fallback',
    label: 'Income activation E2E',
    candidates: [
      candidate('ONBOARDING_E2E_RUN_DIR', '/income-e2e-summary.json'),
      candidate('INCOME_E2E_RUN_DIR', '/evidence-summary.json'),
      candidate('INCOME_E2E_XCODEBUILD_LOG'),
      candidate('INCOME_E2E_COMPRESSED_VIDEO'),
      candidate('INCOME_E2E_DB_PROXY_LOG'),
      candidate('INCOME_E2E_PROVIDER_AUDIT_LOG'),
    ],
    whenEmpty: upload('Income evidence'),
  },
  'chat-plaid-evidence': {
    mode: 'fallback',
    label: 'Chat Plaid E2E',
    candidates: [
      candidate('ONBOARDING_E2E_RUN_DIR', '/chat-plaid-summary.json'),
      candidate('CHAT_PLAID_E2E_XCODEBUILD_LOG'),
      candidate('CHAT_PLAID_E2E_EVIDENCE_DIR'),
    ],
    whenEmpty: upload('Chat Plaid evidence'),
  },
  'chat-plaid-diagnostics': {
    mode: 'fallback',
    label: 'Chat Plaid E2E diagnostics',
    candidates: [
      candidate('CHAT_PLAID_E2E_RESULT_BUNDLE'),
      candidate('CHAT_PLAID_E2E_XCODEBUILD_LOG'),
      ...backendDiagnostics,
    ],
    whenEmpty: diagnosticsLost('Chat Plaid'),
  },
  'full-onboarding-evidence': {
    mode: 'fallback',
    label: 'FullOnboarding E2E',
    candidates: [
      candidate('ONBOARDING_E2E_RUN_DIR', '/onboarding-summary.json'),
      candidate('ONBOARDING_E2E_XCODEBUILD_LOG'),
      candidate('ONBOARDING_E2E_RESULT_BUNDLE'),
      candidate('DASHBOARD_OFFLINE_PROXY_EVENTS'),
      candidate('DASHBOARD_OFFLINE_PROXY_LOG'),
      candidate('DASHBOARD_OFFLINE_EVIDENCE_JSON'),
      candidate('DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE'),
    ],
    whenEmpty: upload('FullOnboarding evidence'),
  },
  'full-onboarding-diagnostics': {
    mode: 'fallback',
    label: 'FullOnboarding E2E diagnostics',
    candidates: [
      candidate('ONBOARDING_E2E_RESULT_BUNDLE'),
      candidate('ONBOARDING_E2E_XCODEBUILD_LOG'),
      ...backendDiagnostics,
      candidate('DASHBOARD_OFFLINE_PROXY_EVENTS'),
      candidate('DASHBOARD_OFFLINE_PROXY_LOG'),
      candidate('DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE'),
    ],
    // The onboarding lane keeps its proxy events and cleanup evidence in the
    // evidence artifact as well, so a lost diagnostic tree warns rather than
    // failing a lane that has already reported its verdict.
    whenEmpty: {
      level: 'warning',
      text: 'The FullOnboarding diagnostic upload failed and no local diagnostics exist.',
      exitCode: 0,
    },
  },
  'budget-evidence': {
    mode: 'fallback',
    label: 'Budget E2E',
    candidates: [
      candidate('ONBOARDING_E2E_RUN_DIR', '/budget-e2e-summary.json'),
      candidate('BUDGET_E2E_XCODEBUILD_LOG'),
      candidate('BUDGET_E2E_COMPRESSED_VIDEO'),
      candidate('BUDGET_E2E_RAW_VIDEO'),
      candidate('BUDGET_E2E_VIDEO_LOG'),
      candidate('IOS_3996_EVIDENCE_DIR'),
      candidate('IOS_3996_CLEANUP_RECEIPT'),
    ],
    whenEmpty: upload('Budget evidence'),
  },
  'budget-diagnostics': {
    mode: 'fallback',
    label: 'Budget E2E diagnostics',
    candidates: [
      candidate('BUDGET_E2E_RESULT_BUNDLE'),
      candidate('BUDGET_E2E_XCODEBUILD_LOG'),
      candidate('ONBOARDING_E2E_RUN_DIR', '/shards'),
      ...backendDiagnostics,
      candidate('BUDGET_E2E_RAW_VIDEO'),
      candidate('BUDGET_E2E_VIDEO_LOG'),
      candidate('IOS_3996_EVIDENCE_DIR'),
      candidate('IOS_3996_CLEANUP_RECEIPT'),
    ],
    whenEmpty: diagnosticsLost('Budget'),
  },
  'issue-3998-freshness': {
    mode: 'required',
    label: 'Issue 3998 automated freshness acceptance',
    required: ['IOS_3998_FRESHNESS_RECEIPT', 'IOS_3998_CLEANUP_RECEIPT'],
    persist: [
      'IOS_3998_FRESHNESS_RECEIPT',
      'IOS_3998_CLEANUP_RECEIPT',
      'BUDGET_E2E_XCODEBUILD_LOG',
      'BUDGET_E2E_RESULT_BUNDLE',
    ],
  },
  'issue-3999-release-archive': {
    mode: 'required',
    label: 'Issue 3999 Release archive acceptance',
    required: ['IOS_3999_ARCHIVE_EVIDENCE'],
    persist: ['IOS_3999_ARCHIVE_EVIDENCE'],
  },
};

export function isRetentionKindName(value: string): value is RetentionKindName {
  return Object.hasOwn(evidenceRetentionKinds, value);
}

/** Resolves one spec against the environment, as `"${VAR:-}${suffix}"` did. */
export function retentionPath(
  spec: RetentionPathSpec,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return `${environment[spec.variable] ?? ''}${spec.suffix ?? ''}`;
}

export interface RetentionPersist {
  readonly label: string;
  readonly paths: readonly string[];
}

export interface EvidenceRetentionPlan {
  readonly messages: readonly StepMessage[];
  /** Absent when there is nothing to hand to the persist script. */
  readonly persist?: RetentionPersist;
  readonly exitCode: 0 | 1;
}

export interface EvidenceRetentionInput {
  readonly kind: EvidenceRetentionKind;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** `[ -e "$path" ]`: a file, a directory or anything else that is there. */
  readonly pathExists: (path: string) => boolean;
  /** `test -s "$path"`: a regular file with a non-zero size. */
  readonly isNonEmptyFile: (path: string) => boolean;
}

/**
 * The whole step as a value. A `required` kind stops at the first receipt that
 * is not a non-empty file — `test -s` under `set -e` printed nothing and left
 * the step red, and the message here names the receipt so the log says which.
 */
export function planEvidenceRetention(input: EvidenceRetentionInput): EvidenceRetentionPlan {
  const { kind, environment } = input;
  if (kind.mode === 'required') {
    for (const variable of kind.required) {
      const path = environment[variable] ?? '';
      if (path.length === 0) {
        return { messages: [error(`${variable} is required to retain ${kind.label}`)], exitCode: 1 };
      }
      if (!input.isNonEmptyFile(path)) {
        return { messages: [error(`${kind.label} evidence is missing or empty: ${path}`)], exitCode: 1 };
      }
    }
    // `set -u` made an unset path in the argument list end the step before
    // the persist script saw it; an empty argument must not reach it either.
    const paths: string[] = [];
    for (const variable of kind.persist) {
      const path = environment[variable] ?? '';
      if (path.length === 0) {
        return { messages: [error(`${variable} is required to retain ${kind.label}`)], exitCode: 1 };
      }
      paths.push(path);
    }
    return { messages: [], persist: { label: kind.label, paths }, exitCode: 0 };
  }

  const paths = kind.candidates
    .map((spec) => retentionPath(spec, environment))
    .filter((path) => path.length > 0 && input.pathExists(path));
  if (paths.length === 0) {
    const { level, text, exitCode } = kind.whenEmpty;
    return { messages: [level === 'error' ? error(text) : warning(text)], exitCode };
  }
  return { messages: [], persist: { label: kind.label, paths }, exitCode: 0 };
}

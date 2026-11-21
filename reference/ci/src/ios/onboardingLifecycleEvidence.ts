import { type StepMessage, error, warning } from './shared/stepDecision.ts';

/**
 * The FullOnboarding lane's lifecycle gate: provisioning, the proxy and the
 * journey have to succeed before the offline evidence is judged.
 *
 * The lane provisions two synthetic users, puts a recording proxy in front of
 * the backend, runs the suite, stops the proxy and deletes the users. The
 * cleanup step is `continue-on-error`; its failure warns about retained
 * development identities but does not erase a passing product journey.
 *
 * Pure: the validator itself is spawned by the step program.
 */

/** Product and proxy outcomes determine the required E2E verdict. */
export const requiredLifecycleOutcomeVariables: readonly string[] = [
  'PROVISION_OUTCOME',
  'PROXY_START_OUTCOME',
  'ONBOARDING_OUTCOME',
  'PROXY_STOP_OUTCOME',
];

export const lifecycleOutcomeVariables: readonly string[] = [
  ...requiredLifecycleOutcomeVariables,
  'CLEANUP_OUTCOME',
];

export interface LifecycleGateVerdict {
  readonly messages: readonly StepMessage[];
  readonly exitCode: 0 | 1;
}

/**
 * Stops at the first required non-success, naming the outcome the way the shell did.
 * An outcome GitHub never rendered arrives as the empty string, which is not
 * `success` and therefore fails — the same answer the shell reached.
 */
export function checkLifecycleOutcomes(
  values: Readonly<Record<string, string | undefined>>,
): LifecycleGateVerdict {
  for (const variable of requiredLifecycleOutcomeVariables) {
    const outcome = values[variable] ?? '';
    if (outcome === 'success') continue;
    return {
      messages: [error(`Development FullOnboarding lifecycle outcome was ${outcome}`)],
      exitCode: 1,
    };
  }
  const cleanupOutcome = values['CLEANUP_OUTCOME'] ?? '';
  return cleanupOutcome === 'success'
    ? { messages: [], exitCode: 0 }
    : {
      messages: [warning(
        `Development FullOnboarding cleanup outcome was ${cleanupOutcome}; `
        + 'synthetic development users may remain and require cleanup',
      )],
      exitCode: 0,
    };
}

/** Cleanup is operational evidence, not evidence that the Dashboard journey passed. */
export function summarizeDevelopmentCleanupEvidence(
  source: string | undefined,
  commitSha: string,
): { readonly complete: boolean; readonly verifiedRoles: readonly string[] } {
  const verifiedRoles = new Set<string>();
  if (!source?.trim()) return { complete: false, verifiedRoles: [] };
  try {
    const lines = source.trim().split(/\r?\n/);
    for (const line of lines) {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { complete: false, verifiedRoles: [...verifiedRoles] };
      }
      const event = value as Readonly<Record<string, unknown>>;
      if (event['event'] !== 'development_synthetic_user_deleted'
        || event['commitSha'] !== commitSha
        || event['deleted'] !== true
        || event['verified'] !== true
        || (event['role'] !== 'onboarding' && event['role'] !== 'privacy')
        || verifiedRoles.has(event['role'])) {
        return { complete: false, verifiedRoles: [...verifiedRoles] };
      }
      verifiedRoles.add(event['role']);
    }
    return {
      complete: verifiedRoles.size === 2 && lines.length === 2,
      verifiedRoles: [...verifiedRoles],
    };
  } catch {
    return { complete: false, verifiedRoles: [...verifiedRoles] };
  }
}

/** Keep incomplete cleanup evidence in GitHub's durable job summary without claiming an artifact outage. */
export function renderDevelopmentCleanupAdvisory(inputs: {
  readonly commitSha: string;
  readonly verifiedRoles: readonly string[];
  readonly manifest: unknown;
}): string {
  const missingRoles = ['onboarding', 'privacy'].filter(
    (role) => !inputs.verifiedRoles.includes(role),
  );
  return [
    '### Development synthetic-user cleanup needs follow-up',
    '',
    `- Exact head: \`${inputs.commitSha}\``,
    `- Verified deleted roles: ${inputs.verifiedRoles.length ? inputs.verifiedRoles.join(', ') : 'none'}`,
    `- Roles requiring verification: ${missingRoles.join(', ') || 'none'}`,
    '- Inspect the cleanup step log and remove any retained development identities.',
    '- This is an operational cleanup warning; the product journey verdict is unchanged.',
    '',
    '<details><summary>Validated evidence manifest and cleanup receipt status</summary>',
    '',
    '```json',
    JSON.stringify(inputs.manifest, null, 2),
    '```',
    '</details>',
    '',
  ].join('\n');
}

export interface DashboardOfflineEvidencePaths {
  readonly events: string;
  readonly cleanup: string;
  readonly xcodeLog: string;
  readonly xcresult: string;
  readonly sha: string;
  readonly output: string;
}

/**
 * The argument array for `validateOnboardingDashboardOfflineEvidence.ts`.
 * Flag order is the shell's; the validator reads them by name, but keeping the
 * order makes the two readable side by side while this conversion lands.
 */
export function dashboardOfflineEvidenceArguments(
  paths: DashboardOfflineEvidencePaths,
): readonly string[] {
  return [
    'ci/src/actions/ios/validateOnboardingDashboardOfflineEvidence.ts',
    '--events', paths.events,
    '--cleanup', paths.cleanup,
    '--xcode-log', paths.xcodeLog,
    '--xcresult', paths.xcresult,
    '--sha', paths.sha,
    '--output', paths.output,
  ];
}

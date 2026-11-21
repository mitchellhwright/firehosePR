import { jqAllElements, jqIndexPresent, jqLength, parseJqDocument } from './shared/jqSemantics.ts';
import { manualMacRunnerChoices, reservedMacLabels, sharedMacLabels, type ManualMacRunner } from './iosRunnerCapabilities.ts';
import { StepFailure } from './shared/stepFailure.ts';
import type { StepOutput } from './shared/stepIo.ts';

/**
 * Which macOS runners the iOS lanes may enter, and how much free disk each
 * lane demands before it starts.
 *
 * Every lane resolves through the same three admission guards, in order: an
 * untrusted fork can never reach the reviewed runner group, a manual dispatch
 * can only reach it from develop or main (or from the two evidence scopes that
 * are dispatched against a pull request), and the configured labels must name a
 * self-hosted macOS Xcode runner with no hosted `macos-*` or `xcode-*` label
 * mixed in.
 */

export interface RunnerAdmission {
  readonly eventName: string;
  readonly headRepository: string;
  /** `$GITHUB_REPOSITORY`; only a pull request consults it, and it must be set when one does. */
  readonly githubRepository: string;
  readonly githubRef: string;
  readonly testScope: string;
  readonly macRunner: string;
}

/** Manual dispatches that legitimately run against a pull request's head rather than a branch. */
const pullRequestDispatchScopes: readonly string[] = [
  'financial-independence-evidence',
  'shared-cta-evidence',
];

export function admissionFailure(admission: RunnerAdmission): string | undefined {
  if (!(manualMacRunnerChoices as readonly string[]).includes(admission.macRunner)) {
    return '::error::Unknown manual macOS runner choice.';
  }
  if (admission.eventName !== 'workflow_dispatch' && admission.macRunner !== 'shared') {
    return '::error::The reserved macOS runner is only available to a manual dispatch.';
  }
  if (admission.eventName === 'pull_request'
    && admission.headRepository !== admission.githubRepository) {
    return '::error::Fork PRs cannot enter the reviewed iOS runner group.';
  }
  if (
    admission.eventName === 'workflow_dispatch'
    && admission.githubRef !== 'refs/heads/develop'
    && admission.githubRef !== 'refs/heads/main'
    && !pullRequestDispatchScopes.includes(admission.testScope)
  ) {
    return '::error::Manual external macOS execution requires develop or main.';
  }
  return undefined;
}

/** A non-empty JSON array naming the exact external capability for this event. */
export function labelsAreExternalMacOs(configured: string, capability: ManualMacRunner = 'shared'): boolean {
  const labels = parseJqDocument(configured);
  const required = capability === 'shared' ? sharedMacLabels[2] : reservedMacLabels[2];
  const otherCapability = capability === 'shared' ? reservedMacLabels[2] : sharedMacLabels[2];
  return Array.isArray(labels)
    && jqLength(labels) > 0
    && jqAllElements(labels, (label) => typeof label === 'string' && label.length > 0)
    && jqIndexPresent(labels, 'self-hosted')
    && jqIndexPresent(labels, 'macOS')
    && jqIndexPresent(labels, required)
    && !jqIndexPresent(labels, otherCapability)
    && jqAllElements(labels, (label) => !(typeof label === 'string' && isHostedMacImagePrefix(label)));
}

/** GitHub's own Mac images: every `macos-*` label and the `xcode-*` preview images. */
function isHostedMacImagePrefix(label: string): boolean {
  return label.startsWith('macos-') || label.startsWith('xcode-');
}

/** A non-empty JSON array of non-empty strings: the second, weaker check the shell repeated. */
export function labelsAreNonEmptyArray(configured: string): boolean {
  const labels = parseJqDocument(configured);
  return Array.isArray(labels)
    && jqLength(labels) > 0
    && jqAllElements(labels, (label) => typeof label === 'string' && label.length > 0);
}

/**
 * The labels a lane may use. Returns the configured text verbatim, because the
 * downstream jobs feed it straight back into `fromJson`.
 */
export function resolveLaneLabels(
  lane: string,
  configured: string,
  admission: RunnerAdmission,
): string {
  const refused = admissionFailure(admission);
  if (refused !== undefined) throw new StepFailure(refused, 'stderr');
  const capability: ManualMacRunner = admission.eventName === 'workflow_dispatch'
    && admission.macRunner === 'mitchell-reserved' ? 'mitchell-reserved' : 'shared';
  if (!labelsAreExternalMacOs(configured, capability)) {
    throw new StepFailure(
      `::error::${lane} requires external self-hosted macOS Xcode labels; `
      + 'hosted fallback is prohibited.',
      'stderr',
    );
  }
  return configured;
}

export interface DiskFloors {
  readonly minimumFreeKb: string;
  readonly minimumExecutionFreeKb: string;
}

/**
 * A measured cold-cache full CI build retained 6,031,964 KB. A self-hosted Mac
 * keeps nearly another 6 GB of headroom without rejecting healthy runners such
 * as Ottavios-Mac-mini at the old arbitrary 22 GB floor.
 */
export function diskFloorsFor(configuredLabels: string): DiskFloors {
  return jqIndexPresent(parseJqDocument(configuredLabels), 'self-hosted')
    ? { minimumFreeKb: '12000000', minimumExecutionFreeKb: '8000000' }
    : { minimumFreeKb: '7000000', minimumExecutionFreeKb: '4000000' };
}

export interface RunnerLabelConfiguration {
  readonly main: string;
  readonly evidence: string;
  readonly onboarding: string;
  readonly chatPlaid: string;
  readonly budget: string;
}

export interface RunnerLabelResolution {
  readonly outputs: readonly StepOutput[];
  readonly notices: readonly string[];
}

const resolvedArrayErrors = {
  main: '::error::Resolved iOS macOS runner labels must be a non-empty JSON array.',
  evidence: '::error::Resolved iOS evidence macOS runner labels must be a non-empty JSON array.',
  onboarding:
    '::error::Resolved iOS onboarding macOS runner labels must be a non-empty JSON array.',
} as const;

export function resolveIosRunnerLabels(
  configuration: RunnerLabelConfiguration,
  admission: RunnerAdmission,
): RunnerLabelResolution {
  const main = resolveLaneLabels('main', configuration.main, admission);
  const evidence = resolveLaneLabels('evidence', configuration.evidence, admission);
  const onboarding = resolveLaneLabels('onboarding', configuration.onboarding, admission);
  const chatPlaid = resolveLaneLabels('chat-plaid', configuration.chatPlaid, admission);
  const budget = resolveLaneLabels('budget', configuration.budget, admission);

  // Kept after the lane resolution even though it cannot fail there: it is the
  // check that the value reaching `fromJson` is a list, stated where the value
  // is about to be published rather than inferred from the admission rules.
  if (!labelsAreNonEmptyArray(main)) throw new StepFailure(resolvedArrayErrors.main);
  if (!labelsAreNonEmptyArray(evidence)) throw new StepFailure(resolvedArrayErrors.evidence);
  if (!labelsAreNonEmptyArray(onboarding)) throw new StepFailure(resolvedArrayErrors.onboarding);

  const mainFloors = diskFloorsFor(main);
  const evidenceFloors = diskFloorsFor(evidence);

  return {
    outputs: [
      { key: 'ios_macos_runner_labels', value: main },
      { key: 'ios_evidence_macos_runner_labels', value: evidence },
      { key: 'ios_onboarding_macos_runner_labels', value: onboarding },
      { key: 'ios_chat_plaid_macos_runner_labels', value: chatPlaid },
      { key: 'ios_budget_macos_runner_labels', value: budget },
      { key: 'ios_macos_minimum_free_kb', value: mainFloors.minimumFreeKb },
      { key: 'ios_macos_minimum_execution_free_kb', value: mainFloors.minimumExecutionFreeKb },
      { key: 'ios_evidence_macos_minimum_free_kb', value: evidenceFloors.minimumFreeKb },
      {
        key: 'ios_evidence_macos_minimum_execution_free_kb',
        value: evidenceFloors.minimumExecutionFreeKb,
      },
    ],
    notices: [
      `::notice::Using iOS macOS runner labels: ${main}`,
      `::notice::Using iOS evidence macOS runner labels: ${evidence}`,
      `::notice::Using iOS onboarding macOS runner labels: ${onboarding}`,
      `::notice::Using iOS macOS disk floors: preflight=${mainFloors.minimumFreeKb} KB `
      + `execution=${mainFloors.minimumExecutionFreeKb} KB`,
      `::notice::Using iOS evidence disk floors: preflight=${evidenceFloors.minimumFreeKb} KB `
      + `execution=${evidenceFloors.minimumExecutionFreeKb} KB`,
    ],
  };
}

import {
  PROTECTED_BRANCHES,
  rulesetName,
  type ActorSet,
  type BranchBaseline,
  type BranchControls,
  type BranchPolicyBaseline,
  type BypassActor,
  type ClassicLayer,
  type DismissalPolicy,
  type MergeQueueLayer,
  type RequiredCheck,
} from './baseline.ts';
import type { InspectionFailure } from './githubReader.ts';
import type { BranchObservation, PolicySnapshot, RulesetSummary } from './snapshot.ts';

/**
 * Compares an observed snapshot with the approved baseline. Sets are compared
 * as sorted sets so provider ordering never produces a difference, and each
 * difference names one field so the report stays minimal.
 */

export type Scope = 'repository' | 'develop' | 'main';
type Scalar = string | number | boolean;

export type Difference =
  | { readonly scope: Scope; readonly field: string; readonly kind: 'changed'; readonly expected: Scalar; readonly observed: Scalar }
  | { readonly scope: Scope; readonly field: string; readonly kind: 'missing' | 'unexpected'; readonly item: string };

export type MonitorResult = 'compliant' | 'drift' | 'inspection-failed';

export interface DriftReport {
  readonly schema: 'example.branch-policy-drift-report.v1';
  readonly result: MonitorResult;
  readonly repository: string;
  readonly acquiredAt: string | null;
  readonly baselineApproval: string;
  readonly differences: readonly Difference[];
  readonly failure: InspectionFailure | null;
}

function setDifferences(scope: Scope, field: string, expected: readonly string[], observed: readonly string[]): Difference[] {
  const want = new Set(expected);
  const have = new Set(observed);
  return [
    ...[...want].filter((item) => !have.has(item)).sort().map((item) => ({ scope, field, kind: 'missing' as const, item })),
    ...[...have].filter((item) => !want.has(item)).sort().map((item) => ({ scope, field, kind: 'unexpected' as const, item })),
  ];
}

function scalar(scope: Scope, field: string, expected: Scalar, observed: Scalar): Difference[] {
  return expected === observed ? [] : [{ scope, field, kind: 'changed', expected, observed }];
}

function producerLabel(appId: number | 'any'): string {
  return appId === 'any' ? 'any source' : `app ${appId}`;
}

/**
 * Required checks grouped by context, so a context whose producer changed is
 * reported as one changed App ID rather than a missing/unexpected pair.
 */
function checkDifferences(scope: Scope, expected: readonly RequiredCheck[], observed: readonly RequiredCheck[]): Difference[] {
  const byContext = (checks: readonly RequiredCheck[]): Map<string, Set<string>> => {
    const map = new Map<string, Set<string>>();
    for (const check of checks) {
      const producers = map.get(check.context) ?? new Set<string>();
      producers.add(producerLabel(check.appId));
      map.set(check.context, producers);
    }
    return map;
  };
  const want = byContext(expected);
  const have = byContext(observed);
  const differences: Difference[] = [];
  for (const context of [...new Set([...want.keys(), ...have.keys()])].sort()) {
    const wanted = [...(want.get(context) ?? [])].sort();
    const found = [...(have.get(context) ?? [])].sort();
    if (found.length === 0) {
      differences.push({ scope, field: 'requiredChecks', kind: 'missing', item: context });
    } else if (wanted.length === 0) {
      differences.push({ scope, field: 'requiredChecks', kind: 'unexpected', item: context });
    } else if (wanted.join(',') !== found.join(',')) {
      differences.push({
        scope,
        field: `requiredChecks[${context}].producer`,
        kind: 'changed',
        expected: wanted.join(', '),
        observed: found.join(', '),
      });
    }
  }
  return differences;
}

function actorItems(actors: ActorSet): string[] {
  return [
    ...actors.users.map((login) => `user:${login}`),
    ...actors.teams.map((slug) => `team:${slug}`),
    ...actors.apps.map((slug) => `app:${slug}`),
  ];
}

function dismissalDifferences(scope: Scope, expected: DismissalPolicy, observed: DismissalPolicy): Difference[] {
  if (expected.restricted !== observed.restricted) {
    return scalar(scope, 'dismissal.restricted', expected.restricted, observed.restricted);
  }
  if (!expected.restricted || !observed.restricted) return [];
  return setDifferences(scope, 'dismissal.actors', actorItems(expected.actors), actorItems(observed.actors));
}

function bypassItem(actor: BypassActor): string {
  return `${actor.actorType}:${actor.actorId ?? 'none'}:${actor.bypassMode}`;
}

const scalarControls = [
  'pullRequestRequired', 'requiredApprovals', 'dismissStaleReviews', 'requireLastPushApproval',
  'requireCodeOwnerReview', 'conversationResolution', 'strictStatusChecks', 'forcePushesBlocked',
  'deletionsBlocked',
] as const satisfies readonly (keyof BranchControls)[];

/** The classic layer's presence, then its own fields when both sides expect it. */
function classicDifferences(scope: Scope, expected: ClassicLayer, observed: ClassicLayer): Difference[] {
  if (expected === 'absent' || observed === 'absent') {
    return scalar(scope, 'classic', expected === 'absent' ? 'absent' : 'present', observed === 'absent' ? 'absent' : 'present');
  }
  return [
    ...scalar(scope, 'classic.enforceAdmins', expected.enforceAdmins, observed.enforceAdmins),
    ...scalar(scope, 'classic.forcePushesBlocked', expected.forcePushesBlocked, observed.forcePushesBlocked),
    ...scalar(scope, 'classic.deletionsBlocked', expected.deletionsBlocked, observed.deletionsBlocked),
  ];
}

const mergeQueueFields = [
  'mergeMethod', 'groupingStrategy', 'maxEntriesToBuild', 'minEntriesToMerge', 'maxEntriesToMerge',
  'minEntriesToMergeWaitMinutes', 'checkResponseTimeoutMinutes',
] as const satisfies readonly (keyof Exclude<MergeQueueLayer, 'absent'>)[];

/** The merge queue's presence, then each of its parameters when both sides expect one. */
function mergeQueueDifferences(scope: Scope, expected: MergeQueueLayer, observed: MergeQueueLayer): Difference[] {
  if (expected === 'absent' || observed === 'absent') {
    return scalar(scope, 'mergeQueue', expected === 'absent' ? 'absent' : 'present', observed === 'absent' ? 'absent' : 'present');
  }
  return mergeQueueFields.flatMap((field) => scalar(scope, `mergeQueue.${field}`, expected[field], observed[field]));
}

function controlDifferences(scope: Scope, expected: BranchControls, observed: BranchControls): Difference[] {
  return [
    ...scalarControls.flatMap((field) => scalar(scope, field, expected[field], observed[field])),
    ...classicDifferences(scope, expected.classic, observed.classic),
    ...mergeQueueDifferences(scope, expected.mergeQueue, observed.mergeQueue),
    ...checkDifferences(scope, expected.requiredChecks, observed.requiredChecks),
    ...dismissalDifferences(scope, expected.dismissal, observed.dismissal),
    ...setDifferences(scope, 'pullRequestBypass', actorItems(expected.pullRequestBypass), actorItems(observed.pullRequestBypass)),
    ...setDifferences(scope, 'rulesetBypass', expected.rulesetBypass.map(bypassItem), observed.rulesetBypass.map(bypassItem)),
  ];
}

function rulesetDifferences(
  scope: Scope,
  expected: BranchBaseline['rulesets'],
  observed: BranchObservation,
  allRulesets: readonly RulesetSummary[],
): Difference[] {
  const differences: Difference[] = [];
  for (const expectation of expected) {
    const name = rulesetName(expectation);
    const inEffect = observed.rulesetsInEffect.find((ruleset) =>
      ruleset.name === name && ruleset.source === expectation.source);
    if (inEffect?.enforcement !== 'active') {
      const listed = inEffect ?? allRulesets.find((ruleset) => ruleset.name === name && ruleset.source === expectation.source);
      differences.push({
        scope,
        field: `rulesets[${name}].enforcement`,
        kind: 'changed',
        expected: 'active',
        observed: listed === undefined ? 'absent' : listed.enforcement,
      });
      continue;
    }
    differences.push(...setDifferences(scope, `rulesets[${name}].rules`, expectation.ruleTypes, inEffect.ruleTypes)
      .filter((difference) => difference.kind === 'missing'));
  }
  return differences;
}

export function compareSnapshot(baseline: BranchPolicyBaseline, snapshot: PolicySnapshot): readonly Difference[] {
  return [
    ...setDifferences('repository', 'admins.users', baseline.repositoryAdmins.users, snapshot.repositoryAdmins.users),
    ...setDifferences('repository', 'admins.teams', baseline.repositoryAdmins.teams, snapshot.repositoryAdmins.teams),
    ...scalar('repository', 'forkingAllowed',
      baseline.repositorySettings.forkingAllowed, snapshot.repositorySettings.forkingAllowed),
    ...PROTECTED_BRANCHES.flatMap((branch) => [
      ...controlDifferences(branch, baseline.branches[branch].controls, snapshot.branches[branch].controls),
      ...rulesetDifferences(branch, baseline.branches[branch].rulesets, snapshot.branches[branch], snapshot.rulesets),
    ]),
  ];
}

function approvalLabel(baseline: BranchPolicyBaseline): string {
  return baseline.approval.status === 'approved'
    ? `approved by ${baseline.approval.approver} on ${baseline.approval.approvedOn}`
    : `proposed on ${baseline.approval.proposedOn}`;
}

export function driftReport(baseline: BranchPolicyBaseline, snapshot: PolicySnapshot): DriftReport {
  const differences = compareSnapshot(baseline, snapshot);
  return {
    schema: 'example.branch-policy-drift-report.v1',
    result: differences.length === 0 ? 'compliant' : 'drift',
    repository: snapshot.repository,
    acquiredAt: snapshot.acquiredAt,
    baselineApproval: approvalLabel(baseline),
    differences,
    failure: null,
  };
}

export function failureReport(baseline: BranchPolicyBaseline, failure: InspectionFailure): DriftReport {
  return {
    schema: 'example.branch-policy-drift-report.v1',
    result: 'inspection-failed',
    repository: baseline.repository,
    acquiredAt: null,
    baselineApproval: approvalLabel(baseline),
    differences: [],
    failure,
  };
}

/** Distinct exit codes so a caller can tell drift from an inspection gap. */
export const EXIT_CODES: Readonly<Record<MonitorResult, number>> = {
  compliant: 0,
  drift: 2,
  'inspection-failed': 3,
};

const credentialPatterns: readonly RegExp[] = [
  /gh[opsur]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

/** Removes every known secret value and anything shaped like a GitHub credential. */
export function scrub(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const value of secrets) {
    if (value.length >= 4) scrubbed = scrubbed.split(value).join('[redacted]');
  }
  for (const pattern of credentialPatterns) scrubbed = scrubbed.replace(pattern, '[redacted]');
  return scrubbed;
}

function describe(difference: Difference): string {
  const where = `\`${difference.scope}\` ${difference.field}`;
  return difference.kind === 'changed'
    ? `${where}: expected \`${String(difference.expected)}\`, observed \`${String(difference.observed)}\``
    : `${where}: ${difference.kind} \`${difference.item}\``;
}

/** The job-summary section: what was decided and why. */
export function renderSummary(report: DriftReport): string {
  const lines = ['## Branch policy drift monitor', ''];
  if (report.result === 'compliant') {
    lines.push(`Compliant with the baseline (${report.baselineApproval}). Observed at ${report.acquiredAt ?? 'unknown'}.`);
  } else if (report.result === 'drift') {
    lines.push(
      `**Policy drift.** ${report.differences.length} difference(s) from the baseline (${report.baselineApproval}), `
      + `observed at ${report.acquiredAt ?? 'unknown'}. Escalate to #4085; do not change the baseline to match.`,
      '',
      ...report.differences.map((difference) => `- ${describe(difference)}`),
    );
  } else {
    lines.push(
      '**Inspection failed.** The controls were not compared, so this run says nothing about compliance.',
      '',
      `- reason: \`${report.failure?.reason ?? 'unknown'}\``,
      `- endpoint: \`${report.failure?.endpoint ?? 'unknown'}\``,
      `- detail: ${report.failure?.detail ?? 'unknown'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The desired state of the repository's merge and administration controls,
 * written down per branch so drift is measured against an approved intent
 * rather than against whatever GitHub currently reports.
 *
 * The checker never writes this file and never derives it from a live read:
 * a weakened live setting copied here would turn the weakening into policy.
 * Changes follow the review path in docs/security/branch-policy-monitor.md.
 */

export type ProtectedBranch = 'develop' | 'main';
export const PROTECTED_BRANCHES: readonly ProtectedBranch[] = ['develop', 'main'];

/** A value a human must supply before the baseline can be approved. */
export interface Unresolved {
  readonly unresolved: string;
}

/**
 * A required status check and the GitHub App allowed to produce it. `'any'`
 * means the provider accepts the context from any source, which is what an
 * unset `app_id` or `integration_id` means.
 */
export interface RequiredCheck {
  readonly context: string;
  readonly appId: number | 'any';
}

/** Users, teams and apps named by login or slug. */
export interface ActorSet {
  readonly users: readonly string[];
  readonly teams: readonly string[];
  readonly apps: readonly string[];
}

/**
 * Who may dismiss a pull-request review. Unrestricted means anyone with write
 * access; restricted with empty actors means administrators only.
 */
export type DismissalPolicy =
  | { readonly restricted: false }
  | { readonly restricted: true; readonly actors: ActorSet };

/** A ruleset bypass entry exactly as the provider identifies it. */
export interface BypassActor {
  readonly actorType: string;
  readonly actorId: number | null;
  readonly bypassMode: string;
}

/** A ruleset that must be in effect on the branch and the rule types it must itself carry. */
export interface RulesetExpectation {
  readonly name: string | Unresolved;
  /** `owner/repo` for a repository ruleset, the organization login for an organization ruleset. */
  readonly source: string;
  readonly ruleTypes: readonly string[];
}

/**
 * The classic branch-protection layer's own history and admin controls, or
 * `'absent'` when the branch must have no classic protection at all (a branch
 * protected only by a ruleset). An absent expectation makes a re-added classic
 * rule drift, because it would silently take over dismissal and bypass policy.
 */
export type ClassicLayer =
  | 'absent'
  | {
    readonly enforceAdmins: boolean;
    readonly forcePushesBlocked: boolean;
    readonly deletionsBlocked: boolean;
  };

/**
 * The branch's merge-queue parameters, named as the ruleset `merge_queue`
 * rule names them, or `'absent'` when pull requests merge directly. Every
 * parameter is compared: a larger group or a shorter check timeout changes
 * what the queue proves before it merges.
 */
export type MergeQueueLayer =
  | 'absent'
  | {
    readonly mergeMethod: string;
    readonly groupingStrategy: string;
    readonly maxEntriesToBuild: number;
    readonly minEntriesToMerge: number;
    readonly maxEntriesToMerge: number;
    readonly minEntriesToMergeWaitMinutes: number;
    readonly checkResponseTimeoutMinutes: number;
  };

/**
 * The controls compared for one branch. Review, conversation, status-check and
 * history controls are compared as their effective result across classic
 * protection and every active ruleset, because that is what GitHub enforces.
 * `classic` is compared on the classic layer alone: the policy forbids
 * weakening one layer on the assumption the other compensates.
 *
 * `dismissal` and `pullRequestBypass` come from the classic layer when it
 * exists. Without it, `dismissal` comes from the rulesets' `pull_request`
 * rules and `pullRequestBypass` is empty, since a ruleset expresses bypass
 * only through its bypass list, which `rulesetBypass` compares.
 */
export interface BranchControls {
  readonly pullRequestRequired: boolean;
  readonly requiredApprovals: number;
  readonly dismissStaleReviews: boolean;
  readonly requireLastPushApproval: boolean;
  readonly requireCodeOwnerReview: boolean;
  readonly conversationResolution: boolean;
  readonly strictStatusChecks: boolean;
  readonly requiredChecks: readonly RequiredCheck[];
  readonly forcePushesBlocked: boolean;
  readonly deletionsBlocked: boolean;
  readonly classic: ClassicLayer;
  readonly mergeQueue: MergeQueueLayer;
  readonly dismissal: DismissalPolicy;
  readonly pullRequestBypass: ActorSet;
  readonly rulesetBypass: readonly BypassActor[];
}

export interface BranchBaseline {
  readonly controls: BranchControls;
  readonly rulesets: readonly RulesetExpectation[];
}

export interface RepositoryAdmins {
  readonly users: readonly string[];
  readonly teams: readonly string[];
}

export type BaselineApproval =
  | {
    readonly status: 'proposed';
    readonly proposedOn: string;
    readonly tracking: string;
  }
  | {
    readonly status: 'approved';
    readonly approver: string;
    readonly approvedOn: string;
    /** Link to the issue comment that records the approval. */
    readonly record: string;
  };

/** Repository-wide settings the policy depends on, beyond branch rules. */
export interface RepositorySettings {
  /**
   * `allow_forking`. The develop merge queue runs queued code with repository
   * secrets, and it relies on no fork PR ever being queued
   * (docs/ci/merge-queue-plan.md, review control option B).
   */
  readonly forkingAllowed: boolean;
}

export interface BranchPolicyBaseline {
  readonly schema: 'example.branch-policy-baseline.v1';
  readonly repository: string;
  readonly approval: BaselineApproval;
  readonly repositoryAdmins: RepositoryAdmins;
  readonly repositorySettings: RepositorySettings;
  readonly branches: Readonly<Record<ProtectedBranch, BranchBaseline>>;
}

const GITHUB_ACTIONS_APP_ID = 15368;
const NO_ACTORS: ActorSet = { users: [], teams: [], apps: [] };

/**
 * APPROVED by the owner on 2026-09-26 (record: #5406) and, with the develop
 * merge queue, on 2026-09-27 (record: #4085 comment 5859150504, the current
 * `approval.record`). Grounded in
 * docs/github-repository-security.md and the required contexts the current
 * workflow definitions produce. The approval came from the account that
 * authored the baseline pull requests; an independent review is still
 * requested under the change control in docs/security/branch-policy-monitor.md.
 * Approval alone does not activate the monitor: the activation gate still
 * refuses a live read until #4085 decision 7 is implemented and the
 * read-only credential is provisioned.
 *
 * develop moved from classic protection to the `develop-protection` ruleset on
 * 2026-09-25 with the owner's approval. Its review dismissal is restricted to
 * the two repository administrators, which is what both the ruleset and the
 * classic rule it replaces enforce; the earlier administrators-only entry
 * never matched the live setting.
 *
 * main follows develop onto its existing `no-push-to-main` ruleset once the
 * operator step in docs/github-repository-security.md adds the strict
 * required-check rule and example-sheng as a dismisser, then deletes classic
 * protection. Its zero-approval, no-last-push review rule is the owner's live
 * configuration and is adopted rather than reported: native reviews are
 * 0-approval with conversation resolution (docs/ci/native-review-ownership.md).
 * example-sheng is a repository administrator through organization ownership.
 * The owner recorded these decisions (1, 4, 5 and 6) on 2026-09-26:
 * https://github.com/example-org/example-app/issues/4085#issuecomment-5846251573
 *
 * `repositorySettings.forkingAllowed: false` was added on 2026-09-27 with the
 * owner's approval of merge-queue review control option B
 * (docs/ci/merge-queue-plan.md, S3). It matches the live setting.
 *
 * develop's `mergeQueue` and its ruleset's `merge_queue` rule were added on
 * 2026-09-27, when merge-queue stage S3 was applied to ruleset 24024929 with
 * the owner's approval (docs/ci/merge-queue-plan.md, S3). main has no queue.
 */
export const branchPolicyBaseline: BranchPolicyBaseline = {
  schema: 'example.branch-policy-baseline.v1',
  repository: 'example-org/example-app',
  approval: {
    status: 'approved',
    approver: 'example-user',
    approvedOn: '2026-09-27',
    record: 'https://github.com/example-org/example-app/issues/4085#issuecomment-5859150504',
  },
  repositoryAdmins: { users: ['example-user', 'example-sheng', 'tyankov'], teams: [] },
  repositorySettings: { forkingAllowed: false },
  branches: {
    develop: {
      controls: {
        pullRequestRequired: true,
        requiredApprovals: 0,
        dismissStaleReviews: true,
        requireLastPushApproval: false,
        requireCodeOwnerReview: false,
        conversationResolution: true,
        strictStatusChecks: false,
        requiredChecks: [
          { context: 'Lint changed code', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'Validate pull request changes', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'Test - iOS', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'Onboarding E2E', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'iOS Change Gate', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'StoreKit Purchase - iOS', appId: GITHUB_ACTIONS_APP_ID },
        ],
        forcePushesBlocked: true,
        deletionsBlocked: true,
        classic: 'absent',
        mergeQueue: {
          mergeMethod: 'MERGE',
          groupingStrategy: 'ALLGREEN',
          maxEntriesToBuild: 8,
          minEntriesToMerge: 1,
          maxEntriesToMerge: 1,
          minEntriesToMergeWaitMinutes: 0,
          checkResponseTimeoutMinutes: 150,
        },
        dismissal: { restricted: true, actors: { users: ['example-user', 'tyankov'], teams: [], apps: [] } },
        pullRequestBypass: NO_ACTORS,
        rulesetBypass: [],
      },
      rulesets: [{
        name: 'develop-protection',
        source: 'example-org/example-app',
        ruleTypes: ['deletion', 'merge_queue', 'non_fast_forward', 'pull_request', 'required_status_checks'],
      }],
    },
    main: {
      controls: {
        pullRequestRequired: true,
        requiredApprovals: 0,
        dismissStaleReviews: true,
        requireLastPushApproval: false,
        requireCodeOwnerReview: false,
        conversationResolution: true,
        strictStatusChecks: true,
        requiredChecks: [
          { context: 'Lint changed code', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'Validate pull request changes', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'Test - iOS', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'Onboarding E2E', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'iOS Change Gate', appId: GITHUB_ACTIONS_APP_ID },
          { context: 'StoreKit Purchase - iOS', appId: GITHUB_ACTIONS_APP_ID },
        ],
        forcePushesBlocked: true,
        deletionsBlocked: true,
        classic: 'absent',
        mergeQueue: 'absent',
        dismissal: {
          restricted: true, actors: { users: ['example-user', 'example-sheng', 'tyankov'], teams: [], apps: [] },
        },
        pullRequestBypass: NO_ACTORS,
        rulesetBypass: [],
      },
      rulesets: [{
        name: 'no-push-to-main',
        source: 'example-org/example-app',
        ruleTypes: ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'],
      }],
    },
  },
};

function isUnresolved(value: unknown): value is Unresolved {
  return typeof value === 'object' && value !== null && 'unresolved' in value;
}

/** Every question a human must answer before this baseline may be approved. */
export function unresolvedBaselineFacts(baseline: BranchPolicyBaseline): readonly string[] {
  const facts: string[] = [];
  for (const branch of PROTECTED_BRANCHES) {
    for (const ruleset of baseline.branches[branch].rulesets) {
      if (isUnresolved(ruleset.name)) facts.push(`${branch}: ${ruleset.name.unresolved}`);
    }
  }
  return facts;
}

/**
 * Why a live inspection may not run against this baseline, or an empty list.
 * A proposed or incomplete baseline is refused rather than compared, so a
 * green run can only ever mean "matches what a human approved".
 */
export function baselineActivationBlockers(baseline: BranchPolicyBaseline): readonly string[] {
  const blockers: string[] = [];
  if (baseline.approval.status !== 'approved') {
    blockers.push(`baseline is ${baseline.approval.status}; #4085's operator must approve it first`);
  }
  for (const fact of unresolvedBaselineFacts(baseline)) blockers.push(`unresolved baseline fact — ${fact}`);
  return blockers;
}

export function rulesetName(expectation: RulesetExpectation): string {
  return isUnresolved(expectation.name) ? `<unresolved: ${expectation.name.unresolved}>` : expectation.name;
}

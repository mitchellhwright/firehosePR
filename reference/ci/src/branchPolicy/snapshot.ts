import {
  PROTECTED_BRANCHES,
  type ActorSet,
  type BranchControls,
  type BypassActor,
  type ClassicLayer,
  type DismissalPolicy,
  type MergeQueueLayer,
  type ProtectedBranch,
  type RepositoryAdmins,
  type RepositorySettings,
  type RequiredCheck,
} from './baseline.ts';
import { InspectionError, type GithubReader } from './githubReader.ts';

/**
 * Reads the provider's controls and reduces them to the same shape the
 * baseline uses. Parsing is strict: a field the comparison depends on that is
 * absent or of the wrong type is a malformed response, never a default. The
 * only absences read as "not configured" are the ones GitHub documents as
 * meaning exactly that: an omitted classic review or status-check section, a
 * `404 Branch not protected` for the whole classic layer, and an omitted or
 * disabled ruleset `dismissal_restriction`.
 */

export interface RulesetSummary {
  readonly id: number;
  readonly name: string;
  readonly source: string;
  readonly enforcement: string;
}

export interface ObservedRuleset extends RulesetSummary {
  readonly ruleTypes: readonly string[];
  readonly bypass: readonly BypassActor[];
}

export interface BranchObservation {
  readonly controls: BranchControls;
  readonly rulesetsInEffect: readonly ObservedRuleset[];
}

export interface PolicySnapshot {
  readonly repository: string;
  readonly acquiredAt: string;
  readonly repositoryAdmins: RepositoryAdmins;
  readonly repositorySettings: RepositorySettings;
  readonly rulesets: readonly RulesetSummary[];
  readonly branches: Readonly<Record<ProtectedBranch, BranchObservation>>;
}

class Malformed extends Error {}

type Json = Readonly<Record<string, unknown>>;

function object(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Malformed(`${path} is not an object`);
  return value as Json;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Malformed(`${path} is not an array`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Malformed(`${path} is not a boolean`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') throw new Malformed(`${path} is not a non-empty string`);
  return value;
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Malformed(`${path} is not a non-negative integer`);
  }
  return value;
}

function enabled(value: unknown, path: string): boolean {
  return bool(object(value, path)['enabled'], `${path}.enabled`);
}

/** `null`, `-1` and an omitted id all mean the context is accepted from any source. */
function producer(value: unknown, path: string): number | 'any' {
  if (value === undefined || value === null || value === -1) return 'any';
  return count(value, path);
}

function actorSet(value: unknown, path: string): ActorSet {
  const section = object(value, path);
  const names = (key: string, field: string): string[] =>
    array(section[key], `${path}.${key}`).map((entry, index) =>
      text(object(entry, `${path}.${key}[${index}]`)[field], `${path}.${key}[${index}].${field}`));
  return { users: names('users', 'login'), teams: names('teams', 'slug'), apps: names('apps', 'slug') };
}

const NO_ACTORS: ActorSet = { users: [], teams: [], apps: [] };

interface ClassicProtection {
  readonly pullRequestRequired: boolean;
  readonly requiredApprovals: number;
  readonly dismissStaleReviews: boolean;
  readonly requireLastPushApproval: boolean;
  readonly requireCodeOwnerReview: boolean;
  readonly dismissal: DismissalPolicy;
  readonly pullRequestBypass: ActorSet;
  readonly strictStatusChecks: boolean;
  readonly requiredChecks: readonly RequiredCheck[];
  readonly enforceAdmins: boolean;
  readonly forcePushesBlocked: boolean;
  readonly deletionsBlocked: boolean;
  readonly conversationResolution: boolean;
}

export function parseClassicProtection(payload: unknown): ClassicProtection {
  const root = object(payload, 'protection');
  const reviewsValue = root['required_pull_request_reviews'];
  const reviews = reviewsValue === undefined ? undefined : object(reviewsValue, 'required_pull_request_reviews');
  const checksValue = root['required_status_checks'];
  const checks = checksValue === undefined ? undefined : object(checksValue, 'required_status_checks');
  const at = (key: string): string => `required_pull_request_reviews.${key}`;
  return {
    pullRequestRequired: reviews !== undefined,
    requiredApprovals: reviews === undefined ? 0 : count(reviews['required_approving_review_count'], at('required_approving_review_count')),
    dismissStaleReviews: reviews === undefined ? false : bool(reviews['dismiss_stale_reviews'], at('dismiss_stale_reviews')),
    requireLastPushApproval: reviews === undefined ? false : bool(reviews['require_last_push_approval'], at('require_last_push_approval')),
    requireCodeOwnerReview: reviews === undefined ? false : bool(reviews['require_code_owner_reviews'], at('require_code_owner_reviews')),
    dismissal: reviews?.['dismissal_restrictions'] === undefined
      ? { restricted: false }
      : { restricted: true, actors: actorSet(reviews['dismissal_restrictions'], at('dismissal_restrictions')) },
    pullRequestBypass: reviews?.['bypass_pull_request_allowances'] === undefined
      ? NO_ACTORS
      : actorSet(reviews['bypass_pull_request_allowances'], at('bypass_pull_request_allowances')),
    strictStatusChecks: checks === undefined ? false : bool(checks['strict'], 'required_status_checks.strict'),
    requiredChecks: checks === undefined ? [] : array(checks['checks'], 'required_status_checks.checks').map((entry, index) => {
      const check = object(entry, `required_status_checks.checks[${index}]`);
      return {
        context: text(check['context'], `required_status_checks.checks[${index}].context`),
        appId: producer(check['app_id'], `required_status_checks.checks[${index}].app_id`),
      };
    }),
    enforceAdmins: enabled(root['enforce_admins'], 'enforce_admins'),
    forcePushesBlocked: !enabled(root['allow_force_pushes'], 'allow_force_pushes'),
    deletionsBlocked: !enabled(root['allow_deletions'], 'allow_deletions'),
    conversationResolution: enabled(root['required_conversation_resolution'], 'required_conversation_resolution'),
  };
}

export interface EffectiveRule {
  readonly type: string;
  readonly rulesetId: number;
  readonly parameters: Json | undefined;
}

/** The repository settings the baseline compares. A missing field is malformed, never a default. */
export function parseRepositorySettings(payload: unknown): RepositorySettings {
  const repository = object(payload, 'repository');
  return { forkingAllowed: bool(repository['allow_forking'], 'repository.allow_forking') };
}

export function parseEffectiveRules(items: readonly unknown[]): readonly EffectiveRule[] {
  return items.map((entry, index) => {
    const rule = object(entry, `rules[${index}]`);
    const parameters = rule['parameters'];
    return {
      type: text(rule['type'], `rules[${index}].type`),
      rulesetId: count(rule['ruleset_id'], `rules[${index}].ruleset_id`),
      parameters: parameters === undefined ? undefined : object(parameters, `rules[${index}].parameters`),
    };
  });
}

function sourceOf(ruleset: Json, path: string): string {
  return text(ruleset['source'], `${path}.source`);
}

export function parseRulesetSummaries(items: readonly unknown[]): readonly RulesetSummary[] {
  return items.map((entry, index) => {
    const ruleset = object(entry, `rulesets[${index}]`);
    return {
      id: count(ruleset['id'], `rulesets[${index}].id`),
      name: text(ruleset['name'], `rulesets[${index}].name`),
      source: sourceOf(ruleset, `rulesets[${index}]`),
      enforcement: text(ruleset['enforcement'], `rulesets[${index}].enforcement`),
    };
  });
}

/**
 * A ruleset's bypass list. GitHub omits `bypass_actors` for callers without
 * write access to the ruleset; that is an inspection gap, not an empty list.
 */
export function parseRulesetDetail(payload: unknown): { readonly summary: RulesetSummary; readonly bypass: readonly BypassActor[] } {
  const ruleset = object(payload, 'ruleset');
  if (ruleset['bypass_actors'] === undefined) {
    throw new Malformed('ruleset.bypass_actors is not visible to this credential');
  }
  return {
    summary: {
      id: count(ruleset['id'], 'ruleset.id'),
      name: text(ruleset['name'], 'ruleset.name'),
      source: sourceOf(ruleset, 'ruleset'),
      enforcement: text(ruleset['enforcement'], 'ruleset.enforcement'),
    },
    bypass: array(ruleset['bypass_actors'], 'ruleset.bypass_actors').map((entry, index) => {
      const actor = object(entry, `ruleset.bypass_actors[${index}]`);
      const id = actor['actor_id'];
      return {
        actorType: text(actor['actor_type'], `ruleset.bypass_actors[${index}].actor_type`),
        actorId: id === null || id === undefined ? null : count(id, `ruleset.bypass_actors[${index}].actor_id`),
        bypassMode: text(actor['bypass_mode'], `ruleset.bypass_actors[${index}].bypass_mode`),
      };
    }),
  };
}

/** Account and team names by numeric id, for rules that name actors only by id. */
export interface ActorDirectory {
  readonly users: ReadonlyMap<number, string>;
  readonly teams: ReadonlyMap<number, string>;
}

interface NamedAccount {
  readonly id: number;
  readonly name: string;
}

export function parseAdminUsers(items: readonly unknown[]): readonly NamedAccount[] {
  return items.map((entry, index) => {
    const user = object(entry, `collaborators[${index}]`);
    const permissions = object(user['permissions'], `collaborators[${index}].permissions`);
    if (!bool(permissions['admin'], `collaborators[${index}].permissions.admin`)) {
      throw new Malformed(`collaborators[${index}] was returned by an admin-only query without admin permission`);
    }
    return { id: count(user['id'], `collaborators[${index}].id`), name: text(user['login'], `collaborators[${index}].login`) };
  });
}

export function parseTeams(items: readonly unknown[]): readonly (NamedAccount & { readonly admin: boolean })[] {
  return items.map((entry, index) => {
    const team = object(entry, `teams[${index}]`);
    return {
      id: count(team['id'], `teams[${index}].id`),
      name: text(team['slug'], `teams[${index}].slug`),
      admin: text(team['permission'], `teams[${index}].permission`) === 'admin',
    };
  });
}

/**
 * A ruleset `dismissal_restriction`. GitHub names its actors by id only, so
 * users and teams are named through the directory of administrators and
 * repository teams; an actor outside it keeps its id (`#123`), which never
 * matches a baseline login and is therefore reported rather than dropped.
 */
export function parseDismissalRestriction(value: unknown, path: string, directory: ActorDirectory): DismissalPolicy {
  if (value === undefined) return { restricted: false };
  const restriction = object(value, path);
  if (!bool(restriction['enabled'], `${path}.enabled`)) return { restricted: false };
  const users: string[] = [];
  const teams: string[] = [];
  const apps: string[] = [];
  array(restriction['allowed_actors'], `${path}.allowed_actors`).forEach((entry, index) => {
    const actor = object(entry, `${path}.allowed_actors[${index}]`);
    const id = count(actor['id'], `${path}.allowed_actors[${index}].id`);
    const type = text(actor['type'], `${path}.allowed_actors[${index}].type`);
    if (type === 'User') users.push(directory.users.get(id) ?? `#${id}`);
    else if (type === 'Team') teams.push(directory.teams.get(id) ?? `#${id}`);
    else apps.push(`${type}#${id}`);
  });
  return { restricted: true, actors: { users, teams, apps } };
}

/** Actors allowed by every restriction, which is who GitHub lets dismiss when rules overlap. */
function strictestDismissal(policies: readonly DismissalPolicy[]): DismissalPolicy {
  let result: DismissalPolicy = { restricted: false };
  for (const policy of policies) {
    if (!policy.restricted) continue;
    if (!result.restricted) {
      result = policy;
      continue;
    }
    const kept: ActorSet = result.actors;
    const both = (key: keyof ActorSet): string[] => kept[key].filter((item) => policy.actors[key].includes(item));
    result = { restricted: true, actors: { users: both('users'), teams: both('teams'), apps: both('apps') } };
  }
  return result;
}

interface PullRequestRule {
  readonly approvals: number;
  readonly dismissStale: boolean;
  readonly lastPush: boolean;
  readonly codeOwner: boolean;
  readonly threads: boolean;
  readonly dismissal: DismissalPolicy;
}

function parsePullRequestRule(value: unknown, path: string, directory: ActorDirectory): PullRequestRule {
  const parameters = object(value, path);
  return {
    approvals: count(parameters['required_approving_review_count'], `${path}.required_approving_review_count`),
    dismissStale: bool(parameters['dismiss_stale_reviews_on_push'], `${path}.dismiss_stale_reviews_on_push`),
    lastPush: bool(parameters['require_last_push_approval'], `${path}.require_last_push_approval`),
    codeOwner: bool(parameters['require_code_owner_review'], `${path}.require_code_owner_review`),
    threads: bool(parameters['required_review_thread_resolution'], `${path}.required_review_thread_resolution`),
    dismissal: parseDismissalRestriction(parameters['dismissal_restriction'], `${path}.dismissal_restriction`, directory),
  };
}

function parseStatusCheckRule(value: unknown, path: string): { readonly strict: boolean; readonly checks: RequiredCheck[] } {
  const parameters = object(value, path);
  return {
    strict: bool(parameters['strict_required_status_checks_policy'], `${path}.strict_required_status_checks_policy`),
    checks: array(parameters['required_status_checks'], `${path}.required_status_checks`).map((entry, index) => {
      const check = object(entry, `${path}.required_status_checks[${index}]`);
      return {
        context: text(check['context'], `${path}.required_status_checks[${index}].context`),
        appId: producer(check['integration_id'], `${path}.required_status_checks[${index}].integration_id`),
      };
    }),
  };
}

function parseMergeQueueRule(value: unknown, path: string): Exclude<MergeQueueLayer, 'absent'> {
  const parameters = object(value, path);
  const number = (key: string): number => count(parameters[key], `${path}.${key}`);
  return {
    mergeMethod: text(parameters['merge_method'], `${path}.merge_method`),
    groupingStrategy: text(parameters['grouping_strategy'], `${path}.grouping_strategy`),
    maxEntriesToBuild: number('max_entries_to_build'),
    minEntriesToMerge: number('min_entries_to_merge'),
    maxEntriesToMerge: number('max_entries_to_merge'),
    minEntriesToMergeWaitMinutes: number('min_entries_to_merge_wait_minutes'),
    checkResponseTimeoutMinutes: number('check_response_timeout_minutes'),
  };
}

/** What an unprotected branch contributes before any ruleset is applied. */
const NO_CLASSIC: ClassicProtection = {
  pullRequestRequired: false,
  requiredApprovals: 0,
  dismissStaleReviews: false,
  requireLastPushApproval: false,
  requireCodeOwnerReview: false,
  dismissal: { restricted: false },
  pullRequestBypass: NO_ACTORS,
  strictStatusChecks: false,
  requiredChecks: [],
  enforceAdmins: false,
  forcePushesBlocked: false,
  deletionsBlocked: false,
  conversationResolution: false,
};

function classicLayer(classic: ClassicProtection | undefined): ClassicLayer {
  if (classic === undefined) return 'absent';
  return {
    enforceAdmins: classic.enforceAdmins,
    forcePushesBlocked: classic.forcePushesBlocked,
    deletionsBlocked: classic.deletionsBlocked,
  };
}

/**
 * The effective controls: the strongest value across classic protection (when
 * the branch has it) and every active rule, which is what GitHub enforces when
 * the layers overlap. Dismissal and pull-request bypass come from the classic
 * layer when it exists and from the rulesets otherwise; see `BranchControls`.
 */
export function effectiveControls(
  classic: ClassicProtection | undefined,
  rules: readonly EffectiveRule[],
  rulesetBypass: readonly BypassActor[],
  directory: ActorDirectory,
): BranchControls {
  const base = classic ?? NO_CLASSIC;
  let pullRequestRequired = base.pullRequestRequired;
  let requiredApprovals = base.requiredApprovals;
  let dismissStaleReviews = base.dismissStaleReviews;
  let requireLastPushApproval = base.requireLastPushApproval;
  let requireCodeOwnerReview = base.requireCodeOwnerReview;
  let conversationResolution = base.conversationResolution;
  let strictStatusChecks = base.strictStatusChecks;
  const requiredChecks: RequiredCheck[] = [...base.requiredChecks];
  let forcePushesBlocked = base.forcePushesBlocked;
  let deletionsBlocked = base.deletionsBlocked;
  const rulesetDismissals: DismissalPolicy[] = [];
  let mergeQueue: MergeQueueLayer = 'absent';

  rules.forEach((rule, index) => {
    const path = `rules[${index}].parameters`;
    if (rule.type === 'deletion') deletionsBlocked = true;
    if (rule.type === 'non_fast_forward') forcePushesBlocked = true;
    if (rule.type === 'pull_request') {
      // Parse every parameter before combining: `a ||= parse()` would skip
      // validating a field whenever the classic layer is already stronger.
      const pullRequest = parsePullRequestRule(rule.parameters, path, directory);
      pullRequestRequired = true;
      requiredApprovals = Math.max(requiredApprovals, pullRequest.approvals);
      dismissStaleReviews = dismissStaleReviews || pullRequest.dismissStale;
      requireLastPushApproval = requireLastPushApproval || pullRequest.lastPush;
      requireCodeOwnerReview = requireCodeOwnerReview || pullRequest.codeOwner;
      conversationResolution = conversationResolution || pullRequest.threads;
      rulesetDismissals.push(pullRequest.dismissal);
    }
    if (rule.type === 'required_status_checks') {
      const statusChecks = parseStatusCheckRule(rule.parameters, path);
      strictStatusChecks = strictStatusChecks || statusChecks.strict;
      requiredChecks.push(...statusChecks.checks);
    }
    if (rule.type === 'merge_queue') {
      if (mergeQueue !== 'absent') throw new Malformed(`${path}: more than one merge_queue rule applies to the branch`);
      mergeQueue = parseMergeQueueRule(rule.parameters, path);
    }
  });

  return {
    pullRequestRequired,
    requiredApprovals,
    dismissStaleReviews,
    requireLastPushApproval,
    requireCodeOwnerReview,
    conversationResolution,
    strictStatusChecks,
    requiredChecks,
    forcePushesBlocked,
    deletionsBlocked,
    classic: classicLayer(classic),
    mergeQueue,
    dismissal: classic === undefined ? strictestDismissal(rulesetDismissals) : classic.dismissal,
    pullRequestBypass: base.pullRequestBypass,
    rulesetBypass,
  };
}

/** Runs a parser and turns a shape violation into a malformed-response failure at that endpoint. */
function parsed<T>(endpoint: string, parse: () => T): T {
  try {
    return parse();
  } catch (error: unknown) {
    if (error instanceof Malformed) {
      throw new InspectionError({ reason: 'malformed-response', endpoint, detail: error.message });
    }
    throw error;
  }
}

/** GitHub's answer for a branch with no classic protection, as opposed to one this credential cannot see. */
export const BRANCH_NOT_PROTECTED = 'Branch not protected';

async function observeBranch(
  reader: GithubReader,
  repository: string,
  branch: ProtectedBranch,
  directory: ActorDirectory,
): Promise<BranchObservation> {
  const classicEndpoint = `GET /repos/{repo}/branches/${branch}/protection`;
  const classicRead = await reader.getOptionalJson(`/repos/${repository}/branches/${branch}/protection`, BRANCH_NOT_PROTECTED);
  const classic = classicRead.found ? parsed(classicEndpoint, () => parseClassicProtection(classicRead.body)) : undefined;
  const rulePages = await reader.getAllPages(`/repos/${repository}/rules/branches/${branch}`);
  const rules = parsed(`GET /repos/{repo}/rules/branches/${branch}`, () => parseEffectiveRules(rulePages));

  const rulesetIds = [...new Set(rules.map((rule) => rule.rulesetId))].sort((left, right) => left - right);
  const rulesetsInEffect: ObservedRuleset[] = [];
  for (const id of rulesetIds) {
    const payload = await reader.getJson(`/repos/${repository}/rulesets/${id}`, { includes_parents: 'true' });
    const detail = parsed('GET /repos/{repo}/rulesets/{id}', () => parseRulesetDetail(payload));
    rulesetsInEffect.push({
      ...detail.summary,
      ruleTypes: [...new Set(rules.filter((rule) => rule.rulesetId === id).map((rule) => rule.type))],
      bypass: detail.bypass,
    });
  }
  const controls = parsed(`GET /repos/{repo}/rules/branches/${branch}`, () =>
    effectiveControls(classic, rules, rulesetsInEffect.flatMap((ruleset) => ruleset.bypass), directory));
  return { controls, rulesetsInEffect };
}

export interface AcquireOptions {
  readonly reader: GithubReader;
  readonly repository: string;
  readonly now?: () => Date;
}

/** Reads every control once. Any failure aborts the whole snapshot. */
export async function acquireSnapshot(options: AcquireOptions): Promise<PolicySnapshot> {
  const { reader, repository } = options;
  const acquiredAt = (options.now ?? (() => new Date()))().toISOString();
  const repositoryPayload = await reader.getJson(`/repos/${repository}`);
  const repositorySettings = parsed('GET /repos/{repo}', () => parseRepositorySettings(repositoryPayload));
  const adminPages = await reader.getAllPages(`/repos/${repository}/collaborators`, { affiliation: 'all', permission: 'admin' });
  const admins = parsed('GET /repos/{repo}/collaborators', () => parseAdminUsers(adminPages));
  const teamPages = await reader.getAllPages(`/repos/${repository}/teams`);
  const teams = parsed('GET /repos/{repo}/teams', () => parseTeams(teamPages));
  const rulesetPages = await reader.getAllPages(`/repos/${repository}/rulesets`, { includes_parents: 'true' });
  const rulesets = parsed('GET /repos/{repo}/rulesets', () => parseRulesetSummaries(rulesetPages));
  const directory: ActorDirectory = {
    users: new Map(admins.map((admin) => [admin.id, admin.name])),
    teams: new Map(teams.map((team) => [team.id, team.name])),
  };

  const branches: Partial<Record<ProtectedBranch, BranchObservation>> = {};
  for (const branch of PROTECTED_BRANCHES) branches[branch] = await observeBranch(reader, repository, branch, directory);
  const { develop, main } = branches;
  if (develop === undefined || main === undefined) throw new Error('every protected branch is observed');
  const repositoryAdmins: RepositoryAdmins = {
    users: admins.map((admin) => admin.name),
    teams: teams.filter((team) => team.admin).map((team) => team.name),
  };
  return { repository, acquiredAt, repositoryAdmins, repositorySettings, rulesets, branches: { develop, main } };
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SYNTHETIC_DRIFT_ADMIN, runMonitor, type MonitorOutcome } from '../src/actions/checkBranchPolicyDrift.ts';
import {
  UNSETTLED_ACTIVATION_DECISIONS, activationBlockers,
} from '../src/actions/confirmBranchPolicyMonitorActivation.ts';
import {
  PROTECTED_BRANCHES, baselineActivationBlockers, branchPolicyBaseline, unresolvedBaselineFacts,
  type BranchPolicyBaseline,
} from '../src/branchPolicy/baseline.ts';
import { scrub, type Difference } from '../src/branchPolicy/drift.ts';
import {
  ALLOWED_ENDPOINTS, InspectionError, MAX_PAGES, createGithubReader,
} from '../src/branchPolicy/githubReader.ts';
import { definitions } from '../workflows/all.ts';
import { requiredContextsFrom } from '../workflows/lib/projections.ts';
import {
  ADMIN_IDS, API, DEVELOP_MERGE_QUEUE, DEVELOP_RULESET_ID, DEVELOP_RULESET_NAME, MAIN_RULESET_ID, MAIN_RULESET_NAME, REPOSITORY, SENTINEL_TOKEN,
  approvedBaseline, classicProtection, desiredState, fakeGithub, monitorEnv, observedState, proposedBaseline,
  typedChecks,
  type FakeGithubOptions, type ProviderState,
} from './fixtures/branchPolicyFixtures.ts';

const base = `/repos/${REPOSITORY}`;
const fixedNow = (): Date => new Date('2026-09-24T21:00:00.000Z');

async function monitor(
  options: FakeGithubOptions,
  env: Readonly<Record<string, string | undefined>> = monitorEnv,
  baseline: BranchPolicyBaseline = approvedBaseline(),
): Promise<MonitorOutcome & { readonly requests: ReturnType<typeof fakeGithub>['requests'] }> {
  const github = fakeGithub(options);
  const outcome = await runMonitor({ env, baseline, fetchImpl: github.fetchImpl, now: fixedNow });
  assert.ok(!outcome.reportJson.includes(SENTINEL_TOKEN), 'report must never carry the credential');
  assert.ok(!outcome.summary.includes(SENTINEL_TOKEN), 'summary must never carry the credential');
  return { ...outcome, requests: github.requests };
}

function mutated(change: (state: ProviderState) => void, start: () => ProviderState = desiredState): ProviderState {
  const state = start();
  change(state);
  return state;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function ruleParameters(state: ProviderState, branch: 'develop' | 'main', type: string): Record<string, unknown> {
  return record(state.rules[branch].find((rule) => rule['type'] === type)?.['parameters']);
}

function developPullRequest(state: ProviderState): Record<string, unknown> {
  return ruleParameters(state, 'develop', 'pull_request');
}

function developStatusChecks(state: ProviderState): Record<string, unknown> {
  return ruleParameters(state, 'develop', 'required_status_checks');
}

function mainStatusChecks(state: ProviderState): Record<string, unknown> {
  return ruleParameters(state, 'main', 'required_status_checks');
}

function mainCheck(state: ProviderState, context: string): Record<string, unknown> {
  return record(list(mainStatusChecks(state)['required_status_checks']).find((check) => record(check)['context'] === context));
}

function dismissers(parameters: Record<string, unknown>): unknown[] {
  return list(record(parameters['dismissal_restriction'])['allowed_actors']);
}

/**
 * main's post-migration state from the live-shaped fixture: the `no-push-to-main`
 * ruleset with the operator's planned additions, the disabled duplicate ruleset
 * still listed, and no classic protection.
 */
function liveMainState(): ProviderState {
  const live = record(JSON.parse(readFileSync('ci/tests/fixtures/branchPolicyLiveMain.json', 'utf8')));
  const detail = record(live['rulesetDetail']);
  const state = desiredState();
  state.protection.main = undefined;
  state.rules.main = list(live['rules']).map(record);
  state.rulesets = [
    ...state.rulesets.filter((ruleset) => ruleset['id'] !== MAIN_RULESET_ID),
    record(live['rulesetSummary']),
    record(live['retiredRulesetSummary']),
  ];
  state.rulesetDetails = {
    [DEVELOP_RULESET_ID]: record(state.rulesetDetails[DEVELOP_RULESET_ID]),
    [Number(detail['id'])]: detail,
  };
  return state;
}

/** Classic protection on main carrying the same controls as its ruleset. */
function withClassicMain(state: ProviderState): void {
  state.protection.main = classicProtection({
    approvals: 0,
    lastPush: false,
    strict: true,
    contexts: typedChecks,
    conversation: true,
    dismissers: ['example-user', 'example-sheng', 'tyankov'],
  });
}

/** Adds classic protection to main and returns its payload for mutation. */
function classicMain(state: ProviderState): Record<string, unknown> {
  withClassicMain(state);
  return record(state.protection.main);
}

/** A baseline expecting a fully enforced classic layer on main, to exercise layered comparison. */
function classicMainBaseline(): BranchPolicyBaseline {
  const baseline = approvedBaseline();
  const { main } = baseline.branches;
  return {
    ...baseline,
    branches: {
      ...baseline.branches,
      main: {
        ...main,
        controls: { ...main.controls, classic: { enforceAdmins: true, forcePushesBlocked: true, deletionsBlocked: true } },
      },
    },
  };
}

async function drift(
  change: (state: ProviderState) => void,
  start: () => ProviderState = desiredState,
  baseline: BranchPolicyBaseline = approvedBaseline(),
): Promise<readonly Difference[]> {
  const outcome = await monitor({ state: mutated(change, start) }, monitorEnv, baseline);
  assert.equal(outcome.report.result, 'drift');
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.report.failure, null);
  return outcome.report.differences;
}

async function inspectionFailure(options: FakeGithubOptions, env = monitorEnv as Readonly<Record<string, string | undefined>>) {
  const outcome = await monitor(options, env);
  assert.equal(outcome.report.result, 'inspection-failed');
  assert.equal(outcome.exitCode, 3);
  assert.deepEqual(outcome.report.differences, [], 'a failed inspection never reports a partial comparison');
  assert.ok(outcome.report.failure);
  return { failure: outcome.report.failure, outcome };
}

// Compliance and ordering

test('a provider state matching the approved baseline is compliant', async () => {
  const outcome = await monitor({ state: desiredState() });
  assert.equal(outcome.report.result, 'compliant');
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.report.differences, []);
  assert.equal(outcome.report.acquiredAt, '2026-09-24T21:00:00.000Z');
  assert.match(outcome.summary, /Compliant with the baseline \(approved by fixture-approver/);
});

test('reordered but equivalent payloads compare cleanly', async () => {
  const state = desiredState();
  state.collaborators.reverse();
  state.rulesets.reverse();
  for (const branch of PROTECTED_BRANCHES) {
    state.rules[branch].reverse();
    list(ruleParameters(state, branch, 'required_status_checks')['required_status_checks']).reverse();
    dismissers(ruleParameters(state, branch, 'pull_request')).reverse();
  }
  const outcome = await monitor({ state });
  assert.equal(outcome.report.result, 'compliant');
});

test('every page of a paginated list is read before comparing', async () => {
  const outcome = await monitor({ state: desiredState(), pageSize: 1 });
  assert.equal(outcome.report.result, 'compliant');
  const collaboratorPages = outcome.requests.filter((request) => request.url.pathname === `${base}/collaborators`);
  assert.deepEqual(collaboratorPages.map((request) => request.url.searchParams.get('page') ?? '1'), ['1', '2', '3']);
});

// Policy drift

test('a required check dropped from the develop ruleset is drift on that branch only', async () => {
  const differences = await drift((state) => {
    const parameters = developStatusChecks(state);
    parameters['required_status_checks'] = list(parameters['required_status_checks'])
      .filter((check) => record(check)['context'] !== 'Onboarding E2E');
  });
  assert.deepEqual(differences, [{ scope: 'develop', field: 'requiredChecks', kind: 'missing', item: 'Onboarding E2E' }]);
});

test('a required check produced by the wrong App is drift', async () => {
  const differences = await drift((state) => { mainCheck(state, 'Test - iOS')['integration_id'] = 424242; });
  assert.deepEqual(differences, [{
    scope: 'main', field: 'requiredChecks[Test - iOS].producer', kind: 'changed', expected: 'app 15368', observed: 'app 424242',
  }]);
});

test('a required check accepted from any source is drift', async () => {
  const differences = await drift((state) => { mainCheck(state, 'iOS Change Gate')['integration_id'] = null; });
  assert.deepEqual(differences.map((difference) => difference.field), ['requiredChecks[iOS Change Gate].producer']);
});

test('conversation resolution off in the main ruleset is drift', async () => {
  const differences = await drift((state) => {
    ruleParameters(state, 'main', 'pull_request')['required_review_thread_resolution'] = false;
  });
  assert.deepEqual(differences, [{ scope: 'main', field: 'conversationResolution', kind: 'changed', expected: true, observed: false }]);
});

test('thread resolution off in the develop ruleset is drift', async () => {
  const differences = await drift((state) => { developPullRequest(state)['required_review_thread_resolution'] = false; });
  assert.deepEqual(differences, [{ scope: 'develop', field: 'conversationResolution', kind: 'changed', expected: true, observed: false }]);
});

test('an approval or last-push requirement added to main is drift from the adopted configuration', async () => {
  const differences = await drift((state) => {
    const pullRequest = ruleParameters(state, 'main', 'pull_request');
    pullRequest['required_approving_review_count'] = 1;
    pullRequest['require_last_push_approval'] = true;
  });
  assert.deepEqual(differences, [
    { scope: 'main', field: 'requiredApprovals', kind: 'changed', expected: 0, observed: 1 },
    { scope: 'main', field: 'requireLastPushApproval', kind: 'changed', expected: false, observed: true },
  ]);
});

test('stale-review dismissal and code-owner review changes are drift', async () => {
  const differences = await drift((state) => {
    const pullRequest = developPullRequest(state);
    pullRequest['dismiss_stale_reviews_on_push'] = false;
    pullRequest['require_code_owner_review'] = true;
  });
  assert.deepEqual(differences.map((difference) => difference.field).sort(), ['dismissStaleReviews', 'requireCodeOwnerReview']);
});

test('unexpected admins, dismissal actors and bypass actors are drift', async () => {
  const differences = await drift((state) => {
    state.collaborators.push({ login: 'new-admin', id: 5001, permissions: { admin: true }, role_name: 'admin' });
    state.teams.push({ id: 7002, slug: 'platform', permission: 'admin' });
    dismissers(ruleParameters(state, 'main', 'pull_request')).push({ id: 5001, type: 'User' });
    record(state.rulesetDetails[MAIN_RULESET_ID])['bypass_actors'] = [
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ];
  });
  assert.deepEqual(differences, [
    { scope: 'repository', field: 'admins.users', kind: 'unexpected', item: 'new-admin' },
    { scope: 'repository', field: 'admins.teams', kind: 'unexpected', item: 'platform' },
    { scope: 'main', field: 'dismissal.actors', kind: 'unexpected', item: 'user:new-admin' },
    { scope: 'main', field: 'rulesetBypass', kind: 'unexpected', item: 'RepositoryRole:5:always' },
  ]);
});

for (const branch of PROTECTED_BRANCHES) {
  for (const [name, change] of [
    ['disabled', (parameters: Record<string, unknown>) => { record(parameters['dismissal_restriction'])['enabled'] = false; }],
    ['removed', (parameters: Record<string, unknown>) => { delete parameters['dismissal_restriction']; }],
  ] as const) {
    test(`a ${name} ${branch} ruleset dismissal restriction is drift`, async () => {
      const differences = await drift((state) => { change(ruleParameters(state, branch, 'pull_request')); });
      assert.deepEqual(differences, [{ scope: branch, field: 'dismissal.restricted', kind: 'changed', expected: true, observed: false }]);
    });
  }
}

test('a ruleset dismissal actor is named by login, and an actor outside the directory keeps its id', async () => {
  const differences = await drift((state) => {
    record(developPullRequest(state)['dismissal_restriction'])['allowed_actors'] = [
      { id: ADMIN_IDS.example-user, type: 'User' },
      { id: 999, type: 'User' },
      { id: 7001, type: 'Team' },
      { id: 42, type: 'Integration' },
    ];
  });
  assert.deepEqual(differences, [
    { scope: 'develop', field: 'dismissal.actors', kind: 'missing', item: 'user:tyankov' },
    { scope: 'develop', field: 'dismissal.actors', kind: 'unexpected', item: 'app:Integration#42' },
    { scope: 'develop', field: 'dismissal.actors', kind: 'unexpected', item: 'team:engineering' },
    { scope: 'develop', field: 'dismissal.actors', kind: 'unexpected', item: 'user:#999' },
  ]);
});

test('overlapping ruleset dismissal restrictions allow only actors both permit', async () => {
  const differences = await drift((state) => {
    state.rules.develop.push({
      type: 'pull_request',
      ruleset_source_type: 'Repository',
      ruleset_source: REPOSITORY,
      ruleset_id: DEVELOP_RULESET_ID,
      parameters: {
        ...developPullRequest(state),
        dismissal_restriction: { enabled: true, allowed_actors: [{ id: ADMIN_IDS.tyankov, type: 'User' }] },
      },
    });
  });
  assert.deepEqual(differences, [{ scope: 'develop', field: 'dismissal.actors', kind: 'missing', item: 'user:example-user' }]);
});

test('a removed admin is drift', async () => {
  const differences = await drift((state) => { state.collaborators.pop(); });
  // A ruleset names dismissal actors by id; once tyankov is no longer an admin, the id cannot be named.
  assert.deepEqual(differences, [
    { scope: 'repository', field: 'admins.users', kind: 'missing', item: 'tyankov' },
    { scope: 'develop', field: 'dismissal.actors', kind: 'missing', item: 'user:tyankov' },
    { scope: 'develop', field: 'dismissal.actors', kind: 'unexpected', item: `user:#${ADMIN_IDS.tyankov}` },
    { scope: 'main', field: 'dismissal.actors', kind: 'missing', item: 'user:tyankov' },
    { scope: 'main', field: 'dismissal.actors', kind: 'unexpected', item: `user:#${ADMIN_IDS.tyankov}` },
  ]);
});

test('repository forking turned on is drift, because the merge queue runs queued code with secrets', async () => {
  const differences = await drift((state) => { state.repository['allow_forking'] = true; });
  assert.deepEqual(differences, [
    { scope: 'repository', field: 'forkingAllowed', kind: 'changed', expected: false, observed: true },
  ]);
});

// develop merge queue (stage S3, 2026-09-27)

test('the develop merge queue removed from its ruleset is drift', async () => {
  const differences = await drift((state) => {
    state.rules.develop = state.rules.develop.filter((rule) => rule['type'] !== 'merge_queue');
  });
  assert.deepEqual(differences, [
    { scope: 'develop', field: 'mergeQueue', kind: 'changed', expected: 'present', observed: 'absent' },
    { scope: 'develop', field: `rulesets[${DEVELOP_RULESET_NAME}].rules`, kind: 'missing', item: 'merge_queue' },
  ]);
});

const mergeQueueChanges: readonly {
  readonly parameter: keyof typeof DEVELOP_MERGE_QUEUE;
  readonly field: string;
  readonly value: string | number;
}[] = [
  { parameter: 'merge_method', field: 'mergeMethod', value: 'SQUASH' },
  { parameter: 'grouping_strategy', field: 'groupingStrategy', value: 'HEADGREEN' },
  { parameter: 'max_entries_to_build', field: 'maxEntriesToBuild', value: 4 },
  { parameter: 'min_entries_to_merge', field: 'minEntriesToMerge', value: 2 },
  { parameter: 'max_entries_to_merge', field: 'maxEntriesToMerge', value: 5 },
  { parameter: 'min_entries_to_merge_wait_minutes', field: 'minEntriesToMergeWaitMinutes', value: 5 },
  { parameter: 'check_response_timeout_minutes', field: 'checkResponseTimeoutMinutes', value: 60 },
];

for (const change of mergeQueueChanges) {
  test(`a changed develop merge queue ${change.parameter} is drift`, async () => {
    const differences = await drift((state) => { ruleParameters(state, 'develop', 'merge_queue')[change.parameter] = change.value; });
    assert.deepEqual(differences, [{
      scope: 'develop',
      field: `mergeQueue.${change.field}`,
      kind: 'changed',
      expected: DEVELOP_MERGE_QUEUE[change.parameter],
      observed: change.value,
    }]);
  });
}

test('a merge queue added to main is drift', async () => {
  const differences = await drift((state) => {
    state.rules.main.push({
      type: 'merge_queue', ruleset_source_type: 'Repository', ruleset_source: REPOSITORY, ruleset_id: MAIN_RULESET_ID,
      parameters: { ...DEVELOP_MERGE_QUEUE },
    });
  });
  assert.deepEqual(differences, [
    { scope: 'main', field: 'mergeQueue', kind: 'changed', expected: 'absent', observed: 'present' },
  ]);
});

test('two merge_queue rules on one branch are an inspection failure, not a pick of either', async () => {
  const { failure } = await inspectionFailure({
    state: mutated((state) => {
      state.rules.develop.push({ type: 'merge_queue', ruleset_id: DEVELOP_RULESET_ID, parameters: { ...DEVELOP_MERGE_QUEUE } });
    }),
  });
  assert.equal(failure.reason, 'malformed-response');
  assert.match(failure.detail, /more than one merge_queue rule/);
});

test('a disabled main ruleset is drift and its rules stop counting toward the effective controls', async () => {
  const differences = await drift((state) => {
    record(state.rulesets.find((ruleset) => ruleset['id'] === MAIN_RULESET_ID))['enforcement'] = 'disabled';
    record(state.rulesetDetails[MAIN_RULESET_ID])['enforcement'] = 'disabled';
    state.rules.main = [];
  });
  assert.deepEqual(differences.map((difference) => difference.field).sort(), [
    'conversationResolution', 'deletionsBlocked', 'dismissStaleReviews', 'dismissal.restricted', 'forcePushesBlocked',
    'pullRequestRequired', 'requiredChecks', 'requiredChecks', 'requiredChecks', 'requiredChecks', 'requiredChecks',
    'requiredChecks', `rulesets[${MAIN_RULESET_NAME}].enforcement`, 'strictStatusChecks',
  ]);
  assert.ok(differences.some((difference) =>
    difference.kind === 'changed' && difference.field === `rulesets[${MAIN_RULESET_NAME}].enforcement`
    && difference.observed === 'disabled'));
});

test('a ruleset missing a rule it must carry is drift', async () => {
  const differences = await drift((state) => {
    state.rules.main = state.rules.main.filter((rule) => rule['type'] !== 'deletion');
  });
  assert.deepEqual(differences, [
    { scope: 'main', field: 'deletionsBlocked', kind: 'changed', expected: true, observed: false },
    { scope: 'main', field: `rulesets[${MAIN_RULESET_NAME}].rules`, kind: 'missing', item: 'deletion' },
  ]);
});

// main: the no-push-to-main ruleset alone, after the operator's migration step

test('the planned post-migration main configuration is compliant', async () => {
  const outcome = await monitor({ state: liveMainState() });
  assert.deepEqual(outcome.report.differences, []);
  assert.equal(outcome.report.result, 'compliant');
  const rulesetReads = outcome.requests.map((request) => request.url.pathname).filter((path) => path.startsWith(`${base}/rulesets/`));
  assert.ok(rulesetReads.includes(`${base}/rulesets/13473954`));
  assert.ok(!rulesetReads.includes(`${base}/rulesets/9413559`), 'the disabled duplicate ruleset contributes no rules');
});

test('main classic protection reappearing is drift, and its dismissal list takes over', async () => {
  const differences = await drift((state) => {
    state.protection.main = classicProtection({
      approvals: 0, lastPush: false, strict: true, contexts: typedChecks, conversation: true,
    });
  }, liveMainState);
  assert.deepEqual(differences, [
    { scope: 'main', field: 'classic', kind: 'changed', expected: 'absent', observed: 'present' },
    { scope: 'main', field: 'dismissal.actors', kind: 'missing', item: 'user:example-user' },
    { scope: 'main', field: 'dismissal.actors', kind: 'missing', item: 'user:example-sheng' },
    { scope: 'main', field: 'dismissal.actors', kind: 'missing', item: 'user:tyankov' },
  ]);
});

test('strict status checks off on main is drift, though develop legitimately runs without them', async () => {
  const differences = await drift((state) => {
    mainStatusChecks(state)['strict_required_status_checks_policy'] = false;
  }, liveMainState);
  assert.deepEqual(differences, [{ scope: 'main', field: 'strictStatusChecks', kind: 'changed', expected: true, observed: false }]);
});

test('a required check dropped from the main ruleset is drift on that branch only', async () => {
  const differences = await drift((state) => {
    const parameters = mainStatusChecks(state);
    parameters['required_status_checks'] = list(parameters['required_status_checks'])
      .filter((check) => record(check)['context'] !== 'StoreKit Purchase - iOS');
  }, liveMainState);
  assert.deepEqual(differences, [{ scope: 'main', field: 'requiredChecks', kind: 'missing', item: 'StoreKit Purchase - iOS' }]);
});

test('example-sheng dropped from main review dismissal is drift', async () => {
  const differences = await drift((state) => {
    const parameters = record(ruleParameters(state, 'main', 'pull_request')['dismissal_restriction']);
    parameters['allowed_actors'] = list(parameters['allowed_actors'])
      .filter((actor) => record(actor)['id'] !== ADMIN_IDS.exampleSheng);
  }, liveMainState);
  assert.deepEqual(differences, [{ scope: 'main', field: 'dismissal.actors', kind: 'missing', item: 'user:example-sheng' }]);
});

// A baseline that expects classic protection compares that layer on its own

test('a baseline expecting classic protection is satisfied by matching classic and ruleset layers', async () => {
  const outcome = await monitor({ state: mutated(withClassicMain) }, monitorEnv, classicMainBaseline());
  assert.equal(outcome.report.result, 'compliant');
});

test('classic admin, force-push and deletion weakening is drift even while the ruleset still blocks both', async () => {
  const differences = await drift((state) => {
    withClassicMain(state);
    const classic = record(state.protection.main);
    classic['enforce_admins'] = { enabled: false };
    classic['allow_force_pushes'] = { enabled: true };
    classic['allow_deletions'] = { enabled: true };
  }, desiredState, classicMainBaseline());
  assert.deepEqual(differences.map((difference) => difference.field).sort(), [
    'classic.deletionsBlocked', 'classic.enforceAdmins', 'classic.forcePushesBlocked',
  ]);
});

test('classic review dismissal and pull-request bypass take over from the ruleset while that layer exists', async () => {
  const differences = await drift((state) => {
    withClassicMain(state);
    const reviews = record(record(state.protection.main)['required_pull_request_reviews']);
    delete reviews['dismissal_restrictions'];
    reviews['bypass_pull_request_allowances'] = { users: [], teams: [], apps: [{ slug: 'merge-bot' }] };
  }, desiredState, classicMainBaseline());
  assert.deepEqual(differences, [
    { scope: 'main', field: 'dismissal.restricted', kind: 'changed', expected: true, observed: false },
    { scope: 'main', field: 'pullRequestBypass', kind: 'unexpected', item: 'app:merge-bot' },
  ]);
});

test('a ruleset requiring thread resolution satisfies the effective control when the classic field is false', async () => {
  const state = mutated((provider) => {
    withClassicMain(provider);
    record(provider.protection.main)['required_conversation_resolution'] = { enabled: false };
  });
  const outcome = await monitor({ state }, monitorEnv, classicMainBaseline());
  assert.equal(outcome.report.result, 'compliant');
});

// develop: ruleset only, no classic layer

test('develop classic protection reappearing is drift, and its dismissal list takes over', async () => {
  const differences = await drift((state) => {
    state.protection.develop = classicProtection({
      approvals: 0, lastPush: false, strict: false, contexts: typedChecks, conversation: true,
    });
  });
  assert.deepEqual(differences, [
    { scope: 'develop', field: 'classic', kind: 'changed', expected: 'absent', observed: 'present' },
    { scope: 'develop', field: 'dismissal.actors', kind: 'missing', item: 'user:example-user' },
    { scope: 'develop', field: 'dismissal.actors', kind: 'missing', item: 'user:tyankov' },
  ]);
});

test('a missing develop ruleset is drift and leaves develop unprotected', async () => {
  const differences = await drift((state) => {
    state.rules.develop = [];
    state.rulesets = state.rulesets.filter((ruleset) => ruleset['id'] !== DEVELOP_RULESET_ID);
  });
  assert.deepEqual(differences.map((difference) => difference.field).sort(), [
    'conversationResolution', 'deletionsBlocked', 'dismissStaleReviews', 'dismissal.restricted', 'forcePushesBlocked',
    'mergeQueue', 'pullRequestRequired', 'requiredChecks', 'requiredChecks', 'requiredChecks', 'requiredChecks',
    'requiredChecks', 'requiredChecks', `rulesets[${DEVELOP_RULESET_NAME}].enforcement`,
  ]);
  assert.ok(differences.some((difference) =>
    difference.kind === 'changed' && difference.field === `rulesets[${DEVELOP_RULESET_NAME}].enforcement`
    && difference.observed === 'absent'));
});

for (const enforcement of ['disabled', 'evaluate']) {
  test(`a develop ruleset in ${enforcement} mode is drift`, async () => {
    const differences = await drift((state) => {
      record(state.rulesets.find((ruleset) => ruleset['id'] === DEVELOP_RULESET_ID))['enforcement'] = enforcement;
      record(state.rulesetDetails[DEVELOP_RULESET_ID])['enforcement'] = enforcement;
    });
    assert.deepEqual(differences, [{
      scope: 'develop', field: `rulesets[${DEVELOP_RULESET_NAME}].enforcement`, kind: 'changed', expected: 'active', observed: enforcement,
    }]);
  });
}

test('a develop ruleset bypass actor is drift', async () => {
  const differences = await drift((state) => {
    record(state.rulesetDetails[DEVELOP_RULESET_ID])['bypass_actors'] = [
      { actor_id: 16886764, actor_type: 'User', bypass_mode: 'pull_request' },
    ];
  });
  assert.deepEqual(differences, [{ scope: 'develop', field: 'rulesetBypass', kind: 'unexpected', item: 'User:16886764:pull_request' }]);
});

const unreadableClassic: readonly { readonly name: string; readonly rawBody: string }[] = [
  { name: 'a hidden or missing branch', rawBody: '{"message":"Not Found"}' },
  { name: 'a missing branch', rawBody: '{"message":"Branch not found"}' },
  { name: 'a message differing only in case', rawBody: '{"message":"branch not protected"}' },
  { name: 'a non-JSON body', rawBody: 'Branch not protected' },
];

for (const branch of PROTECTED_BRANCHES) {
  for (const unreadable of unreadableClassic) {
    test(`a ${branch} 404 for ${unreadable.name} is an inspection failure, not an absent classic layer`, async () => {
      const { failure } = await inspectionFailure({
        state: desiredState(),
        overrides: { [`${base}/branches/${branch}/protection`]: { status: 404, rawBody: unreadable.rawBody } },
      });
      assert.deepEqual(failure, {
        reason: 'not-found',
        endpoint: 'GET /repos/{repo}/branches/{branch}/protection',
        detail: 'HTTP 404; the control may have been removed or the credential cannot see it — both need a human',
      });
    });
  }
}

test('the live develop configuration captured on 2026-09-27 after stage S3 is compliant', async () => {
  const live = record(JSON.parse(readFileSync('ci/tests/fixtures/branchPolicyLiveDevelop.json', 'utf8')));
  const detail = record(live['rulesetDetail']);
  const id = Number(detail['id']);
  const state = desiredState();
  state.protection.develop = undefined;
  state.rules.develop = list(live['rules']).map(record);
  state.rulesets = [...state.rulesets.filter((ruleset) => ruleset['id'] !== DEVELOP_RULESET_ID), record(live['rulesetSummary'])];
  state.rulesetDetails = { [MAIN_RULESET_ID]: record(state.rulesetDetails[MAIN_RULESET_ID]), [id]: detail };
  const outcome = await monitor({ state });
  assert.deepEqual(outcome.report.differences, []);
  assert.equal(outcome.report.result, 'compliant');
  assert.ok(outcome.requests.some((request) => request.url.pathname === `${base}/rulesets/${id}`));
});

test('the dated 2026-09-21 observation is reported as drift, not adopted', async () => {
  const outcome = await monitor({ state: observedState() });
  assert.equal(outcome.report.result, 'drift');
  assert.deepEqual(outcome.report.differences, [
    { scope: 'develop', field: 'classic', kind: 'changed', expected: 'absent', observed: 'present' },
    { scope: 'develop', field: 'mergeQueue', kind: 'changed', expected: 'present', observed: 'absent' },
    { scope: 'develop', field: 'requiredChecks', kind: 'unexpected', item: 'PR review resolution gate' },
    { scope: 'develop', field: 'dismissal.actors', kind: 'missing', item: 'user:example-user' },
    { scope: 'develop', field: 'dismissal.actors', kind: 'missing', item: 'user:tyankov' },
    { scope: 'develop', field: `rulesets[${DEVELOP_RULESET_NAME}].rules`, kind: 'missing', item: 'merge_queue' },
    {
      scope: 'develop', field: `rulesets[${DEVELOP_RULESET_NAME}].rules`, kind: 'missing', item: 'required_status_checks',
    },
    { scope: 'main', field: 'classic', kind: 'changed', expected: 'absent', observed: 'present' },
    { scope: 'main', field: 'requiredChecks', kind: 'missing', item: 'Lint changed code' },
    { scope: 'main', field: 'requiredChecks', kind: 'missing', item: 'Validate pull request changes' },
    { scope: 'main', field: 'requiredChecks', kind: 'unexpected', item: 'lint' },
    { scope: 'main', field: 'requiredChecks', kind: 'unexpected', item: 'validate' },
    { scope: 'main', field: 'dismissal.actors', kind: 'missing', item: 'user:example-user' },
    { scope: 'main', field: 'dismissal.actors', kind: 'missing', item: 'user:example-sheng' },
    { scope: 'main', field: 'dismissal.actors', kind: 'missing', item: 'user:tyankov' },
    { scope: 'main', field: `rulesets[${MAIN_RULESET_NAME}].rules`, kind: 'missing', item: 'required_status_checks' },
  ]);
  assert.ok(
    !outcome.report.differences.some((difference) => difference.field === 'conversationResolution'),
    "main's ruleset thread resolution must not be misreported from the classic field",
  );
  assert.match(outcome.summary, /Escalate to #4085; do not change the baseline to match/);
});

test('a synthetic drift run reports exactly one labelled difference against a compliant state', async () => {
  const outcome = await monitor({ state: desiredState() }, { ...monitorEnv, BRANCH_POLICY_SYNTHETIC_DRIFT: 'true' });
  assert.equal(outcome.report.result, 'drift');
  assert.equal(outcome.exitCode, 2);
  assert.deepEqual(outcome.report.differences, [
    { scope: 'repository', field: 'admins.users', kind: 'missing', item: SYNTHETIC_DRIFT_ADMIN },
  ]);
});

// Inspection failure

test('a proposed baseline is refused before any request is made', async () => {
  const github = fakeGithub({ state: desiredState() });
  const outcome = await runMonitor({ env: monitorEnv, baseline: proposedBaseline(), fetchImpl: github.fetchImpl });
  assert.equal(outcome.report.result, 'inspection-failed');
  assert.equal(outcome.report.failure?.reason, 'baseline-not-activatable');
  assert.equal(github.requests.length, 0);
});

test('a missing credential is an inspection failure, never compliance', async () => {
  const { failure, outcome } = await inspectionFailure(
    { state: desiredState() },
    { ...monitorEnv, BRANCH_POLICY_MONITOR_TOKEN: undefined },
  );
  assert.equal(failure.reason, 'missing-credential');
  assert.equal(outcome.requests.length, 0);
});

test('a non-GitHub API URL is refused so the credential is never sent elsewhere', async () => {
  const { failure, outcome } = await inspectionFailure(
    { state: desiredState() },
    { ...monitorEnv, GITHUB_API_URL: 'https://attacker.example' },
  );
  assert.equal(failure.reason, 'unsupported-api-url');
  assert.equal(outcome.requests.length, 0);
});

test('a run for another repository is refused', async () => {
  const { failure } = await inspectionFailure({ state: desiredState() }, { ...monitorEnv, GITHUB_REPOSITORY: 'someone/fork' });
  assert.equal(failure.reason, 'endpoint-not-allowed');
});

interface StatusCase {
  readonly name: string;
  readonly override: { readonly status: number; readonly headers?: Record<string, string> };
  readonly reason: string;
}

const statusCases: readonly StatusCase[] = [
  { name: '401', override: { status: 401 }, reason: 'unauthorized' },
  { name: '403', override: { status: 403, headers: { 'x-ratelimit-remaining': '12' } }, reason: 'forbidden' },
  { name: '404', override: { status: 404 }, reason: 'not-found' },
  {
    name: '403 with an exhausted rate limit',
    override: { status: 403, headers: { 'x-ratelimit-remaining': '0' } },
    reason: 'rate-limited',
  },
  { name: '429', override: { status: 429 }, reason: 'rate-limited' },
  { name: '502', override: { status: 502 }, reason: 'http-error' },
];

for (const statusCase of statusCases) {
  test(`HTTP ${statusCase.name} is an inspection failure`, async () => {
    const { failure } = await inspectionFailure({
      state: desiredState(),
      overrides: { [`${base}/branches/main/protection`]: statusCase.override },
    });
    assert.equal(failure.reason, statusCase.reason);
    assert.equal(failure.endpoint, 'GET /repos/{repo}/branches/{branch}/protection');
  });
}

test('a timeout is an inspection failure', async () => {
  const timeout = new Error('timed out');
  timeout.name = 'TimeoutError';
  const { failure } = await inspectionFailure({ state: desiredState(), overrides: { [`${base}/teams`]: { throws: timeout } } });
  assert.equal(failure.reason, 'timeout');
});

test('a transport error is an inspection failure and its message is not echoed', async () => {
  const { failure } = await inspectionFailure({
    state: desiredState(),
    overrides: { [`${base}/teams`]: { throws: new TypeError(`connect failed with ${SENTINEL_TOKEN}`) } },
  });
  assert.deepEqual(failure, { reason: 'transport', endpoint: 'GET /repos/{repo}/teams', detail: 'TypeError' });
});

test('a non-JSON body is an inspection failure', async () => {
  const { failure } = await inspectionFailure({
    state: desiredState(),
    overrides: { [`${base}/rulesets`]: { rawBody: '<html>maintenance</html>' } },
  });
  assert.equal(failure.reason, 'malformed-response');
});

test('a list endpoint returning an object is an inspection failure', async () => {
  const { failure } = await inspectionFailure({
    state: desiredState(),
    overrides: { [`${base}/collaborators`]: { rawBody: '{"message":"not a list"}' } },
  });
  assert.equal(failure.reason, 'malformed-response');
});

const missingFieldCases: readonly { readonly name: string; readonly change: (state: ProviderState) => void }[] = [
  { name: 'enforce_admins', change: (state) => { delete classicMain(state)['enforce_admins']; } },
  { name: 'allow_force_pushes', change: (state) => { delete classicMain(state)['allow_force_pushes']; } },
  { name: 'collaborator id', change: (state) => { delete record(state.collaborators[0])['id']; } },
  { name: 'team id', change: (state) => { delete record(state.teams[0])['id']; } },
  {
    name: 'dismissal_restriction enabled flag',
    change: (state) => { delete record(developPullRequest(state)['dismissal_restriction'])['enabled']; },
  },
  {
    name: 'dismissal_restriction actor id',
    change: (state) => {
      record(developPullRequest(state)['dismissal_restriction'])['allowed_actors'] = [{ id: 'example-user', type: 'User' }];
    },
  },
  {
    name: 'dismissal_restriction actor list',
    change: (state) => { delete record(developPullRequest(state)['dismissal_restriction'])['allowed_actors']; },
  },
  {
    name: 'classic protection body on a branch GitHub reports as protected',
    change: (state) => { state.protection.develop = { message: 'Moved Permanently' }; },
  },
  { name: 'required_conversation_resolution', change: (state) => { delete classicMain(state)['required_conversation_resolution']; } },
  {
    name: 'required_approving_review_count',
    change: (state) => { delete record(classicMain(state)['required_pull_request_reviews'])['required_approving_review_count']; },
  },
  {
    name: 'status check app_id type',
    change: (state) => {
      const checks = list(record(classicMain(state)['required_status_checks'])['checks']);
      record(checks[0])['app_id'] = '15368';
    },
  },
  {
    name: 'status check rule parameter',
    change: (state) => {
      state.rules.main.push({
        type: 'required_status_checks', ruleset_id: MAIN_RULESET_ID, parameters: { required_status_checks: [] },
      });
    },
  },
  {
    name: 'pull_request rule parameter',
    change: (state) => {
      const pullRequest = record(state.rules.main.find((rule) => rule['type'] === 'pull_request')?.['parameters']);
      delete pullRequest['required_review_thread_resolution'];
    },
  },
  {
    name: 'ruleset bypass_actors hidden from the credential',
    change: (state) => { delete record(state.rulesetDetails[DEVELOP_RULESET_ID])['bypass_actors']; },
  },
  { name: 'collaborator permissions', change: (state) => { delete record(state.collaborators[0])['permissions']; } },
  { name: 'repository allow_forking', change: (state) => { delete state.repository['allow_forking']; } },
  {
    name: 'merge_queue check_response_timeout_minutes',
    change: (state) => { delete ruleParameters(state, 'develop', 'merge_queue')['check_response_timeout_minutes']; },
  },
  {
    name: 'merge_queue max_entries_to_build type',
    change: (state) => { ruleParameters(state, 'develop', 'merge_queue')['max_entries_to_build'] = '4'; },
  },
  {
    name: 'merge_queue merge_method',
    change: (state) => { delete ruleParameters(state, 'develop', 'merge_queue')['merge_method']; },
  },
  { name: 'ruleset enforcement', change: (state) => { delete state.rulesets[0]?.['enforcement']; } },
];

for (const missing of missingFieldCases) {
  test(`a missing or mistyped ${missing.name} is an inspection failure, not a default`, async () => {
    const { failure } = await inspectionFailure({ state: mutated(missing.change) });
    assert.equal(failure.reason, 'malformed-response');
  });
}

test('ruleset bypass actors hidden from a read-only credential are reported as an access gap', async () => {
  const { failure } = await inspectionFailure({
    state: mutated((state) => { delete record(state.rulesetDetails[MAIN_RULESET_ID])['bypass_actors']; }),
  });
  assert.deepEqual(failure, {
    reason: 'malformed-response',
    endpoint: 'GET /repos/{repo}/rulesets/{id}',
    detail: 'ruleset.bypass_actors is not visible to this credential',
  });
});

test('a failure on a later page discards the partial list', async () => {
  const { failure } = await inspectionFailure({
    state: desiredState(),
    pageSize: 1,
    overrides: { [`${base}/collaborators?page=2`]: { status: 502 } },
  });
  assert.equal(failure.reason, 'http-error');
});

test('pagination beyond the page limit is an incomplete-pagination failure', async () => {
  const { failure } = await inspectionFailure({
    state: mutated((state) => {
      for (let index = 0; index < MAX_PAGES; index += 1) {
        state.teams.push({ id: 8000 + index, slug: `team-${index}`, permission: 'pull' });
      }
    }),
    pageSize: 1,
  });
  assert.equal(failure.reason, 'incomplete-pagination');
});

test('a pagination link to another origin is refused', async () => {
  const { failure, outcome } = await inspectionFailure({
    state: desiredState(),
    overrides: {
      [`${base}/collaborators`]: {
        rawBody: JSON.stringify(desiredState().collaborators),
        headers: { link: '<https://attacker.example/repos/example-org/example-app/collaborators?page=2>; rel="next"' },
      },
    },
  });
  assert.equal(failure.reason, 'endpoint-not-allowed');
  assert.ok(outcome.requests.every((request) => request.url.origin === API));
});

// Read-only and scrubbing guarantees

test('a complete inspection issues only GET requests to allow-listed endpoints', async () => {
  const outcome = await monitor({ state: desiredState(), pageSize: 1 });
  assert.equal(outcome.report.result, 'compliant');
  assert.ok(outcome.requests.length > 0);
  for (const request of outcome.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.hasBody, false);
    assert.equal(request.redirect, 'error');
    assert.equal(request.url.origin, API);
    assert.ok(ALLOWED_ENDPOINTS.some((endpoint) => endpoint.pattern.test(request.url.pathname)), request.url.pathname);
    assert.deepEqual(Object.keys(request.headers).sort(), ['accept', 'authorization', 'x-github-api-version']);
    assert.equal(request.headers['authorization'], `Bearer ${SENTINEL_TOKEN}`);
  }
  const endpoints = new Set(outcome.requests.map((request) => request.url.pathname));
  assert.deepEqual([...endpoints].sort(), [
    base,
    `${base}/branches/develop/protection`,
    `${base}/branches/main/protection`,
    `${base}/collaborators`,
    `${base}/rules/branches/develop`,
    `${base}/rules/branches/main`,
    `${base}/rulesets`,
    `${base}/rulesets/${MAIN_RULESET_ID}`,
    `${base}/rulesets/${DEVELOP_RULESET_ID}`,
    `${base}/teams`,
  ]);
});

test('the reader refuses endpoints outside its allow-list before sending anything', async () => {
  const github = fakeGithub({ state: desiredState() });
  const reader = createGithubReader({ apiUrl: API, token: SENTINEL_TOKEN, fetchImpl: github.fetchImpl });
  for (const path of [
    `${base}/branches/main/protection/enforce_admins`,
    `${base}/branches/feature/protection`,
    '/user',
    `${base}/collaborators/someone`,
  ]) {
    await assert.rejects(reader.getJson(path), (error: unknown) =>
      error instanceof InspectionError && error.failure.reason === 'endpoint-not-allowed');
  }
  assert.equal(github.requests.length, 0);
});

test('the reader has no way to send anything but GET', () => {
  const source = readFileSync('ci/src/branchPolicy/githubReader.ts', 'utf8');
  assert.deepEqual(source.match(/method:\s*[^,\n]+/g), ["method: 'GET'"]);
});

test('credential material in provider data is scrubbed from the report', async () => {
  const outcome = await monitor({
    state: mutated((state) => {
      state.collaborators.push({ login: SENTINEL_TOKEN, id: 5002, permissions: { admin: true }, role_name: 'admin' });
    }),
  });
  assert.equal(outcome.report.result, 'drift');
  assert.match(outcome.reportJson, /\[redacted\]/);
});

test('scrub removes exact secrets and credential-shaped strings', () => {
  // Built at runtime so no credential-shaped literal is committed.
  const shaped = {
    installation: `ghs_${'A'.repeat(36)}`,
    classic: `ghp_${'b'.repeat(36)}`,
    fineGrained: `github_pat_${'C'.repeat(22)}_${'d'.repeat(20)}`,
    bearer: `Bearer ${'e'.repeat(12)}.${'f'.repeat(12)}`,
    key: ['-----BEGIN', 'RSA PRIVATE KEY-----\nkeymaterial\n-----END', 'RSA PRIVATE KEY-----'].join(' '),
  };
  const text = [SENTINEL_TOKEN, ...Object.values(shaped)].join('\n');
  const scrubbed = scrub(text, [SENTINEL_TOKEN]);
  for (const value of [SENTINEL_TOKEN, ...Object.values(shaped), 'keymaterial']) {
    assert.ok(!scrubbed.includes(value), `${value.slice(0, 12)} survived scrubbing`);
  }
});

// Baseline and activation

test('the committed baseline records the owner approval of the S3 merge queue', () => {
  assert.deepEqual(branchPolicyBaseline.approval, {
    status: 'approved',
    approver: 'example-user',
    approvedOn: '2026-09-27',
    record: 'https://github.com/example-org/example-app/issues/4085#issuecomment-5859150504',
  });
  assert.deepEqual(unresolvedBaselineFacts(branchPolicyBaseline), []);
  assert.deepEqual(baselineActivationBlockers(branchPolicyBaseline), []);
});

test('a proposed baseline cannot activate live inspection', () => {
  const blockers = baselineActivationBlockers(proposedBaseline());
  assert.deepEqual(blockers, ["baseline is proposed; #4085's operator must approve it first"]);
});

test('an unresolved ruleset name blocks activation even on an approved baseline', () => {
  const approved = approvedBaseline();
  const { main } = approved.branches;
  const unresolved: BranchPolicyBaseline = {
    ...approved,
    branches: {
      ...approved.branches,
      main: { ...main, rulesets: main.rulesets.map((ruleset) => ({ ...ruleset, name: { unresolved: 'Which ruleset?' } })) },
    },
  };
  assert.deepEqual(unresolvedBaselineFacts(unresolved), ['main: Which ruleset?']);
  assert.deepEqual(baselineActivationBlockers(unresolved), ['unresolved baseline fact — main: Which ruleset?']);
});

test('baseline checks are explicit per branch and name current required-check producers', () => {
  const produced = new Set<string>(requiredContextsFrom(definitions));
  for (const branch of PROTECTED_BRANCHES) {
    const checks = branchPolicyBaseline.branches[branch].controls.requiredChecks;
    assert.ok(checks.length > 0);
    for (const check of checks) {
      assert.ok(produced.has(check.context), `${branch} requires ${check.context}, which no workflow definition produces`);
      assert.equal(typeof check.appId, 'number', `${branch} ${check.context} must name its producer App`);
    }
  }
  assert.notEqual(
    branchPolicyBaseline.branches.develop.controls.requiredChecks,
    branchPolicyBaseline.branches.main.controls.requiredChecks,
    'each branch owns its own list',
  );
});

test('the baseline encodes the written policy for both branches', () => {
  const { develop, main } = branchPolicyBaseline.branches;
  assert.equal(main.controls.requiredApprovals, 0);
  assert.equal(main.controls.requireLastPushApproval, false);
  assert.equal(main.controls.strictStatusChecks, true);
  assert.equal(develop.controls.requiredApprovals, 0);
  assert.equal(develop.controls.strictStatusChecks, false);
  for (const branch of [develop, main]) {
    assert.equal(branch.controls.conversationResolution, true);
    assert.equal(branch.controls.dismissStaleReviews, true);
    assert.equal(branch.controls.requireCodeOwnerReview, false);
    assert.equal(branch.controls.forcePushesBlocked && branch.controls.deletionsBlocked, true);
    assert.deepEqual(branch.controls.rulesetBypass, []);
    assert.deepEqual(branch.controls.pullRequestBypass, { users: [], teams: [], apps: [] });
    assert.ok(!branch.controls.requiredChecks.some((check) => /secret/i.test(check.context)));
  }
  assert.deepEqual(branchPolicyBaseline.repositoryAdmins, { users: ['example-user', 'example-sheng', 'tyankov'], teams: [] });
  assert.deepEqual(branchPolicyBaseline.repositorySettings, { forkingAllowed: false });
});

test('develop expects only the develop-protection ruleset and no classic layer', () => {
  const { develop } = branchPolicyBaseline.branches;
  assert.equal(develop.controls.classic, 'absent');
  assert.deepEqual(develop.rulesets, [{
    name: 'develop-protection',
    source: 'example-org/example-app',
    ruleTypes: ['deletion', 'merge_queue', 'non_fast_forward', 'pull_request', 'required_status_checks'],
  }]);
  assert.deepEqual(develop.controls.dismissal, {
    restricted: true, actors: { users: ['example-user', 'tyankov'], teams: [], apps: [] },
  });
});

test('develop expects exactly the merge queue applied at stage S3 and main expects none', () => {
  assert.deepEqual(branchPolicyBaseline.branches.develop.controls.mergeQueue, {
    mergeMethod: 'MERGE',
    groupingStrategy: 'ALLGREEN',
    maxEntriesToBuild: 8,
    minEntriesToMerge: 1,
    maxEntriesToMerge: 1,
    minEntriesToMergeWaitMinutes: 0,
    checkResponseTimeoutMinutes: 150,
  });
  assert.equal(branchPolicyBaseline.branches.main.controls.mergeQueue, 'absent');
});

test('main expects only the no-push-to-main ruleset, no classic layer and three dismissers', () => {
  const { main } = branchPolicyBaseline.branches;
  assert.equal(main.controls.classic, 'absent');
  assert.deepEqual(main.rulesets, [{
    name: 'no-push-to-main',
    source: 'example-org/example-app',
    ruleTypes: ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'],
  }]);
  assert.deepEqual(main.controls.dismissal, {
    restricted: true, actors: { users: ['example-user', 'example-sheng', 'tyankov'], teams: [], apps: [] },
  });
});

test('activation requires the switch, the default branch, an approved baseline and settled decisions', () => {
  const ready = {
    enabled: 'true', ref: 'refs/heads/develop', defaultBranch: 'develop', baseline: approvedBaseline(), unsettledDecisions: [],
  };
  assert.deepEqual(activationBlockers(ready), []);
  assert.equal(activationBlockers({ ...ready, enabled: undefined }).length, 1);
  assert.equal(activationBlockers({ ...ready, enabled: 'false' }).length, 1);
  assert.equal(activationBlockers({ ...ready, ref: 'refs/heads/feature' }).length, 1);
  assert.equal(activationBlockers({ ...ready, defaultBranch: undefined }).length, 1);
  assert.equal(activationBlockers({ ...ready, baseline: proposedBaseline() }).length, 1);
  assert.deepEqual(
    activationBlockers({ ...ready, unsettledDecisions: ['decision 99'] }),
    ['unsettled activation decision — decision 99'],
  );
});

test('the committed monitor stays inactive after baseline approval because decision 7 is unsettled', () => {
  const committed = {
    enabled: 'true',
    ref: 'refs/heads/develop',
    defaultBranch: 'develop',
    baseline: branchPolicyBaseline,
    unsettledDecisions: UNSETTLED_ACTIVATION_DECISIONS,
  };
  const blockers = activationBlockers(committed);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0] ?? '', /^unsettled activation decision — #4085 decision 7 \(ruleset bypass visibility\)/);
  assert.equal(activationBlockers({ ...committed, enabled: undefined }).length, 2, 'the missing switch also blocks');
});

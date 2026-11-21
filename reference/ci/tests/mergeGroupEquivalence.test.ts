import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';
import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';

/**
 * Merge-queue stage S1 rewrote every event-derived expression in the two
 * required workflows. This proves, by evaluation rather than by text, that on
 * `pull_request` and `workflow_dispatch` the rewritten YAML computes what the
 * YAML before S1 computed. `fixtures/pre-merge-group/` holds the generated
 * workflows of develop at the point S1 branched; every expression site whose
 * text changed is evaluated in both documents over a matrix of PR and dispatch
 * contexts (draft/ready, same-repo/fork/deleted fork, dependabot, base
 * develop/main, opened/synchronize, every dispatch scope × Mac runner × ref)
 * and three states of the job graph. A site may differ only where the
 * allow-list below names it, with the reason.
 */

type Document = Record<string, unknown>;
type Context = Record<string, ExpressionValue>;

const REPOSITORY = 'example-org/example-app';
const PR_HEAD = 'd'.repeat(40);
const PR_BASE = 'e'.repeat(40);
const EVENT_SHA = 'f'.repeat(40);

/** Expression sites: a stable path per value, with steps keyed by id or name. */
function sites(value: unknown, path: string, into: Map<string, string>): Map<string, string> {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    into.set(path, String(value));
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      const step = entry as { id?: string; name?: string; uses?: string };
      const key = path.endsWith('.steps') ? (step.id ?? step.name ?? step.uses ?? String(index)) : String(index);
      sites(entry, `${path}[${key}]`, into);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) sites(entry, path === '' ? key : `${path}.${key}`, into);
  }
  return into;
}

/**
 * What GitHub does with a site's value: an `if` is truthiness; any other
 * field is rendered, where null is the empty string and an object (a
 * `fromJson` runner label array) stays structured.
 */
function evaluateSite(path: string, text: string, context: Context, graph: Graph): string {
  try {
    // A generated run command with no expression is literal workflow text.
    if (path.endsWith('.run') && !text.includes('${{')) return JSON.stringify(text);
    const value = evaluateExpression(text, context, { resolve: graph.resolve });
    if (/(^|\.)if$/.test(path)) {
      return String(!(value === false || value === null || value === 0 || value === ''));
    }
    if (value === null) return '""';
    return typeof value === 'object' ? JSON.stringify(value) : JSON.stringify(String(value));
  } catch (error: unknown) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

interface Graph {
  readonly label: string;
  readonly resolve: (path: readonly string[]) => ExpressionValue;
}

/** Three job-graph states: everything passed and selected, skipped and empty, failed and false. */
const graphs: readonly Graph[] = [
  ['passed', 'success', 'true'], ['skipped', 'skipped', ''], ['failed', 'failure', 'false'],
].map(([label, result, output]) => ({
  label: label ?? '',
  resolve: (path: readonly string[]): ExpressionValue => {
    const [root, , field] = path;
    if (root === 'needs' && path[1] === '*') return [result ?? '', result ?? ''];
    // The re-plan step publishes outputs only on a covered selection-only base
    // update, which did not exist at S1; everywhere else the gate's own values
    // stand. iosSelectionReplan.test.ts covers the covered case.
    if (root === 'steps' && path[1] === 'replan' && field !== 'outcome') return '';
    // The queue reuse step runs only on merge_group (queueEvidenceReuse.test.ts
    // proves its condition is false on every pull_request and dispatch).
    if (root === 'steps' && path[1] === 'queue-reuse' && field !== 'outcome') return '';
    if (root === 'needs' || root === 'steps') {
      if (field === 'result' || field === 'outcome' || field === 'conclusion') return result ?? '';
      return output ?? '';
    }
    if (root === 'matrix') return 'native1';
    if (root === 'runner') return 'Linux';
    if (root === 'secrets') return 'secret';
    return output ?? '';
  },
}));

interface PullRequestCase {
  readonly draft: boolean;
  readonly origin: 'same' | 'fork' | 'deleted-fork';
  readonly actor: string;
  readonly base: 'develop' | 'main';
  readonly action: 'opened' | 'synchronize';
}

function pullRequestContext(options: PullRequestCase): Context {
  const repo = options.origin === 'deleted-fork' ? null
    : { full_name: options.origin === 'same' ? REPOSITORY : 'outside/fork' };
  return {
    github: {
      event_name: 'pull_request', sha: EVENT_SHA, ref: 'refs/pull/7/merge', repository: REPOSITORY,
      actor: options.actor, run_id: 42, run_attempt: 1, workspace: '/w', token: 'token', api_url: 'https://api',
      workflow_sha: EVENT_SHA,
      event: {
        action: options.action,
        repository: { default_branch: 'develop' },
        pull_request: {
          number: 7, draft: options.draft,
          head: { sha: PR_HEAD, ref: 'feature/x', repo },
          base: { sha: PR_BASE, ref: options.base },
        },
      },
    },
    inputs: {},
  };
}

function pullRequestContexts(): Array<readonly [string, Context]> {
  const contexts: Array<readonly [string, Context]> = [];
  for (const draft of [false, true]) {
    for (const origin of ['same', 'fork', 'deleted-fork'] as const) {
      for (const actor of ['octocat', 'dependabot[bot]']) {
        for (const base of ['develop', 'main'] as const) {
          for (const action of ['opened', 'synchronize'] as const) {
            const options = { draft, origin, actor, base, action };
            contexts.push([JSON.stringify(options), pullRequestContext(options)]);
          }
        }
      }
    }
  }
  return contexts;
}

const TEST_SCOPES = [
  'full', 'promotion-evidence', 'affected', 'e2e', 'evidence', 'onboarding-copy-evidence',
  'mortgage-assignment-evidence', 'financial-independence-evidence', 'shared-cta-evidence',
  'debt-card-evidence', 'development-e2e-schema', 'observability-credential-sync',
] as const;

function dispatchContexts(): Array<readonly [string, Context]> {
  const contexts: Array<readonly [string, Context]> = [];
  for (const testScope of TEST_SCOPES) {
    for (const macRunner of ['shared', 'mitchell-reserved']) {
      for (const ref of ['refs/heads/develop', 'refs/heads/main', 'refs/heads/feature']) {
        for (const pullRequestNumber of ['', '7']) {
          const inputs = {
            test_scope: testScope, mac_runner: macRunner, pull_request_number: pullRequestNumber,
            promotion_base_sha: '',
          };
          contexts.push([JSON.stringify(inputs) + ref, {
            github: {
              event_name: 'workflow_dispatch', sha: EVENT_SHA, ref, repository: REPOSITORY, actor: 'octocat',
              run_id: 42, run_attempt: 1, workspace: '/w', token: 'token', api_url: 'https://api',
              workflow_sha: EVENT_SHA, event: { inputs, repository: { default_branch: 'develop' } },
            },
            inputs,
          }]);
        }
      }
    }
  }
  return contexts;
}

interface Allowed {
  readonly site: RegExp;
  readonly reason: string;
  /** Limits the allowance to these contexts; every context when absent. */
  readonly when?: (label: string) => boolean;
}

/** Every intentional pull_request/dispatch difference, one line of reason each. */
const allowedDifferences: readonly Allowed[] = [
  {
    site: /^jobs\.(onboarding-e2e|chat-plaid-e2e|income-e2e|budget-e2e)\.steps\[(Isolate|Remove isolated) Google Cloud SDK state\]\.run$/,
    reason: 'Credential directory lifecycle runs from the gate-proven control checkout so old product heads cannot lack cleanup; '
      + 'cloudSdkState.test.ts executes creation and cleanup with an empty product checkout and real directories',
  },
  {
    site: /^jobs\.workflow-contracts\.steps\[Validate typed CI contracts\]\.run$/,
    reason: 'explicit workflow mode installs and links CI dependencies once, then runs the same selected checks; '
      + 'installWorkflowContractDependencies.test.ts exercises the actual CLI, installation failures and full check ordering',
  },
  {
    site: /^jobs\.ios-change-gate\.runs-on$/,
    reason: 'The gate now consumes initial Linux admission; controllerControlAdmission proves external fallback, admitted hosted routing and fork isolation.',
  },
  {
    site: /^jobs\.(verify-ios-release-archive|build-ios-native-test-products|build-ios-e2e-test-products|test-ios-execution)\.steps\[Verify exact (Release archive|native test|iOS test|E2E) revision\]\.run$/,
    reason: 'admission now runs directly from the gate-proven verifier checkout; '
      + 'iosWorkflowE2eContracts and macRevisionAdmission tests prove its pin, order and fail-closed behavior',
  },
  {
    site: /^jobs\.plan-pr-validation\.steps\[plan\]\.run$/,
    reason: 'the retired wrapper selected the base-owned typed planner whenever its CI lockfile existed; '
      + 'all supported bases have that lockfile, and prChecksBootstrap.test.ts proves direct base ownership',
  },
  {
    site: /^jobs\.plan-pr-validation\.runs-on$/,
    reason: 'the planner now reads the first hosted route job output before its static reviewed fallback; '
      + 'the expression harness substitutes booleans for needs outputs, while '
      + 'workflows.verdictRouting.test.ts proves the external fallback and typed route shape',
  },
  {
    site: /^jobs\.lint(\.if|\.steps\[Lint selected PR code\]\.if)$/,
    reason: 'the lint job now runs its documentation-input guard on source PRs even when the '
      + 'selected lint plan is none; the lint command itself remains conditional',
  },
  {
    site: /^jobs\.validation-policy\.steps\[Checkout the workflow revision\]\.with\.fetch-depth$/,
    reason: 'the policy checks out only the candidate, then ensurePolicyHistory fetches that exact '
      + 'candidate ancestry before the debt preflight verifies its base and head',
  },
  {
    site: /^jobs\.(validation-policy|validate|release-full-routing-predecessor|await-retained-ios-predecessor|confirm-current-ios-pr|test-ios|storekit-purchase-status|onboarding-e2e-status|remove-run-artifacts-after-success)\.runs-on$/,
    reason: 'runs-on reads the first job’s planned control route before the static one; this harness '
      + 'stubs every needs output as "true"/"false". ci/tests/selectControlRunners.test.ts proves an '
      + 'empty planned route renders the S1 runner for every event',
  },
  {
    site: /^jobs\.(plan-pr-validation\.steps\[Checkout base-update classifier\]|ios-change-gate\.steps\[Checkout trusted base-update classifier\])\.with\.sparse-checkout$/,
    reason: 'plain path list, not an expression: adds ci/contracts, which the base-update '
      + 'classifier reads for real-server lane inputs',
  },
  {
    site: /^jobs\.confirm-current-ios-pr\.steps\[runtime\]\.env\.HEAD_REPOSITORY$/,
    when: (label) => label.includes('"deleted-fork"'),
    reason: 'a deleted fork head now renders an empty repository instead of borrowing github.repository',
  },
  {
    site: /^jobs\.ios-change-gate\.steps\[(detect|Lint throwable iOS enabled-state reads)\]\.run$/,
    reason: 'the planner now runs from $IOS_*_ROOT, asserted below to be "." on pull_request and dispatch',
  },
  {
    site: /^jobs\.ios-change-gate\.steps\[Checkout trusted native selection controls\]\.if$/,
    reason: 'the trusted controls also check out when the classifier reports a selection re-plan '
      + '(replan_selection == true), an output S1 did not have; the graph model sets every output true',
  },
  {
    site: /^jobs\.ios-change-gate\.steps\[classify\]\.run$/,
    reason: 'the classifier now runs from $IOS_PLANNING_PROGRAM_ROOT, asserted below to be "."',
  },
  {
    site: /^jobs\.test-ios-execution\.steps\[narrow-simulator\]\.(if|env\.IOS_CI_LANE)$/,
    reason: 'native1 runs the narrow paywall phase, so it now provisions the narrow simulator, '
      + 'named Main Narrow unless it owns account-update evidence, as cleanup releases it',
  },
  {
    site: /^jobs\.[a-z0-9-]+\.steps\[(Select exact Xcode|Select exact Xcode for Release archive)\]\.run$/,
    reason: 'every iOS lane now selects the one pinned Xcode build instead of the first of two accepted builds',
  },
  {
    site: /^jobs\.release-full-routing-predecessor\.steps\[Checkout proven predecessor verifier\]\.with\.sparse-checkout$/,
    reason: 'the verifier checkout now also carries scripts and .github/workflows, which the cancellation owner '
      + 'reads; the retired base-controller checkout carried them before',
  },
  {
    site: /^jobs\.release-full-routing-predecessor\.steps\[Cancel retained predecessors\]\.run$/,
    reason: 'the release runs the single cancellation owner instead of the retired cancelBlockedPrCi.ts launcher',
  },
  {
    site: /^jobs\.verify-ios-release-archive\.steps\[Verify Release archive image prerequisites\]\.run$/,
    reason: 'the Release archive checks the device SDK and no simulator runtime (--purpose archive), '
      + 'so it can run on a hosted image that ships the pinned Xcode',
  },
];

/** Sites S1 added. Each is either inert off merge_group or listed with its reason. */
const addedSites: ReadonlyArray<readonly [RegExp, string]> = [
  [/^jobs\.prepare-dev-e2e-schema\.runs-on$/,
    'schema verification now consumes gate-admitted Linux overflow; devE2eSchemaWorkflow.test.ts '
      + 'executes hosted, external, absent-output and fork routes while preserving environment and IAM guards'],
  [/^on\.merge_group/, 'the new trigger'],
  [/^jobs\.cancel-deleted-queue-candidate\./, 'queue-only job; its `if` requires a merge_group event'],
  [/\.env\.(INPUT_)?MERGE_GROUP_REF$/, 'queue ref input; asserted empty off merge_group'],
  [/\.env\.IOS_(CHANGE_DETECTOR|PLANNING_PROGRAM)_ROOT$/, 'program root; asserted "." off merge_group'],
  [/^jobs\.plan-pr-validation\.steps\[plan\]\.env\.INPUT_BASE_BRANCH$/,
    'validation depth (merge-queue plan section 8): a PR into develop runs light lanes'],
  [/^jobs\.ios-change-gate\.steps\[classify\]\.env\.IOS_NATIVE_BASE_BRANCH$/,
    'validation depth (merge-queue plan section 8): a PR into develop defers full UI and the archive'],
  [/\.env\.SCHEMA_PREPARATION_RESULT$/, 'real-server verdicts read the schema job result (new need)'],
  [/^jobs\.(test-ios|onboarding-e2e-status)\.needs\[\d+\]$/, 'real-server verdicts now need prepare-dev-e2e-schema'],
  [/^jobs\.validation-policy\.steps\[debt-preflight\]\.env\.GITHUB_TOKEN$/, 'the preflight reads a queued PR body'],
  [/^jobs\.validation-policy\.steps\[Install typed CI dependencies\]/, 'the preflight imports zod'],
  [/^jobs\.plan-pr-validation\.steps\[base-update\]\.if$/, 'classifier is PR-only; asserted true on pull_request'],
  [/^jobs\.server-tests\.steps\[(capture-shard-inputs)\]\.if$/, 'receipts are PR-only; asserted true on pull_request'],
  [/^jobs\.ios-change-gate\.steps\[evidence-selection\]\.env\.IOS_AFFECTED_TESTS_/,
    'the record-only evidence-lane selector copies the main selector inputs; it runs only for a recorded or re-planned PR'],
  [/^jobs\.ios-change-gate\.steps\[(Checkout trusted queue candidate detector|Install trusted queue candidate detector dependencies)\]/,
    'queue-only checkout; its `if` is asserted false off merge_group'],
  [/^jobs\.(verify-ios-release-archive|build-ios-native-test-products|test-ios-execution)\.runs-on$/,
    'the routed Mac runner: the pool branch is the old group and labels, asserted in hostedMacRoute.test.ts'],
  [/^jobs\.ios-change-gate\.steps\[hosted-mac-(route|confirm)\]\.(env\.|if$)/,
    'the hosted macOS route planner and its reservation check read the event name and head; they only ever choose a runner'],
  [/^jobs\.route-initial-control\.if$/,
    'the short hosted route job runs for the same ready PR and queue events as the planner'],
  [/^jobs\.route-initial-control\.runs-on$/,
    'the first route uses hosted Linux only while policy is enabled; selectControlRunners.test.ts '
      + 'evaluates both policy settings for same-repository, fork and queue events'],
  [/^jobs\.route-initial-control\.steps\[(trusted-gate-source|Checkout trusted Linux admission policy)\]\.with\.ref$/,
    'the route selector executes from the protected default branch, not PR-head code'],
  [/^jobs\.(route-initial-control|ios-change-gate)\.steps\[control-route\]\.env\.(SAME_REPOSITORY_CODE|REPOSITORY_DEFAULT_BRANCH)$/,
    'control-route inputs: which control jobs may overflow to hosted Linux; an empty route keeps the external runner'],
  [/^jobs\.(build-ios-native-test-products|test-ios-execution)\.steps\[Prepare native selector history\]\.env\.(IOS_AFFECTED_TESTS_HEAD|IOS_SELECTOR_HISTORY)$/,
    'the selector history step now runs on every event; IOS_SELECTOR_HISTORY is "promotion" exactly where the old step\'s `if` was true'],
  [/^jobs\.plan-pr-validation\.steps\[queue-reuse\]/, 'queue-only lane evidence match; its `if` is asserted false off merge_group'],
  [/^jobs\.validate\.steps\[Require every selected validation lane\]\.env\.(EVENT_NAME|REPOSITORY|PR_NUMBER|PR_HEAD_SHA|PR_BASE_SHA|TESTED_MERGE_SHA|WORKFLOW_SHA|RUN_ID|RUN_ATTEMPT|REUSED_LANES|LANE_EVIDENCE|TARGETED_(SERVER|INTEGRATION)_TESTS_PLAN|ENTITLEMENT_ACCEPTANCE_REQUIRED|TEST_ONLY_HELPERS_PLAN)$/,
    'the aggregate prints the PR lane evidence marker on pull_request and reads a queue candidate\'s reuse record'],
];

/**
 * Sites the hosted macOS route replaced: the pool's group and labels are now
 * the false branch of one `runs-on` expression the gate can redirect.
 */
const movedSites: ReadonlyArray<readonly [RegExp, string]> = [
  [/^jobs\.(verify-ios-release-archive|build-ios-native-test-products|test-ios-execution)\.runs-on\.(group|labels)$/,
    'the pool route became one fromJson expression the gate can redirect to hosted macOS'],
  [/^jobs\.(build-ios-native-test-products|test-ios-execution)\.steps\[Prepare exact promotion selector history\]\.(if|env\.IOS_AFFECTED_TESTS_HEAD)$/,
    'the promotion-only history step became "Prepare native selector history", which runs on every event'],
];

/**
 * Sites deleted with the behavior they fed: the retained-predecessor release
 * no longer checks out the base controller, because the single cancellation
 * owner it now runs comes from the verifier checkout.
 */
const retiredSites: ReadonlyArray<readonly [RegExp, string]> = [
  [/^jobs\.plan-pr-validation\.steps\[plan\]\.env\.INPUT_BASE_SHA$/,
    'the retired bundled planner read this compatibility alias; the typed planner reads INPUT_TRUSTED_SCRIPT_SOURCE_SHA'],
  [/^jobs\.release-full-routing-predecessor\.steps\[Checkout exact base predecessor controller\]\.with\.ref$/,
    'the retired cancelBlockedPrCi.ts controller was read from this base checkout'],
  [/^jobs\.release-full-routing-predecessor\.steps\[Cancel retained predecessors\]\.env\.BASE_SHA$/,
    'only the retired controller plan compared the base checkout against BASE_SHA'],
];

const eventDerived = (text: string): boolean =>
  /github\.(event|sha|ref|head_ref|base_ref|actor)\b|inputs\./.test(text);

const minimumCompared = { 'pr-checks': 30, 'ios-tests': 130 } as const;

function assertEquivalent(file: 'pr-checks' | 'ios-tests', contexts: Array<readonly [string, Context]>): void {
  const before = sites(load(readFileSync(`ci/tests/fixtures/pre-merge-group/${file}.yml`, 'utf8')) as Document, '', new Map());
  const after = sites(load(readFileSync(`.github/workflows/${file}.yml`, 'utf8')) as Document, '', new Map());
  // Only event-derived sites are pinned, so unrelated later edits to these
  // workflows do not have to refreeze the snapshot.
  const removed = [...before].filter(([key, text]) => !after.has(key) && eventDerived(text)
    && !movedSites.some(([pattern]) => pattern.test(key))
    && !retiredSites.some(([pattern]) => pattern.test(key))).map(([key]) => key);
  assert.deepEqual(removed, [], `${file}: event-derived expression sites removed since S1`);
  const unexplained = [...after].filter(([key, text]) => !before.has(key) && eventDerived(text)
    && !addedSites.some(([pattern]) => pattern.test(key))).map(([key]) => key);
  assert.deepEqual(unexplained, [], `${file}: expression sites added without a reason`);

  const failures: string[] = [];
  let compared = 0;
  for (const [site, text] of after) {
    const old = before.get(site);
    if (old === undefined || old === text) continue;
    compared += 1;
    for (const [label, context] of contexts) {
      for (const graph of graphs) {
        const was = evaluateSite(site, old, context, graph);
        const now = evaluateSite(site, text, context, graph);
        if (was === now) continue;
        if (allowedDifferences.some((allowed) => allowed.site.test(site) && (allowed.when?.(label) ?? true))) continue;
        failures.push(`${site} [${label} ${graph.label}]: ${was} -> ${now}`);
      }
    }
  }
  assert.deepEqual(failures.slice(0, 20), [], `${file}: ${failures.length} unexplained evaluation differences`);
  // The rewrite touched dozens of sites in each file; a vacuous comparison would prove nothing.
  assert.ok(compared >= minimumCompared[file], `${file}: only ${compared} rewritten sites were evaluated`);

  // Added sites must be inert on these events.
  for (const [site, text] of after) {
    if (before.has(site)) continue;
    for (const [label, context] of contexts) {
      const value = evaluateSite(site, text, context, graphs[0] as Graph);
      if (site.endsWith('MERGE_GROUP_REF')) assert.equal(value, '""', `${site} [${label}]`);
      if (site.endsWith('_ROOT')) assert.equal(value, '"."', `${site} [${label}]`);
      if (/queue candidate detector.*\.if$/.test(site)) assert.equal(value, 'false', `${site} [${label}]`);
      if (/\[queue-reuse\]\.if$/.test(site)) assert.equal(value, 'false', `${site} [${label}]`);
      if (/\[(base-update|capture-shard-inputs)\]\.if$/.test(site)) assert.equal(value, 'true', `${site} [${label}]`);
    }
  }
}

test('PR Checks evaluates exactly as before S1 on every pull_request shape', () => {
  assertEquivalent('pr-checks', pullRequestContexts());
});

test('Test - iOS evaluates exactly as before S1 on every pull_request shape', () => {
  assertEquivalent('ios-tests', pullRequestContexts());
});

test('Test - iOS evaluates exactly as before S1 on every workflow_dispatch scope, runner and ref', () => {
  assertEquivalent('ios-tests', dispatchContexts());
});

test('the rewritten program commands are the old commands once their root is "."', () => {
  const after = sites(load(readFileSync('.github/workflows/ios-tests.yml', 'utf8')) as Document, '', new Map());
  const before = sites(load(readFileSync('ci/tests/fixtures/pre-merge-group/ios-tests.yml', 'utf8')) as Document,
    '', new Map());
  // `classify` ran a bash wrapper before S1; it now runs planIosNative.ts
  // directly (mergeGroupWorkflows.test.ts pins that command and its root).
  for (const step of ['detect', 'Lint throwable iOS enabled-state reads']) {
    const site = `jobs.ios-change-gate.steps[${step}].run`;
    const now = after.get(site);
    assert.ok(now !== undefined, site);
    assert.equal(now.replace(/"\$IOS_[A-Z_]+_ROOT\/([^"]+)"/, '$1'), before.get(site), site);
  }
});

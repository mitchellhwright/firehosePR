import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import {
  ciEventCondition, ciEventField, SUPPORTED_CI_EVENTS, UNAVAILABLE_EVENT_FIELD,
} from '../workflows/lib/ciEvent.ts';
import { prChecks } from '../workflows/pr-checks.ts';
import { iosTests } from '../workflows/ios-tests/index.ts';
import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';

/**
 * Merge-queue stage S1: both required workflows run on `merge_group`, every
 * required context renders there, and no trusted-base value can resolve to
 * the queue candidate. The rendered YAML is evaluated, not pattern-matched,
 * so the assertions are about what GitHub would compute for each event.
 */

const BASE = 'b'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const PR_HEAD = 'd'.repeat(40);
const PR_BASE = 'e'.repeat(40);
const PR_MERGE = 'f'.repeat(40);
const QUEUE_REF = `refs/heads/gh-readonly-queue/develop/pr-6151-${BASE}`;
const REPOSITORY = 'example-org/example-app';

type Context = Record<string, ExpressionValue>;

function github(overrides: Record<string, ExpressionValue>): ExpressionValue {
  return { repository: REPOSITORY, run_id: 42, ref: 'refs/heads/develop', ...overrides };
}

/** A realistic merge_group payload: `head_ref` is delivered fully qualified. */
function mergeGroupContext(group: Record<string, ExpressionValue> = {}): Context {
  return {
    github: github({
      event_name: 'merge_group', sha: CANDIDATE, ref: QUEUE_REF,
      event: {
        action: 'checks_requested',
        merge_group: {
          head_sha: CANDIDATE, base_sha: BASE, head_ref: QUEUE_REF, base_ref: 'refs/heads/develop',
          ...group,
        },
        repository: { full_name: REPOSITORY, default_branch: 'develop' },
      },
    }),
    inputs: {}, vars: {}, needs: {}, steps: {},
  };
}

function pullRequestContext(options: { readonly draft?: boolean; readonly base?: string } = {}): Context {
  return {
    github: github({
      event_name: 'pull_request', sha: PR_MERGE, ref: 'refs/pull/7/merge',
      event: {
        action: 'synchronize',
        pull_request: {
          number: 7, draft: options.draft ?? false,
          head: { sha: PR_HEAD, ref: 'feature/x', repo: { full_name: REPOSITORY } },
          base: { sha: PR_BASE, ref: options.base ?? 'develop' },
        },
      },
    }),
    inputs: {}, vars: {}, needs: {}, steps: {},
  };
}

function dispatchContext(): Context {
  return {
    github: github({ event_name: 'workflow_dispatch', sha: BASE, event: { inputs: {} } }),
    inputs: { test_scope: 'affected' }, vars: {}, needs: {}, steps: {},
  };
}

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly id?: string;
  readonly if?: string;
  readonly with?: Record<string, string>;
  readonly env?: Record<string, string>;
}
interface Job {
  readonly name?: string;
  readonly 'runs-on'?: string;
  readonly if?: string;
  readonly steps: readonly Step[];
  readonly outputs?: Record<string, string>;
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly env?: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

const prChecksYaml = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as Workflow;
const iosTestsYaml = load(readFileSync('.github/workflows/ios-tests.yml', 'utf8')) as Workflow;

function jobOf(workflow: Workflow, id: string): Job {
  const job = workflow.jobs[id];
  assert.ok(job, id);
  return job;
}

function stepOf(workflow: Workflow, jobId: string, name: string): Step {
  const step = jobOf(workflow, jobId).steps.find((candidate) => candidate.name === name);
  assert.ok(step, `${jobId}: ${name}`);
  return step;
}

function evaluate(source: string | undefined, context: Context): ExpressionValue {
  assert.ok(source !== undefined);
  return evaluateExpression(source, context);
}

/** The property every trusted-base value must hold on a queue candidate. */
function assertQueueBase(value: ExpressionValue, where: string): void {
  assert.notEqual(value, CANDIDATE, `${where} resolved to the merge queue candidate`);
  assert.equal(value, BASE, `${where} must be merge_group.base_sha`);
}

/** The trusted-base values the two workflows check out or hand to verifiers. */
function trustedBaseValues(): ReadonlyArray<readonly [string, string | undefined]> {
  return [
    ['ios-tests env EXAMPLE_CI_TRUSTED_BASE_SHA', iosTestsYaml.env?.['EXAMPLE_CI_TRUSTED_BASE_SHA']],
    ['ios precheck checkout ref', stepOf(iosTestsYaml, 'ios-change-gate', 'Checkout trusted iOS gate precheck').with?.['ref']],
    ['ios precheck BASE_SHA', stepOf(iosTestsYaml, 'ios-change-gate', 'Precheck iOS Gate').env?.['BASE_SHA']],
    ['pr-checks trusted_policy_sha', jobOf(prChecksYaml, 'plan-pr-validation').outputs?.['trusted_policy_sha']],
    ['pr-checks planner checkout', stepOf(prChecksYaml, 'plan-pr-validation', 'Checkout trusted base workspace').with?.['ref']],
    ['pr-checks inventory BASE_SHA', stepOf(prChecksYaml, 'plan-pr-validation', 'Collect PR change inventory').env?.['BASE_SHA']],
    ['pr-checks verdict checkout', stepOf(prChecksYaml, 'validate', 'Check out the typed validation verdict').with?.['ref']],
  ];
}

test('both required workflows subscribe to merge_group checks_requested on develop only', () => {
  for (const [name, workflow] of [['pr-checks', prChecksYaml], ['ios-tests', iosTestsYaml]] as const) {
    assert.deepEqual(workflow.on['merge_group'], { types: ['checks_requested'], branches: ['develop'] }, name);
    assert.ok('pull_request' in workflow.on, name);
  }
  assert.deepEqual(Object.keys(iosTestsYaml.on).sort(), ['merge_group', 'pull_request', 'workflow_dispatch']);
  assert.deepEqual(Object.keys(prChecksYaml.on).sort(), ['merge_group', 'pull_request']);
});

test('every required context keeps its name and renders on a merge queue candidate', () => {
  const context = mergeGroupContext();
  const required = new Map([
    ['pr-checks', { workflow: prChecksYaml, definition: prChecks }],
    ['ios-tests', { workflow: iosTestsYaml, definition: iosTests }],
  ]);
  const names: string[] = [];
  for (const [label, { workflow, definition }] of required) {
    for (const id of definition.config.requiredContexts ?? []) {
      const job = jobOf(workflow, id);
      // The gate has run and succeeded; an aggregate must still publish.
      const gated = {
        ...context,
        needs: {
          'plan-pr-validation': { result: 'success', outputs: { docs_only: 'false', lint_plan: '{"mode":"full","paths":[]}' } },
          'ios-change-gate': { result: 'success', outputs: { storekit_required: 'false' } },
        },
      };
      assert.ok(evaluate(job.if ?? 'true', gated), `${label}/${id} is skipped on merge_group`);
      const name = job.name ?? id;
      names.push(name.includes('${{') ? String(evaluate(name, gated)) : name);
    }
  }
  assert.deepEqual(names.sort(), [
    'Lint changed code', 'Onboarding E2E', 'StoreKit Purchase - iOS', 'Test - iOS',
    'Validate pull request changes', 'iOS Change Gate',
  ].sort());
});

test('trusted-base values resolve to merge_group.base_sha and never to github.sha', () => {
  for (const [where, source] of trustedBaseValues()) {
    assertQueueBase(evaluate(source, mergeGroupContext()), where);
  }
});

test('a merge_group payload without base_sha checks out nothing rather than the candidate', () => {
  const broken = mergeGroupContext({ base_sha: null });
  for (const [where, source] of trustedBaseValues()) {
    const value = evaluate(source, broken);
    assert.notEqual(value, CANDIDATE, where);
    assert.equal(value, UNAVAILABLE_EVENT_FIELD, where);
  }
});

test('mutation check: the pre-S1 fallback would have run candidate code as the verifier', () => {
  // The expressions the workflows rendered before this stage. Evaluated for a
  // queue candidate they return github.sha, which assertQueueBase rejects: the
  // tests above would fail if either fallback came back.
  for (const legacy of [
    'github.event.pull_request.base.sha || github.sha',
    "github.event.pull_request.base.ref == 'main' && 'develop' || github.event.pull_request.base.sha || github.sha",
  ]) {
    const value = evaluate(legacy, mergeGroupContext());
    assert.equal(value, CANDIDATE);
    assert.throws(() => assertQueueBase(value, legacy), /resolved to the merge queue candidate/);
  }
  // And an empty trusted base is what the checkout action would have turned
  // into github.sha: the projection never renders one for merge_group.
  assert.notEqual(evaluate(ciEventField('trustedBaseSha').expression, mergeGroupContext({ base_sha: '' })), '');
});

test('the event projections map every supported event explicitly', () => {
  const contexts: Record<(typeof SUPPORTED_CI_EVENTS)[number], Context> = {
    pull_request: pullRequestContext(),
    merge_group: mergeGroupContext(),
    workflow_dispatch: dispatchContext(),
  };
  const expected = {
    headSha: { pull_request: PR_HEAD, merge_group: CANDIDATE, workflow_dispatch: BASE },
    trustedBaseSha: { pull_request: PR_BASE, merge_group: BASE, workflow_dispatch: BASE },
    baseBranch: { pull_request: 'develop', merge_group: 'develop', workflow_dispatch: '' },
    headRepository: { pull_request: REPOSITORY, merge_group: REPOSITORY, workflow_dispatch: '' },
    prNumber: { pull_request: 7, merge_group: '', workflow_dispatch: '' },
    mergeGroupRef: { pull_request: '', merge_group: QUEUE_REF, workflow_dispatch: '' },
  } as const;
  for (const [field, byEvent] of Object.entries(expected)) {
    for (const event of SUPPORTED_CI_EVENTS) {
      assert.equal(
        evaluate(ciEventField(field as keyof typeof expected).expression, contexts[event]),
        byEvent[event], `${field} on ${event}`,
      );
    }
  }
  const unsupported = { ...dispatchContext(), github: github({ event_name: 'push', sha: CANDIDATE }) };
  assert.equal(evaluate(ciEventField('trustedBaseSha').expression, unsupported), UNAVAILABLE_EVENT_FIELD);
  assert.equal(evaluate(ciEventField('headSha').expression, unsupported), UNAVAILABLE_EVENT_FIELD);
});

test('draft guards are explicit per event: a draft waits, a queue candidate and a dispatch do not', () => {
  const ready = ciEventCondition('ready');
  assert.equal(evaluate(ready, pullRequestContext({ draft: true })), false);
  assert.equal(evaluate(ready, pullRequestContext({ draft: false })), true);
  assert.equal(evaluate(ready, mergeGroupContext()), true);
  assert.equal(evaluate(ready, dispatchContext()), true);
  // The pre-S1 guard passed on merge_group only because null == false coerces
  // to true; the projection no longer reads a missing draft field at all.
  assert.equal(evaluate('github.event.pull_request.draft == false', mergeGroupContext()), true);
  assert.doesNotMatch(ready.replace(/\(github\.event_name == 'pull_request' && [^)]*\)/, ''), /draft/);

  const gates: ReadonlyArray<readonly [Workflow, string]> = [
    [prChecksYaml, 'plan-pr-validation'], [prChecksYaml, 'validate'], [iosTestsYaml, 'ios-change-gate'],
    [iosTestsYaml, 'test-ios'], [iosTestsYaml, 'onboarding-e2e-status'],
  ];
  for (const [workflow, id] of gates) {
    const condition = jobOf(workflow, id).if;
    assert.equal(evaluate(condition, pullRequestContext({ draft: true })), false, `${id} runs for a draft`);
    assert.ok(evaluate(condition, pullRequestContext({ draft: false })), `${id} skips a ready PR`);
    assert.ok(evaluate(condition, mergeGroupContext()), `${id} skips a merge_group`);
  }
});

test('queue candidates route to trusted runners, forks stay hosted', () => {
  const route = (context: Context): string =>
    JSON.stringify(evaluate(jobOf(prChecksYaml, 'plan-pr-validation')['runs-on'], context));
  assert.match(route(mergeGroupContext()), /example-trusted-control/);
  assert.match(route(pullRequestContext()), /example-trusted-control/);
  const fork = pullRequestContext();
  const event = fork['github'] as { event: { pull_request: { head: { repo: { full_name: string } } } } };
  event.event.pull_request.head.repo.full_name = 'outside/fork';
  assert.match(route(fork), /ubuntu-24\.04/);
});

test('required workflow sources read event tuple fields only through the ciEvent projection', () => {
  const sources = [
    'ci/workflows/pr-checks.ts',
    'ci/workflows/lib/runners.ts',
    ...readdirSync('ci/workflows/ios-tests').map((file) => join('ci/workflows/ios-tests', file)),
  ];
  const forbidden = new RegExp([
    'event\\.pull_request', 'event\\.merge_group', 'github\\.head_ref', 'github\\.base_ref',
    '\\|\\| github\\.sha', "event_name == 'merge_group'", "event_name != 'pull_request'",
  ].join('|'));
  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, forbidden, `${path} reads an event field outside ci/workflows/lib/ciEvent.ts`);
  }
});

test('on a queue candidate the planning programs run from the queue base checkout', () => {
  const gate = 'ios-change-gate';
  const lint = stepOf(iosTestsYaml, gate, 'Lint throwable iOS enabled-state reads');
  const detect = stepOf(iosTestsYaml, gate, 'Detect iOS Changes');
  const classify = stepOf(iosTestsYaml, gate, 'Classify selected UI work');
  assert.equal(lint.run, 'node "$IOS_PLANNING_PROGRAM_ROOT/ci/src/actions/ios/lintIosUiTestElementState.ts"');
  assert.equal(classify.run, 'node "$IOS_PLANNING_PROGRAM_ROOT/ci/src/actions/planIosNative.ts"');
  assert.equal(detect.run, 'node "$IOS_CHANGE_DETECTOR_ROOT/ci/src/actions/ios/detectIosChanges.ts"');
  const roots = [
    lint.env?.['IOS_PLANNING_PROGRAM_ROOT'], classify.env?.['IOS_PLANNING_PROGRAM_ROOT'],
    detect.env?.['IOS_CHANGE_DETECTOR_ROOT'],
  ];
  for (const root of roots) {
    assert.equal(evaluate(root, mergeGroupContext()), '.ci/trusted-ios-detector');
    assert.equal(evaluate(root, pullRequestContext()), '.');
    assert.equal(evaluate(root, dispatchContext()), '.');
  }
  // That checkout is the verifier the precheck proved (the queue base), and it
  // is materialised, with its dependencies, only for a queue candidate.
  const checkout = stepOf(iosTestsYaml, gate, 'Checkout trusted queue candidate detector');
  assert.equal(checkout.with?.['ref'], '${{ steps.precheck.outputs.verifier_sha }}');
  assert.equal(checkout.with?.['path'], '.ci/trusted-ios-detector');
  const queued = { ...mergeGroupContext(), steps: { precheck: { outputs: { needs_checkout: 'true' } } } };
  assert.equal(evaluate(checkout.if, queued), true);
  assert.equal(evaluate(checkout.if, { ...pullRequestContext(), steps: queued.steps }), false);
});

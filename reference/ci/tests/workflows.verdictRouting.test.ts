import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load } from 'js-yaml';
import {
  initialControlAdmissionLinuxRunner,
  plannedControlLinuxRunner,
} from '../workflows/lib/runners.ts';
import { ciEventCondition, ciEventFieldSource } from '../workflows/lib/ciEvent.ts';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
}

interface WorkflowJob {
  readonly name?: string;
  readonly 'runs-on': string;
  readonly if?: string;
  readonly needs?: readonly string[];
  readonly permissions?: Readonly<Record<string, string>>;
  readonly steps: readonly WorkflowStep[];
}

interface WorkflowDocument {
  readonly permissions?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

function workflow(name: string): WorkflowDocument {
  return load(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as WorkflowDocument;
}

function job(document: WorkflowDocument, id: string): WorkflowJob {
  const value = document.jobs[id];
  assert.ok(value, id);
  return value;
}

function checkout(value: WorkflowJob): WorkflowStep {
  const step = value.steps.find((candidate) => candidate.uses?.startsWith('actions/checkout@'));
  assert.ok(step);
  assert.equal(step.with?.['persist-credentials'], false);
  return step;
}

test('a short hosted admission job routes the PR planner and later control jobs', () => {
  const document = workflow('pr-checks');
  const verdict = job(document, 'validate');
  assert.equal(verdict['runs-on'],
    String(plannedControlLinuxRunner('needs.plan-pr-validation.outputs.control_runner_labels')));
  assert.match(verdict['runs-on'], /example-trusted-control/);
  assert.match(verdict['runs-on'], /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(verdict['runs-on'], /ubuntu-24\.04/);
  const route = job(document, 'route-initial-control');
  assert.equal(route['runs-on'], String(initialControlAdmissionLinuxRunner));
  assert.match(route['runs-on'], /CI_HOSTED_LINUX_AVAILABLE != '1'/);
  assert.equal(route.needs, undefined);
  assert.equal(checkout(route).with?.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(route.steps.find((step) => step.run === 'node ci/src/actions/selectControlRunners.ts')
    ?.env?.RUNNER_ENVIRONMENT, '${{ runner.environment }}');
  assert.equal(job(document, 'plan-pr-validation')['runs-on'],
    String(plannedControlLinuxRunner('needs.route-initial-control.outputs.control_runner_labels')));
  assert.deepEqual(job(document, 'plan-pr-validation').needs, ['route-initial-control']);
  assert.match(job(document, 'plan-pr-validation').if ?? '', /always\(\).* !cancelled\(\)/);
  assert.equal(job(document, 'validation-policy')['runs-on'],
    String(plannedControlLinuxRunner('needs.plan-pr-validation.outputs.control_runner_labels')));
  assert.match(job(document, 'plan-pr-validation')['runs-on'], /example-trusted-control/);
  assert.deepEqual(document.permissions, {
    actions: 'read', contents: 'read', 'pull-requests': 'read',
  });
  assert.equal(checkout(verdict).with?.ref,
    `\${{ needs.plan-pr-validation.outputs.trusted_policy_sha || ${ciEventFieldSource('trustedBaseSha')} }}`);
  const decision = verdict.steps.find((step) => step.run === 'node ci/src/actions/requireSelectedValidationLanes.ts');
  assert.ok(decision);
  assert.equal(decision.env?.PR_VALIDATION_PLAN, '${{ needs.plan-pr-validation.result }}');
  assert.equal(decision.env?.DOCS_ONLY, '${{ needs.plan-pr-validation.outputs.docs_only }}');
});

test('completed iOS verdicts use planned control capacity', () => {
  const document = workflow('ios-tests');
  const laneContract = JSON.parse(readFileSync(
    new URL('../contracts/workflow-lane-contract.v2.json', import.meta.url), 'utf8',
  )) as { readonly lanes: readonly { readonly jobId: string; readonly runnerClass: string }[] };
  for (const id of ['test-ios', 'onboarding-e2e-status']) {
    assert.equal(laneContract.lanes.find((lane) => lane.jobId === id)?.runnerClass, 'hosted-control', id);
  }
  assert.equal(laneContract.lanes.find((lane) => lane.jobId === 'storekit-purchase-status')?.runnerClass,
    'hosted-control');
  for (const id of ['test-ios', 'storekit-purchase-status', 'onboarding-e2e-status']) {
    const verdict = job(document, id);
    const runner = plannedControlLinuxRunner('needs.ios-change-gate.outputs.control_runner_labels');
    assert.equal(verdict['runs-on'], String(runner), id);
    assert.match(verdict['runs-on'], /example-trusted-control/, id);
    assert.match(verdict['runs-on'], /ubuntu-24\.04/, id);
    assert.equal(
      checkout(verdict).with?.ref,
      '${{ needs.ios-change-gate.outputs.verifier_sha || env.EXAMPLE_CI_TRUSTED_BASE_SHA }}',
      id,
    );
    const permissions = verdict.permissions ?? document.permissions;
    assert.ok(permissions);
    assert.equal(permissions.contents, 'read');
    assert.ok(Object.values(permissions).every((permission) => permission === 'read'), id);
    assert.equal(verdict.steps.some((step) => step.uses?.startsWith('actions/create-github-app-token@')), false, id);
  }
  assert.equal(job(document, 'ios-change-gate')['runs-on'], String(plannedControlLinuxRunner('needs.route-initial-control.outputs.control_runner_labels')));
  assert.deepEqual(job(document, 'ios-change-gate').needs, ['route-initial-control']);
  for (const id of [
    'confirm-current-ios-pr', 'await-retained-ios-predecessor',
    'release-full-routing-predecessor', 'remove-run-artifacts-after-success',
  ]) {
    assert.equal(job(document, id)['runs-on'],
      String(plannedControlLinuxRunner('needs.ios-change-gate.outputs.control_runner_labels')), id);
    assert.match(job(document, id)['runs-on'], /example-trusted-control/, id);
  }
});

test('StoreKit required context is natively skipped only on a successful explicit false selection', () => {
  const verdict = job(workflow('ios-tests'), 'storekit-purchase-status');
  // A skipped job does not evaluate a dynamic job name. GitHub must publish
  // this exact required context even when no runner was allocated.
  assert.equal(verdict.name, 'StoreKit Purchase - iOS');
  assert.deepEqual(verdict.needs, ['ios-change-gate', 'build-ios-native-test-products']);
  assert.equal(verdict.if,
    "always() && !cancelled() && inputs.test_scope != 'observability-credential-sync' "
    + `&& ${ciEventCondition('ready')} `
    + "&& !(github.event_name == 'pull_request' && needs.ios-change-gate.result == 'success' "
    + "&& needs.ios-change-gate.outputs.storekit_required == 'false')");
  const gate = job(workflow('ios-tests'), 'ios-change-gate') as WorkflowJob & {
    readonly outputs?: Readonly<Record<string, string>>;
  };
  assert.equal(gate.outputs?.storekit_required,
    "${{ steps.queue-reuse.outputs.storekit_required || steps.replan.outputs.storekit_required "
    + "|| steps.detect.outputs.storekit_required "
    + "|| steps.precheck.outputs.storekit_required || 'unknown' }}");
});

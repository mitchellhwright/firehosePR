import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowJob } from '../src/workflowStepShell.ts';

function condition(jobName: string, stepName: string): string {
  const step = workflowJob('ios-tests.yml', jobName).steps?.find((candidate) =>
    candidate.name === stepName);
  assert.ok(step, `${jobName} is missing ${stepName}`);
  if (typeof step.if !== 'string') throw new Error(`${stepName} has no condition`);
  return step.if;
}

test('manual financial-independence evidence validates on native1 only when selected', () => {
  const actual = condition('test-ios-execution', 'Validate financial independence evidence');
  for (const required of [
    "matrix.lane == 'native1'",
    "github.event_name == 'workflow_dispatch'",
    "inputs.test_scope == 'financial-independence-evidence'",
    "steps.affected-tests.outputs.should_run == 'true'",
  ]) {
    assert.ok(actual.includes(required), `missing financial-independence guard: ${required}`);
  }
});

test('iOS diagnostics upload only for a failed native test or build step', () => {
  const nativeDiagnostics = condition('test-ios-execution', 'Upload iOS Test Diagnostics');
  assert.match(nativeDiagnostics, /steps\.execute-tests\.outcome == 'failure'/);
  assert.match(nativeDiagnostics, /steps\.rebuild-native-products\.outcome == 'failure'/);
  assert.match(nativeDiagnostics, /steps\.summarize-ios-test-failures\.outcome == 'failure'/);
  assert.match(condition('test-ios-execution', 'Upload iOS Busy retry diagnostics'),
    /steps\.execute-tests\.outcome == 'failure'/);
  assert.match(condition('build-ios-native-test-products', 'Upload native unit and StoreKit diagnostics'),
    /steps\.unit-preflight\.outcome == 'failure'/);
  assert.match(condition('build-ios-native-test-products', 'Upload native unit and StoreKit diagnostics'),
    /steps\.storekit\.outcome == 'failure'/);
  assert.match(condition('verify-ios-release-archive', 'Upload Release archive diagnostics'),
    /steps\.compile-release-archive\.outcome == 'failure'/);
});

test('E2E diagnostic uploads follow their own test and evidence outcomes', () => {
  for (const [job, step, testStep] of [
    ['chat-plaid-e2e', 'Upload Chat Plaid E2E diagnostics', 'chat-plaid-e2e'],
    ['onboarding-e2e', 'Upload onboarding E2E diagnostics', 'onboarding-e2e'],
    ['budget-e2e', 'Upload Budget E2E diagnostics', 'budget-e2e'],
  ] as const) {
    const actual = condition(job, step);
    assert.ok(actual.includes(`steps.${testStep}.outcome == 'failure'`));
    assert.ok(actual.includes(`steps.${testStep}.outcome == 'skipped' && failure()`),
      `${job} must retain setup diagnostics if XCTest never starts`);
  }
  for (const name of [
    'Upload FullOnboarding E2E evidence',
    'Upload onboarding E2E diagnostics',
  ]) {
    assert.ok(condition('onboarding-e2e', name)
      .includes("steps.validate-onboarding-lifecycle.outcome == 'failure'"));
  }
});

test('optional iOS evidence and review media do not upload for passed tests', () => {
  for (const name of [
    'Retain required Wellness execution evidence',
    'Upload iOS Test Screenshots',
  ]) {
    assert.match(condition('test-ios-execution', name), /steps\.execute-tests\.outcome == 'failure'/);
  }
  for (const name of ['Upload iOS Test Screenshots', 'Upload iOS Test Diagnostics']) {
    const actual = condition('test-ios-execution', name);
    for (const step of [
      'export-ios-test-screenshots',
      'validate-financial-independence',
      'validate-onboarding-copy',
    ]) {
      assert.ok(actual.includes(`steps.${step}.outcome == 'failure'`), `${name}: ${step}`);
    }
  }
  assert.match(condition('test-ios-execution', 'Upload iOS Test Screenshots'),
    /startsWith\(matrix\.lane, 'evidence-'\)/);
  for (const [job, step, testStep] of [
    ['income-e2e', 'Upload Income E2E evidence', 'income-e2e'],
    ['chat-plaid-e2e', 'Upload Chat Plaid E2E evidence', 'chat-plaid-e2e'],
    ['onboarding-e2e', 'Upload FullOnboarding E2E evidence', 'onboarding-e2e'],
    ['onboarding-e2e', 'Upload raw onboarding video for non-gating review', 'onboarding-e2e'],
    ['budget-e2e', 'Upload Budget E2E evidence', 'budget-e2e'],
  ] as const) {
    assert.ok(condition(job, step).includes(`steps.${testStep}.outcome == 'failure'`));
  }
  for (const [job, step] of [
    ['income-e2e', 'Upload Income E2E evidence'],
    ['chat-plaid-e2e', 'Upload Chat Plaid E2E evidence'],
    ['chat-plaid-e2e', 'Upload Chat Plaid E2E diagnostics'],
    ['onboarding-e2e', 'Upload FullOnboarding E2E evidence'],
    ['onboarding-e2e', 'Upload onboarding E2E diagnostics'],
    ['budget-e2e', 'Upload Budget E2E evidence'],
    ['budget-e2e', 'Upload Budget E2E diagnostics'],
  ] as const) {
    assert.ok(condition(job, step).includes('|| failure()'),
      `${job}: ${step} must retain evidence for any failed lane step`);
  }
  assert.ok(condition('budget-e2e', 'Upload Budget E2E evidence')
    .includes("steps.export-compact-summaries.outcome == 'failure'"));
  assert.ok(condition('income-e2e', 'Upload Income E2E evidence')
    .includes("steps.income-e2e.outcome == 'skipped' && failure()"));
  const budgetVideo = workflowJob('ios-tests.yml', 'budget-e2e-video-processing');
  assert.match(String(budgetVideo.if), /needs\.budget-e2e\.result == 'failure'/);
  const rawVideoDownload = budgetVideo.steps?.find((step) => step.name === 'Download raw Budget video');
  assert.ok(rawVideoDownload);
  assert.equal(rawVideoDownload.with?.pattern,
    'budget-e2e-evidence-${{ github.run_id }}-${{ github.run_attempt }}-*');
  assert.equal(rawVideoDownload.with?.name, undefined);
});

test('non-handoff evidence for passed production onboarding and debt preflight stays in job logs', () => {
  for (const [workflow, job, step, failedStep] of [
    ['trusted-production-onboarding-e2e.yml', 'production-onboarding-e2e',
      'Upload production onboarding evidence', 'production-onboarding-e2e'],
    ['pr-checks.yml', 'validation-policy', 'Retain debt dependency evidence', 'debt-preflight'],
  ] as const) {
    const upload = workflowJob(workflow, job).steps?.find((candidate) => candidate.name === step);
    assert.ok(upload, `${workflow}: ${step}`);
    assert.match(String(upload.if), new RegExp(`steps\\.${failedStep}\\.outcome == 'failure'`));
  }
  const production = workflowJob('trusted-production-onboarding-e2e.yml', 'production-onboarding-e2e')
    .steps?.find((step) => step.name === 'Upload production onboarding evidence');
  assert.match(String(production?.if), /steps\.production-onboarding-e2e\.outcome == 'skipped' && failure\(\)/);
  assert.match(String(production?.if), /steps\.summarize-production-onboarding-failures\.outcome == 'failure'/);
});

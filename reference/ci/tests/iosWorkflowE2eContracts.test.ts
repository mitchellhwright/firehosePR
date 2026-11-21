import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';
import { z } from 'zod';
import { classifyIosChangedPaths } from '../src/ios/iosChangeClassification.ts';
import { buildDetectOutputs, type GateContext } from '../src/ios/iosChangeGate.ts';
import { manualDispatchDecision, pullRequestStillMatchesEvent } from '../src/ios/iosGatePrecheck.ts';
import { scriptStepOutputs } from '../src/stepOutputs.ts';
import { conventionalWorkflowText, stepShell, workflowJob } from '../src/workflowStepShell.ts';
import { readSourceText } from '../../scripts/source-text.ts';
import {
  ciEventConcurrencyKey, ciEventCondition, ciEventFieldSource, ciEventFieldWith,
} from '../workflows/lib/ciEvent.ts';

const stepSchema = z.object({
  name: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  with: z.record(z.string(), z.unknown()).default({}),
}).passthrough();
const jobSchema = z.object({
  outputs: z.record(z.string(), z.string()).default({}),
  needs: z.array(z.string()).default([]),
  steps: z.array(stepSchema),
}).passthrough();
function job(id: string): z.infer<typeof jobSchema> {
  return jobSchema.parse(workflowJob('ios-tests.yml', id));
}
function readWorkflow(name: string): string {
  return conventionalWorkflowText(readSourceText(new URL(`../../.github/workflows/${name}`, import.meta.url)));
}

test('exact-develop promotion evidence uses the staffed reviewed Mac pool in every native and E2E lane', () => {
  const workflow = load(readFileSync('.github/workflows/ios-tests.yml', 'utf8')) as {
    jobs: Record<string, { 'runs-on'?: string | { group?: string; labels?: string } }>;
  };
  for (const id of [
    'verify-ios-release-archive', 'build-ios-native-test-products',
    'test-ios-execution', 'build-ios-e2e-test-products',
    'onboarding-e2e', 'chat-plaid-e2e', 'income-e2e', 'budget-e2e',
  ]) {
    const route = workflow.jobs[id]?.['runs-on'];
    assert.ok(route, `${id} has a Mac route`);
    // The three native lanes carry the pool as the false branch of one routed
    // expression; the E2E lanes still pin the group and labels directly.
    const group = typeof route === 'string' ? route : route.group ?? '';
    const labels = typeof route === 'string' ? route : route.labels ?? '';
    assert.match(group, /inputs\.test_scope == 'promotion-evidence'/u, id);
    assert.match(group, /example-reviewed-pr-macs/u, id);
    assert.match(labels, /ios-xcode/u, id);
  }
});

test('both native selectors use the gate-proven source/base tuple after preparing selector history', () => {
  const exactBase = '${{ needs.ios-change-gate.outputs.expected_base_sha }}';
  const exactHead = `\${{ ${ciEventFieldSource('headSha')} }}`;
  for (const id of ['build-ios-native-test-products', 'test-ios-execution']) {
    const steps = job(id).steps;
    const prepareIndex = steps.findIndex((step) => step.name === 'Prepare native selector history');
    const selectIndex = steps.findIndex((step) =>
      step.name === 'Determine native build selection' || step.name === 'Determine Affected iOS Tests');
    assert.ok(prepareIndex >= 0 && prepareIndex < selectIndex, id);
    const prepare = steps[prepareIndex];
    const select = steps[selectIndex];
    assert.ok(prepare && select);
    // Every event prewarms: a blob:none checkout on a fresh (hosted) Mac has no
    // merge-base blobs, and the selector itself runs without credentials.
    assert.equal(prepare.if, undefined, id);
    assert.equal(select.if, undefined, id);
    assert.equal(prepare.env.IOS_SELECTOR_HISTORY, "${{ github.event_name == 'workflow_dispatch' "
      + "&& inputs.test_scope == 'promotion-evidence' && 'promotion' || 'checkout' }}");
    assert.equal(prepare.env.GITHUB_TOKEN, '${{ github.token }}');
    assert.equal(prepare.env.IOS_AFFECTED_TESTS_BASE, exactBase);
    assert.equal(prepare.env.IOS_AFFECTED_TESTS_HEAD, exactHead);
    assert.match(prepare.run ?? '', /prepareNativeSelectorHistory\.ts/);
    assert.equal(select.env.IOS_AFFECTED_TESTS_BASE, exactBase);
    assert.equal(select.env.IOS_AFFECTED_TESTS_HEAD, exactHead);
  }
});
function withInvokedShell(source: string): string {
  return source.replace(
    /^[ \t]*run: bash scripts\/ci\/lib\/run-step\.sh (scripts\/\S+\.sh)$/gm,
    (line: string, script: string) => `${line}\n${readSourceText(new URL(`../../${script}`, import.meta.url))}`,
  );
}
function jobSource(workflow: string, jobName: string): string {
  const marker = `\n  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `missing workflow job: ${jobName}`);
  const nextJobMatch = /^\s{2}[A-Za-z0-9_-]+:\s*$/gm;
  nextJobMatch.lastIndex = start + marker.length;
  const nextJob = nextJobMatch.exec(workflow)?.index ?? -1;
  return withInvokedShell(workflow.slice(start, nextJob === -1 ? undefined : nextJob));
}
function jobCondition(workflow: string, jobName: string): string {
  const source = jobSource(workflow, jobName);
  const start = source.indexOf('\n    if: ');
  assert.notEqual(start, -1, `missing if: condition on ${jobName}`);
  const nextKey = /^ {4}[a-z-]+:/gm;
  nextKey.lastIndex = start + 10;
  const end = nextKey.exec(source)?.index ?? -1;
  return source.slice(start, end === -1 ? undefined : end);
}
function runStatusProgram(program: string, environment: Record<string, string>) {
  return spawnSync(process.execPath, [program], {
    encoding: 'utf8',
    cwd: path.dirname(path.dirname(path.dirname(new URL(import.meta.url).pathname))),
    env: { PATH: process.env.PATH, ...environment },
  });
}
const trustedDevelopPullRequest = {
  EVENT_NAME: 'pull_request', BASE_BRANCH: 'develop',
  HEAD_REPOSITORY: 'example-org/example-app', REPOSITORY: 'example-org/example-app',
  DISPATCH_REF: 'refs/pull/1/merge', CHANGE_GATE_RESULT: 'success', TEST_SCOPE: '',
};
const REAL_SERVER_E2E_STATUS = 'ci/src/actions/ios/verifyRealServerE2eStatus.ts';
const STOREKIT_PURCHASE_STATUS = 'ci/src/actions/ios/verifyStorekitPurchaseStatus.ts';
function gateContext(overrides: Partial<GateContext> = {}): GateContext {
  return { forcedIosLanesRaw: '[]', reuseNativeEvidenceRaw: 'false',
    changedFilesDelimiter: 'CHANGED_FILES_1_1', ...overrides };
}

test('onboarding status requires selected PR E2E lanes to execute', () => {
  const workflow = readWorkflow('ios-tests.yml');
  const onboardingStatus = jobSource(workflow, 'onboarding-e2e-status');

  assert.ok(!onboardingStatus.includes('TEST_RESULT: ${{ needs.test-ios.result }}'));
  assert.match(onboardingStatus, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(onboardingStatus, /BUDGET_E2E_ENABLED/);

  // Every lane the aggregate verifies is held to the same rule: selected means
  // it must have passed, unselected means it must not have run at all.
  const laneBaseline = {
    ...trustedDevelopPullRequest,
    STATUS_AGGREGATE: 'onboarding-e2e-status',
    BUDGET_E2E_ENABLED: 'true',
    ONBOARDING_REQUIRED: 'false', CHAT_PLAID_REQUIRED: 'false',
    INCOME_REQUIRED: 'false', BUDGET_REQUIRED: 'false',
    EXECUTION_RESULT: 'skipped', CHAT_PLAID_EXECUTION_RESULT: 'skipped',
    INCOME_EXECUTION_RESULT: 'skipped', BUDGET_EXECUTION_RESULT: 'skipped',
  };
  for (const [lane, requiredName, resultName] of [
    ['onboarding', 'ONBOARDING_REQUIRED', 'EXECUTION_RESULT'],
    ['chat-plaid', 'CHAT_PLAID_REQUIRED', 'CHAT_PLAID_EXECUTION_RESULT'],
    ['budget', 'BUDGET_REQUIRED', 'BUDGET_EXECUTION_RESULT'],
  ] as const) {
    const selectedButSkipped = runStatusProgram(REAL_SERVER_E2E_STATUS, {
      ...laneBaseline, [requiredName]: 'true',
    });
    assert.equal(selectedButSkipped.status, 1, `${lane}: ${selectedButSkipped.stderr}`);
    assert.match(selectedButSkipped.stdout, new RegExp(`Selected ${lane} E2E did not pass`));

    const unselectedButRan = runStatusProgram(REAL_SERVER_E2E_STATUS, {
      ...laneBaseline, [resultName]: 'success',
    });
    assert.equal(unselectedButRan.status, 1, `${lane}: ${unselectedButRan.stderr}`);
    assert.match(unselectedButRan.stdout, new RegExp(`Unselected ${lane} E2E had unexpected result`));
  }
  assert.match(jobCondition(workflow, 'budget-e2e'), /vars\.IOS_ENABLE_BUDGET_E2E == 'true'/);
  assert.match(
    jobCondition(workflow, 'budget-e2e'),
    /vars\.IOS_ENABLE_BUDGET_E2E == 'true'[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*inputs\.test_scope == 'debt-card-evidence'/,
    'an explicit debt-card evidence dispatch must run its sole consumer while general Budget E2E is disabled',
  );
  assert.match(
    jobCondition(workflow, 'build-ios-e2e-test-products'),
    /budget_required == 'true'\s*&&\s*vars\.IOS_ENABLE_BUDGET_E2E == 'true'/,
  );
  const noneSelected = runStatusProgram(REAL_SERVER_E2E_STATUS, laneBaseline);
  assert.equal(noneSelected.status, 0, noneSelected.stderr);
  assert.match(noneSelected.stdout, /not selected: no real-server E2E lane is selected for these changes/);

  const untrusted = runStatusProgram(REAL_SERVER_E2E_STATUS, {
    ...laneBaseline, HEAD_REPOSITORY: 'outside/fork', EXECUTION_RESULT: 'success',
  });
  assert.equal(untrusted.status, 1);
  assert.match(untrusted.stdout, /An untrusted pull request unexpectedly executed real-server E2E/);
  assert.doesNotMatch(onboardingStatus, /expected_(onboarding|chat_plaid|budget)_result/);
});

test('real-server E2E jobs use their matching change-gate selectors', () => {
  const workflow = readWorkflow('ios-tests.yml');
  const changeGate = jobSource(workflow, 'ios-change-gate');
  const onboardingCondition = jobCondition(workflow, 'onboarding-e2e');
  const chatPlaidCondition = jobCondition(workflow, 'chat-plaid-e2e');
  // The path owners moved into the typed classifier; assert the routing
  // itself rather than the shell that used to spell it.
  for (const changedPath of ['server/routes/plaid.ts', 'server/services/plaid/plaidService.ts']) {
    assert.equal(
      classifyIosChangedPaths([changedPath]).chatPlaidRequired,
      true,
      `${changedPath} must own the Chat-Plaid lane`,
    );
  }
  assert.match(
    changeGate,
    /chat_plaid_required: \$\{\{ steps\.queue-reuse\.outputs\.chat_plaid_required \|\| steps\.replan\.outputs\.chat_plaid_required \|\| steps\.detect\.outputs\.chat_plaid_required \|\| steps\.precheck\.outputs\.chat_plaid_required \|\| 'false' \}\}/
  );
  assert.equal(
    buildDetectOutputs(gateContext(), { shouldRun: 'true', summary: '', chatPlaidRequired: 'true' })
      .find((output) => output.key === 'chat_plaid_required')?.value,
    'true',
    'the detect program must publish chat_plaid_required',
  );
  // The Chat-Plaid lane is selected by the typed precheck now. Its output is
  // still written under the name the job reads it back by, and the broad
  // manual dispatch still selects it.
  assert.ok(
    (scriptStepOutputs['.github/workflows/ios-tests.yml']['ios-change-gate'].precheck ?? [])
      .includes('chat_plaid_required')
  );
  assert.ok(
    readFileSync(new URL('../../ci/src/actions/ios/precheckIosGate.ts', import.meta.url), 'utf8')
      .includes("['chat_plaid_required', String(gateOutcome.chatPlaidRequired)]")
  );
  const broadManual = manualDispatchDecision('', '');
  assert.equal(broadManual.kind, 'outcome');
  assert.equal(broadManual.outcome.summary, 'Manual run requested iOS checks.');
  assert.deepEqual(
    ['needsCheckout', 'storekitRequired', 'onboardingRequired', 'budgetRequired',
      'productionPromotion', 'evidenceRequired', 'chatPlaidRequired', 'incomeRequired']
      .map((lane) => broadManual.outcome[lane as keyof typeof broadManual.outcome]),
    [false, true, true, true, false, true, true, false]
  );
  assert.match(onboardingCondition, /outputs\.onboarding_required == 'true'/);
  assert.doesNotMatch(onboardingCondition, /outputs\.chat_plaid_required == 'true'/);
  assert.match(chatPlaidCondition, /outputs\.chat_plaid_required == 'true'/);
  assert.doesNotMatch(chatPlaidCondition, /outputs\.onboarding_required == 'true'/);
});

test('user data activation changes require onboarding E2E', () => {
  assert.match(
    stepShell('ios-tests.yml', 'ios-change-gate', 'Detect iOS Changes'),
    /node "\$IOS_CHANGE_DETECTOR_ROOT\/ci\/src\/actions\/ios\/detectIosChanges\.ts"/,
  );
  assert.equal(
    classifyIosChangedPaths(['ios/example-ios/ViewModels/User/UserDataViewModel.swift'])
      .onboardingRequired,
    true,
  );
});

test('a main promotion requires exact-develop onboarding proof without allocating another Mac', () => {
  const gate = job('ios-change-gate');
  assert.match(gate.outputs.should_run ?? '', /production_promotion == 'true' && 'false'/);
  assert.match(gate.outputs.onboarding_required ?? '', /production_promotion == 'true' && 'true'/);
  assert.match(gate.outputs.promotion_proven ?? '', /promotion-proof\.outputs\.proven/);
  const sourceCheckout = gate.steps.find((step) => step.name === 'Checkout iOS change selector');
  assert.match(String(sourceCheckout?.with.ref ?? ''), /production_promotion == 'true'.*checkpoint_sha/);
  const detector = gate.steps.find((step) => step.name === 'Detect iOS Changes');
  assert.match(detector?.env.TEST_SCOPE ?? '', /production_promotion == 'true' && 'promotion-evidence'/);

  const tupleGuard = job('confirm-current-ios-pr');
  assert.match(String(workflowJob('ios-tests.yml', 'confirm-current-ios-pr')?.if ?? ''),
    /outputs\.should_run == 'true'/);
  for (const id of [
    'verify-ios-release-archive', 'build-ios-native-test-products',
    'test-ios-execution', 'build-ios-e2e-test-products',
    'onboarding-e2e', 'chat-plaid-e2e', 'income-e2e', 'budget-e2e',
  ]) assert.ok(job(id).needs.includes('confirm-current-ios-pr'), `${id} must remain behind the skipped promotion tuple guard`);
  assert.ok(tupleGuard.needs.includes('ios-change-gate'));

  const gateSource = jobSource(readWorkflow('ios-tests.yml'), 'ios-change-gate');
  assert.match(gateSource, /steps\.precheck\.outputs\.production_promotion == 'true'/);
  assert.match(
    gateSource,
    /verifyPromotionEvidence\.ts/,
    'promotion must verify prior exact-develop execution',
  );

  assert.match(jobCondition(readWorkflow('ios-tests.yml'), 'build-ios-e2e-test-products'),
    /outputs\.should_run == 'true'/);
  assert.match(jobCondition(readWorkflow('ios-tests.yml'), 'onboarding-e2e'),
    /outputs\.onboarding_required == 'true'/);

  const verdict = job('test-ios');
  const nativeVerdict = verdict.steps.find((step) => step.name === 'Verify iOS test lanes');
  const onboardingVerdict = verdict.steps.find(
    (step) => step.name === 'Verify onboarding execution result',
  );
  assert.match(nativeVerdict?.if ?? '', /production_promotion != 'true'/);
  assert.match(onboardingVerdict?.if ?? '', /production_promotion != 'true'/);
  for (const id of ['test-ios', 'storekit-purchase-status', 'onboarding-e2e-status']) {
    assert.ok(job(id).steps.some((step) => step.name === 'Verify exact-develop promotion verdict'), id);
  }
});

test('the first main promotion runs the precheck from protected develop and later verdicts from its proved checkpoint', () => {
  const gate = job('ios-change-gate');
  const precheck = gate.steps.find((step) => step.name === 'Checkout trusted iOS gate precheck');
  assert.ok(precheck);
  assert.equal(String(precheck.with.ref ?? ''),
    `\${{ ${ciEventCondition('pullRequestIntoMain')} && 'develop' || ${ciEventFieldSource('trustedBaseSha')} }}`);
  assert.doesNotMatch(String(precheck.with.ref ?? ''), /head\.sha/,
    'the privileged precheck must never execute unproved PR-head code');
  assert.match(gate.outputs.verifier_sha ?? '', /steps\.precheck\.outputs\.verifier_sha/);

  for (const jobName of [
    'confirm-current-ios-pr', 'test-ios', 'storekit-purchase-status',
    'onboarding-e2e-status', 'remove-run-artifacts-after-success',
  ]) {
    const candidateJob = job(jobName);
    assert.ok(candidateJob.needs.includes('ios-change-gate'), `${jobName} must depend on the proof`);
    assert.ok(candidateJob.steps.some((step) => String(step.with?.ref ?? '').includes(
      'needs.ios-change-gate.outputs.verifier_sha')),
    `${jobName} must execute typed verifier code from the proved revision`);
  }
  const schema = job('prepare-dev-e2e-schema');
  assert.ok(schema.steps.some((step) => String(step.with?.ref ?? '').includes(
    'needs.ios-change-gate.outputs.verifier_sha')));
  const schemaGuard = schema.steps.find((step) => step.name === 'Verify trusted schema verifier revision');
  assert.ok(schemaGuard);
  assert.match(schemaGuard.env.TRUSTED_VERIFIER_SHA ?? '', /needs\.ios-change-gate\.outputs\.verifier_sha/);
});

test('Mac revision guards read the proved verifier while checking the actual PR base tuple', () => {
  const guardedSteps = [
    ['build-ios-native-test-products', 'Verify exact native test revision'],
    ['build-ios-e2e-test-products', 'Verify exact E2E revision'],
    ['test-ios-execution', 'Verify exact iOS test revision'],
    ['verify-ios-release-archive', 'Verify exact Release archive revision'],
  ] as const;
  for (const [jobName, stepName] of guardedSteps) {
    const candidateJob = job(jobName);
    const step = candidateJob.steps.find((candidate) => candidate.name === stepName);
    assert.ok(step, `${jobName} must guard the Mac checkout`);
    assert.match(step.env.EXAMPLE_CI_GUARD_SHA ?? '', /needs\.ios-change-gate\.outputs\.verifier_sha/);
    assert.match(step.env.EXAMPLE_CI_TRUSTED_BASE_SHA ?? '', /needs\.ios-change-gate\.outputs\.expected_base_sha/);

    assert.match(String(step.run), /\.ci\/trusted-(?:native-controls|ios-revision-guard)\/ci\/src\/actions\/ios\/verifyExact/);
    const checkoutIndex = candidateJob.steps.findIndex(candidate =>
      candidate.name === 'Checkout trusted native selection controls'
      || candidate.name === 'Checkout typed iOS revision guard');
    const guardIndex = candidateJob.steps.indexOf(step);
    assert.ok(checkoutIndex >= 0 && checkoutIndex < guardIndex, jobName);
    assert.match(String(candidateJob.steps[checkoutIndex]?.with.ref), /needs\.ios-change-gate\.outputs\.verifier_sha/);
  }
  const execution = job('onboarding-e2e');
  const realServer = execution.steps.find((step) => step.name === 'Verify exact iOS test revision');
  assert.ok(realServer);
  assert.match(realServer.env.EXAMPLE_CI_GUARD_SHA ?? '', /needs\.ios-change-gate\.outputs\.verifier_sha/);
  assert.match(realServer.env.EXAMPLE_CI_TRUSTED_BASE_SHA ?? '', /needs\.ios-change-gate\.outputs\.expected_base_sha/);
  assert.equal(realServer.run,
    'node .ci/trusted-ios-revision-guard/ci/src/actions/ios/verifyExactIosRevision.ts');
  const trustedCheckout = execution.steps.find((step) => step.name === 'Checkout typed iOS revision guard');
  assert.ok(trustedCheckout);
  assert.match(String(trustedCheckout.with.ref ?? ''), /needs\.ios-change-gate\.outputs\.verifier_sha/);

  for (const file of [
    'ci/src/actions/ios/verifyExactIosRevision.ts',
    'ci/src/actions/ios/verifyExactReleaseArchiveRevision.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /macRevisionAdmission\(import\.meta\.url\)/);
    assert.doesNotMatch(source, /confirm-current-ios-pr\.sh|runCommand\('bash'/);
  }
});

test('StoreKit status accepts a safe fork skip without exposing the persistent runner', () => {
  const workflow = readWorkflow('ios-tests.yml');
  const storekitStatus = jobSource(workflow, 'storekit-purchase-status');

  assert.match(storekitStatus, /HEAD_REPOSITORY:.*github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(
    storekitStatus,
    /EXECUTION_RESULT:.*needs\.build-ios-native-test-products\.outputs\.storekit_result/
  );
  assert.match(
    storekitStatus,
    /PARENT_EXECUTION_RESULT:.*needs\.build-ios-native-test-products\.result/
  );
  assert.match(storekitStatus, /REPOSITORY:.*github\.repository/);
  // The fork skip is the typed decision's first rule: a pull_request from
  // another repository whose producing job was skipped. Each of the three
  // conditions is load-bearing, so each is dropped in turn.
  const forkSkip = {
    EVENT_NAME: 'pull_request',
    HEAD_REPOSITORY: 'someone-else/example-app',
    REPOSITORY: 'example-org/example-app',
    PARENT_EXECUTION_RESULT: 'skipped',
    CHANGE_GATE_RESULT: 'success',
    STOREKIT_REQUIRED: 'true',
    EXECUTION_RESULT: '',
  };
  const skipped = runStatusProgram(STOREKIT_PURCHASE_STATUS, forkSkip);
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /StoreKit execution is intentionally unavailable for external pull request code\./);

  for (const narrowed of [
    { EVENT_NAME: 'workflow_dispatch' },
    { HEAD_REPOSITORY: 'example-org/example-app' },
    { PARENT_EXECUTION_RESULT: 'failure' },
  ]) {
    const exposed = runStatusProgram(STOREKIT_PURCHASE_STATUS, { ...forkSkip, ...narrowed });
    assert.equal(exposed.status, 1, JSON.stringify(narrowed));
    assert.doesNotMatch(exposed.stdout, /intentionally unavailable/);
  }
});

test('macOS test jobs select Xcode before reclaiming warm simulator templates', () => {
  const workflow = readWorkflow('ios-tests.yml');

  for (const jobName of [
    'verify-ios-release-archive',
    'build-ios-native-test-products',
    'test-ios-execution',
    'onboarding-e2e',
  ]) {
    const job = jobSource(workflow, jobName);
    // Anchored to the invocation rather than the step title: what matters is
    // that the toolchain is chosen before warm-template identities are
    // derived, and a step rename should not be able to silence this.
    const selectXcode = job.indexOf('selectXcode.ts');
    const reclaimDisk = job.indexOf('reclaim-ios-runner-disk.sh preflight');

    assert.ok(selectXcode >= 0, `${jobName} must select Xcode`);
    assert.ok(reclaimDisk >= 0, `${jobName} must reclaim runner disk`);
    assert.ok(
      selectXcode < reclaimDisk,
      `${jobName} must select Xcode before deriving warm-template identities`,
    );
  }
});

test('selected real-server lanes run on every non-focused dispatch, including promotion evidence', () => {
  // Selection (`<lane>_required`) decides whether a lane runs. A dispatch
  // clause narrower than the other lanes' left income required but skipped on
  // promotion-evidence runs, which failed the Onboarding E2E verdict.
  const workflow = load(readFileSync('.github/workflows/ios-tests.yml', 'utf8')) as {
    jobs: Record<string, { if?: string }>;
  };
  const dispatchClause = "(github.event_name == 'workflow_dispatch' "
    + "&& (github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main') "
    + "&& inputs.test_scope != 'mortgage-assignment-evidence' "
    + "&& inputs.test_scope != 'debt-card-evidence')";
  for (const id of ['onboarding-e2e', 'chat-plaid-e2e', 'income-e2e']) {
    const condition = workflow.jobs[id]?.if ?? '';
    assert.ok(condition.includes(dispatchClause), `${id} must admit every non-focused dispatch`);
    assert.doesNotMatch(condition, /inputs\.test_scope == 'e2e'/, id);
  }
});

test('real-server E2E lanes run the trusted typed guard after Node and before Xcode', () => {
  for (const jobName of ['onboarding-e2e', 'chat-plaid-e2e', 'income-e2e', 'budget-e2e']) {
    const steps = job(jobName).steps;
    const position = (name: string): number => steps.findIndex(step => step.name === name);
    const guard = position('Verify exact iOS test revision');
    const checkout = position('Checkout typed iOS revision guard');
    const node = position('Set up the Node.js runtime');
    const selector = position('Select exact Xcode');
    const reclaim = position('Reclaim stale iOS runner artifacts');
    assert.ok(checkout >= 0 && checkout < node && node < guard
      && guard < selector && selector < reclaim, jobName);
  }
});


test('iOS workflow waits for the prior PR run while dispatches and Mac lanes stay isolated', () => {
  const workflow = readWorkflow('ios-tests.yml');
  const concurrencySource = /^concurrency:\n(?: {2}.*\n)+/m.exec(workflow)?.[0];
  assert.ok(concurrencySource);
  const document = z.object({
    concurrency: z.object({
      group: z.string(),
      'cancel-in-progress': z.boolean(),
    }).passthrough(),
  }).parse(load(concurrencySource));
  assert.equal(document.concurrency.group, `ios-run-\${{ ${ciEventConcurrencyKey.expression} }}`);
  assert.equal(document.concurrency['cancel-in-progress'], false);
  assert.equal(document.concurrency['queue'], 'max');

  // The required context remains waiting on its normal dependencies. Neither
  // the deferred marker nor the verdict may turn a pending predecessor green.
  assert.ok(job('test-ios').needs.includes('await-retained-ios-predecessor'));
  assert.match(jobCondition(workflow, 'test-ios'), /always\(\) && !cancelled\(\)/);
  assert.equal(job('test-ios')['continue-on-error'], undefined);
  assert.match(jobCondition(workflow, 'await-retained-ios-predecessor'),
    /base_update_deferred == 'true'/);

  const allGroups = [...workflow.matchAll(/^\s+group: (ios-.*)$/gm)]
    .flatMap(match => match[1] === undefined ? [] : [match[1]]);
  const runGroup = allGroups.find(group => group.startsWith('ios-run-'));
  assert.ok(runGroup);
  assert.doesNotMatch(runGroup, /metadata-|event\.action == 'edited'/);
  assert.match(runGroup, /pull_request\.number.*github\.run_id/);
  assert.doesNotMatch(runGroup, /pull_request\.head\.sha|pull_request\.base\.sha/);
  const groups = allGroups.filter(group => !group.startsWith('ios-run-'));
  assert.equal(groups.length, 8);
  for (const group of groups) {
    // pull_request events share one key per PR and lane (the close event cancels
    // by it); a dispatch or push run keys by run id so it can never take the
    // single pending slot away from the PR's required lane; a queue candidate
    // keys by its own queue ref.
    assert.ok(group.startsWith(`ios-\${{ ${ciEventConcurrencyKey.expression} }}-`), group);
    assert.doesNotMatch(group, /inputs\.pull_request_number|pull_request\.head\.sha|pull_request\.base\.sha/);
  }
  assert.equal((workflow.match(/^\s+cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' && github\.event\.action == 'synchronize' \}\}$/gm) ?? []).length, 8);
});

test('iOS precheck rejects exact-head evidence from an obsolete base SHA', () => {
  const workflow = readWorkflow('ios-tests.yml');
  const precheck = jobSource(workflow, 'ios-change-gate');
  const precheckStep = job('ios-change-gate').steps.find((step) => step.name === 'Precheck iOS Gate');
  assert.equal(precheckStep?.env.BASE_SHA,
    `\${{ ${ciEventFieldWith('trustedBaseSha', { workflow_dispatch: "''" }).expression} }}`);
  assert.doesNotMatch(precheck, /continuing this exact-head develop event/);
  // The revalidation is the typed precheck's now: the live pull request must
  // still carry the exact base SHA this event was raised against, so a base
  // that moved underneath the run cannot keep the run's evidence.
  const event = {
    baseBranch: 'develop',
    baseSha: 'b'.repeat(40),
    headBranch: 'feature/x',
    headSha: 'c'.repeat(40),
    headRepository: 'example-org/example-app',
  };
  const live = {
    state: 'open',
    base: { ref: event.baseBranch, sha: event.baseSha },
    head: { ref: event.headBranch, sha: event.headSha, repo: { full_name: event.headRepository } },
  };
  assert.equal(pullRequestStillMatchesEvent(live, event), true);
  assert.equal(
    pullRequestStillMatchesEvent(
      { ...live, base: { ref: event.baseBranch, sha: 'd'.repeat(40) } },
      event
    ),
    false
  );
});

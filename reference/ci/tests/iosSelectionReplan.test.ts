import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  IOS_CI_PLANNING_ROLES,
  iosBaseLineageReusePlan,
  iosExecutionScopeChanged,
} from '../src/ios/iosExecutionInputs.ts';
import {
  NATIVE_SELECTION_RECORD_FILE,
  nativeSelectionRecordSchema,
  readNativeSelectionRecord,
  replanDecision,
  selectionCoverage,
  type NativeSelectionRecord,
  type RecordedSelection,
} from '../src/ios/nativeSelectionRecord.ts';
import { removableArtifacts } from '../src/ios/runArtifactCleanup.ts';
import { controllerBaseUpdateDelta, lineageChangeMessage } from '../src/ios/controllers/baseUpdateDelta.ts';

const sha = (character: string): string => character.repeat(40);

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = `${directory}/${entry}`;
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('every planning role names an existing file; everything else in the iOS CI trees invalidates', () => {
  for (const path of Object.keys(IOS_CI_PLANNING_ROLES)) {
    assert.ok(existsSync(path), `${path} is classified but does not exist`);
  }
  for (const path of [...filesUnder('ci/src/ios'), ...filesUnder('ci/src/actions/ios')]) {
    const plan = iosBaseLineageReusePlan([{ filename: path }]);
    assert.ok(plan, path);
    const classified = path in IOS_CI_PLANNING_ROLES;
    assert.deepEqual(plan.replanPaths, classified ? [path] : [], path);
    assert.deepEqual(plan.invalidatingPaths, classified ? [] : [path], path);
  }
});

test('selector changes re-plan while execution and unknown files keep invalidating', () => {
  const plan = iosBaseLineageReusePlan([
    { filename: 'scripts/select-ios-affected-tests.ts' },
    { filename: 'ci/src/ios/iosChangeClassification.ts' },
  ]);
  assert.deepEqual(plan?.invalidatingPaths, []);
  assert.deepEqual(plan?.replanPaths, [
    'scripts/select-ios-affected-tests.ts', 'ci/src/ios/iosChangeClassification.ts',
  ]);
  assert.deepEqual(iosBaseLineageReusePlan([{ filename: 'ci/src/runnerPolicy.ts' }]), {
    invalidatingPaths: [],
    replanPaths: ['ci/src/runnerPolicy.ts'],
    changedFiles: [],
    rerunAuxiliary: [],
  });
  for (const path of [
    'ci/src/ios/fullUiShards.ts', 'ci/src/actions/ios/verifyExactIosRevision.ts',
    'ci/src/ios/brandNewProgram.ts', 'scripts/ios-test.ts',
    // Verdicts define what a passing Test - iOS means; evidence-reuse policy defines what evidence counts.
    'ci/src/ios/nativeTestLaneStatus.ts', 'ci/src/ios/realServerE2eStatus.ts',
    'ci/src/actions/ios/verifyNativeTestLanes.ts', 'ci/src/actions/ios/verifyRealServerE2eStatus.ts',
    'ci/src/ios/promotionVerdict.ts',
    'ci/src/ios/nativeSelectionRecord.ts', 'ci/src/ios/iosGatePrecheck.ts',
  ]) {
    assert.deepEqual(iosBaseLineageReusePlan([{ filename: path }])?.invalidatingPaths, [path], path);
  }
  for (const path of [
    'ci/src/ios/controllers/baseUpdateDelta.ts', 'ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts',
  ]) {
    assert.deepEqual(iosBaseLineageReusePlan([{ filename: path }]), {
      invalidatingPaths: [], replanPaths: [path], changedFiles: [], rerunAuxiliary: [],
    });
    assert.equal(iosExecutionScopeChanged([{ filename: path }]), true, 'coverage must be re-planned');
  }
  // Consumers other than the classifier cannot re-plan, so they still see a scope change.
  assert.equal(iosExecutionScopeChanged([{ filename: 'scripts/select-ios-affected-tests.ts' }]), true);
});

test('UI shard metadata re-plans retained evidence after a base update', () => {
  for (const path of [
    'ios/ci/ui-test-duration-weights.json',
    'ios/ci/ui-test-primary-exclusions.txt',
  ]) {
    assert.deepEqual(iosBaseLineageReusePlan([{ filename: path }]), {
      invalidatingPaths: [],
      replanPaths: [path],
      changedFiles: [],
      rerunAuxiliary: [],
    });
    assert.equal(iosExecutionScopeChanged([{ filename: path }]), true);
  }
});

test('the classifier log names a selection-only change instead of discarding evidence', () => {
  assert.equal(
    lineageChangeMessage(iosBaseLineageReusePlan([{ filename: 'scripts/select-ios-affected-tests.ts' }])),
    'Target branch changed iOS selection or controller code (scripts/select-ios-affected-tests.ts); '
    + 'the selection is re-planned against the prior run\'s recorded selection.',
  );
  assert.match(
    lineageChangeMessage(iosBaseLineageReusePlan([{ filename: 'ios/example-ios/App.swift' }])),
    /^Target branch changed iOS execution inputs \(ios\/example-ios\/App\.swift\); prior iOS evidence cannot be reused\.$/,
  );
});

const noLanes = {
  storekit: false, main: false, onboarding: false, chatPlaid: false,
  budget: false, income: false, evidence: false,
};

function selection(overrides: Partial<NonNullable<RecordedSelection['native']>> = {}, lanes = {}): RecordedSelection {
  return {
    lanes: { ...noLanes, main: true, ...lanes },
    native: {
      mode: 'affected',
      shouldRun: true,
      releaseArchiveRequired: false,
      narrowPaywallRequired: false,
      evidenceGroups: [],
      onlyTesting: ['example-iosTests/BudgetTests', 'example-iosUITests/DebtUITests/testPayoff'],
      evidenceTesting: ['example-iosUITests/VisualEvidenceUITests/testBudgetCard'],
      wellnessRequired: false,
      wellnessTesting: [],
      producerMode: 'shared-products',
      executionLanes: ['native1', 'native2'],
      fullExecutionLanes: [],
      executionRequired: true,
      uiRequired: true,
      handoffRequired: true,
      ...overrides,
    },
  };
}

test('coverage accepts a subset and names the first uncovered lane, flag, or test', () => {
  const prior = selection();
  assert.deepEqual(selectionCoverage(prior, selection({
    onlyTesting: ['example-iosTests/BudgetTests/testRollover'], executionLanes: ['native1'],
  })), { covered: true });
  assert.deepEqual(selectionCoverage(prior, selection({
    onlyTesting: ['example-iosTests/IncomeTests'],
  })), { covered: false, uncovered: 'native.test:example-iosTests/IncomeTests' });
  assert.deepEqual(selectionCoverage(prior, selection({ executionLanes: ['native3'] })), {
    covered: false, uncovered: 'native.lane:native3',
  });
  assert.deepEqual(selectionCoverage(prior, selection({}, { onboarding: true })), {
    covered: false, uncovered: 'lane.onboarding',
  });
  assert.deepEqual(selectionCoverage(prior, selection({ mode: 'full' })), {
    covered: false, uncovered: 'native.mode:full',
  });
  assert.deepEqual(selectionCoverage(prior, selection({ releaseArchiveRequired: true })), {
    covered: false, uncovered: 'native.releaseArchiveRequired',
  });
  assert.deepEqual(selectionCoverage(selection({ mode: 'full' }), selection({
    onlyTesting: ['example-iosTests/IncomeTests'],
  })), { covered: true });
  assert.deepEqual(selectionCoverage({ lanes: noLanes, native: null }, selection()), {
    covered: false, uncovered: 'lane.main',
  });
  assert.deepEqual(selectionCoverage({ lanes: { ...noLanes, main: true }, native: null }, selection()), {
    covered: false, uncovered: 'native:not-recorded',
  });
});

const priorRun = { runId: 4100, runAttempt: 2, headSha: sha('a') };

function record(overrides: Partial<NativeSelectionRecord> = {}): NativeSelectionRecord {
  return {
    schema: 'example.ios-native-selection-record.v1',
    run: { id: priorRun.runId, attempt: priorRun.runAttempt, headSha: priorRun.headSha, verifierSha: sha('b') },
    selectorInputFingerprint: 'c'.repeat(64),
    evidence: { kind: 'executed' },
    selection: selection(),
    ...overrides,
  };
}

test('a lane that newly requires full execution is not covered', () => {
  assert.deepEqual(selectionCoverage(selection(), selection({ fullExecutionLanes: ['native2'] })), {
    covered: false, uncovered: 'native.fullLane:native2',
  });
  assert.deepEqual(selectionCoverage(selection({ fullExecutionLanes: ['native2'] }),
    selection({ fullExecutionLanes: ['native2'] })), { covered: true });
  assert.deepEqual(selectionCoverage(selection({ executionRequired: false }), selection()), {
    covered: false, uncovered: 'native.executionRequired',
  });
});

test('a same-group evidence test or a newly required Wellness contract is not covered', () => {
  const prior = selection();
  assert.deepEqual(selectionCoverage(prior, selection({
    evidenceTesting: [
      'example-iosUITests/VisualEvidenceUITests/testBudgetCard',
      'example-iosUITests/VisualEvidenceUITests/testDebtCard',
    ],
  })), {
    covered: false, uncovered: 'native.evidenceTest:example-iosUITests/VisualEvidenceUITests/testDebtCard',
  });
  assert.deepEqual(selectionCoverage(prior, selection({
    wellnessRequired: true, wellnessTesting: ['example-iosTests/WellnessContractTests'],
  })), { covered: false, uncovered: 'native.wellnessRequired' });
  const wellnessPrior = selection({
    wellnessRequired: true, wellnessTesting: ['example-iosTests/WellnessContractTests/testScore'],
  });
  assert.deepEqual(selectionCoverage({ ...wellnessPrior, native: { ...wellnessPrior.native!, mode: 'full' } },
    selection({
      wellnessRequired: true,
      wellnessTesting: ['example-iosTests/WellnessContractTests/testScore', 'example-iosTests/WellnessContractTests/testTrend'],
    })), {
    covered: false, uncovered: 'native.wellnessTest:example-iosTests/WellnessContractTests/testTrend',
  });
  assert.deepEqual(selectionCoverage(wellnessPrior, selection({
    wellnessRequired: true, wellnessTesting: ['example-iosTests/WellnessContractTests/testScore'],
  })), { covered: true });
});

test('a record counts only when it parses and names the retained run exactly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ios-selection-record-'));
  try {
    const path = join(directory, NATIVE_SELECTION_RECORD_FILE);
    assert.deepEqual(readNativeSelectionRecord(path, priorRun), { kind: 'missing', detail: 'no-artifact' });
    writeFileSync(path, '{');
    assert.deepEqual(readNativeSelectionRecord(path, priorRun), { kind: 'missing', detail: 'unparseable' });
    writeFileSync(path, JSON.stringify({ ...record(), schema: 'example.ios-native-selection-record.v0' }));
    assert.deepEqual(readNativeSelectionRecord(path, priorRun), { kind: 'missing', detail: 'schema-invalid' });
    writeFileSync(path, JSON.stringify(record({
      run: { id: priorRun.runId, attempt: 1, headSha: priorRun.headSha, verifierSha: sha('b') },
    })));
    assert.deepEqual(readNativeSelectionRecord(path, priorRun), { kind: 'missing', detail: 'run-mismatch' });
    writeFileSync(path, JSON.stringify(record()));
    assert.deepEqual(readNativeSelectionRecord(path, priorRun), { kind: 'record', record: record() });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const recordedJobs = ['native-products', 'native:native1', 'native:native2'];
const sameAttempt = {
  runId: priorRun.runId, recordAttempt: priorRun.runAttempt, successAttempt: priorRun.runAttempt,
  successfulJobs: recordedJobs,
};

test('the re-plan decision states a machine-readable reason', () => {
  assert.deepEqual(replanDecision({ kind: 'missing', detail: 'no-artifact' }, selection(), sameAttempt), {
    reason: 'replan-no-record',
    covered: false,
    log: 'iOS selection replan: reason=replan-no-record prior_run=4100 record_attempt=2 success_attempt=2 '
      + 'detail=no-artifact',
  });
  assert.deepEqual(replanDecision({ kind: 'record', record: record() }, selection({
    onlyTesting: ['example-iosTests/BudgetTests'],
  }), sameAttempt), {
    reason: 'replan-covered',
    covered: true,
    log: 'iOS selection replan: reason=replan-covered prior_run=4100 record_attempt=2 success_attempt=2 '
      + 'tests=1 prior_tests=2',
  });
  assert.equal(replanDecision({ kind: 'record', record: record() }, selection({
    onlyTesting: ['example-iosTests/IncomeTests'],
  }), sameAttempt).log, 'iOS selection replan: reason=replan-expanded prior_run=4100 record_attempt=2 '
    + 'success_attempt=2 tests=1 prior_tests=2 uncovered=native.test:example-iosTests/IncomeTests');
});

test('a record from a carried-forward gate counts only when its lanes succeeded in the green attempt', () => {
  const carried = { ...sameAttempt, recordAttempt: 1, successAttempt: 2 };
  const recordedInAttempt1 = record({
    run: { id: priorRun.runId, attempt: 1, headSha: priorRun.headSha, verifierSha: sha('b') },
  });
  assert.deepEqual(replanDecision({ kind: 'record', record: recordedInAttempt1 }, selection(), carried), {
    reason: 'replan-covered',
    covered: true,
    log: 'iOS selection replan: reason=replan-covered prior_run=4100 record_attempt=1 success_attempt=2 '
      + 'tests=2 prior_tests=2',
  });
  assert.equal(replanDecision({ kind: 'record', record: recordedInAttempt1 }, selection(), {
    ...carried, successfulJobs: ['native-products', 'native:native1'],
  }).log, 'iOS selection replan: reason=replan-no-record prior_run=4100 record_attempt=1 success_attempt=2 '
    + 'detail=required-job-not-successful:native:native2');
  assert.equal(replanDecision({ kind: 'missing', detail: 'gate-job-missing' }, selection(), {
    ...carried, recordAttempt: null,
  }).log, 'iOS selection replan: reason=replan-no-record prior_run=4100 record_attempt=unproven '
    + 'success_attempt=2 detail=gate-job-missing');
});

const selectionEnvironment = (onlyTestingFile: string, evidenceFile = ''): NodeJS.ProcessEnv => ({
  SELECTION_STOREKIT_REQUIRED: 'false',
  SELECTION_MAIN_REQUIRED: 'true',
  SELECTION_ONBOARDING_REQUIRED: 'false',
  SELECTION_CHAT_PLAID_REQUIRED: 'false',
  SELECTION_BUDGET_REQUIRED: 'false',
  SELECTION_INCOME_REQUIRED: 'false',
  SELECTION_EVIDENCE_REQUIRED: 'false',
  NATIVE_PLANNED: 'true',
  NATIVE_MODE: 'affected',
  NATIVE_SHOULD_RUN: 'true',
  NATIVE_RELEASE_ARCHIVE_REQUIRED: 'false',
  NATIVE_NARROW_PAYWALL_REQUIRED: 'false',
  NATIVE_EVIDENCE_GROUPS: '',
  NATIVE_ONLY_TESTING_FILE: onlyTestingFile,
  NATIVE_EVIDENCE_ONLY_TESTING_FILE: evidenceFile,
  NATIVE_WELLNESS_REQUIRED: 'false',
  NATIVE_WELLNESS_ONLY_TESTING_FILE: '',
  NATIVE_PRODUCER_MODE: 'shared-products',
  NATIVE_EXECUTION_LANES: '["native1"]',
  NATIVE_FULL_EXECUTION_LANES: '[]',
  NATIVE_EXECUTION_REQUIRED: 'true',
  NATIVE_UI_REQUIRED: 'true',
  NATIVE_HANDOFF_REQUIRED: 'true',
});

function outputs(path: string): Map<string, string> {
  return new Map(readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

test('the recorded selection of one gate covers the same selection re-planned by the next', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ios-selection-replan-'));
  try {
    const onlyTesting = join(directory, 'only-testing.txt');
    writeFileSync(onlyTesting, 'example-iosTests/BudgetTests\n');
    const evidence = join(directory, 'evidence.txt');
    writeFileSync(evidence, 'example-iosUITests/VisualEvidenceUITests/testBudgetCard\n');
    const recordDirectory = join(directory, 'record');
    const write = spawnSync(process.execPath, ['ci/src/actions/ios/writeNativeSelectionRecord.ts'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...selectionEnvironment(onlyTesting, evidence),
        RUN_ID: String(priorRun.runId),
        RUN_ATTEMPT: String(priorRun.runAttempt),
        HEAD_SHA: priorRun.headSha,
        VERIFIER_SHA: sha('b'),
        GITHUB_WORKFLOW_SHA: sha('c'),
        NATIVE_CHANGED_FILES: 'ios/example-ios/Budget.swift',
        REPLAN_COVERED: 'false',
        REPLAN_EVIDENCE_RUN_ID: '',
        REPLAN_EVIDENCE_RUN_ATTEMPT: '',
        OUTPUT_DIRECTORY: recordDirectory,
      },
    });
    assert.equal(write.status, 0, write.stderr);
    const written = nativeSelectionRecordSchema.parse(JSON.parse(readFileSync(
      join(recordDirectory, NATIVE_SELECTION_RECORD_FILE), 'utf8',
    )));
    assert.equal(written.run.workflowSha, sha('c'));

    const check = (testsFile: string, evidenceFile = evidence) => {
      const output = join(directory, `output-${Math.random()}`);
      writeFileSync(output, '');
      const result = spawnSync(process.execPath, ['ci/src/actions/ios/checkReplannedSelection.ts'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...selectionEnvironment(testsFile, evidenceFile),
          GITHUB_OUTPUT: output,
          RECORD_DIRECTORY: recordDirectory,
          EXPECTED_RUN_ID: String(priorRun.runId),
          RECORD_ATTEMPT: String(priorRun.runAttempt),
          RECORD_DETAIL: 'gate-ran-in-success-attempt',
          SUCCESS_ATTEMPT: String(priorRun.runAttempt),
          SUCCESSFUL_JOBS: JSON.stringify(['native-products', 'native:native1']),
          EXPECTED_HEAD_SHA: priorRun.headSha,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return { values: outputs(output), stdout: result.stdout };
    };

    const covered = check(onlyTesting);
    assert.equal(covered.values.get('covered'), 'true');
    assert.equal(covered.values.get('reason'), 'replan-covered');
    assert.equal(covered.values.get('native_should_run'), 'false');
    assert.equal(covered.values.get('should_run'), 'false');
    assert.match(covered.stdout, /reason=replan-covered prior_run=4100 record_attempt=2 success_attempt=2/);

    const widened = join(directory, 'widened.txt');
    writeFileSync(widened, 'example-iosTests/BudgetTests\nexample-iosTests/IncomeTests\n');
    const expanded = check(widened);
    assert.equal(expanded.values.get('covered'), 'false');
    assert.equal(expanded.values.get('reason'), 'replan-expanded');
    assert.equal(expanded.values.has('native_should_run'), false, 'an expanded plan keeps the gate outputs');

    const widenedEvidence = join(directory, 'widened-evidence.txt');
    writeFileSync(widenedEvidence,
      'example-iosUITests/VisualEvidenceUITests/testBudgetCard\nexample-iosUITests/VisualEvidenceUITests/testDebtCard\n');
    const evidenceExpanded = check(onlyTesting, widenedEvidence);
    assert.equal(evidenceExpanded.values.get('reason'), 'replan-expanded');
    assert.match(evidenceExpanded.stdout,
      /uncovered=native\.evidenceTest:example-iosUITests\/VisualEvidenceUITests\/testDebtCard/);

    rmSync(recordDirectory, { recursive: true, force: true });
    mkdirSync(recordDirectory);
    const missing = check(onlyTesting);
    assert.equal(missing.values.get('reason'), 'replan-no-record');
    assert.equal(missing.values.has('should_run'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('run artifact cleanup keeps the selection record', () => {
  assert.deepEqual(removableArtifacts({
    artifacts: [
      { id: 1, name: 'ios-native-selection-record-1', size_in_bytes: 10, expired: false },
      { id: 2, name: 'native-test-products', size_in_bytes: 20, expired: false },
    ],
  }), [{ id: 2, name: 'native-test-products', sizeInBytes: 20 }]);
});

const replacement = (filename: string) => ({
  filename, status: 'modified', sha: sha('e'), additions: 1, deletions: 1, changes: 2,
  patch: '@@ -1 +1 @@\n-old\n+new',
});

function classify(lineageFiles: readonly string[], workflow = 'Test - iOS') {
  const previousHead = sha('a');
  const base = sha('b');
  const head = sha('c');
  const oldBase = sha('d');
  const repository = { full_name: 'example-org/example-app' };
  const patch = [replacement('ios/example-ios/Budget.swift')];
  const job = (id: number, name: string) => ({
    id, name, status: 'completed', conclusion: 'success',
    run_id: priorRun.runId, run_attempt: priorRun.runAttempt, head_sha: previousHead,
  });
  return controllerBaseUpdateDelta({
    pullRequest: {
      number: 42,
      head: { sha: head, repo: repository },
      base: { ref: 'develop', sha: base, repo: repository },
    },
    commit: {
      sha: head,
      parents: [{ sha: previousHead }, { sha: base }],
      commit: { message: 'chore: update PR #42 from develop' },
    },
    comparison: {
      status: 'ahead', merge_base_commit: { sha: previousHead },
      files: lineageFiles.map(replacement),
    },
    priorBaseComparison: { status: 'ahead', merge_base_commit: { sha: base } },
    effectiveComparison: { status: 'ahead', merge_base_commit: { sha: base }, files: patch },
    priorEffectiveComparison: { status: 'ahead', merge_base_commit: { sha: oldBase }, files: patch },
    baseLineageComparison: {
      status: 'ahead', merge_base_commit: { sha: oldBase }, files: lineageFiles.map(replacement),
    },
    runs: [{
      name: workflow, id: priorRun.runId, run_attempt: priorRun.runAttempt, head_sha: previousHead,
      status: 'completed', conclusion: 'success', created_at: '2026-09-25T01:00:00Z',
      pull_requests: [{ number: 42, base: { ref: 'develop' } }],
    }],
    jobsByRunId: {
      [priorRun.runId]: [
        job(1, 'Build shared native iOS test products'),
        job(2, 'StoreKit Purchase - iOS'),
        job(3, 'Test - iOS execution (native1)'),
        job(4, 'Validate pull request changes'),
      ],
    },
    timeline: [],
    workflows: [workflow],
    previousHead,
  });
}

test('the classifier re-plans a selector-only base update against the retained run', () => {
  assert.deepEqual(classify(['scripts/select-ios-affected-tests.ts']), {
    priorHead: sha('a'),
    changedFiles: ['ios/example-ios/Budget.swift'],
    replanSelection: { runId: priorRun.runId, runAttempt: priorRun.runAttempt, headSha: sha('a') },
  });
  assert.equal(classify(['scripts/select-ios-affected-tests.ts', 'ci/src/ios/fullUiShards.ts']), null);
  // A server path also reruns a real-server lane; that combination keeps full routing.
  assert.equal(classify(['scripts/select-ios-affected-tests.ts', 'pages/api/health.ts']), null);
});

test('PR Checks keeps its own reuse when the base changes only selector code', () => {
  const result = classify(['scripts/select-ios-affected-tests.ts'], 'PR Checks');
  assert.notEqual(result, null);
  assert.equal(result?.replanSelection, undefined);
});

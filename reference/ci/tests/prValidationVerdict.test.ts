import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  prValidationLaneReasons,
  prValidationVerdict,
  type PrValidationVerdictInput,
  type ValidationLane,
} from '../src/prValidationVerdict.ts';
import { parsePrChecksLaneEvidenceLog } from '../src/queueLaneEvidence.ts';

const passing: PrValidationVerdictInput = {
  results: {
    'plan-pr-validation': 'success',
    lint: 'success',
    'validation-policy': 'skipped',
    'workflow-contracts': 'skipped',
    'server-static': 'skipped',
    'server-process-tests': 'skipped',
    'server-tests': 'skipped',
    'targeted-server-tests': 'skipped',
    'ios-contracts': 'skipped',
    'database-integration': 'skipped',
  },
  docsOnly: 'false',
  lintPlan: { mode: 'selected', paths: ['server/example.ts'] },
  metadataOnly: 'false',
  policyRequired: 'false',
  workflowContractsRequired: 'false',
  serverStaticRequired: 'false',
  serverTestMode: 'none',
  processHeavyRequired: 'false',
  iosContractsRequired: 'false',
  databaseRequired: 'false',
};

function withResult(lane: ValidationLane, result: string): PrValidationVerdictInput {
  return { ...passing, results: { ...passing.results, [lane]: result } };
}

test('the selected lane verdict preserves the aggregate contract', async (context) => {
  const cases: readonly {
    readonly name: string;
    readonly input: PrValidationVerdictInput;
    readonly errors: readonly string[];
  }[] = [
    { name: 'selected lanes pass and unselected lanes skip', input: passing, errors: [] },
    {
      name: 'the validation planner must succeed', input: withResult('plan-pr-validation', 'skipped'),
      errors: ['Selected validation lane plan-pr-validation ended with: skipped'],
    },
    {
      name: 'ordinary changes require lint', input: withResult('lint', 'skipped'),
      errors: ['Selected validation lane lint ended with: skipped'],
    },
    {
      name: 'non-lintable changes skip lint without consuming a runner',
      input: { ...withResult('lint', 'skipped'), lintPlan: { mode: 'none', paths: [] } },
      errors: [],
    },
    {
      name: 'documentation changes may skip lint',
      input: { ...withResult('lint', 'skipped'), docsOnly: 'true' }, errors: [],
    },
    {
      name: 'metadata only changes may skip lint',
      input: { ...withResult('lint', 'skipped'), metadataOnly: 'true' }, errors: [],
    },
    ...([
      ['policyRequired', 'validation-policy'],
      ['workflowContractsRequired', 'workflow-contracts'],
      ['serverStaticRequired', 'server-static'],
      ['iosContractsRequired', 'ios-contracts'],
      ['databaseRequired', 'database-integration'],
    ] as const).map(([flag, lane]) => ({
      name: `${lane} is required when selected`,
      input: { ...passing, [flag]: 'true' },
      errors: [`Selected validation lane ${lane} ended with: skipped`],
    })),
    {
      name: 'full mode requires both server lanes',
      input: { ...passing, serverTestMode: 'full', processHeavyRequired: 'true' },
      errors: [
        'Selected validation lane server-process-tests ended with: skipped',
        'Selected validation lane server-tests ended with: skipped',
      ],
    },
    {
      name: 'targeted process-heavy selection requires its isolated lane',
      input: { ...passing, processHeavyRequired: 'true' },
      errors: ['Selected validation lane server-process-tests ended with: skipped'],
    },
    {
      name: 'targeted mode requires its own lane',
      input: { ...passing, serverTestMode: 'targeted' },
      errors: ['Selected validation lane targeted-server-tests ended with: skipped'],
    },
    {
      name: 'unknown mode fails closed',
      input: { ...passing, serverTestMode: 'unexpected' },
      errors: ['Unknown server test mode: unexpected'],
    },
    {
      name: 'failure in an unselected lane still fails the aggregate',
      input: withResult('validation-policy', 'failure'),
      errors: ['Validation lane validation-policy ended with: failure'],
    },
    {
      name: 'cancelled lane still fails the aggregate',
      input: withResult('database-integration', 'cancelled'),
      errors: ['Validation lane database-integration ended with: cancelled'],
    },
  ];

  for (const entry of cases) {
    await context.test(entry.name, () => {
      assert.deepEqual(prValidationVerdict(entry.input), entry.errors);
    });
  }
});

test('the workflow action fails when a selected lane is skipped', () => {
  const env = {
    ...process.env,
    PR_VALIDATION_PLAN: 'success',
    LINT: 'success',
    LINT_PLAN: JSON.stringify(passing.lintPlan),
    POLICY: 'skipped',
    WORKFLOW_CONTRACTS: 'skipped',
    SERVER_STATIC: 'skipped',
    SERVER_PROCESS_TESTS: 'skipped',
    SERVER_TESTS: 'skipped',
    TARGETED_SERVER_TESTS: 'skipped',
    IOS_CONTRACTS: 'skipped',
    DATABASE: 'skipped',
    DOCS_ONLY: 'false',
    METADATA_ONLY: 'false',
    POLICY_REQUIRED: 'true',
    WORKFLOW_CONTRACTS_REQUIRED: 'false',
    SERVER_STATIC_REQUIRED: 'false',
    SERVER_TEST_MODE: 'none',
    PROCESS_HEAVY_REQUIRED: 'false',
    IOS_CONTRACTS_REQUIRED: 'false',
    DATABASE_REQUIRED: 'false',
  };
  const result = spawnSync(process.execPath, ['ci/src/actions/requireSelectedValidationLanes.ts'], {
    cwd: process.cwd(), env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Selected validation lane validation-policy ended with: skipped/);
});

test('the workflow action accepts a skipped lint job only when the typed plan selects none', () => {
  const env = {
    ...process.env,
    PR_VALIDATION_PLAN: 'success',
    LINT: 'skipped',
    LINT_PLAN: JSON.stringify({ mode: 'none', paths: [] }),
    POLICY: 'skipped',
    WORKFLOW_CONTRACTS: 'skipped',
    SERVER_STATIC: 'skipped',
    SERVER_PROCESS_TESTS: 'skipped',
    SERVER_TESTS: 'skipped',
    TARGETED_SERVER_TESTS: 'skipped',
    IOS_CONTRACTS: 'skipped',
    DATABASE: 'skipped',
    DOCS_ONLY: 'false',
    METADATA_ONLY: 'false',
    POLICY_REQUIRED: 'false',
    WORKFLOW_CONTRACTS_REQUIRED: 'false',
    SERVER_STATIC_REQUIRED: 'false',
    SERVER_TEST_MODE: 'none',
    PROCESS_HEAVY_REQUIRED: 'false',
    IOS_CONTRACTS_REQUIRED: 'false',
    DATABASE_REQUIRED: 'false',
  };
  const result = spawnSync(process.execPath, ['ci/src/actions/requireSelectedValidationLanes.ts'], {
    cwd: process.cwd(), env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

const reusedEvidence = {
  sourceRunId: 500, sourceRunAttempt: 1, sourceHeadSha: 'd'.repeat(40), testedMergeSha: 'f'.repeat(40), inputDigest: '1'.repeat(64),
};

test('a merge queue candidate accepts a skipped lane only when the plan job reused it', async (context) => {
  const cases: readonly { readonly name: string; readonly input: PrValidationVerdictInput; readonly errors: readonly string[] }[] = [
    {
      name: 'a reused selected lane may be skipped',
      input: { ...passing, serverTestMode: 'full', processHeavyRequired: 'true', reused: { 'server-tests': reusedEvidence, 'server-process-tests': reusedEvidence } },
      errors: [],
    },
    {
      name: 'a reused lane that ran anyway must have passed',
      input: { ...withResult('server-tests', 'failure'), serverTestMode: 'full', processHeavyRequired: 'true', reused: { 'server-tests': reusedEvidence } },
      errors: ['Validation lane server-tests ended with: failure', 'Selected validation lane server-process-tests ended with: skipped', 'Selected validation lane server-tests ended with: failure'],
    },
    {
      name: 'reuse never covers a lane the plan did not select',
      input: { ...passing, reused: { 'database-integration': reusedEvidence } },
      errors: ['Reused lane database-integration is not selected: database_required=false'],
    },
    {
      name: 'lint and the policy lane can never be reused',
      input: { ...withResult('lint', 'skipped'), policyRequired: 'true', reused: { lint: reusedEvidence, 'validation-policy': reusedEvidence } },
      errors: ['Lane lint can never be reused', 'Lane validation-policy can never be reused', 'Selected validation lane lint ended with: skipped', 'Selected validation lane validation-policy ended with: skipped'],
    },
  ];
  for (const entry of cases) {
    await context.test(entry.name, () => {
      assert.deepEqual(prValidationVerdict(entry.input), entry.errors);
    });
  }
});

test('lane reasons say reused, with the source run, only for a skipped lane the plan job reused', () => {
  const lines = prValidationLaneReasons({
    ...passing, serverTestMode: 'full', processHeavyRequired: 'true',
    results: { ...passing.results, 'server-process-tests': 'success' },
    reused: { 'server-tests': reusedEvidence, 'server-process-tests': reusedEvidence },
  });
  assert.ok(lines.includes(`server-tests: reused from run 500 attempt 1 head ${'d'.repeat(40)}, input digest ${'1'.repeat(64)} (not executed on this candidate; tested merge ${'f'.repeat(40)})`));
  assert.ok(lines.includes('server-process-tests: executed (success)'));
  assert.ok(lines.includes('targeted-server-tests: not selected: server_test_mode=full'));
});

const markerEnvironment = {
  EVENT_NAME: 'pull_request', REPOSITORY: 'example-org/example-app', PR_NUMBER: '6151', PR_HEAD_SHA: 'd'.repeat(40),
  PR_BASE_SHA: 'e'.repeat(40), TESTED_MERGE_SHA: 'f'.repeat(40), WORKFLOW_SHA: '1'.repeat(40), RUN_ID: '500', RUN_ATTEMPT: '1',
  TARGETED_SERVER_TESTS_PLAN: '[]', TARGETED_INTEGRATION_TESTS_PLAN: '[]', ENTITLEMENT_ACCEPTANCE_REQUIRED: 'false',
  TEST_ONLY_HELPERS_PLAN: '[]',
};

test('the workflow action prints the lane evidence marker on a passing pull request run only', () => {
  const env = {
    ...process.env, ...markerEnvironment, PR_VALIDATION_PLAN: 'success', LINT: 'success', LINT_PLAN: JSON.stringify(passing.lintPlan),
    POLICY: 'success', WORKFLOW_CONTRACTS: 'skipped', SERVER_STATIC: 'skipped', SERVER_PROCESS_TESTS: 'skipped', SERVER_TESTS: 'skipped',
    TARGETED_SERVER_TESTS: 'skipped', IOS_CONTRACTS: 'skipped', DATABASE: 'skipped', DOCS_ONLY: 'false', METADATA_ONLY: 'false',
    POLICY_REQUIRED: 'true', WORKFLOW_CONTRACTS_REQUIRED: 'false', SERVER_STATIC_REQUIRED: 'false', SERVER_TEST_MODE: 'none',
    PROCESS_HEAVY_REQUIRED: 'false', IOS_CONTRACTS_REQUIRED: 'false', DATABASE_REQUIRED: 'false', REUSED_LANES: '[]', LANE_EVIDENCE: '',
  };
  const passingRun = spawnSync(process.execPath, ['ci/src/actions/requireSelectedValidationLanes.ts'], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(passingRun.status, 0, passingRun.stderr);
  const marker = parsePrChecksLaneEvidenceLog(passingRun.stdout);
  assert.equal(marker.mergeSha, 'f'.repeat(40));
  assert.equal(marker.runId, 500);
  assert.deepEqual(marker.plan.targetedServerTests, []);
  assert.equal(marker.results['validation-policy'], 'success');

  const failingRun = spawnSync(process.execPath, ['ci/src/actions/requireSelectedValidationLanes.ts'], {
    cwd: process.cwd(), env: { ...env, POLICY: 'skipped' }, encoding: 'utf8',
  });
  assert.equal(failingRun.status, 1);
  assert.throws(() => parsePrChecksLaneEvidenceLog(failingRun.stdout), /found 0/);

  const candidateRun = spawnSync(process.execPath, ['ci/src/actions/requireSelectedValidationLanes.ts'], {
    cwd: process.cwd(), env: { ...env, EVENT_NAME: 'merge_group', PR_NUMBER: '' }, encoding: 'utf8',
  });
  assert.equal(candidateRun.status, 0, candidateRun.stderr);
  assert.throws(() => parsePrChecksLaneEvidenceLog(candidateRun.stdout), /found 0/);
});

test('the workflow action accepts a reused lane from the evidence record and rejects a mismatched declaration', () => {
  const record = {
    schema: 'example.linux-queue-evidence-reuse.v1', candidateSha: 'c'.repeat(40), queueBaseSha: 'b'.repeat(40), prNumber: '6151', prHeadSha: 'd'.repeat(40),
    lanes: [
      { lane: 'server-tests', verdict: 'reused', sourceRunId: 500, sourceRunAttempt: 1, sourceHeadSha: 'd'.repeat(40), testedMergeSha: 'f'.repeat(40), inputDigest: '1'.repeat(64), jobs: ['Server tests (1/4)'] },
      { lane: 'server-process-tests', verdict: 'executed', reason: 'input-digest-changed', detail: 'server' },
      { lane: 'workflow-contracts', verdict: 'not-selected' },
    ],
  };
  const env = {
    ...process.env, EVENT_NAME: 'merge_group', PR_VALIDATION_PLAN: 'success', LINT: 'success', LINT_PLAN: JSON.stringify(passing.lintPlan),
    POLICY: 'success', WORKFLOW_CONTRACTS: 'skipped', SERVER_STATIC: 'skipped', SERVER_PROCESS_TESTS: 'success', SERVER_TESTS: 'skipped',
    TARGETED_SERVER_TESTS: 'skipped', IOS_CONTRACTS: 'skipped', DATABASE: 'skipped', DOCS_ONLY: 'false', METADATA_ONLY: 'false',
    POLICY_REQUIRED: 'true', WORKFLOW_CONTRACTS_REQUIRED: 'false', SERVER_STATIC_REQUIRED: 'false', SERVER_TEST_MODE: 'full',
    PROCESS_HEAVY_REQUIRED: 'true', IOS_CONTRACTS_REQUIRED: 'false', DATABASE_REQUIRED: 'false',
    REUSED_LANES: '["server-tests"]', LANE_EVIDENCE: JSON.stringify(record),
  };
  const reused = spawnSync(process.execPath, ['ci/src/actions/requireSelectedValidationLanes.ts'], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, /^server-tests: reused from run 500 attempt 1 head d{40}, input digest 1{64} \(not executed on this candidate; tested merge f{40}\)$/m);
  assert.match(reused.stdout, /^server-process-tests: executed \(success\)$/m);

  const mismatched = spawnSync(process.execPath, ['ci/src/actions/requireSelectedValidationLanes.ts'], {
    cwd: process.cwd(), env: { ...env, REUSED_LANES: '[]' }, encoding: 'utf8',
  });
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /REUSED_LANES \[\] does not match the evidence record's reused lanes \["server-tests"\]/);

  const withoutEvidence = spawnSync(process.execPath, ['ci/src/actions/requireSelectedValidationLanes.ts'], {
    cwd: process.cwd(), env: { ...env, REUSED_LANES: '[]', LANE_EVIDENCE: '' }, encoding: 'utf8',
  });
  assert.equal(withoutEvidence.status, 1);
  assert.match(withoutEvidence.stderr, /Selected validation lane server-tests ended with: skipped/);
});

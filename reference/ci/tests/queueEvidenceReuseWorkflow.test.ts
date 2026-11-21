import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';
import { COVERED_REPLAN_OUTPUTS } from '../src/ios/nativeSelectionRecord.ts';
import {
  planQueueEvidenceReuse, reuseGateOutputs, type GitTreeEntry,
} from '../src/ios/queueEvidenceReuse.ts';
import { sameQueueLaneExecutionContract } from '../src/ios/queueLaneExecutionContract.ts';

/**
 * The generated Test - iOS workflow wires queue evidence reuse the way the
 * decision module assumes: the planner runs only on a merge queue candidate,
 * only from the queue base's trusted detector, its outputs replace exactly the
 * gate outputs the Mac jobs select themselves from, and every required
 * aggregate names what was reused before it gives its verdict.
 */

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
}
interface Job {
  readonly if?: string;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly steps: readonly Step[];
}
interface Workflow { readonly jobs: Readonly<Record<string, Job>> }

const workflow = load(readFileSync('.github/workflows/ios-tests.yml', 'utf8')) as Workflow;

it('keeps unrelated generated jobs outside each lane execution contract', () => {
  const source = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
  const candidate = source.replace('  sync-observability-github-token:\n',
    '  sync-observability-github-token:\n    timeout-minutes: 15\n');
  assert.notEqual(candidate, source);
  for (const lane of ['native', 'onboarding', 'chat-plaid', 'income', 'budget'] as const) {
    assert.equal(sameQueueLaneExecutionContract(source, candidate, lane), true, lane);
  }
});

function job(id: string): Job {
  const found = workflow.jobs[id];
  assert.ok(found, id);
  return found;
}

function step(jobId: string, name: string): Step {
  const found = job(jobId).steps.find((candidate) => candidate.name === name || candidate.id === name);
  assert.ok(found, `${jobId}: ${name}`);
  return found;
}

const REPOSITORY = 'example-org/example-app';
const BASE = 'b'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const HEAD = 'a'.repeat(40);
const QUEUE_REF = `refs/heads/gh-readonly-queue/develop/pr-6300-${BASE}`;

type Context = Record<string, ExpressionValue>;

function mergeGroupContext(): Context {
  return {
    github: {
      event_name: 'merge_group', sha: CANDIDATE, ref: QUEUE_REF, repository: REPOSITORY, run_attempt: 1,
      event: {
        merge_group: { head_sha: CANDIDATE, base_sha: BASE, head_ref: QUEUE_REF, base_ref: 'refs/heads/develop' },
        repository: { full_name: REPOSITORY },
      },
    },
    inputs: {}, vars: { IOS_ENABLE_BUDGET_E2E: 'false' },
  };
}

function pullRequestContext(): Context {
  return {
    github: {
      event_name: 'pull_request', sha: 'f'.repeat(40), ref: 'refs/pull/7/merge', repository: REPOSITORY,
      event: {
        pull_request: {
          number: 7, draft: false,
          head: { sha: HEAD, ref: 'feature', repo: { full_name: REPOSITORY } },
          base: { sha: BASE, ref: 'develop' },
        },
      },
    },
    inputs: {}, vars: {},
  };
}

function dispatchContext(): Context {
  return {
    github: { event_name: 'workflow_dispatch', sha: BASE, ref: 'refs/heads/develop', repository: REPOSITORY, event: {} },
    inputs: { test_scope: 'full' }, vars: {},
  };
}

/** What the gate's own steps answer for a candidate selecting native work and onboarding. */
const gateSteps: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  precheck: { needs_checkout: 'true', production_promotion: 'false', verifier_sha: BASE },
  'base-update': {},
  detect: {
    should_run: 'true', main_required: 'true', storekit_required: 'true', onboarding_required: 'true',
    chat_plaid_required: 'false', budget_required: 'false', income_required: 'false',
    evidence_required: 'false', native_changed_files_explicit_empty: 'false',
  },
  selection: { mode: 'affected' },
  classify: {
    producer_mode: 'shared-products', ui_required: 'true', execution_required: 'true',
    execution_lanes: '["native1"]', full_execution_lanes: '[]', release_archive_required: 'true',
    handoff_required: 'true',
  },
  replan: {},
  'queue-evidence-source': { status: 'found', run_id: '900', record_attempt: '1' },
};

function stepResolver(queueReuse: Readonly<Record<string, string>> | undefined) {
  return (path: readonly string[]): ExpressionValue => {
    const [root, id, kind, key] = path;
    if (root !== 'steps' || id === undefined) return null;
    if (kind === 'outcome' || kind === 'conclusion') {
      return id === 'queue-reuse' && queueReuse === undefined ? 'skipped' : 'success';
    }
    const outputs = id === 'queue-reuse' ? queueReuse ?? {} : gateSteps[id] ?? {};
    return key === undefined ? null : outputs[key] ?? '';
  };
}

function gateOutputs(queueReuse: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const outputs = job('ios-change-gate').outputs ?? {};
  const resolve = stepResolver(queueReuse);
  return Object.fromEntries(Object.entries(outputs).map(([name, expression]) => {
    const value = evaluateExpression(expression, mergeGroupContext(), { resolve });
    return [name, value === null ? '' : String(value)];
  }));
}

function jobRuns(id: string, gate: Readonly<Record<string, string>>): boolean {
  const condition = job(id).if;
  assert.ok(condition, id);
  const value = evaluateExpression(condition, mergeGroupContext(), {
    resolve: (path) => {
      const [root, needed, kind, key] = path;
      if (root !== 'needs') return null;
      if (kind === 'result') return 'success';
      if (needed === 'ios-change-gate' && kind === 'outputs' && key !== undefined) return gate[key] ?? '';
      if (needed === 'confirm-current-ios-pr' && key === 'current') return 'true';
      return '';
    },
  });
  return !(value === false || value === null || value === '' || value === 0);
}

function tree(changed: Readonly<Record<string, string>> = {}): GitTreeEntry[] {
  const files: Record<string, string> = {
    '.github/workflows/ios-tests.yml': '1'.repeat(40),
    'ci/src/ios/toolchainPolicy.ts': '2'.repeat(40),
    'ci/src/ios/shared/testProductToolchain.ts': '3'.repeat(40),
    'next.config.mjs': '4'.repeat(40),
    'ios/example-ios/App.swift': '5'.repeat(40),
    'server/services/onboarding/onboardingService.ts': '6'.repeat(40),
    ...changed,
  };
  return Object.entries(files).map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha }));
}

/** The queue-reuse step's outputs for a candidate whose develop changed `changed`. */
function queueReuseOutputs(changed: Readonly<Record<string, string>>): Record<string, string> {
  const selection = {
    lanes: {
      storekit: true, main: true, onboarding: true, chatPlaid: false, budget: false, income: false, evidence: false,
    },
    native: {
      mode: 'affected' as const, shouldRun: true, releaseArchiveRequired: true, narrowPaywallRequired: false,
      evidenceGroups: [], onlyTesting: ['example-iosTests/BudgetTests'], evidenceTesting: [], wellnessRequired: false,
      wellnessTesting: [], producerMode: 'shared-products' as const, executionLanes: ['native1' as const],
      fullExecutionLanes: [], executionRequired: true, uiRequired: true, handoffRequired: true,
    },
  };
  const planned = planQueueEvidenceReuse({
    candidateSha: CANDIDATE, queueBaseSha: BASE, prNumber: '6300', prHeadSha: HEAD, current: selection,
    budgetE2eEnabled: false,
    source: {
      kind: 'found',
      evidence: {
        runId: 900, runAttempt: 1, headSha: HEAD, recordAttempt: 1,
        successfulJobs: ['e2e:onboarding', 'native-products', 'native:native1', 'release-archive', 'storekit'],
        record: {
          schema: 'example.ios-native-selection-record.v1',
          run: { id: 900, attempt: 1, headSha: HEAD, verifierSha: BASE, workflowSha: HEAD },
          selectorInputFingerprint: 'f'.repeat(64),
          evidence: { kind: 'executed' },
          selection,
        },
      },
    },
    headTree: tree(),
    candidateTree: tree(changed),
    workflowBlobs: { headSha: '1'.repeat(40), candidateSha: '1'.repeat(40), sources: null },
  });
  return { ...Object.fromEntries(reuseGateOutputs(planned)), record: JSON.stringify(planned) };
}

const NATIVE_MAC_JOBS = ['verify-ios-release-archive', 'build-ios-native-test-products', 'test-ios-execution'];
const REAL_SERVER_MAC_JOBS = ['build-ios-e2e-test-products', 'onboarding-e2e'];
const REAL_SERVER_JOBS = ['prepare-dev-e2e-schema', ...REAL_SERVER_MAC_JOBS];
const QUEUE_STEPS = [
  'queue-evidence-source', 'queue-source-selection-record', 'queue-reuse', 'Upload the queue evidence reuse record',
];

describe('queue evidence reuse in the generated Test - iOS workflow', () => {
  it('plans reuse only on a merge queue candidate', () => {
    const resolve = stepResolver({});
    for (const name of QUEUE_STEPS.slice(0, 3)) {
      const condition = step('ios-change-gate', name).if;
      assert.ok(condition, name);
      assert.equal(evaluateExpression(condition, pullRequestContext(), { resolve }), false, `${name} on pull_request`);
      assert.equal(evaluateExpression(condition, dispatchContext(), { resolve }), false, `${name} on dispatch`);
      assert.ok(evaluateExpression(condition, mergeGroupContext(), { resolve }), `${name} on merge_group`);
    }
    const upload = step('ios-change-gate', 'Upload the queue evidence reuse record');
    assert.equal(upload.if, "steps.queue-reuse.outcome == 'success'");
    assert.match(upload.with?.['name'] ?? '', /ios-queue-evidence-reuse-\{0\}', github\.run_attempt/);
  });

  it('runs both programs from the queue base detector, never from the candidate workspace', () => {
    const detector = step('ios-change-gate', 'Checkout trusted queue candidate detector');
    assert.equal(detector.with?.['ref'], '${{ steps.precheck.outputs.verifier_sha }}');
    assert.equal(detector.with?.['path'], '.ci/trusted-ios-detector');
    assert.equal(step('ios-change-gate', 'queue-evidence-source').run,
      'node .ci/trusted-ios-detector/ci/src/actions/ios/findQueuedPullRequestEvidence.ts');
    assert.equal(step('ios-change-gate', 'queue-reuse').run,
      'node .ci/trusted-ios-detector/ci/src/actions/ios/planQueueEvidenceReuse.ts');
    const record = step('ios-change-gate', 'queue-source-selection-record');
    assert.equal(record.with?.['run-id'], '${{ steps.queue-evidence-source.outputs.run_id }}');
    assert.match(record.with?.['name'] ?? '', /ios-native-selection-record-\{0\}', steps\.queue-evidence-source\.outputs\.record_attempt/);
  });

  it('lets the queue reuse step replace exactly the outputs a covered re-plan replaces', () => {
    const outputs = job('ios-change-gate').outputs ?? {};
    for (const name of Object.keys(COVERED_REPLAN_OUTPUTS)) {
      assert.match(outputs[name] ?? '', new RegExp(`^\\$\\{\\{ steps\\.queue-reuse\\.outputs\\.${name} \\|\\| steps\\.replan\\.outputs\\.${name} \\|\\| `), name);
    }
    assert.equal(outputs['queue_evidence_reuse'], "${{ steps.queue-reuse.outputs.record || '' }}");
  });

  it('keeps every Mac lane when no reuse was planned', () => {
    const gate = gateOutputs(undefined);
    assert.equal(gate['queue_evidence_reuse'], '');
    for (const id of [...NATIVE_MAC_JOBS, ...REAL_SERVER_JOBS]) assert.equal(jobRuns(id, gate), true, id);
  });

  it('skips the native Mac jobs and keeps the real-server lane after a server-only develop change', () => {
    const gate = gateOutputs(queueReuseOutputs({ 'server/services/onboarding/onboardingService.ts': '9'.repeat(40) }));
    for (const id of NATIVE_MAC_JOBS) assert.equal(jobRuns(id, gate), false, id);
    for (const id of REAL_SERVER_JOBS) assert.equal(jobRuns(id, gate), true, id);
    assert.equal(gate['should_run'], 'true');
    assert.equal(gate['storekit_required'], 'false');
  });

  it('allocates no Mac when every selected lane is reused, but still verifies the schema', () => {
    const gate = gateOutputs(queueReuseOutputs({ 'README.md': '9'.repeat(40) }));
    for (const id of [...NATIVE_MAC_JOBS, ...REAL_SERVER_MAC_JOBS]) assert.equal(jobRuns(id, gate), false, id);
    assert.equal(gate['should_run'], 'false');
    assert.equal(gate['real_server_evidence_reused'], 'true');
    assert.equal(jobRuns('prepare-dev-e2e-schema', gate), true, 'reused real-server evidence');
    assert.equal(jobRuns('prepare-dev-e2e-schema', { ...gate, real_server_evidence_reused: 'false' }), false,
      'nothing else selects the schema job once every lane is reused');
    assert.match(gate['queue_evidence_reuse'] ?? '', /"verdict":"reused"/);
  });

  it('publishes no reused real-server evidence outside a queue reuse', () => {
    assert.equal(gateOutputs(undefined)['real_server_evidence_reused'], 'false');
    const nativeOnly = gateOutputs(queueReuseOutputs({ 'server/services/onboarding/onboardingService.ts': '9'.repeat(40) }));
    assert.equal(nativeOnly['real_server_evidence_reused'], 'false');
  });

  it('refuses reused real-server evidence in the aggregates unless the schema job succeeded', () => {
    for (const jobId of ['test-ios', 'onboarding-e2e-status']) {
      assert.equal(step(jobId, 'Report reused queue evidence').env?.['SCHEMA_PREPARATION_RESULT'],
        '${{ needs.prepare-dev-e2e-schema.result }}', jobId);
    }
    assert.equal(step('storekit-purchase-status', 'Report reused queue evidence').env?.['SCHEMA_PREPARATION_RESULT'],
      undefined);
  });

  it('runs every Mac lane again when develop changed an iOS source', () => {
    const gate = gateOutputs(queueReuseOutputs({ 'ios/example-ios/App.swift': '9'.repeat(40) }));
    for (const id of [...NATIVE_MAC_JOBS, ...REAL_SERVER_JOBS]) assert.equal(jobRuns(id, gate), true, id);
  });

  it('has every required aggregate name reused lanes, from its trusted checkout, before its verdict', () => {
    const expectations = [
      ['test-ios', 'native,onboarding,chat-plaid,income,budget', 'Verify iOS test lanes', ''],
      ['storekit-purchase-status', 'native', 'Verify consolidated StoreKit execution result',
        '.ci/trusted-storekit-status/'],
      ['onboarding-e2e-status', 'onboarding,chat-plaid,income,budget', 'Verify onboarding execution result', ''],
    ] as const;
    for (const [jobId, lanes, verdict, root] of expectations) {
      const steps = job(jobId).steps;
      const report = steps.findIndex((candidate) => candidate.name === 'Report reused queue evidence');
      const verify = steps.findIndex((candidate) => candidate.name === verdict);
      assert.ok(report >= 0 && report < verify, jobId);
      const reportStep = steps[report];
      assert.ok(reportStep);
      assert.equal(reportStep.env?.['CONTEXT_LANES'], lanes, jobId);
      assert.equal(reportStep.env?.['QUEUE_EVIDENCE_REUSE'], '${{ needs.ios-change-gate.outputs.queue_evidence_reuse }}');
      assert.equal(reportStep.run, `node ${root}ci/src/actions/ios/reportQueueEvidenceReuse.ts`, jobId);
      const condition = reportStep.if ?? '';
      assert.equal(evaluateExpression(condition, pullRequestContext()), false, jobId);
      assert.ok(evaluateExpression(condition, mergeGroupContext()), jobId);
    }
  });
});

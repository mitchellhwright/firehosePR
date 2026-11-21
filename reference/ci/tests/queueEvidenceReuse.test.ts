import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  changedLaneInputs,
  choosePullRequestRun,
  isQueueLaneInput,
  laneInputs,
  parseGitTree,
  planQueueEvidenceReuse,
  readGitTree,
  readWorkflowBlob,
  readWorkflowRevisionTree,
  readPullRequestRuns,
  REQUIRED_NATIVE_INPUTS,
  reuseGateOutputs,
  type EvidenceSource,
  type GitTreeEntry,
  type QueueReuseInput,
  type WorkflowRunSummary,
} from '../src/ios/queueEvidenceReuse.ts';
import {
  queueReuseReport,
  verdictLine,
  type LaneVerdict,
  type QueueEvidenceReuseRecord,
  type QueueReuseLane,
} from '../src/ios/queueEvidenceReuseRecord.ts';
import {
  requiredEvidenceJobs,
  type NativeSelectionRecord,
  type RecordedSelection,
} from '../src/ios/nativeSelectionRecord.ts';
import { removableArtifacts } from '../src/ios/runArtifactCleanup.ts';
import { GithubTransportError, type GithubReader } from '../src/ios/shared/githubRest.ts';

const sha = (character: string): string => character.repeat(40);
const HEAD = sha('a');
const CANDIDATE = sha('c');
const BASE = sha('b');
const REPOSITORY = 'example-org/example-app';

/** A Test - iOS tree: every file the closures read, plus files neither reads. */
const BASE_TREE: Readonly<Record<string, string>> = {
  '.github/workflows/ios-tests.yml': sha('1'),
  '.github/workflows/pr-checks.yml': sha('2'),
  'ci/src/ios/toolchainPolicy.ts': sha('3'),
  'ci/src/actions/ios/selectXcode.ts': sha('4'),
  'ci/src/ios/shared/testProductToolchain.ts': sha('5'),
  'scripts/ios-ci-image-prerequisites.py': sha('6'),
  'scripts/select-ios-affected-tests.ts': sha('7'),
  'ci/src/prValidationPlan.ts': sha('8'),
  'ios/example-ios/App.swift': sha('9'),
  'ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved': sha('d'),
  'ios/example-ios/Models/Generated/ChatPayloads.generated.swift': sha('e'),
  'package.json': sha('f'),
  'package-lock.json': sha('b'),
  'next.config.mjs': sha('1'.repeat(1)),
  'server/services/budget/budgetService.ts': sha('2'),
  'server/db/migrations/0042_add_goal.sql': sha('3'),
  'pages/api/[...path].ts': sha('4'),
  'shared/schemas/chat.ts': sha('5'),
  'server/tests/budget.test.ts': sha('6'),
  'src/components/Button.tsx': sha('7'),
  'docs/ci/merge-queue-plan.md': sha('8'),
  'README.md': sha('9'),
};

/** Non-TypeScript files the backend reads at runtime, one per class the server loads. */
/** Read by services/chat/services/docs.ts, videoScripts.ts and mcp/exampleDocsMcpServer.ts. */
/** Paths the lane-input contract grants to Chat Plaid alone (`ci/contracts/real-server-lane-inputs.v1.json`). */
const CHAT_PLAID_ONLY_INPUTS = [
  'server/docs/cards/IRA Card.md',
  'server/docs/CHAT_ARCHITECTURE.md',
  // the Chat Plaid lane seeds the dev database from these
  'server/testdata/chat-plaid-e2e-seed.json',
  'server/scripts/plaid/dev-seed-db.ts',
] as const;

/** Backend files every real-server lane reads at runtime, beside its code. */
const SERVER_RUNTIME_READS = [
  // services/users/activationFlowService.ts
  'server/data/activation-flows/default.json',
  // services/dashboard/data/curatedSecurityClassifications.ts
  'server/services/dashboard/data/curatedSecurityClassifications.json',
  // swagger/spec.ts globs server/routes/**/*.yaml; gen:types reads them too
  'server/routes/budget.yaml',
  'server/generated/openapi.json',
  // db/migrate.ts applies the SQL and its journal
  'server/db/migrations/meta/_journal.json',
] as const;

function tree(overrides: Readonly<Record<string, string | null>> = {}): GitTreeEntry[] {
  const files = { ...BASE_TREE, ...overrides };
  return Object.entries(files).flatMap(([path, object]) => (
    object === null ? [] : [{ path, mode: '100644', type: 'blob' as const, sha: object }]
  ));
}

const noLanes = {
  storekit: false, main: false, onboarding: false, chatPlaid: false,
  budget: false, income: false, evidence: false,
};

function selection(
  lanes: Partial<RecordedSelection['lanes']> = {},
  native: Partial<NonNullable<RecordedSelection['native']>> = {},
): RecordedSelection {
  return {
    lanes: { ...noLanes, main: true, storekit: true, onboarding: true, ...lanes },
    native: {
      mode: 'affected',
      shouldRun: true,
      releaseArchiveRequired: true,
      narrowPaywallRequired: false,
      evidenceGroups: [],
      onlyTesting: ['example-iosTests/BudgetTests', 'example-iosUITests/DebtUITests/testPayoff'],
      evidenceTesting: [],
      wellnessRequired: false,
      wellnessTesting: [],
      producerMode: 'shared-products',
      executionLanes: ['native1', 'native2'],
      fullExecutionLanes: [],
      executionRequired: true,
      uiRequired: true,
      handoffRequired: true,
      ...native,
    },
  };
}

function record(recorded: RecordedSelection = selection(), overrides: Partial<NativeSelectionRecord> = {}): NativeSelectionRecord {
  return {
    schema: 'example.ios-native-selection-record.v1',
    run: { id: 900, attempt: 1, headSha: HEAD, verifierSha: sha('9'), workflowSha: HEAD },
    selectorInputFingerprint: 'f'.repeat(64),
    evidence: { kind: 'executed' },
    selection: recorded,
    ...overrides,
  };
}

function found(
  recorded: NativeSelectionRecord = record(),
  successfulJobs: readonly string[] = requiredEvidenceJobs(recorded.selection),
): EvidenceSource {
  return {
    kind: 'found',
    evidence: { runId: 900, runAttempt: 2, headSha: HEAD, recordAttempt: 1, successfulJobs, record: recorded },
  };
}

function input(overrides: Partial<QueueReuseInput> = {}): QueueReuseInput {
  return {
    candidateSha: CANDIDATE,
    queueBaseSha: BASE,
    prNumber: '6300',
    prHeadSha: HEAD,
    current: selection(),
    budgetE2eEnabled: false,
    source: found(),
    headTree: tree(),
    candidateTree: tree(),
    workflowBlobs: { headSha: sha('1'), candidateSha: sha('1'), sources: null },
    ...overrides,
  };
}

function verdictOf(planned: QueueEvidenceReuseRecord, lane: QueueReuseLane): LaneVerdict {
  const verdict = planned.lanes.find((candidate) => candidate.lane === lane);
  assert.ok(verdict, lane);
  return verdict;
}

function assertExecuted(planned: QueueEvidenceReuseRecord, lane: QueueReuseLane, reason: string, detail?: RegExp): void {
  const verdict = verdictOf(planned, lane);
  assert.equal(verdict.verdict, 'executed', `${lane}: ${JSON.stringify(verdict)}`);
  if (verdict.verdict !== 'executed') return;
  assert.equal(verdict.reason, reason, lane);
  if (detail !== undefined) assert.match(verdict.detail, detail, lane);
}

function assertReused(planned: QueueEvidenceReuseRecord, lane: QueueReuseLane): void {
  const verdict = verdictOf(planned, lane);
  assert.equal(verdict.verdict, 'reused', `${lane}: ${JSON.stringify(verdict)}`);
}

describe('lane input closures', () => {
  it('bind the toolchain pins, workflow, lockfiles and generated models into the native closure', () => {
    for (const path of [
      ...REQUIRED_NATIVE_INPUTS,
      'ci/src/actions/ios/selectXcode.ts',
      'scripts/ios-ci-image-prerequisites.py',
      'ios/example-ios/Models/Generated/ChatPayloads.generated.swift',
      'ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
      'package-lock.json',
      'ci/package-lock.json',
    ]) {
      assert.equal(isQueueLaneInput('native', path), true, path);
    }
    for (const path of [
      'server/services/budget/budgetService.ts', 'pages/api/[...path].ts', 'docs/ci/merge-queue-plan.md',
      'src/components/Button.tsx', '.github/workflows/pr-checks.yml', 'ci/src/prValidationPlan.ts',
      // Selection code is re-run by the queue base; coverage decides, not the digest.
      'scripts/select-ios-affected-tests.ts',
      'ci/src/ios/queueEvidenceReuse.ts',
      'ci/src/ios/queueLaneExecutionContract.ts',
      'ci/src/actions/ios/planQueueEvidenceReuse.ts',
    ]) {
      assert.equal(isQueueLaneInput('native', path), false, path);
    }
  });

  it('add the backend the real-server lanes start to their closure', () => {
    for (const lane of ['onboarding', 'chat-plaid', 'income', 'budget'] as const) {
      for (const path of [
        'server/services/budget/budgetService.ts', 'server/db/migrations/0042_add_goal.sql',
        'pages/api/[...path].ts', 'shared/schemas/chat.ts', 'next.config.mjs', 'tsconfig.json',
        'ios/example-ios/App.swift',
      ]) {
        assert.equal(isQueueLaneInput(lane, path), true, `${lane} ${path}`);
      }
      for (const path of SERVER_RUNTIME_READS) {
        assert.equal(isQueueLaneInput(lane, path), true, `${lane} ${path}`);
      }
      for (const path of [
        'server/tests/budget.test.ts', 'server/tests/fixtures/plaid.json', 'server/vitest.config.ts',
        'server/services/budget/budgetService.test.ts', 'shared/schemas/chat.test.ts',
        'docs/ci/merge-queue-plan.md', 'src/components/Button.tsx',
      ]) {
        assert.equal(isQueueLaneInput(lane, path), false, `${lane} ${path}`);
      }
    }
    for (const path of SERVER_RUNTIME_READS) {
      assert.equal(isQueueLaneInput('native', path), false, path);
    }
  });

  it('add chat docs and the Chat Plaid seed to the Chat Plaid closure alone', () => {
    for (const path of CHAT_PLAID_ONLY_INPUTS) {
      assert.equal(isQueueLaneInput('chat-plaid', path), true, path);
      for (const lane of ['native', 'onboarding', 'income', 'budget'] as const) {
        assert.equal(isQueueLaneInput(lane, path), false, `${lane} ${path}`);
      }
    }
  });

  it('digest the closure by content, independent of listing order and of files outside it', () => {
    const digest = laneInputs('native', tree())?.digest;
    assert.ok(digest);
    assert.equal(laneInputs('native', [...tree()].reverse())?.digest, digest);
    assert.equal(laneInputs('native', tree({ 'README.md': sha('0'), 'src/new.ts': sha('1') }))?.digest, digest);
    assert.notEqual(laneInputs('native', tree({ 'ios/example-ios/App.swift': sha('0') }))?.digest, digest);
    assert.notEqual(laneInputs('native', tree({ 'ios/example-ios/New.swift': sha('0') }))?.digest, digest);
    assert.notEqual(laneInputs('native', tree({ 'ios/example-ios/App.swift': null }))?.digest, digest);
    const executable = tree().map((entry) => (
      entry.path === 'ios/example-ios/App.swift' ? { ...entry, mode: '100755' } : entry
    ));
    assert.notEqual(laneInputs('native', executable)?.digest, digest, 'a mode change is a content change');
    assert.notEqual(laneInputs('onboarding', tree())?.digest, digest, 'closures are domain-separated');
  });

  it('refuse a tree that is truncated, malformed, or not a Test - iOS tree', () => {
    assert.equal(parseGitTree({ truncated: true, tree: tree() }), null);
    assert.equal(parseGitTree({ tree: tree() }), null);
    assert.equal(parseGitTree({ truncated: false, tree: [{ path: 'x', mode: '100644', type: 'blob', sha: 'nope' }] }), null);
    assert.deepEqual(parseGitTree({ truncated: false, tree: tree() }), tree());
    for (const path of REQUIRED_NATIVE_INPUTS) {
      assert.equal(laneInputs('native', tree({ [path]: null })), null, path);
    }
    assert.equal(laneInputs('onboarding', tree({ 'next.config.mjs': null })), null);
    assert.ok(laneInputs('native', tree({ 'next.config.mjs': null })));
  });

  it('name exactly the closure paths that changed', () => {
    const head = laneInputs('native', tree());
    const candidate = laneInputs('native', tree({
      'ios/example-ios/App.swift': sha('0'), 'README.md': sha('0'), 'ios/example-ios/Added.swift': sha('1'),
    }));
    assert.ok(head && candidate);
    assert.deepEqual(changedLaneInputs(head, candidate), ['ios/example-ios/Added.swift', 'ios/example-ios/App.swift']);
  });
});

describe('queue candidate reuse decisions', () => {
  it('reuses every selected lane when develop moved none of its inputs', () => {
    const planned = planQueueEvidenceReuse(input({ candidateTree: tree({ 'README.md': sha('0') }) }));
    assertReused(planned, 'native');
    assertReused(planned, 'onboarding');
    assert.equal(verdictOf(planned, 'chat-plaid').verdict, 'not-selected');
    const native = verdictOf(planned, 'native');
    assert.ok(native.verdict === 'reused');
    assert.equal(native.sourceRunId, 900);
    assert.equal(native.sourceRunAttempt, 2);
    assert.equal(native.sourceHeadSha, HEAD);
    assert.equal(native.inputDigest, laneInputs('native', tree())?.digest);
    assert.deepEqual(native.jobs, ['native-products', 'native:native1', 'native:native2', 'release-archive', 'storekit']);
    assert.match(verdictLine(native),
      new RegExp(`^reused: native from run 900 attempt 2 head ${HEAD}, input digest [0-9a-f]{64} `
        + '\\(not executed on this candidate; jobs native-products,native:native1,native:native2,'
        + 'release-archive,storekit\\)$'));
    const outputs = new Map(reuseGateOutputs(planned));
    assert.equal(outputs.get('should_run'), 'false');
    assert.equal(outputs.get('main_required'), 'false');
    assert.equal(outputs.get('native_release_archive_required'), 'false');
    assert.equal(outputs.get('native_execution_lanes'), '[]');
    assert.equal(outputs.get('onboarding_required'), 'false');
    assert.equal(outputs.get('real_server_evidence_reused'), 'true',
      'a reused real-server lane keeps the schema verification selected');
    assert.equal(outputs.has('chat_plaid_required'), false, 'an unselected lane keeps the gate value');
  });

  it('executes every lane when develop changed an iOS source the lanes build', () => {
    const planned = planQueueEvidenceReuse(input({ candidateTree: tree({ 'ios/example-ios/App.swift': sha('0') }) }));
    assertExecuted(planned, 'native', 'input-digest-changed', /^ios\/example-ios\/App\.swift$/);
    assertExecuted(planned, 'onboarding', 'input-digest-changed', /ios\/example-ios\/App\.swift/);
    assert.deepEqual(reuseGateOutputs(planned), []);
    assert.equal(verdictLine(verdictOf(planned, 'native')),
      'executed: native (input-digest-changed: ios/example-ios/App.swift)');
  });

  it('keeps native reuse but runs a real-server lane when develop changed only the backend', () => {
    for (const path of [
      'server/services/budget/budgetService.ts', 'server/db/migrations/0042_add_goal.sql',
      'pages/api/[...path].ts', 'shared/schemas/chat.ts',
    ]) {
      const planned = planQueueEvidenceReuse(input({ candidateTree: tree({ [path]: sha('0') }) }));
      assertReused(planned, 'native');
      assertExecuted(planned, 'onboarding', 'input-digest-changed', new RegExp(path.replace(/[.[\]]/g, '\\$&')));
      const outputs = new Map(reuseGateOutputs(planned));
      assert.equal(outputs.get('main_required'), 'false', path);
      assert.equal(outputs.has('onboarding_required'), false, path);
      assert.equal(outputs.has('real_server_evidence_reused'), false, 'only native evidence was reused');
      assert.equal(outputs.has('should_run'), false, 'a lane still executes, so the run is still needed');
    }
  });

  it('runs a real-server lane when develop changed a file the backend reads at runtime', () => {
    for (const path of SERVER_RUNTIME_READS) {
      const planned = planQueueEvidenceReuse(input({ candidateTree: tree({ [path]: sha('0') }) }));
      assertReused(planned, 'native');
      assertExecuted(planned, 'onboarding', 'input-digest-changed', new RegExp(path.replace(/[.[\]]/g, '\\$&')));
    }
  });

  it('runs only Chat Plaid after a chat docs change and reuses it after a server test change', () => {
    const chatPlaid = selection({ chatPlaid: true, income: true });
    const withChatPlaid = { current: chatPlaid, source: found(record(chatPlaid)) };
    const docs = planQueueEvidenceReuse(input({
      ...withChatPlaid,
      candidateTree: tree({ 'server/docs/CHAT_ARCHITECTURE.md': sha('0') }),
    }));
    assertReused(docs, 'native');
    assertReused(docs, 'onboarding');
    assertReused(docs, 'income');
    assertExecuted(docs, 'chat-plaid', 'input-digest-changed', /^server\/docs\/CHAT_ARCHITECTURE\.md$/);
    const tests = planQueueEvidenceReuse(input({
      ...withChatPlaid,
      candidateTree: tree({
        'server/tests/budget.test.ts': sha('0'),
        'server/tests/fixtures/plaid.json': sha('1'),
        'server/services/budget/budgetService.test.ts': sha('2'),
      }),
    }));
    assertReused(tests, 'native');
    assertReused(tests, 'chat-plaid');
  });

  it('reuses a real-server lane on its own when no native lane is selected', () => {
    const current = selection({ main: false, storekit: false }, {});
    const recorded = record({ lanes: { ...noLanes, onboarding: true }, native: null });
    const planned = planQueueEvidenceReuse(input({
      current: { lanes: current.lanes, native: null },
      source: found(recorded),
      candidateTree: tree({ 'server/tests/budget.test.ts': sha('0') }),
    }));
    assert.equal(verdictOf(planned, 'native').verdict, 'not-selected');
    assertReused(planned, 'onboarding');
  });

  it('executes after a lockfile or toolchain change on develop', () => {
    for (const path of [
      'package-lock.json',
      'ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
      'ci/src/ios/toolchainPolicy.ts',
      'ci/src/ios/shared/testProductToolchain.ts',
      'scripts/ios-ci-image-prerequisites.py',
      'ci/src/actions/ios/selectXcode.ts',
      'ios/example-ios/Models/Generated/ChatPayloads.generated.swift',
    ]) {
      const planned = planQueueEvidenceReuse(input({ candidateTree: tree({ [path]: sha('0') }) }));
      assertExecuted(planned, 'native', 'input-digest-changed');
      assertExecuted(planned, 'onboarding', 'input-digest-changed');
    }
  });

  it('uses the workflow revision executed by the PR run, even when its head tree matches the candidate', () => {
    const candidate = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
    const executed = candidate.replace('  ios-change-gate:\n',
      '  ios-change-gate:\n    timeout-minutes: 99\n');
    const planned = planQueueEvidenceReuse(input({
      source: found(record(selection(), {
        run: { id: 900, attempt: 1, headSha: HEAD, verifierSha: sha('9'), workflowSha: sha('d') },
      })),
      // The PR head and candidate trees both name the old workflow. GitHub
      // executed the PR run using a synthetic merge workflow instead.
      headTree: tree(),
      candidateTree: tree(),
      workflowBlobs: { headSha: sha('d'), candidateSha: sha('1'),
        sources: { head: executed, candidate } },
    }));
    assertExecuted(planned, 'native', 'input-digest-changed', /ios-tests.yml/);
    assertExecuted(planned, 'onboarding', 'input-digest-changed', /ios-tests.yml/);
  });

  it('runs lanes when an older selection record did not retain the executed workflow revision', () => {
    const prior = record();
    const oldRecord = record(selection(), {
      run: { id: prior.run.id, attempt: prior.run.attempt,
        headSha: prior.run.headSha, verifierSha: prior.run.verifierSha },
    });
    assertExecuted(planQueueEvidenceReuse(input({ source: found(oldRecord) })),
      'native', 'tree-unreadable', /workflow revision/);
  });

  it('reuses lanes when the executed workflows preserve their execution contracts', () => {
    const head = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
    const candidate = head.replace('name: Test - iOS', 'name: Test - iOS revised');
    const planned = planQueueEvidenceReuse(input({
      candidateTree: tree({ '.github/workflows/ios-tests.yml': sha('0') }),
      workflowBlobs: { headSha: sha('1'), candidateSha: sha('0'), sources: { head, candidate } },
    }));
    assertReused(planned, 'native');
    assertReused(planned, 'onboarding');
  });

  it('keeps unrelated workflow job changes lane-specific and requires both blobs', () => {
    const head = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
    const candidate = head.replace('  onboarding-e2e:\n',
      '  onboarding-e2e:\n    timeout-minutes: 61\n');
    assert.notEqual(candidate, head);
    const altered = tree({ '.github/workflows/ios-tests.yml': sha('0') });
    const planned = planQueueEvidenceReuse(input({
      candidateTree: altered,
      workflowBlobs: { headSha: sha('1'), candidateSha: sha('0'), sources: { head, candidate } },
    }));
    assertReused(planned, 'native');
    assertExecuted(planned, 'onboarding', 'input-digest-changed', /ios-tests.yml/);
    assertExecuted(planQueueEvidenceReuse(input({ candidateTree: altered,
      workflowBlobs: { headSha: sha('1'), candidateSha: sha('0'), sources: null } })),
      'native', 'input-digest-changed', /ios-tests.yml/);
  });

  it('does not restart lanes for a selector-only or unrelated configuration change', () => {
    for (const path of [
      'scripts/select-ios-affected-tests.ts', '.github/workflows/pr-checks.yml', 'ci/src/prValidationPlan.ts',
      'src/components/Button.tsx', 'docs/ci/merge-queue-plan.md',
    ]) {
      const planned = planQueueEvidenceReuse(input({ candidateTree: tree({ [path]: sha('0') }) }));
      assertReused(planned, 'native');
    }
  });

  it('executes when the queue base selector asks for work the pull request run did not do', () => {
    const planned = planQueueEvidenceReuse(input({
      current: selection({}, { onlyTesting: ['example-iosTests/IncomeTests'] }),
    }));
    assertExecuted(planned, 'native', 'selection-not-covered', /^native\.test:example-iosTests\/IncomeTests$/);
    const lane = planQueueEvidenceReuse(input({ current: selection({}, { executionLanes: ['native3'] }) }));
    assertExecuted(lane, 'native', 'selection-not-covered', /native\.lane:native3/);
    const archive = planQueueEvidenceReuse(input({
      current: selection(),
      source: found(record(selection({}, { releaseArchiveRequired: false }))),
    }));
    assertExecuted(archive, 'native', 'selection-not-covered', /releaseArchiveRequired/);
    const storekit = planQueueEvidenceReuse(input({ source: found(record(selection({ storekit: false }))) }));
    assertExecuted(storekit, 'native', 'selection-not-covered', /lane\.storekit/);
  });

  it('never reuses a real-server lane the pull request run did not execute', () => {
    // A lane deferred to the queue (or never selected on the pull request)
    // has no pull request evidence, however identical the trees are.
    const deferred = record(selection({ onboarding: false, chatPlaid: false }));
    const planned = planQueueEvidenceReuse(input({
      current: selection({ chatPlaid: true }),
      source: found(deferred),
    }));
    assertReused(planned, 'native');
    assertExecuted(planned, 'onboarding', 'lane-not-executed-on-pull-request');
    assertExecuted(planned, 'chat-plaid', 'lane-not-executed-on-pull-request');
  });

  it('executes a lane whose evidence is missing or partial', () => {
    const recorded = record();
    const partial = requiredEvidenceJobs(recorded.selection).filter((job) => job !== 'native:native2');
    assertExecuted(planQueueEvidenceReuse(input({ source: found(recorded, partial) })),
      'native', 'lane-job-not-successful', /native:native2 did not succeed in run 900/);
    const withoutE2e = requiredEvidenceJobs(recorded.selection).filter((job) => job !== 'e2e:onboarding');
    const planned = planQueueEvidenceReuse(input({ source: found(recorded, withoutE2e) }));
    assertReused(planned, 'native');
    assertExecuted(planned, 'onboarding', 'lane-job-not-successful', /e2e:onboarding/);
    for (const reason of ['no-pull-request-run', 'selection-record-missing', 'selection-record-unproven',
      'pull-request-run-in-progress', 'program-unavailable'] as const) {
      const unavailable = planQueueEvidenceReuse(input({ source: { kind: 'unavailable', reason, detail: 'x' } }));
      assertExecuted(unavailable, 'native', reason);
      assertExecuted(unavailable, 'onboarding', reason);
      assert.equal(verdictOf(unavailable, 'income').verdict, 'not-selected');
    }
  });

  it('executes a selected lane that names no evidence job at all', () => {
    // A lane flag with no planned native work has nothing a pull request run
    // could have proven, so it cannot be carried.
    const flagOnly: RecordedSelection = { lanes: { ...noLanes, evidence: true }, native: null };
    const planned = planQueueEvidenceReuse(input({ current: flagOnly, source: found(record(flagOnly), []) }));
    assertExecuted(planned, 'native', 'lane-job-not-successful', /has no evidence job for native/);
  });

  it('executes when the evidence is for another head or was retained rather than executed', () => {
    const other = sha('d');
    const wrongRun = found();
    assert.ok(wrongRun.kind === 'found');
    assertExecuted(planQueueEvidenceReuse(input({
      source: { kind: 'found', evidence: { ...wrongRun.evidence, headSha: other } },
    })), 'native', 'pull-request-run-mismatch');
    assertExecuted(planQueueEvidenceReuse(input({
      source: found(record(selection(), { run: { id: 900, attempt: 1, headSha: other, verifierSha: sha('9') } })),
    })), 'native', 'pull-request-run-mismatch');
    assertExecuted(planQueueEvidenceReuse(input({
      source: found(record(selection(), { evidence: { kind: 'retained', runId: 800, runAttempt: 1 } })),
    })), 'native', 'evidence-not-executed-on-head', /retained run 800/);
  });

  it('executes when either tree cannot be read completely', () => {
    assertExecuted(planQueueEvidenceReuse(input({ headTree: null })), 'native', 'tree-unreadable', /pull request head/);
    assertExecuted(planQueueEvidenceReuse(input({ candidateTree: null })), 'native', 'tree-unreadable', /candidate/);
    assertExecuted(planQueueEvidenceReuse(input({
      candidateTree: tree({ 'ci/src/ios/toolchainPolicy.ts': null }),
    })), 'native', 'tree-unreadable');
  });

  it('treats the budget lane as unselected while Budget E2E is switched off', () => {
    const current = selection({ budget: true });
    assert.equal(verdictOf(planQueueEvidenceReuse(input({ current })), 'budget').verdict, 'not-selected');
    assertExecuted(planQueueEvidenceReuse(input({ current, budgetE2eEnabled: true })), 'budget',
      'lane-not-executed-on-pull-request');
  });

  it('keeps every gate output when nothing is selected', () => {
    const planned = planQueueEvidenceReuse(input({ current: { lanes: noLanes, native: null } }));
    assert.ok(planned.lanes.every((verdict) => verdict.verdict === 'not-selected'));
    assert.deepEqual(reuseGateOutputs(planned), []);
  });
});

function run(overrides: Partial<WorkflowRunSummary>): WorkflowRunSummary {
  return {
    id: 1, run_attempt: 1, head_sha: HEAD, event: 'pull_request', status: 'completed', conclusion: 'success',
    path: '.github/workflows/ios-tests.yml', head_repository: { full_name: REPOSITORY }, ...overrides,
  };
}

describe('reading GitHub for a reuse decision', () => {
  it('fetches a synthetic workflow revision instead of substituting the PR head tree', async () => {
    const mergeSha = sha('d');
    const requested: string[] = [];
    const read: GithubReader = async (url) => {
      requested.push(url);
      return { status: 200, statusLabel: '200',
        body: { truncated: false, tree: tree({ '.github/workflows/ios-tests.yml': sha('e') }) } };
    };
    const headTree = tree();
    const root = 'https://api.github.test/repos/example/repo';
    const resolved = await readWorkflowRevisionTree(read, root, mergeSha,
      [{ sha: HEAD, tree: headTree }], () => {});
    assert.deepEqual(requested, [`${root}/git/trees/${mergeSha}?recursive=1`]);
    assert.equal(resolved?.find((entry) => entry.path === '.github/workflows/ios-tests.yml')?.sha,
      sha('e'));
    assert.equal(await readWorkflowRevisionTree(read, root, HEAD,
      [{ sha: HEAD, tree: headTree }], () => {}), headTree);
    assert.equal(requested.length, 1);
  });
  it('binds a workflow blob response to the tree object id', async () => {
    const source = Buffer.from('name: Test - iOS\n');
    const objectSha = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
    const listing = tree({ '.github/workflows/ios-tests.yml': objectSha });
    const read: GithubReader = async () => ({ status: 200, statusLabel: '200',
      body: { encoding: 'base64', content: source.toString('base64'), size: source.length } });
    assert.equal(await readWorkflowBlob(read, 'https://api.github.test/repos/example/repo', listing, () => {}),
      source.toString());
    const wrong = tree({ '.github/workflows/ios-tests.yml': sha('0') });
    assert.equal(await readWorkflowBlob(read, 'https://api.github.test/repos/example/repo', wrong, () => {}), null);
  });
  const API_ROOT = 'https://api.github.test/repos/example-org/example-app';
  const unreachable: GithubReader = (url) => Promise.reject(
    new GithubTransportError(`Could not reach ${url}: connect ETIMEDOUT`));
  const answering = (status: number, body: unknown): GithubReader => () => Promise.resolve({
    status, statusLabel: String(status), body,
  });

  it('executes every selected lane with tree-unreadable when GitHub cannot be reached', async () => {
    const warnings: string[] = [];
    const warn = (message: string): void => { warnings.push(message); };
    const selected = selection({ onboarding: true, chatPlaid: true });
    const planned = planQueueEvidenceReuse(input({
      current: selected,
      source: found(record(selected)),
      headTree: await readGitTree(unreachable, API_ROOT, HEAD, warn),
      candidateTree: await readGitTree(unreachable, API_ROOT, CANDIDATE, warn),
    }));
    const executedLanes = planned.lanes.filter((verdict) => verdict.verdict !== 'not-selected');
    assert.deepEqual(executedLanes.map((verdict) => verdict.lane), ['native', 'onboarding', 'chat-plaid']);
    for (const verdict of executedLanes) assertExecuted(planned, verdict.lane, 'tree-unreadable');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? '', new RegExp(`^Git tree of ${HEAD} is unreadable.*connect ETIMEDOUT$`));
    assert.match(warnings[1] ?? '', new RegExp(`^Git tree of ${CANDIDATE} is unreadable`));
  });

  it('executes every selected lane when the candidate could not be re-read', () => {
    const selected = selection({ onboarding: true, chatPlaid: true });
    const planned = planQueueEvidenceReuse(input({
      current: selected,
      prHeadSha: null,
      source: { kind: 'unavailable', reason: 'candidate-unreadable', detail: 'candidate-unreadable: HTTP 503' },
      headTree: null,
      candidateTree: null,
    }));
    assert.equal(planned.prHeadSha, null);
    for (const lane of ['native', 'onboarding', 'chat-plaid'] as const) {
      assertExecuted(planned, lane, 'candidate-unreadable', /HTTP 503/);
    }
  });

  it('warns with the status or the malformed answer instead of reading them as a tree', async () => {
    const warnings: string[] = [];
    const warn = (message: string): void => { warnings.push(message); };
    assert.equal(await readGitTree(answering(404, undefined), API_ROOT, HEAD, warn), null);
    assert.equal(await readGitTree(answering(200, { truncated: true, tree: [] }), API_ROOT, HEAD, warn), null);
    assert.deepEqual(await readGitTree(answering(200, { truncated: false, tree: tree() }), API_ROOT, HEAD, warn),
      tree());
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? '', /: HTTP 404$/);
    assert.match(warnings[1] ?? '', /truncated or malformed$/);
  });

  it('lets a defect that is not a transport failure fail the step', async () => {
    const broken: GithubReader = () => Promise.reject(new TypeError('reader bug'));
    await assert.rejects(readGitTree(broken, API_ROOT, HEAD, () => undefined), /reader bug/);
    await assert.rejects(readPullRequestRuns(broken, API_ROOT, HEAD), /reader bug/);
  });

  it('answers an unreachable or unexpected run listing as unreadable, not a thrown failure', async () => {
    const offline = await readPullRequestRuns(unreachable, API_ROOT, HEAD);
    assert.ok(offline.kind === 'unreadable');
    assert.match(offline.detail, new RegExp(`^could not read Test - iOS runs for ${HEAD} \\(Could not reach .*ETIMEDOUT\\)$`));
    const forbidden = await readPullRequestRuns(answering(403, undefined), API_ROOT, HEAD);
    assert.ok(forbidden.kind === 'unreadable');
    assert.match(forbidden.detail, /\(HTTP 403\)$/);
    const malformed = await readPullRequestRuns(answering(200, { runs: [] }), API_ROOT, HEAD);
    assert.ok(malformed.kind === 'unreadable');
    const listed = await readPullRequestRuns(answering(200, { workflow_runs: [run({ id: 5 })] }), API_ROOT, HEAD);
    assert.ok(listed.kind === 'listed');
    assert.deepEqual(listed.runs.map((summary) => summary.id), [5]);
  });
});

describe('choosing the pull request run', () => {
  it('takes the newest completed run on the exact head and reports its latest attempt', () => {
    assert.deepEqual(choosePullRequestRun([run({ id: 5, run_attempt: 3 }), run({ id: 4 })], HEAD, REPOSITORY),
      { kind: 'run', runId: 5, runAttempt: 3 });
  });

  it('refuses a failed or cancelled newest run even when an older run passed', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', null]) {
      const choice = choosePullRequestRun([run({ id: 4 }), run({ id: 7, conclusion })], HEAD, REPOSITORY);
      assert.equal(choice.kind, 'unavailable');
      assert.ok(choice.kind === 'unavailable');
      assert.equal(choice.reason, 'pull-request-run-not-successful', String(conclusion));
      assert.match(choice.detail, /^run 7 attempt 1 concluded /);
    }
  });

  it('skips a run that is being re-run, and says so when no run has completed', () => {
    assert.deepEqual(choosePullRequestRun([run({ id: 8, status: 'in_progress', conclusion: null }), run({ id: 6 })],
      HEAD, REPOSITORY), { kind: 'run', runId: 6, runAttempt: 1 });
    const pending = choosePullRequestRun([run({ id: 8, status: 'queued', conclusion: null })], HEAD, REPOSITORY);
    assert.ok(pending.kind === 'unavailable');
    assert.equal(pending.reason, 'pull-request-run-in-progress');
  });

  it('ignores runs of another head, event, workflow or repository', () => {
    const choice = choosePullRequestRun([
      run({ id: 9, head_sha: sha('d') }),
      run({ id: 10, event: 'merge_group' }),
      run({ id: 11, event: 'workflow_dispatch' }),
      run({ id: 12, path: '.github/workflows/pr-checks.yml' }),
      run({ id: 13, head_repository: { full_name: 'outside/fork' } }),
      run({ id: 14, head_repository: null }),
    ], HEAD, REPOSITORY);
    assert.ok(choice.kind === 'unavailable');
    assert.equal(choice.reason, 'no-pull-request-run');
  });
});

describe('aggregate reuse report', () => {
  const planned = planQueueEvidenceReuse(input({ candidateTree: tree({ 'server/services/budget/budgetService.ts': sha('0') }) }));
  const required = { native: false, onboarding: true, 'chat-plaid': false, income: false, budget: false };

  it('prints the reused and executed lines of its own context', () => {
    const report = queueReuseReport(JSON.stringify(planned), required, ['native']);
    assert.ok(report.kind === 'report');
    assert.equal(report.lines.length, 1);
    assert.match(report.lines[0] ?? '', /^reused: native from run 900 attempt 2 head a{40}, input digest [0-9a-f]{64} /);
    const realServer = queueReuseReport(JSON.stringify(planned), required, ['onboarding', 'income']);
    assert.ok(realServer.kind === 'report');
    assert.deepEqual(realServer.lines.map((line) => line.split(' (')[0]), [
      'executed: onboarding', 'not selected: income is not selected for this candidate',
    ]);
  });

  it('says nothing was planned when the gate published no record', () => {
    assert.deepEqual(queueReuseReport('', required, ['native']), { kind: 'none' });
  });

  it('rejects a malformed record or one that contradicts the gate outputs', () => {
    assert.equal(queueReuseReport('{', required, ['native']).kind, 'invalid');
    assert.equal(queueReuseReport(JSON.stringify({ ...planned, schema: 'other' }), required, ['native']).kind, 'invalid');
    assert.equal(queueReuseReport(JSON.stringify({ ...planned, lanes: planned.lanes.slice(1) }), required, ['native']).kind,
      'invalid');
    assert.equal(queueReuseReport(JSON.stringify({ ...planned, lanes: [...planned.lanes].reverse() }), required,
      ['native']).kind, 'invalid');
    const contradicted = queueReuseReport(JSON.stringify(planned), { ...required, native: true }, ['native']);
    assert.deepEqual(contradicted, {
      kind: 'invalid', message: 'the record calls native reused, but the gate still requires it',
    });
  });

  it('does not ask for a verified schema when only native evidence was reused', () => {
    for (const result of ['', 'failure', 'skipped', 'success']) {
      assert.equal(queueReuseReport(JSON.stringify(planned), required, ['onboarding', 'income'], result).kind,
        'report', result);
    }
  });
});

describe('aggregate reuse report for reused real-server evidence', () => {
  const planned = planQueueEvidenceReuse(input({ candidateTree: tree({ 'README.md': sha('0') }) }));
  const rendered = JSON.stringify(planned);
  const required = { native: false, onboarding: false, 'chat-plaid': false, income: false, budget: false };

  it('accepts the reuse only after the candidate schema verification succeeded', () => {
    const report = queueReuseReport(rendered, required, ['onboarding', 'income'], 'success');
    assert.ok(report.kind === 'report');
    assert.match(report.lines[0] ?? '', /^reused: onboarding from run 900 /);
  });

  it('refuses the reuse when the schema verification failed, was skipped or left no result', () => {
    for (const result of ['failure', 'skipped', 'cancelled', '']) {
      const report = queueReuseReport(rendered, required, ['native', 'onboarding'], result);
      assert.ok(report.kind === 'schema-unverified', result);
      assert.match(report.message,
        new RegExp(`^onboarding reuses pull request evidence, but prepare-dev-e2e-schema ended ${result || 'without a result'} `));
      assert.equal(report.lines.length, 2);
    }
  });

  it('leaves a native-only context to its own verdict', () => {
    assert.equal(queueReuseReport(rendered, required, ['native'], '').kind, 'report');
  });
});

it('keeps the queue reuse record through the successful-run artifact cleanup', () => {
  const removable = removableArtifacts({
    artifacts: [
      { id: 1, name: 'ios-queue-evidence-reuse-1', size_in_bytes: 10 },
      { id: 2, name: 'ios-native-selection-record-1', size_in_bytes: 10 },
      { id: 3, name: 'ios-native-test-products', size_in_bytes: 10 },
    ],
  });
  assert.deepEqual(removable.map((artifact) => artifact.id), [3]);
});

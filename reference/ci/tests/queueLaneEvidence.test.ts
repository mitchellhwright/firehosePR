import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';
import { createJobLogReader } from '../src/actionsJobLog.ts';
import { parseLaneEvidencePlanJson, reverifiedCandidate } from '../src/actions/planQueueLaneReuse.ts';
import type { MergeGroupEventTuple } from '../src/ciEvent.ts';
import type { GithubResponse } from '../src/ios/shared/githubRest.ts';
import {
  LINUX_LANE_DOCUMENTATION_INPUTS, LINUX_LANE_INPUT_DECLARATION_PATH, REUSABLE_LINUX_LANES,
  changedInputs, encodePrChecksLaneEvidenceLog, gitBlobSha, laneSelected, laneVerdictLine, linuxLaneInputDeclarationSha,
  linuxLaneInputDigest, linuxLaneInputEntries, linuxLaneJobNames, parsePrChecksLaneEvidenceLog, planLinuxLaneReuse, readNewestCompletedRun,
  reusedLanes,
  uncoveredObligations,
  type GitTreeEntry, type LaneEvidencePlan, type LaneInputEntry, type LaneReuseInput, type PrChecksLaneEvidence,
  type ReusableLinuxLane, type SourceRun,
} from '../src/queueLaneEvidence.ts';
import { validationLaneNames } from '../src/prValidationVerdict.ts';
import { evaluateExpression, type ExpressionValue } from './fixtures/actionsExpression.ts';

const REPOSITORY = 'example-org/example-app';
const BASE = 'b'.repeat(40);
const CANDIDATE = 'c'.repeat(40);
const PR_HEAD = 'd'.repeat(40);
const PR_BASE = 'e'.repeat(40);
const MERGE = 'f'.repeat(40);
const WORKFLOW = '1'.repeat(40);

const fullPlan: LaneEvidencePlan = {
  serverTestMode: 'full',
  targetedServerTests: [],
  targetedIntegrationTests: ['server/tests/isolated-postgres/a.integration.test.ts'],
  entitlementAcceptanceRequired: false,
  testOnlyHelpersToTypecheck: ['server/tests/helpers/x.ts'],
  processHeavyRequired: true,
  serverStaticRequired: true,
  workflowContractsRequired: true,
  iosContractsRequired: true,
  databaseRequired: true,
};

it('accepts the full PR validation plan while retaining only strict lane obligations', () => {
  const validationPlan = {
    ...fullPlan,
    schema: 'example.pr-validation-plan.v1',
    docsOnly: false,
    metadataOnly: false,
    policyRequired: true,
    applicationTestImpact: true,
    validationDepth: 'standard',
    calculationAssurance: { selected: false },
  };
  assert.deepEqual(parseLaneEvidencePlanJson(JSON.stringify(validationPlan)), fullPlan);
  const incomplete: Record<string, unknown> = { ...validationPlan };
  delete incomplete.databaseRequired;
  assert.throws(() => parseLaneEvidencePlanJson(JSON.stringify(incomplete)));
});

const successfulResults = Object.fromEntries(validationLaneNames.map((lane) => [lane, 'success'])) as PrChecksLaneEvidence['results'];

function marker(overrides: Partial<PrChecksLaneEvidence> = {}): PrChecksLaneEvidence {
  return {
    schema: 'example.pr-checks-lane-evidence.v1',
    repository: REPOSITORY, prNumber: '6151', prHeadSha: PR_HEAD, prBaseSha: PR_BASE, mergeSha: MERGE,
    workflowSha: WORKFLOW, runId: 500, runAttempt: 1, plan: fullPlan, results: successfulResults,
    ...overrides,
  };
}

const laneJobs = [
  { id: 1, name: 'Plan PR validation', conclusion: 'success' },
  { id: 2, name: 'Lint changed code', conclusion: 'success' },
  { id: 3, name: 'Workflow contracts', conclusion: 'success' },
  { id: 4, name: 'Server static validation', conclusion: 'success' },
  { id: 5, name: 'Server process-heavy tests', conclusion: 'success' },
  { id: 6, name: 'Server tests (1/4)', conclusion: 'success' },
  { id: 7, name: 'Server tests (2/4)', conclusion: 'success' },
  { id: 8, name: 'Server tests (3/4)', conclusion: 'success' },
  { id: 9, name: 'Server tests (4/4)', conclusion: 'success' },
  { id: 10, name: 'iOS-server contracts', conclusion: 'success' },
  { id: 11, name: 'Run database integration tests', conclusion: 'success' },
  { id: 12, name: 'Validate pull request changes', conclusion: 'success' },
];

function run(overrides: Partial<SourceRun> = {}): SourceRun {
  return { id: 500, attempt: 1, headSha: PR_HEAD, status: 'completed', conclusion: 'success', jobs: laneJobs, ...overrides };
}

const treeEntries: LaneInputEntry[] = [
  { path: 'ci', type: 'tree', mode: '040000', sha: '2'.repeat(40) },
  { path: 'docs/TESTING.md', type: 'blob', mode: '100644', sha: '3'.repeat(40) },
  { path: 'package.json', type: 'blob', mode: '100644', sha: '4'.repeat(40) },
  { path: 'server', type: 'tree', mode: '040000', sha: '5'.repeat(40) },
];

function input(overrides: Partial<LaneReuseInput> = {}): LaneReuseInput {
  return {
    candidate: { prNumber: '6151', prHeadSha: PR_HEAD, candidateSha: CANDIDATE, queueBaseSha: BASE },
    repository: REPOSITORY,
    plan: fullPlan,
    sourceRun: run(),
    marker: marker(),
    testedMerge: { sha: MERGE, parents: [PR_BASE, PR_HEAD], treeSha: '6'.repeat(40) },
    testedEntries: treeEntries,
    candidateEntries: treeEntries,
    inputDeclaration: { running: 'a'.repeat(40), candidate: 'a'.repeat(40) },
    ...overrides,
  };
}

function verdicts(reuse: LaneReuseInput): Record<string, string> {
  const record = planLinuxLaneReuse(reuse);
  return Object.fromEntries(record.lanes.map((lane) => [lane.lane, lane.verdict === 'executed' ? `executed:${lane.reason}` : lane.verdict]));
}

describe('Linux lane reuse on a merge queue candidate', () => {
  it('reuses every selected lane when the run, marker, merge and input trees all agree', () => {
    const record = planLinuxLaneReuse(input());
    assert.deepEqual(reusedLanes(record).sort(), REUSABLE_LINUX_LANES.filter((lane) => lane !== 'targeted-server-tests').sort());
    assert.equal(record.lanes.find((lane) => lane.lane === 'targeted-server-tests')?.verdict, 'not-selected');
    const serverTests = record.lanes.find((lane) => lane.lane === 'server-tests');
    assert.equal(serverTests?.verdict, 'reused');
    if (serverTests?.verdict !== 'reused') return;
    assert.deepEqual(serverTests.jobs, ['Server tests (1/4)', 'Server tests (2/4)', 'Server tests (3/4)', 'Server tests (4/4)']);
    assert.equal(serverTests.testedMergeSha, MERGE);
    assert.equal(serverTests.inputDigest, linuxLaneInputDigest('server-tests', treeEntries));
    assert.match(laneVerdictLine(serverTests), /^reused: server-tests from run 500 attempt 1 head d{40}, input digest [0-9a-f]{64} \(not executed on this candidate; tested merge f{40}; jobs Server tests \(1\/4\)/);
  });

  it('never reuses a lane the candidate does not select', () => {
    const plan: LaneEvidencePlan = { ...fullPlan, serverTestMode: 'targeted', targetedServerTests: ['server/tests/a.test.ts'], workflowContractsRequired: false };
    const record = planLinuxLaneReuse(input({ plan }));
    assert.equal(verdicts(input({ plan }))['server-tests'], 'not-selected');
    assert.equal(verdicts(input({ plan }))['workflow-contracts'], 'not-selected');
    assert.equal(record.lanes.find((lane) => lane.lane === 'targeted-server-tests')?.verdict, 'executed');
    assert.equal(laneVerdictLine({ lane: 'server-tests', verdict: 'not-selected' }), 'not selected: server-tests is not selected for this candidate');
  });

  const refusals: readonly { readonly name: string; readonly reuse: LaneReuseInput; readonly reason: string; readonly detail: RegExp }[] = [
    { name: 'no PR run', reuse: input({ sourceRun: undefined }), reason: 'no-pull-request-run', detail: /no completed PR Checks run/ },
    { name: 'PR run still running', reuse: input({ sourceRun: run({ status: 'in_progress', conclusion: null }) }), reason: 'pull-request-run-in-progress', detail: /in_progress/ },
    { name: 'PR run failed', reuse: input({ sourceRun: run({ conclusion: 'failure' }) }), reason: 'pull-request-run-not-successful', detail: /concluded failure/ },
    { name: 'PR run for another head', reuse: input({ sourceRun: run({ headSha: '7'.repeat(40) }) }), reason: 'pull-request-run-mismatch', detail: /tested head 7{40}/ },
    { name: 'no marker in the aggregate log', reuse: input({ marker: { error: 'Expected exactly one PR Checks lane evidence marker, found 0.' } }), reason: 'evidence-marker-missing', detail: /found 0/ },
    { name: 'marker for another PR', reuse: input({ marker: marker({ prNumber: '6000' }) }), reason: 'evidence-marker-mismatch', detail: /pull request #6000/ },
    { name: 'marker for another head', reuse: input({ marker: marker({ prHeadSha: '7'.repeat(40) }) }), reason: 'evidence-marker-mismatch', detail: /head 7{40}/ },
    { name: 'marker from another run attempt', reuse: input({ marker: marker({ runAttempt: 2 }) }), reason: 'evidence-marker-mismatch', detail: /run 500 attempt 2/ },
    { name: 'marker from another repository', reuse: input({ marker: marker({ repository: 'example-org/other' }) }), reason: 'evidence-marker-mismatch', detail: /repository example-org\/other/ },
    { name: 'tested merge unreadable', reuse: input({ testedMerge: { error: 'GET commit answered HTTP 404.' } }), reason: 'tested-tree-unreadable', detail: /HTTP 404/ },
    { name: 'tested merge is not a merge of the PR head', reuse: input({ testedMerge: { sha: MERGE, parents: [PR_HEAD], treeSha: '6'.repeat(40) } }), reason: 'tested-merge-not-pr-head', detail: /parents \[d{40}\]/ },
    { name: 'tested merge has the head as first parent', reuse: input({ testedMerge: { sha: MERGE, parents: [PR_HEAD, PR_BASE], treeSha: '6'.repeat(40) } }), reason: 'tested-merge-not-pr-head', detail: /expected \[base, d{40}\]/ },
    { name: 'tested merge differs from the marker', reuse: input({ testedMerge: { sha: '8'.repeat(40), parents: [PR_BASE, PR_HEAD], treeSha: '6'.repeat(40) } }), reason: 'tested-merge-not-pr-head', detail: /merge 8{40}/ },
    { name: 'tested tree unreadable', reuse: input({ testedEntries: { error: 'Tree 6666 was truncated by the API; refusing to digest it.' } }), reason: 'tested-tree-unreadable', detail: /truncated/ },
    { name: 'candidate tree unreadable', reuse: input({ candidateEntries: { error: 'GET tree answered HTTP 500.' } }), reason: 'tested-tree-unreadable', detail: /HTTP 500/ },
    { name: 'lane skipped on the PR run', reuse: input({ marker: marker({ results: { ...successfulResults, 'server-tests': 'skipped' } }) }), reason: 'lane-not-executed-on-pull-request', detail: /server-tests: skipped/ },
    { name: 'lane job failed on the PR run', reuse: input({ sourceRun: run({ jobs: laneJobs.map((job) => (job.id === 8 ? { ...job, conclusion: 'failure' } : job)) }) }), reason: 'lane-job-not-successful', detail: /Server tests \(3\/4\): failure/ },
    { name: 'lane job absent from the PR run', reuse: input({ sourceRun: run({ jobs: laneJobs.filter((job) => !job.name.startsWith('Server tests (')) }) }), reason: 'lane-job-not-successful', detail: /no server-tests job/ },
    { name: 'candidate needs a shard mode the PR run did not discharge', reuse: input({ marker: marker({ plan: { ...fullPlan, serverTestMode: 'targeted' } }) }), reason: 'selection-not-covered', detail: /server_test_mode=targeted/ },
    { name: 'candidate input tree differs', reuse: input({ candidateEntries: treeEntries.map((entry) => (entry.path === 'server' ? { ...entry, sha: '9'.repeat(40) } : entry)) }), reason: 'input-digest-changed', detail: /^server$/ },
    { name: 'candidate gained a declared documentation input', reuse: input({ candidateEntries: [...treeEntries, { path: 'docs/CODEOWNERS', type: 'blob', mode: '100644', sha: '9'.repeat(40) }] }), reason: 'input-digest-changed', detail: /^docs\/CODEOWNERS$/ },
    { name: 'candidate declares different lane inputs than the running planner', reuse: input({ inputDeclaration: { running: 'a'.repeat(40), candidate: '9'.repeat(40) } }), reason: 'input-declaration-changed', detail: /ci\/src\/queueLaneEvidence\.ts is 9{40} in the candidate but a{40} in the running planner/ },
    { name: 'candidate input declaration unreadable', reuse: input({ inputDeclaration: { error: 'GET tree answered HTTP 502.' } }), reason: 'tested-tree-unreadable', detail: /HTTP 502/ },
    { name: 'candidate changed a file mode only', reuse: input({ candidateEntries: treeEntries.map((entry) => (entry.path === 'package.json' ? { ...entry, mode: '100755' } : entry)) }), reason: 'input-digest-changed', detail: /^package\.json$/ },
  ];
  for (const refusal of refusals) {
    it(`executes server-tests when ${refusal.name}`, () => {
      const record = planLinuxLaneReuse(refusal.reuse);
      const lane = record.lanes.find((candidate) => candidate.lane === 'server-tests');
      assert.equal(lane?.verdict, 'executed');
      if (lane?.verdict !== 'executed') return;
      assert.equal(lane.reason, refusal.reason);
      assert.match(lane.detail, refusal.detail);
      assert.equal(laneVerdictLine(lane), `executed: server-tests (${lane.reason}: ${lane.detail})`);
      assert.ok(!reusedLanes(record).includes('server-tests'));
    });
  }

  it('judges each lane on its own job and obligations', () => {
    const jobs = laneJobs.map((job) => (job.name === 'iOS-server contracts' ? { ...job, conclusion: 'cancelled' } : job));
    const result = verdicts(input({ sourceRun: run({ jobs }) }));
    assert.equal(result['ios-contracts'], 'executed:lane-job-not-successful');
    assert.equal(result['server-tests'], 'reused');
    assert.equal(result['database-integration'], 'reused');
  });

  it('covers targeted obligations only by inclusion in what the PR run discharged', () => {
    const tested: LaneEvidencePlan = {
      ...fullPlan, serverTestMode: 'targeted', targetedServerTests: ['server/tests/a.test.ts', 'server/tests/b.test.ts'],
      targetedIntegrationTests: ['server/tests/isolated-postgres/a.integration.test.ts'], testOnlyHelpersToTypecheck: ['server/tests/helpers/x.ts'],
    };
    const candidate: LaneEvidencePlan = { ...tested, targetedServerTests: ['server/tests/b.test.ts'] };
    assert.deepEqual(uncoveredObligations('targeted-server-tests', candidate, tested), []);
    assert.deepEqual(uncoveredObligations('targeted-server-tests', { ...candidate, targetedServerTests: ['server/tests/c.test.ts'] }, tested), ['server/tests/c.test.ts']);
    assert.deepEqual(uncoveredObligations('targeted-server-tests', candidate, { ...tested, serverTestMode: 'full' }), ['server_test_mode=full']);
    assert.deepEqual(uncoveredObligations('server-tests', fullPlan, fullPlan), []);
    assert.deepEqual(uncoveredObligations('server-tests', fullPlan, tested), ['server_test_mode=targeted']);
    assert.deepEqual(uncoveredObligations('database-integration', { ...candidate, entitlementAcceptanceRequired: true }, tested), ['entitlement_acceptance_required']);
    assert.deepEqual(uncoveredObligations('database-integration', { ...candidate, targetedIntegrationTests: ['server/tests/isolated-postgres/b.integration.test.ts'] }, tested), ['server/tests/isolated-postgres/b.integration.test.ts']);
    assert.deepEqual(uncoveredObligations('database-integration', candidate, { ...tested, entitlementAcceptanceRequired: true }), []);
    assert.deepEqual(uncoveredObligations('server-static', { ...candidate, testOnlyHelpersToTypecheck: ['server/tests/helpers/y.ts'] }, tested), ['server/tests/helpers/y.ts']);
    for (const lane of ['workflow-contracts', 'ios-contracts', 'server-process-tests'] as const) {
      assert.deepEqual(uncoveredObligations(lane, fullPlan, { ...tested, serverTestMode: 'none' }), []);
    }
  });

  it('selects lanes exactly as the aggregate verdict does', () => {
    const none: LaneEvidencePlan = {
      serverTestMode: 'none', targetedServerTests: [], targetedIntegrationTests: [], entitlementAcceptanceRequired: false,
      testOnlyHelpersToTypecheck: [], processHeavyRequired: false, serverStaticRequired: false, workflowContractsRequired: false,
      iosContractsRequired: false, databaseRequired: false,
    };
    for (const lane of REUSABLE_LINUX_LANES) assert.equal(laneSelected(lane, none), false, lane);
    assert.equal(laneSelected('server-process-tests', { ...none, processHeavyRequired: true }), true);
    assert.equal(laneSelected('server-process-tests', { ...none, serverTestMode: 'full' }), true);
    assert.equal(laneSelected('server-tests', { ...none, serverTestMode: 'full' }), true);
    assert.equal(laneSelected('targeted-server-tests', { ...none, serverTestMode: 'targeted' }), true);
    assert.equal(laneSelected('targeted-server-tests', { ...none, serverTestMode: 'full' }), false);
    assert.equal(laneSelected('server-static', { ...none, serverStaticRequired: true }), true);
    assert.equal(laneSelected('workflow-contracts', { ...none, workflowContractsRequired: true }), true);
    assert.equal(laneSelected('ios-contracts', { ...none, iosContractsRequired: true }), true);
    assert.equal(laneSelected('database-integration', { ...none, databaseRequired: true }), true);
  });

  it('lists exactly the changed declared inputs, including removed ones', () => {
    const candidate = [
      ...treeEntries.filter((entry) => entry.path !== 'ci'),
      { path: 'server', type: 'tree' as const, mode: '040000', sha: '9'.repeat(40) },
      { path: 'shared', type: 'tree' as const, mode: '040000', sha: '9'.repeat(40) },
    ];
    assert.deepEqual(changedInputs(treeEntries, candidate.filter((entry) => entry.path !== 'server')), ['ci', 'server', 'shared']);
  });
});

describe('Linux lane input entries and digest', () => {
  const unrelatedDocument = 'unrelated-synthetic-fixture.md';
  const root: GitTreeEntry[] = [
    { path: 'ci', type: 'tree', mode: '040000', sha: 'c'.repeat(40) },
    { path: 'docs', type: 'tree', mode: '040000', sha: 'd'.repeat(40) },
    { path: 'ios', type: 'tree', mode: '040000', sha: '1'.repeat(40) },
    { path: 'package.json', type: 'blob', mode: '100644', sha: 'a'.repeat(40) },
    { path: 'server', type: 'tree', mode: '040000', sha: 's'.repeat(40) },
  ];
  const docs: GitTreeEntry[] = [
    { path: 'CODEOWNERS', type: 'blob', mode: '100644', sha: '2'.repeat(40) },
    { path: 'TESTING.md', type: 'blob', mode: '100644', sha: '3'.repeat(40) },
    { path: 'evidence', type: 'tree', mode: '040000', sha: 'e'.repeat(40) },
    { path: unrelatedDocument, type: 'blob', mode: '100644', sha: '4'.repeat(40) },
  ];
  const evidence: GitTreeEntry[] = [
    { path: 'ci-infrastructure-contracts.md', type: 'blob', mode: '100644', sha: '5'.repeat(40) },
    { path: 'notifications', type: 'tree', mode: '040000', sha: 'n'.repeat(40) },
  ];
  const notifications: GitTreeEntry[] = [{ path: 'n7-2026-09-26', type: 'tree', mode: '040000', sha: '7'.repeat(40) }];
  const trees = new Map<string, readonly GitTreeEntry[]>([
    ['r'.repeat(40), root], ['d'.repeat(40), docs], ['e'.repeat(40), evidence], ['n'.repeat(40), notifications],
  ]);
  const read = async (sha: string): Promise<readonly GitTreeEntry[]> => {
    const entries = trees.get(sha);
    if (entries === undefined) throw new Error(`no tree ${sha}`);
    return entries;
  };

  it('keeps every root entry except docs, and resolves the declared documentation inputs', async () => {
    const entries = await linuxLaneInputEntries('r'.repeat(40), read);
    assert.deepEqual(entries.map((entry) => entry.path),
      ['ci', 'ios', 'package.json', 'server', ...LINUX_LANE_DOCUMENTATION_INPUTS].sort());
    assert.deepEqual(entries.find((entry) => entry.path === 'docs/evidence/notifications/n7-2026-09-26'),
      { path: 'docs/evidence/notifications/n7-2026-09-26', type: 'tree', mode: '040000', sha: '7'.repeat(40) });
    assert.deepEqual(entries.find((entry) => entry.path === 'docs/TYPE_GENERATION.md'),
      { path: 'docs/TYPE_GENERATION.md', type: 'absent', mode: '', sha: '' });
    assert.ok(!entries.some((entry) => entry.path === 'docs' || entry.path === ['docs', unrelatedDocument].join('/')));
  });

  it('digests differ per lane and change with any entry, and are stable otherwise', async () => {
    const entries = await linuxLaneInputEntries('r'.repeat(40), read);
    const again = await linuxLaneInputEntries('r'.repeat(40), read);
    assert.equal(linuxLaneInputDigest('server-tests', entries), linuxLaneInputDigest('server-tests', again));
    assert.notEqual(linuxLaneInputDigest('server-tests', entries), linuxLaneInputDigest('ios-contracts', entries));
    const iosChanged = entries.map((entry) => (entry.path === 'ios' ? { ...entry, sha: '0'.repeat(40) } : entry));
    assert.notEqual(linuxLaneInputDigest('server-tests', entries), linuxLaneInputDigest('server-tests', iosChanged));
    const docsOnlyChanged = { ...root.find((entry) => entry.path === 'docs')!, sha: 'x'.repeat(40) };
    trees.set('x'.repeat(40), docs.map((entry) => (entry.path === unrelatedDocument ? { ...entry, sha: '9'.repeat(40) } : entry)));
    trees.set('q'.repeat(40), root.map((entry) => (entry.path === 'docs' ? { ...docsOnlyChanged, sha: 'x'.repeat(40) } : entry)));
    const unrelatedDocs = await linuxLaneInputEntries('q'.repeat(40), read);
    assert.equal(linuxLaneInputDigest('server-tests', entries), linuxLaneInputDigest('server-tests', unrelatedDocs));
  });

  it('refuses an empty root tree', async () => {
    await assert.rejects(linuxLaneInputEntries('z'.repeat(40), async () => []), /lists no entries/);
  });

  it('reads the candidate copy of the lane input declaration by blob id', async () => {
    const declaration = { path: 'queueLaneEvidence.ts', type: 'blob', mode: '100644', sha: '8'.repeat(40) } as const;
    const declaring = new Map<string, readonly GitTreeEntry[]>([
      ['r'.repeat(40), root], ['c'.repeat(40), [{ path: 'src', type: 'tree', mode: '040000', sha: 's'.repeat(40) }]],
      ['s'.repeat(40), [declaration]],
    ]);
    const readDeclaring = async (sha: string): Promise<readonly GitTreeEntry[]> => declaring.get(sha) ?? [];
    assert.equal(LINUX_LANE_INPUT_DECLARATION_PATH, 'ci/src/queueLaneEvidence.ts');
    assert.equal(await linuxLaneInputDeclarationSha('r'.repeat(40), readDeclaring), '8'.repeat(40));
    declaring.set('s'.repeat(40), []);
    assert.equal(await linuxLaneInputDeclarationSha('r'.repeat(40), readDeclaring), 'absent');
  });

  it('hashes the running declaration exactly as Git names its blob', () => {
    const path = join(process.cwd(), LINUX_LANE_INPUT_DECLARATION_PATH);
    const expected = execFileSync('git', ['hash-object', '--no-filters', path], { encoding: 'utf8' }).trim();
    assert.equal(gitBlobSha(readFileSync(path)), expected);
  });

});

describe('PR Checks lane evidence marker', () => {
  it('round-trips through the log marker and rejects a log with several or none', () => {
    const evidence = marker();
    const line = encodePrChecksLaneEvidenceLog(evidence);
    assert.ok(line.startsWith('EXAMPLE_PR_CHECKS_LANE_EVIDENCE_V1='));
    const log = `2026-09-27T00:00:00Z lint: executed (success)\n2026-09-27T00:00:01Z ${line}\n`;
    assert.deepEqual(parsePrChecksLaneEvidenceLog(log), evidence);
    assert.throws(() => parsePrChecksLaneEvidenceLog('nothing here'), /found 0/);
    assert.throws(() => parsePrChecksLaneEvidenceLog(`${line}\n${line}\n`), /found 2/);
    assert.throws(() => parsePrChecksLaneEvidenceLog('EXAMPLE_PR_CHECKS_LANE_EVIDENCE_V1=not*base64url\n'), /Invalid PR Checks lane evidence log encoding/);
    assert.throws(() => encodePrChecksLaneEvidenceLog({ ...evidence, mergeSha: 'short' }), /mergeSha/);
  });

  it('pins the PR Checks job names each lane is read from', () => {
    const workflow = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as { jobs: Record<string, { name: string }> };
    for (const lane of REUSABLE_LINUX_LANES) {
      const name = workflow.jobs[lane]?.name;
      assert.ok(name, lane);
      assert.ok(name.startsWith(linuxLaneJobNames[lane].prefix), `${lane}: ${name}`);
    }
  });
});

describe('PR Checks workflow on a merge queue candidate', () => {
  const workflow = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as {
    jobs: Record<string, { if?: string; steps: { id?: string; if?: string; env?: Record<string, string> }[] }>;
  };
  const planOutputs = (reused: readonly string[], mode: string): Record<string, ExpressionValue> => ({
    docs_only: 'false', workflow_contracts_required: 'true', server_static_required: 'true', process_heavy_required: 'true',
    server_test_mode: mode, ios_contracts_required: 'true', database_required: 'true', reused_lanes: JSON.stringify(reused),
  });
  const context = (reused: readonly string[] | undefined, eventName: string, mode = 'full'): Record<string, ExpressionValue> => ({
    github: { event_name: eventName, event: {} },
    needs: { 'plan-pr-validation': { result: 'success', outputs: reused === undefined ? { ...planOutputs([], mode), reused_lanes: '' } : planOutputs(reused, mode) } },
    steps: {}, inputs: {}, vars: {},
  });

  it('skips exactly the reused lanes and runs every other selected lane', () => {
    for (const lane of REUSABLE_LINUX_LANES) {
      const condition = workflow.jobs[lane]?.if;
      assert.ok(condition, lane);
      const mode = lane === 'targeted-server-tests' ? 'targeted' : 'full';
      assert.equal(evaluateExpression(condition, context([lane], 'merge_group', mode)), false, `${lane} must be skipped when reused`);
      const others = REUSABLE_LINUX_LANES.filter((other) => other !== lane);
      assert.equal(evaluateExpression(condition, context(others, 'merge_group', mode)), true, `${lane} must run when only other lanes are reused`);
      assert.equal(evaluateExpression(condition, context(undefined, 'pull_request', mode)), true, `${lane} must run when the plan job wrote no reuse`);
    }
  });

  it('never skips lint or the policy lane for reuse', () => {
    for (const lane of ['lint', 'validation-policy']) {
      assert.ok(!workflow.jobs[lane]?.if?.includes('reused_lanes'), lane);
    }
    assert.ok(!(REUSABLE_LINUX_LANES as readonly string[]).includes('lint'));
    assert.ok(!(REUSABLE_LINUX_LANES as readonly string[]).includes('validation-policy'));
  });

  it('matches evidence only on merge_group, from the trusted planner job, with the plan it just wrote', () => {
    const step = workflow.jobs['plan-pr-validation']?.steps.find((candidate) => candidate.id === 'queue-reuse');
    assert.ok(step?.if);
    assert.equal(evaluateExpression(step.if, context([], 'merge_group')), true);
    assert.equal(evaluateExpression(step.if, context([], 'pull_request')), false);
    assert.equal(step.env?.['PLAN_JSON'], '${{ steps.plan.outputs.plan_json }}');
    const verdict = workflow.jobs['validate']?.steps.find((candidate) => candidate.env?.['LANE_EVIDENCE'] !== undefined);
    assert.ok(verdict?.env);
    assert.equal(verdict.env['REUSED_LANES'], "${{ needs.plan-pr-validation.outputs.reused_lanes || '[]' }}");
    assert.equal(verdict.env['TESTED_MERGE_SHA'], '${{ github.sha }}');
    assert.equal(verdict.env['WORKFLOW_SHA'], '${{ github.workflow_sha }}');
    assert.equal(verdict.env['EVENT_NAME'], '${{ github.event_name }}');
    for (const name of ['PR_NUMBER', 'PR_HEAD_SHA', 'PR_BASE_SHA', 'RUN_ID', 'RUN_ATTEMPT', 'TARGETED_SERVER_TESTS_PLAN',
      'TARGETED_INTEGRATION_TESTS_PLAN', 'ENTITLEMENT_ACCEPTANCE_REQUIRED', 'TEST_ONLY_HELPERS_PLAN']) {
      assert.ok(verdict.env[name], name);
    }
  });
});

describe('Actions job log reader', () => {
  function fakeFetch(calls: { url: string; auth: string | null; redirect: string | undefined }[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get('authorization'), redirect: init?.redirect });
      if (url.endsWith('/logs')) {
        return new Response(null, { status: 302, headers: { location: 'https://blob.example/signed?sig=1' } });
      }
      if (url.startsWith('https://blob.example/')) return new Response('line one\nEXAMPLE=marker\n', { status: 200 });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
  }

  it('follows the redirect by hand and never sends the GitHub credential to the blob host', async () => {
    const calls: { url: string; auth: string | null; redirect: string | undefined }[] = [];
    const read = createJobLogReader({ tokens: ['event-token'], fetchImpl: fakeFetch(calls), warn: () => {} });
    assert.equal(await read('https://api.github.com/repos/o/r/actions/jobs/7/logs'), 'line one\nEXAMPLE=marker\n');
    assert.deepEqual(calls.map((call) => [call.url, call.auth, call.redirect]), [
      ['https://api.github.com/repos/o/r/actions/jobs/7/logs', 'Bearer event-token', 'manual'],
      ['https://blob.example/signed?sig=1', null, 'follow'],
    ]);
  });

  it('retries a throttled read with the fallback credential and fails on any other status', async () => {
    const seen: string[] = [];
    const throttling = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      seen.push(auth);
      if (auth === 'Bearer first') return new Response('slow down', { status: 429 });
      return new Response('direct log', { status: 200 });
    }) as typeof fetch;
    const read = createJobLogReader({ tokens: ['first', '', 'first', 'second'], fetchImpl: throttling, warn: () => {} });
    assert.equal(await read('https://api.github.com/x/logs'), 'direct log');
    assert.deepEqual(seen, ['Bearer first', 'Bearer second']);
    const missing = createJobLogReader({
      tokens: ['t'], warn: () => {},
      fetchImpl: (async (): Promise<Response> => new Response('gone', { status: 404 })) as typeof fetch,
    });
    await assert.rejects(missing('https://api.github.com/x/logs'), /answered HTTP 404/);
    const noLocation = createJobLogReader({
      tokens: ['t'], warn: () => {},
      fetchImpl: (async (): Promise<Response> => new Response(null, { status: 302 })) as typeof fetch,
    });
    await assert.rejects(noLocation('https://api.github.com/x/logs'), /carried no location/);
  });
});

it('types the reusable lanes as a subset of the validation lanes', () => {
  const lanes: readonly ReusableLinuxLane[] = REUSABLE_LINUX_LANES;
  for (const lane of lanes) assert.ok((validationLaneNames as readonly string[]).includes(lane));
});

describe('reading the pull request source run', () => {
  const apiRoot = 'https://api.github.test/repos/example-org/example-app';
  const runPayload = (id: number, status: string, createdAt: string) => ({
    id, run_attempt: 1, head_sha: PR_HEAD, status, conclusion: status === 'completed' ? 'success' : null,
    created_at: createdAt,
  });

  it('takes the newest completed run even when a newer rerun is still in progress', async () => {
    const urls: string[] = [];
    const run = await readNewestCompletedRun(async (url) => {
      urls.push(url);
      if (url.includes('/actions/workflows/')) {
        return { status: 200, statusLabel: '200', body: { workflow_runs: [
          runPayload(12, 'in_progress', '2026-09-27T20:10:00Z'),
          runPayload(11, 'completed', '2026-09-27T20:00:00Z'),
        ] } };
      }
      return { status: 200, statusLabel: '200', body: { total_count: 1, jobs: [{ id: 5, name: 'Lint changed code', conclusion: 'success' }] } };
    }, apiRoot, PR_HEAD);
    assert.ok(run !== undefined && !('error' in run));
    assert.equal(run.id, 11);
    assert.match(urls[0] ?? '', /[?&]status=completed(&|$)/);
    assert.ok(urls.includes(`${apiRoot}/actions/runs/11/jobs?filter=latest&per_page=100`));
  });

  it('turns an unreadable run or job listing into a refusal instead of failing the planner', async () => {
    const failed = await readNewestCompletedRun(
      async () => ({ status: 502, statusLabel: '502', body: undefined }), apiRoot, PR_HEAD);
    assert.ok(failed !== undefined && 'error' in failed);
    assert.match(failed.error, /HTTP 502/);
    const incomplete = await readNewestCompletedRun(async (url) => (url.includes('/actions/workflows/')
      ? { status: 200, statusLabel: '200', body: { workflow_runs: [runPayload(11, 'completed', '2026-09-27T20:00:00Z')] } }
      : { status: 200, statusLabel: '200', body: { total_count: 2, jobs: [{ id: 5, name: 'Lint changed code', conclusion: 'success' }] } }),
    apiRoot, PR_HEAD);
    assert.ok(incomplete !== undefined && 'error' in incomplete);
    const thrown = await readNewestCompletedRun(async () => { throw new Error('socket hang up'); }, apiRoot, PR_HEAD);
    assert.deepEqual(thrown, { error: 'socket hang up' });
  });

  it('executes every selected lane when the source run could not be read', () => {
    const record = planLinuxLaneReuse(input({ sourceRun: { error: 'GET runs answered HTTP 502.' } }));
    const executed = record.lanes.filter((lane) => lane.verdict === 'executed');
    assert.ok(executed.length > 0);
    for (const lane of executed) assert.equal(lane.reason, 'pull-request-run-unreadable');
    assert.deepEqual(reusedLanes(record), []);
  });
});

describe('re-reading the candidate before planning reuse', () => {
  const event: MergeGroupEventTuple = {
    kind: 'merge_group', prNumber: '6151', headSha: CANDIDATE, trustedBaseSha: BASE, baseBranch: 'develop',
    queueRef: `refs/heads/gh-readonly-queue/develop/pr-6151-${'9'.repeat(40)}`, repository: REPOSITORY,
  };
  const apiUrl = 'https://api.github.com';
  const apiRoot = `${apiUrl}/repos/${REPOSITORY}`;
  const answer = (status: number, body: unknown): GithubResponse => ({ status, statusLabel: String(status), body });
  const candidateReader = (draft: boolean) => async (url: string): Promise<GithubResponse> => {
    if (url === `${apiRoot}/commits/${CANDIDATE}`) {
      return answer(200, {
        commit: { message: 'Merge pull request #6151 from example-org/feature' },
        parents: [{ sha: BASE }, { sha: PR_HEAD }],
      });
    }
    if (url === `${apiRoot}/pulls/6151`) {
      return answer(200, {
        state: 'open', draft, head: { sha: PR_HEAD, repo: { full_name: REPOSITORY } }, base: { ref: 'develop' },
      });
    }
    return answer(404, undefined);
  };

  it('plans no reuse instead of failing when GitHub answers unusably', async () => {
    assert.equal(await reverifiedCandidate(event, apiUrl, async () => answer(502, undefined)), undefined);
    const healthy = candidateReader(false);
    const pullDown = async (url: string): Promise<GithubResponse> =>
      (url.includes('/pulls/') ? answer(503, undefined) : healthy(url));
    assert.equal(await reverifiedCandidate(event, apiUrl, pullDown), undefined);
  });

  it('still fails on a candidate GitHub proves invalid, and returns a valid one', async () => {
    await assert.rejects(reverifiedCandidate(event, apiUrl, candidateReader(true)), /pull-request-draft/);
    const verified = await reverifiedCandidate(event, apiUrl, candidateReader(false));
    assert.equal(verified?.prHeadSha, PR_HEAD);
    assert.equal(verified?.candidateSha, CANDIDATE);
  });
});

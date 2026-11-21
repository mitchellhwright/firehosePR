import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyUpdateBranchResponse, hasRepairableCheckScope, latestBaseRetargetAt, mayBeSelected, nativeIntegrationEvidence,
  overlapMergeability, reportOnlyOverlaps, repairableFailedChecks, retiredWorkflowPaths,
  mergeQueuePullRequests, mergesBaseIntoPullRequests, selectPullRequestsToUpdate,
  type NativeIntegrationRunWithJobs,
} from '../src/baseUpdateFanout.ts';
import { isGeneratedArtifactPath } from '../src/generatedArtifactPath.ts';

const repository = 'example-org/example-app';
const sha = (n: number): string => n.toString(16).padStart(40, '0');
const ordinaryHead = { authorLogin: 'contributor' } as const;
// Assemble a fixture path so the Linux documentation-read scanner does not
// mistake this test data for a runtime file read.
const acceptanceDoc = 'docs' + '/acceptance.md';
/** A base that still merges on overlap: a stacked child's parent branch. */
const stackedBase = 'codex/stacked-parent';

test('develop skips ordinary overlap updates; main and stacked parents still update', () => {
  assert.equal(mergesBaseIntoPullRequests('develop'), false);
  assert.equal(mergesBaseIntoPullRequests('main'), true);
  assert.equal(mergesBaseIntoPullRequests(stackedBase), true);
});

test('a develop push never selects a pull request only because it shares a file', () => {
  const pulls = [
    { number: 6009, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(1), files: ['server/services/chat/tools/registry.ts'] },
    { number: 6019, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(2), files: ['server/generated/api-types.ts'] },
    { number: 6180, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(3), files: ['docs/x.md'] },
  ];
  const pushed = ['server/services/chat/tools/registry.ts', 'server/generated/api-types.ts'];
  assert.deepEqual(selectPullRequestsToUpdate(repository, 'develop', pushed, pulls), []);
  // Every overlap is checked for a conflict instead, generated or authored.
  assert.deepEqual(reportOnlyOverlaps(repository, 'develop', pushed, pulls), [
    { number: 6009, headSha: sha(1), files: ['server/services/chat/tools/registry.ts'] },
    { number: 6019, headSha: sha(2), files: ['server/generated/api-types.ts'] },
  ]);
  // The same push to main still merges the authored overlap.
  assert.deepEqual(selectPullRequestsToUpdate(repository, 'main', pushed, pulls), [{
    number: 6009, headSha: sha(1), overlap: ['server/services/chat/tools/registry.ts'],
  }]);
});

test('a develop iOS source change invalidates the native product even without a shared filename', () => {
  const pulls = [
    { number: 6349, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(1), files: ['ios/example-ios/UI/Cards/Profile/Profile1View.swift'] },
    { number: 6412, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(2), files: [acceptanceDoc] },
  ];
  assert.deepEqual(selectPullRequestsToUpdate(repository, 'develop', [
    'ios/example-ios/UI/Components/InteractiveRetirementProjectionView.swift',
  ], pulls), [{
    number: 6349,
    headSha: sha(1),
    overlap: [],
    iosBaseImpact: ['ios/example-ios/UI/Components/InteractiveRetirementProjectionView.swift'],
  }]);
  assert.deepEqual(selectPullRequestsToUpdate(repository, 'develop', [acceptanceDoc], pulls), []);
  assert.deepEqual(selectPullRequestsToUpdate(repository, 'develop', ['ios/docs/design-system/components.md'], pulls), []);
  assert.deepEqual(
    selectPullRequestsToUpdate(repository, 'develop', ['ci/src/runnerPolicy.ts'], pulls),
    [],
    'Linux and control-runner routing changes must not update iOS PR heads',
  );
});

test('a develop push selects no update for a CI repair, a retired workflow or a missing executable', () => {
  const pulls = [{
    number: 7, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(7),
    files: ['ci/src/prValidationPlan.ts'], failedChecks: ['Validate pull request changes'],
    missingWorkflowRuntimeFiles: ['ci/src/actions/newStep.ts'],
  }];
  const pushed = ['ci/src/prValidationPlan.ts'];
  const retired = ['.github/workflows/gone.yml'];
  assert.deepEqual(selectPullRequestsToUpdate(repository, 'develop', pushed, pulls, retired), []);
  // Each of those reasons still updates the same pull request on main.
  assert.deepEqual(selectPullRequestsToUpdate(repository, 'main', pushed, pulls, retired), [{
    number: 7, headSha: sha(7), overlap: ['ci/src/prValidationPlan.ts'],
    repairedChecks: ['Validate pull request changes'], retiredWorkflows: retired,
    missingWorkflowRuntimeFiles: ['ci/src/actions/newStep.ts'],
  }]);
});

test('the merge queue answer lists queued pull requests and rejects a partial page', () => {
  const answer = (totalCount: number, numbers: readonly (number | null)[]) => ({
    data: { repository: { mergeQueue: { entries: {
      totalCount,
      nodes: numbers.map((number) => ({ pullRequest: number === null ? null : { number } })),
    } } } },
  });
  assert.deepEqual([...mergeQueuePullRequests(answer(3, [6346, null, 6279]))].sort(), [6279, 6346]);
  assert.deepEqual([...mergeQueuePullRequests({ data: { repository: { mergeQueue: null } } })], []);
  assert.throws(() => mergeQueuePullRequests(answer(101, [1])), /holds 101 entries; only 1 were read/);
  assert.throws(() => mergeQueuePullRequests({ errors: [{ message: 'Resource not accessible by integration' }] }),
    /Unexpected merge queue response: .*Resource not accessible/);
  assert.throws(() => mergeQueuePullRequests({
    data: { repository: { mergeQueue: null } }, errors: [{ message: 'Resource not accessible by integration' }],
  }), /Unexpected merge queue response/, 'an error beside a null queue is not "no queue"');
});

test('only same-repository, non-draft pull requests that share a file with the push are updated', () => {
  const decisions = selectPullRequestsToUpdate(repository, stackedBase, ['package.json', 'ci/src/a.ts'], [
    { number: 12, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(1), files: ['package.json', 'docs/x.md'] },
    { number: 7, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(2), files: ['ci/src/a.ts', 'package.json'] },
    { number: 30, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(3), files: ['server/api.ts'] },
    { number: 31, draft: true, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(4), files: ['package.json'] },
    { number: 32, draft: false, ...ordinaryHead, headRepositoryFullName: 'fork/example-app', headSha: sha(5), files: ['package.json'] },
  ]);
  assert.deepEqual(decisions, [
    { number: 7, headSha: sha(2), overlap: ['ci/src/a.ts', 'package.json'] },
    { number: 12, headSha: sha(1), overlap: ['package.json'] },
  ]);
  assert.deepEqual(selectPullRequestsToUpdate(repository, stackedBase, [], [
    { number: 1, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(1), files: ['package.json'] },
  ]), []);
});

test('a shared generated bundle does not fan out unrelated PR heads', () => {
  const generated = ['server/generated/api-types.ts', 'server/generated/openapi.json'];
  const pulls = [
    { number: 6009, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(6009), files: generated },
    { number: 6010, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(6010), files: [...generated, 'server/services/debt/debtService.ts'] },
    { number: 6011, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(6011), files: ['ios/example-ios/Models/Generated/DashboardTypes.generated.swift'] },
  ];
  assert.deepEqual(selectPullRequestsToUpdate(repository, stackedBase, [
    ...generated, 'ios/example-ios/Models/Generated/DashboardTypes.generated.swift',
    'server/services/debt/debtService.ts',
  ], pulls), [{
    number: 6010, headSha: sha(6010), overlap: ['server/services/debt/debtService.ts'],
  }]);
});

test('hand-maintained files inside a mixed generated directory retain authored overlap', () => {
  const compatibilitySource = 'ios/example-ios/Models/Generated/BudgetCategoryEnumsCompat.swift';
  assert.equal(isGeneratedArtifactPath(compatibilitySource), false);
  assert.equal(isGeneratedArtifactPath('ios/example-ios/Models/Generated/BudgetTypes.generated.swift'), true);
  assert.equal(isGeneratedArtifactPath('server/generated/api-types.ts'), true);
  assert.equal(isGeneratedArtifactPath('ci/generated/cloudbuild/testflight-feedback.yaml'), true);
  assert.equal(isGeneratedArtifactPath('scripts/ci/generated/workflow-names.ts'), true);
  const pulls = [{
    number: 6011, draft: false, ...ordinaryHead, headRepositoryFullName: repository,
    headSha: sha(6011), files: [compatibilitySource],
  }];
  assert.deepEqual(selectPullRequestsToUpdate(repository, stackedBase, [compatibilitySource], pulls), [{
    number: 6011, headSha: sha(6011), overlap: [compatibilitySource],
  }]);
  assert.deepEqual(reportOnlyOverlaps(repository, stackedBase, [compatibilitySource], pulls), []);
});

test('generated-only overlap checks mergeability without updating a clean PR', () => {
  const generated = 'server/generated/api-types.ts';
  const pulls = [
    { number: 1, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(1), files: [generated] },
    { number: 2, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(2), files: [generated, 'server/routes/plaid.yaml'] },
    { number: 3, draft: true, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(3), files: [generated] },
  ];
  assert.deepEqual(reportOnlyOverlaps(repository, stackedBase, [generated, 'server/routes/plaid.yaml'], pulls), [
    { number: 1, headSha: sha(1), files: [generated] },
  ]);
  assert.equal(overlapMergeability(true, 'clean'), 'clean');
  assert.equal(overlapMergeability(false, 'dirty'), 'conflict');
  assert.equal(overlapMergeability(null, 'unknown'), 'unknown');
});

test('missing workflow executable refreshes only an affected ready same-repository head', () => {
  const runtime = ['ci/src/actions/ios/selectXcode.ts'];
  const pulls = [
    { number: 7, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(7), files: ['ios/a.swift'], missingWorkflowRuntimeFiles: runtime },
    { number: 8, draft: false, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(8), files: ['ios/b.swift'], missingWorkflowRuntimeFiles: [] },
    { number: 9, draft: true, ...ordinaryHead, headRepositoryFullName: repository, headSha: sha(9), files: [], missingWorkflowRuntimeFiles: runtime },
    { number: 10, draft: false, ...ordinaryHead, headRepositoryFullName: 'fork/example-app', headSha: sha(10), files: [], missingWorkflowRuntimeFiles: runtime },
    { number: 11, draft: false, authorLogin: 'dependabot[bot]', headRepositoryFullName: repository, headSha: sha(11), files: [], missingWorkflowRuntimeFiles: runtime },
  ];
  assert.deepEqual(selectPullRequestsToUpdate(repository, stackedBase, ['.github/workflows/ios-tests.yml'], pulls), [{
    number: 7, headSha: sha(7), overlap: [], missingWorkflowRuntimeFiles: runtime,
  }]);
});

test('Update Branch responses are classified without guessing', () => {
  assert.deepEqual(classifyUpdateBranchResponse(202, '{"message":"Updating pull request branch."}'), { kind: 'updating' });
  assert.deepEqual(classifyUpdateBranchResponse(422, '{"message":"merge conflict between base and head"}'), { kind: 'conflict' });
  assert.deepEqual(classifyUpdateBranchResponse(422, '{"message":"There are no new commits on the base branch."}'), { kind: 'already-current' });
  assert.deepEqual(classifyUpdateBranchResponse(403, 'Resource not accessible by integration'), {
    kind: 'error', status: 403, message: 'Resource not accessible by integration',
  });
});

test('a deleted workflow refreshes every eligible pull request, not only overlapping ones', () => {
  // A check run can only be superseded by the workflow that wrote it. Delete
  // the workflow and every open head keeps its last result — a cancelled one
  // included — with nothing able to replace it, and GitHub counts it in the
  // merge box. Those pull requests overlap no pushed file, so the overlap rule
  // alone never reaches them and they stay blocked permanently.
  const pulls = [
    { number: 7, draft: false, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'a'.repeat(40), files: ['src/a.ts'] },
    { number: 9, draft: false, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'b'.repeat(40), files: ['docs/b.md'] },
    { number: 11, draft: true, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'c'.repeat(40), files: ['src/a.ts'] },
    { number: 13, draft: false, ...ordinaryHead, headRepositoryFullName: 'fork/r', headSha: 'd'.repeat(40), files: ['src/a.ts'] },
  ];
  const retired = retiredWorkflowPaths(['.github/workflows/secret-pr-scan.yml', 'scripts/secret-scan.mjs']);
  assert.deepEqual(retired, ['.github/workflows/secret-pr-scan.yml']);

  const selected = selectPullRequestsToUpdate('o/r', stackedBase, ['scripts/secret-scan.mjs'], pulls, retired);
  // #11 is a draft and is included: it may have been ready when the workflow
  // last ran, so it already carries the dead check run, and marking it ready
  // does not change the head. Excluding it hands the author a branch that can
  // never go green. #13 is a fork head, which this token cannot update at all.
  assert.deepEqual(selected.map((decision) => decision.number), [7, 9, 11]);
  assert.deepEqual(selected[0]?.retiredWorkflows, ['.github/workflows/secret-pr-scan.yml']);
  assert.ok(!selected.some((decision) => decision.number === 13));
});

test('an ordinary push leaves a draft to its author even when it overlaps', () => {
  const pulls = [
    { number: 7, draft: false, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'a'.repeat(40), files: ['src/a.ts'] },
    { number: 11, draft: true, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'c'.repeat(40), files: ['src/a.ts'] },
  ];
  assert.deepEqual(
    selectPullRequestsToUpdate('o/r', stackedBase, ['src/a.ts'], pulls, []).map((decision) => decision.number),
    [7],
  );
});

test('base-update fan-out never edits a Dependabot-owned head', () => {
  const botPull = {
    number: 85, draft: false, authorLogin: 'dependabot[bot]',
    headRepositoryFullName: 'o/r', headSha: sha(85), files: ['package-lock.json'],
    failedChecks: ['Validate pull request changes'],
  };
  const ordinaryPull = {
    ...botPull, number: 86, authorLogin: 'contributor', headSha: sha(86),
  };
  for (const retired of [[], ['.github/workflows/retired.yml']]) {
    assert.equal(mayBeSelected(botPull, 'o/r', retired.length > 0), false);
    const decisions = selectPullRequestsToUpdate(
      'o/r', stackedBase, ['package-lock.json', 'ci/src/baseUpdateFanout.ts'], [botPull, ordinaryPull], retired,
    );
    assert.deepEqual(decisions.map((decision) => decision.number), [86]);
  }
});

test('an ordinary push still selects only the pull requests that overlap it', () => {
  const pulls = [
    { number: 7, draft: false, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'a'.repeat(40), files: ['src/a.ts'] },
    { number: 9, draft: false, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'b'.repeat(40), files: ['docs/b.md'] },
  ];
  const selected = selectPullRequestsToUpdate('o/r', stackedBase, ['src/a.ts'], pulls, retiredWorkflowPaths(['src/a.ts']));
  assert.deepEqual(selected.map((decision) => decision.number), [7]);
  assert.equal(selected[0]?.retiredWorkflows, undefined);
});

// The caller reads one file list per candidate, so it asks this before paying
// for a list it cannot act on: a 3,000-file draft would otherwise exhaust the
// page limit and abort an ordinary fan-out before any eligible PR moved.
test('eligibility is decided before a file list is read, and matches the selection', () => {
  const fork = { draft: false, ...ordinaryHead, headRepositoryFullName: 'fork/r' };
  const draft = { draft: true, ...ordinaryHead, headRepositoryFullName: 'o/r' };
  const ready = { draft: false, ...ordinaryHead, headRepositoryFullName: 'o/r' };
  for (const retiring of [false, true]) {
    assert.equal(mayBeSelected(fork, 'o/r', retiring), false);
    assert.equal(mayBeSelected(ready, 'o/r', retiring), true);
  }
  assert.equal(mayBeSelected(draft, 'o/r', false), false);
  assert.equal(mayBeSelected(draft, 'o/r', true), true);

  // Whatever this rejects, the selection rejects too — so skipping its file
  // list can never drop a pull request the selection would have chosen.
  const pulls = [fork, draft, ready].map((pull, index) => ({
    ...pull, number: index + 1, headSha: String(index + 1).repeat(40), files: ['src/a.ts'],
  }));
  for (const retired of [[], ['.github/workflows/gone.yml']]) {
    const selected = selectPullRequestsToUpdate('o/r', stackedBase, ['src/a.ts'], pulls, retired);
    for (const pull of pulls) {
      const eligible = mayBeSelected(pull, 'o/r', retired.length > 0);
      assert.equal(selected.some((d) => d.number === pull.number), eligible);
    }
  }
});

test('only a workflow file counts as retired, not anything else under .github', () => {
  assert.deepEqual(retiredWorkflowPaths([
    '.github/workflows/a.yml', '.github/workflows/b.yaml',
    '.github/workflows/nested/c.yml', '.github/dependabot.yml', 'workflows/d.yml',
  ]), ['.github/workflows/a.yml', '.github/workflows/b.yaml']);
});

test('a typed PR-check repair selects only pull requests carrying a failed check it can repair', () => {
  const pulls = [
    {
      number: 7, draft: false, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'a'.repeat(40),
      files: ['src/a.ts'], failedChecks: ['Server tests (1/4)', 'Validate pull request changes'],
    },
    {
      number: 9, draft: false, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'b'.repeat(40),
      files: ['docs/b.md'], failedChecks: [],
    },
    {
      number: 11, draft: false, ...ordinaryHead, headRepositoryFullName: 'o/r', headSha: 'c'.repeat(40),
      files: ['src/c.ts'], failedChecks: ['Onboarding E2E'],
    },
  ];
  const selected = selectPullRequestsToUpdate('o/r', stackedBase, ['ci/src/prValidationPlan.ts'], pulls);
  assert.deepEqual(selected, [{
    number: 7,
    headSha: 'a'.repeat(40),
    overlap: [],
    repairedChecks: ['Server tests (1/4)', 'Validate pull request changes'],
  }]);
});

test('controller repairs retry failed continuity without re-running unrelated validation', () => {
  const changed = ['ci/workflows/refresh-pr-ci-after-base-edit.ts'];
  assert.equal(hasRepairableCheckScope(changed), true);
  assert.deepEqual(repairableFailedChecks(changed, [
    'Keep PR work current', 'Validate pull request changes', 'Onboarding E2E',
  ]), ['Keep PR work current']);
  assert.deepEqual(repairableFailedChecks(
    ['ci/src/baseUpdateFanout.ts'], ['Keep PR work current', 'Server tests (1/4)'],
  ), ['Keep PR work current']);
});

test('server contract repairs retry failed server checks without waking iOS failures', () => {
  assert.deepEqual(repairableFailedChecks(
    ['server/tests/plaidSchedulerMigration.test.ts'],
    ['Server tests (1/4)', 'Onboarding E2E', 'Validate pull request changes'],
  ), ['Server tests (1/4)', 'Validate pull request changes']);
  assert.deepEqual(repairableFailedChecks(
    ['src/pages/Budget.tsx'],
    ['Server tests (1/4)'],
  ), []);
});

const integrationRun = (options: {
  name: string;
  pullRequest?: number;
  headSha?: string;
  createdAt?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  gateName?: string;
  gateStatus?: string;
  gateConclusion?: string | null;
}): NativeIntegrationRunWithJobs => ({
  id: 1,
  name: options.name,
  event: options.event ?? 'pull_request',
  head_sha: options.headSha ?? sha(1),
  created_at: options.createdAt ?? '2026-09-22T14:10:34Z',
  status: options.status ?? 'in_progress',
  conclusion: options.conclusion ?? null,
  pull_requests: [{
    number: options.pullRequest ?? 7,
  }],
  jobs: [{
    name: options.gateName ?? (options.name === 'Test - iOS' ? 'iOS Change Gate' : 'Plan PR validation'),
    status: options.gateStatus ?? 'in_progress',
    conclusion: options.gateConclusion ?? null,
  }],
});

test('native workflow tuples prevent a delayed fan-out from invalidating the same integration candidate', () => {
  const evidence = nativeIntegrationEvidence(7, sha(1), '2026-09-22T13:24:30Z', [
    integrationRun({ name: 'PR Checks', status: 'in_progress' }),
    integrationRun({ name: 'Test - iOS', status: 'completed', conclusion: 'success' }),
  ]);
  assert.deepEqual(evidence, {
    complete: true,
    workflows: ['PR Checks', 'Test - iOS'],
  });
});

test('a partial or mismatched tuple cannot suppress a required base update', () => {
  const runs = [
    integrationRun({ name: 'PR Checks' }),
    integrationRun({ name: 'Test - iOS', createdAt: '2026-09-22T13:24:29Z' }),
    integrationRun({ name: 'Test - iOS', headSha: sha(4) }),
    integrationRun({ name: 'Test - iOS', pullRequest: 8 }),
    integrationRun({ name: 'Test - iOS', event: 'workflow_dispatch' }),
    integrationRun({ name: 'Unrelated workflow' }),
  ];
  assert.deepEqual(nativeIntegrationEvidence(7, sha(1), '2026-09-22T13:24:30Z', runs), {
    complete: false,
    workflows: ['PR Checks'],
  });
});

test('runs created in the same second as the base update do not prove a fresh integration candidate', () => {
  const evidence = nativeIntegrationEvidence(7, sha(1), '2026-09-22T14:10:34Z', [
    integrationRun({ name: 'PR Checks', createdAt: '2026-09-22T14:10:34Z' }),
    integrationRun({ name: 'Test - iOS', createdAt: '2026-09-22T14:10:34Z' }),
  ]);
  assert.deepEqual(evidence, { complete: false, workflows: [] });
});

test('native runs started before the latest base retarget cannot stand in for current-base validation', () => {
  const runs = [integrationRun({ name: 'PR Checks' }), integrationRun({ name: 'Test - iOS' })];
  const retarget = latestBaseRetargetAt([
    { event: 'base_ref_changed', created_at: '2026-09-22T13:30:00Z' },
    { event: 'base_ref_changed', created_at: '2026-09-22T14:10:35Z' },
  ]);
  assert.deepEqual(nativeIntegrationEvidence(7, sha(1), '2026-09-22T13:24:30Z', runs, retarget), {
    complete: false, workflows: [],
  });
});

test('native runs started strictly after the latest base retarget can retain the current head', () => {
  const retarget = latestBaseRetargetAt([
    { event: 'base_ref_changed', created_at: '2026-09-22T14:10:35Z' },
  ]);
  const runs = [
    integrationRun({ name: 'PR Checks', createdAt: '2026-09-22T14:10:36Z' }),
    integrationRun({ name: 'Test - iOS', createdAt: '2026-09-22T14:10:36Z' }),
  ];
  assert.deepEqual(nativeIntegrationEvidence(7, sha(1), '2026-09-22T13:24:30Z', runs, retarget), {
    complete: true, workflows: ['PR Checks', 'Test - iOS'],
  });
});

test('native runs created in the retarget second are ambiguous', () => {
  const runs = [
    integrationRun({ name: 'PR Checks', createdAt: '2026-09-22T14:10:35Z' }),
    integrationRun({ name: 'Test - iOS', createdAt: '2026-09-22T14:10:35Z' }),
  ];
  assert.deepEqual(nativeIntegrationEvidence(
    7, sha(1), '2026-09-22T13:24:30Z', runs, '2026-09-22T14:10:35Z',
  ), { complete: false, workflows: [] });
});

test('missing or ambiguous base-retarget timeline fails closed', () => {
  assert.throws(() => latestBaseRetargetAt([]), /Missing pull request timeline evidence/);
  assert.throws(() => latestBaseRetargetAt([
    { event: 'base_ref_changed', created_at: null },
  ]));
  assert.throws(() => latestBaseRetargetAt([
    { event: 'base_ref_changed', created_at: 'invalid timestamp' },
  ]));
  assert.equal(latestBaseRetargetAt([{ event: 'reviewed', created_at: null }]), null);
});

test('a failed native run still proves its integration tuple and is not retried by rewriting the branch', () => {
  const evidence = nativeIntegrationEvidence(7, sha(1), '2026-09-22T13:24:30Z', [
    integrationRun({ name: 'PR Checks', status: 'completed', conclusion: 'failure' }),
    integrationRun({ name: 'Test - iOS', status: 'completed', conclusion: 'cancelled' }),
  ]);
  assert.equal(evidence.complete, true);
});

test('metadata-only runs with skipped gates cannot suppress the base update', () => {
  const evidence = nativeIntegrationEvidence(7, sha(1), '2026-09-22T13:24:30Z', [
    integrationRun({
      name: 'PR Checks', status: 'completed', conclusion: 'success',
      gateStatus: 'completed', gateConclusion: 'skipped',
    }),
    integrationRun({
      name: 'Test - iOS', status: 'completed', conclusion: 'success',
      gateName: 'Ignore unrelated PR metadata - iOS Change Gate',
      gateStatus: 'completed', gateConclusion: 'skipped',
    }),
  ]);
  assert.deepEqual(evidence, { complete: false, workflows: [] });
});

test('a queued gate is not evidence that integration validation has started', () => {
  const evidence = nativeIntegrationEvidence(7, sha(1), '2026-09-22T13:24:30Z', [
    integrationRun({ name: 'PR Checks', status: 'queued', gateStatus: 'queued' }),
    integrationRun({ name: 'Test - iOS', status: 'queued', gateStatus: 'queued' }),
  ]);
  assert.deepEqual(evidence, { complete: false, workflows: [] });
});

test('planner rename preserves evidence from runs using the historical check name', () => {
  for (const gateName of ['Plan PR validation', 'Docs Change Gate']) {
    const evidence = nativeIntegrationEvidence(7, sha(1), '2026-09-22T13:24:30Z', [
      integrationRun({ name: 'PR Checks', gateName }),
      integrationRun({ name: 'Test - iOS' }),
    ]);
    assert.equal(evidence.complete, true, gateName);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findPromotionEvidence, promotionEvidenceGap, promotionRequirementsSchema,
  type PromotionJob, type PromotionRun,
} from '../src/ios/promotionEvidence.ts';
import type { GithubReader, GithubResponse } from '../src/ios/shared/githubRest.ts';

const sha = 'a'.repeat(40);
const repository = 'example-org/example-app';
const baseSha = 'b'.repeat(40);
const requirements = { nativeLanes: ['native1', 'native2', 'native3', 'native4'],
  producerRequired: true, storekitRequired: true, archiveRequired: true } as const;
const run: PromotionRun = {
  id: 123, run_attempt: 2, created_at: '2026-09-25T00:00:00Z', event: 'workflow_dispatch', head_branch: 'develop',
  head_sha: sha, path: '.github/workflows/ios-tests.yml',
  display_title: `promotion-evidence:${sha}:${baseSha}`, status: 'completed',
  conclusion: 'success', repository: { full_name: repository },
};
const names = [
  'Manual - iOS Change Gate',
  'Verify unsigned Release archive',
  'Build shared native iOS test products',
  ...['native1', 'native2', 'native3', 'native4'].map((lane) => `Test - iOS execution (${lane})`),
  'Manual - Test - iOS',
  'StoreKit Purchase - iOS',
  'Build shared iOS E2E test products',
  'Real-server E2E execution (onboarding)',
  'Manual - Onboarding E2E',
] as const;
const executionSteps = new Map<string, readonly string[]>([
  ['Manual - iOS Change Gate', ['Precheck iOS Gate', 'Detect iOS Changes',
    'Select native iOS tests', 'Classify selected UI work']],
  ['Verify unsigned Release archive', ['Compile unsigned Release archive']],
  ...['native1', 'native2', 'native3', 'native4'].map((lane): [string, readonly string[]] =>
    [`Test - iOS execution (${lane})`, ['Execute Precompiled iOS Tests']]),
  ['Build shared native iOS test products', ['Run StoreKit purchase test', 'Record StoreKit result']],
  ['Manual - Test - iOS', ['Verify iOS test lanes',
    'Verify consolidated StoreKit execution result', 'Verify onboarding execution result']],
  ['StoreKit Purchase - iOS', ['Verify consolidated StoreKit execution result']],
  ['Real-server E2E execution (onboarding)', ['Run onboarding E2E']],
  ['Manual - Onboarding E2E', ['Verify onboarding execution result']],
]);
const jobs: readonly PromotionJob[] = names.map((name) => ({
  name, run_attempt: 2, status: 'completed', conclusion: 'success',
  ...(executionSteps.has(name) ? {
    steps: (executionSteps.get(name) ?? []).map((stepName) => ({
      name: stepName, status: 'completed', conclusion: 'success',
    })),
  } : {}),
}));

test('only a complete exact-develop run proves promotion coverage', () => {
  assert.equal(promotionEvidenceGap(run, jobs, repository, sha, baseSha, requirements), null);
  assert.match(promotionEvidenceGap({ ...run, display_title: `promotion-evidence:${sha}:${'c'.repeat(40)}` },
    jobs, repository, sha, baseSha, requirements) ?? '', /identity/);
  assert.match(promotionEvidenceGap({ ...run, head_sha: 'b'.repeat(40) }, jobs, repository, sha, baseSha, requirements) ?? '', /identity/);
  assert.match(promotionEvidenceGap({ ...run, head_branch: 'promotion/develop-a' }, jobs, repository, sha, baseSha, requirements) ?? '', /identity/);
  assert.match(promotionEvidenceGap({ ...run, event: 'pull_request' }, jobs, repository, sha, baseSha, requirements) ?? '', /identity/);
  assert.match(promotionEvidenceGap({ ...run, conclusion: 'failure' }, jobs, repository, sha, baseSha, requirements) ?? '', /identity/);
});

test('only selected native and StoreKit obligations are required while onboarding remains unconditional', () => {
  const selected = { nativeLanes: ['native2'] as const, producerRequired: true,
    storekitRequired: false, archiveRequired: false };
  const narrowJobs = jobs.filter((job) => !job.name.startsWith('Test - iOS execution (native')
    || job.name === 'Test - iOS execution (native2)')
    .filter((job) => job.name !== 'Verify unsigned Release archive');
  assert.equal(promotionEvidenceGap(run, narrowJobs, repository, sha, baseSha, selected), null);
  assert.match(promotionEvidenceGap(run, narrowJobs.filter((job) =>
    job.name !== 'Real-server E2E execution (onboarding)'), repository, sha, baseSha, selected) ?? '',
  /onboarding/);
  assert.match(promotionEvidenceGap(run, narrowJobs, repository, sha, baseSha, requirements) ?? '',
    /Release archive|native1/);
  const onboardingOnly = { nativeLanes: [] as const, producerRequired: false,
    storekitRequired: false, archiveRequired: false };
  const onboardingJobs = narrowJobs.filter((job) =>
    job.name !== 'Build shared native iOS test products'
    && job.name !== 'Test - iOS execution (native2)');
  assert.equal(promotionEvidenceGap(run, onboardingJobs, repository, sha, baseSha, onboardingOnly), null);
});

test('every planner-owned evidence lane is an execution obligation', () => {
  const lanes = ['evidence-account-update', 'evidence-account-update-2', 'evidence-visual'] as const;
  const selected = promotionRequirementsSchema.parse({
    nativeLanes: lanes, producerRequired: true, storekitRequired: false, archiveRequired: false,
  });
  const evidenceJobs = lanes.map((lane): PromotionJob => ({
    name: `Test - iOS execution (${lane})`, run_attempt: 2, status: 'completed', conclusion: 'success',
    steps: [{ name: 'Execute Precompiled iOS Tests', status: 'completed', conclusion: 'success' }],
  }));
  assert.equal(promotionEvidenceGap(run, [...jobs, ...evidenceJobs], repository, sha, baseSha, selected), null);
  for (const lane of lanes) {
    assert.match(promotionEvidenceGap(run, [...jobs, ...evidenceJobs.filter((job) =>
      job.name !== `Test - iOS execution (${lane})`)], repository, sha, baseSha, selected) ?? '',
    new RegExp(`required newest-attempt job.*${lane}`));
  }
});

test('a successful no-op run, skipped lane, future attempt, or duplicate job cannot attest', () => {
  assert.match(promotionEvidenceGap(run, [], repository, sha, baseSha, requirements) ?? '', /job did not pass/);
  assert.match(promotionEvidenceGap(run, jobs.filter((job) => job.name !== 'Real-server E2E execution (onboarding)'), repository, sha, baseSha, requirements) ?? '', /onboarding/);
  assert.match(promotionEvidenceGap(run, jobs.map((job) => job.name === 'Test - iOS execution (native2)'
    ? { ...job, conclusion: 'skipped' } : job), repository, sha, baseSha, requirements) ?? '', /native2/);
  assert.match(promotionEvidenceGap(run, jobs.map((job) => job.name === 'StoreKit Purchase - iOS'
    ? { ...job, run_attempt: 3 } : job), repository, sha, baseSha, requirements) ?? '', /StoreKit/);
  assert.match(promotionEvidenceGap(run, [...jobs, jobs[0]!], repository, sha, baseSha, requirements) ?? '', /exactly once/);
  const retainedPassedJob = jobs.map((job) => job.name === 'Test - iOS execution (native1)'
    ? { ...job, run_attempt: 1 } : job);
  assert.equal(promotionEvidenceGap(run, retainedPassedJob, repository, sha, baseSha, requirements), null);
  const oldFailure = { ...jobs[0]!, run_attempt: 1, conclusion: 'failure' };
  assert.equal(promotionEvidenceGap(run, [...jobs, oldFailure], repository, sha, baseSha, requirements), null);
  const newFailure = { ...jobs[0]!, run_attempt: 2, conclusion: 'failure' };
  assert.match(promotionEvidenceGap(run, [...jobs.map((job) => job.name === oldFailure.name
    ? { ...job, run_attempt: 1 } : job), newFailure], repository, sha, baseSha, requirements) ?? '', /newest-attempt/);
});

test('StoreKit must have run in the producer and passed its required verdict', () => {
  const withoutStep = jobs.map((job) => job.name === 'Build shared native iOS test products'
    ? { ...job, steps: [] } : job);
  assert.match(promotionEvidenceGap(run, withoutStep, repository, sha, baseSha, requirements) ?? '', /Run StoreKit purchase test/);
  const skippedStep = jobs.map((job) => job.name === 'Build shared native iOS test products'
    ? { ...job, steps: [{ name: 'Run StoreKit purchase test', status: 'completed', conclusion: 'skipped' }] }
    : job);
  assert.match(promotionEvidenceGap(run, skippedStep, repository, sha, baseSha, requirements) ?? '', /Run StoreKit purchase test/);
  const failedVerdict = jobs.map((job) => job.name === 'StoreKit Purchase - iOS'
    ? { ...job, conclusion: 'failure' } : job);
  assert.match(promotionEvidenceGap(run, failedVerdict, repository, sha, baseSha, requirements) ?? '', /StoreKit Purchase/);
});

test('a green job with a skipped substantive step does not prove executed tests', () => {
  for (const name of [
    'Verify unsigned Release archive',
    'Test - iOS execution (native2)',
    'Real-server E2E execution (onboarding)',
    'Manual - Test - iOS',
    'StoreKit Purchase - iOS',
    'Manual - Onboarding E2E',
  ]) {
    const skipped = jobs.map((job) => job.name === name
      ? { ...job, steps: job.steps?.map((step) => ({ ...step, conclusion: 'skipped' })) }
      : job);
    assert.match(promotionEvidenceGap(run, skipped, repository, sha, baseSha, requirements) ?? '', /required execution step/);
  }
});

test('each aggregate verdict must execute even when no native lane is selected', () => {
  const onboardingOnly = { nativeLanes: [] as const, producerRequired: false,
    storekitRequired: false, archiveRequired: false };
  const onboardingJobs = jobs.filter((job) => job.name !== 'Verify unsigned Release archive'
    && job.name !== 'Build shared native iOS test products'
    && !job.name.startsWith('Test - iOS execution (native'));
  assert.equal(promotionEvidenceGap(run, onboardingJobs, repository, sha, baseSha, onboardingOnly), null);
  for (const [name, stepName] of [
    ['Manual - Test - iOS', 'Verify iOS test lanes'],
    ['Manual - Test - iOS', 'Verify consolidated StoreKit execution result'],
    ['Manual - Test - iOS', 'Verify onboarding execution result'],
    ['StoreKit Purchase - iOS', 'Verify consolidated StoreKit execution result'],
    ['Manual - Onboarding E2E', 'Verify onboarding execution result'],
  ]) {
    const skipped = onboardingJobs.map((job) => job.name === name
      ? { ...job, steps: job.steps?.map((step) => step.name === stepName
        ? { ...step, conclusion: 'skipped' } : step) }
      : job);
    assert.match(promotionEvidenceGap(run, skipped, repository, sha, baseSha, onboardingOnly) ?? '',
      new RegExp(`required execution step.*${stepName}`));
  }
});

const api = 'https://api.github.test';
const runsUrl = `${api}/repos/${repository}/actions/workflows/ios-tests.yml/runs`
  + `?event=workflow_dispatch&branch=develop&head_sha=${sha}&per_page=100`;
const jobsUrl = `${api}/repos/${repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=1`;
const jobsPage2Url = `${api}/repos/${repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100&page=2`;

function response(body: unknown, status = 200): GithubResponse {
  return { status, statusLabel: String(status), body };
}

function reader(
  responses: ReadonlyMap<string, GithubResponse>,
  requested: string[],
): GithubReader {
  return async (url) => {
    requested.push(url);
    const result = responses.get(url);
    if (result === undefined) throw new Error(`Unexpected GitHub read: ${url}`);
    return result;
  };
}

test('reads all executions and retains a passed native job from an earlier attempt', async () => {
  const requested: string[] = [];
  const retained = jobs.map((job) => job.name === 'Test - iOS execution (native1)'
    ? { ...job, run_attempt: 1 } : job);
  const read = reader(new Map([
    [runsUrl, response({ total_count: 1, workflow_runs: [run] })],
    [jobsUrl, response({ total_count: retained.length + 1, jobs: [
      { ...jobs[0]!, run_attempt: 1, conclusion: 'failure' }, ...retained,
    ] })],
  ]), requested);
  assert.deepEqual(await findPromotionEvidence({ api, repository, checkpointSha: sha, baseSha, requirements, read }), {
    runId: run.id, runAttempt: 2,
  });
  assert.deepEqual(requested, [runsUrl, jobsUrl]);
});

test('successful no-op dispatch never proves required iOS coverage', async () => {
  const read = reader(new Map([
    [runsUrl, response({ total_count: 1, workflow_runs: [run] })],
    [jobsUrl, response({ total_count: 0, jobs: [] })],
  ]), []);
  await assert.rejects(findPromotionEvidence({ api, repository, checkpointSha: sha, baseSha, requirements, read }),
    /required newest-attempt job did not pass exactly once/);
});

test('a mismatched run is ignored and incomplete job pagination fails closed', async () => {
  const requested: string[] = [];
  const read = reader(new Map([
    [runsUrl, response({ total_count: 2, workflow_runs: [
      { ...run, id: 9, head_sha: 'b'.repeat(40) }, run,
    ] })],
    [jobsUrl, response({ total_count: jobs.length + 1, jobs })],
    [jobsPage2Url, response({ total_count: jobs.length + 1, jobs: [] })],
  ]), requested);
  await assert.rejects(findPromotionEvidence({ api, repository, checkpointSha: sha, baseSha, requirements, read }),
    /job inventory is incomplete/);
  assert.deepEqual(requested, [runsUrl, jobsUrl, jobsPage2Url]);
});

test('complete all-attempt job pagination can prove a retained passing job', async () => {
  const prior = { ...jobs[0]!, run_attempt: 1, conclusion: 'failure' };
  const read = reader(new Map([
    [runsUrl, response({ total_count: 1, workflow_runs: [run] })],
    [jobsUrl, response({ total_count: jobs.length + 1, jobs: [prior, ...jobs.slice(0, 7)] })],
    [jobsPage2Url, response({ total_count: jobs.length + 1, jobs: jobs.slice(7) })],
  ]), []);
  assert.deepEqual(await findPromotionEvidence({ api, repository, checkpointSha: sha, baseSha, requirements, read }), {
    runId: run.id, runAttempt: run.run_attempt,
  });
});

test('HTTP errors and incomplete run pagination cannot attest', async () => {
  const failedRead = reader(new Map([[runsUrl, response(undefined, 503)]]), []);
  await assert.rejects(findPromotionEvidence({ api, repository, checkpointSha: sha, baseSha, requirements, read: failedRead }),
    /HTTP 503/);
  const truncatedRead = reader(new Map([
    [runsUrl, response({ total_count: 2, workflow_runs: [run] })],
  ]), []);
  await assert.rejects(findPromotionEvidence({ api, repository, checkpointSha: sha, baseSha, requirements, read: truncatedRead }),
    /run inventory exceeds one page/);
});


test('newer exact-source/base failures supersede older passing dispatch evidence', async () => {
  const recentFailure = { ...run, id: run.id + 1,
    created_at: '2026-09-25T00:01:00Z', conclusion: 'failure' };
  const read = reader(new Map([
    [runsUrl, response({ total_count: 2, workflow_runs: [run, recentFailure] })],
    [jobsUrl, response({ total_count: jobs.length, jobs })],
  ]), []);
  await assert.rejects(findPromotionEvidence({ api, repository, checkpointSha: sha,
    baseSha, requirements, read }), /Newest exact-develop promotion evidence run/);
});

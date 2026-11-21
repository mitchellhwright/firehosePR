import { z } from 'zod';
import { workflowNames } from '../../../scripts/ci/generated/workflow-names.ts';
import { iosLaneSchema } from '../nativeExecutionPlan.ts';
import type { GithubReader } from './shared/githubRest.ts';

/** A promotion can reuse only completed, exact-integrated-develop execution. */
export const promotionRunSchema = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  created_at: z.iso.datetime(),
  event: z.string(),
  head_branch: z.string().nullable(),
  head_sha: z.string(),
  path: z.string(),
  display_title: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  repository: z.object({ full_name: z.string() }),
});
export type PromotionRun = z.infer<typeof promotionRunSchema>;

export const promotionJobSchema = z.object({
  name: z.string(),
  run_attempt: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
  steps: z.array(z.object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
  })).nullable().optional(),
});
export type PromotionJob = z.infer<typeof promotionJobSchema>;

const listingSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(promotionRunSchema),
});

/** Every exact-develop dispatch of the iOS workflow at one source commit fits on this page. */
export function promotionEvidenceRunsUrl(api: string, repository: string, checkpointSha: string): string {
  return `${api}/repos/${repository}/actions/workflows/ios-tests.yml/runs`
    + `?event=workflow_dispatch&branch=develop&head_sha=${checkpointSha}&per_page=100`;
}

/**
 * The newest dispatch that names this exact source and base. A later failure
 * on the same immutable source/base invalidates older successful evidence
 * until that newest execution is repaired or rerun.
 */
export function newestPromotionEvidenceRun<T extends PromotionRun>(
  runs: readonly T[],
  repository: string,
  checkpointSha: string,
  baseSha: string,
): T | undefined {
  const candidates = runs.filter((run) =>
    run.repository.full_name === repository && run.path === '.github/workflows/ios-tests.yml'
    && run.event === 'workflow_dispatch' && run.head_branch === 'develop'
    && run.head_sha === checkpointSha
    && run.display_title === `promotion-evidence:${checkpointSha}:${baseSha}`);
  candidates.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id);
  return candidates[0];
}
const jobsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(promotionJobSchema),
});

const jobs = workflowNames['ios-tests'].jobs;
function requiredName(name: string | undefined): string {
  if (name === undefined) throw new Error('Typed workflow registry is missing a promotion obligation name.');
  return name;
}
export const promotionRequirementsSchema = z.object({
  nativeLanes: z.array(iosLaneSchema).refine(
    (lanes) => new Set(lanes).size === lanes.length, 'duplicate native lane',
  ).readonly(),
  producerRequired: z.boolean(),
  storekitRequired: z.boolean(),
  archiveRequired: z.boolean(),
}).refine((plan) => plan.producerRequired || (
  plan.nativeLanes.length === 0 && !plan.storekitRequired && !plan.archiveRequired
), 'native work requires a producer');
export type PromotionRequirements = z.infer<typeof promotionRequirementsSchema>;

function obligations(plan: PromotionRequirements): {
  readonly requiredJobs: readonly string[];
  readonly requiredSteps: readonly { readonly job: string; readonly step: string }[];
} {
  const nativeExecutions = plan.nativeLanes.map((lane) =>
    `${jobs['test-ios-execution'].name} (${lane})`);
  const requiredJobs = [
    requiredName(jobs['ios-change-gate'].literals[1]),
    ...(plan.archiveRequired ? [jobs['verify-ios-release-archive'].name] : []),
    ...(plan.producerRequired ? [jobs['build-ios-native-test-products'].name] : []),
    ...nativeExecutions,
    requiredName(jobs['test-ios'].literals[1]),
    jobs['storekit-purchase-status'].name,
    jobs['build-ios-e2e-test-products'].name,
    jobs['onboarding-e2e'].name,
    requiredName(jobs['onboarding-e2e-status'].literals[1]),
  ];
  const requiredSteps = [
    { job: requiredName(jobs['ios-change-gate'].literals[1]), step: 'Precheck iOS Gate' },
    { job: requiredName(jobs['ios-change-gate'].literals[1]), step: 'Detect iOS Changes' },
    { job: requiredName(jobs['ios-change-gate'].literals[1]), step: 'Select native iOS tests' },
    { job: requiredName(jobs['ios-change-gate'].literals[1]), step: 'Classify selected UI work' },
    ...(plan.archiveRequired ? [{ job: jobs['verify-ios-release-archive'].name, step: 'Compile unsigned Release archive' }] : []),
    ...nativeExecutions.map((job) => ({ job, step: 'Execute Precompiled iOS Tests' })),
    ...(plan.storekitRequired ? [
      { job: jobs['build-ios-native-test-products'].name, step: 'Run StoreKit purchase test' },
      { job: jobs['build-ios-native-test-products'].name, step: 'Record StoreKit result' },
    ] : []),
    // A green aggregate job is insufficient: GitHub can skip a conditional
    // verdict step and still report the job as successful. Require each
    // dispatch verdict to execute and accept the selected plan explicitly.
    { job: requiredName(jobs['test-ios'].literals[1]), step: 'Verify iOS test lanes' },
    { job: requiredName(jobs['test-ios'].literals[1]), step: 'Verify consolidated StoreKit execution result' },
    { job: requiredName(jobs['test-ios'].literals[1]), step: 'Verify onboarding execution result' },
    { job: jobs['storekit-purchase-status'].name, step: 'Verify consolidated StoreKit execution result' },
    { job: jobs['onboarding-e2e'].name, step: 'Run onboarding E2E' },
    { job: requiredName(jobs['onboarding-e2e-status'].literals[1]), step: 'Verify onboarding execution result' },
  ];
  return { requiredJobs, requiredSteps };
}

/** Returns a concrete gap, never treating a skipped or missing job as success. */
export function promotionEvidenceGap(
  run: PromotionRun,
  runJobs: readonly PromotionJob[],
  repository: string,
  checkpointSha: string,
  baseSha: string,
  requirements: PromotionRequirements,
): string | null {
  if (run.repository.full_name !== repository || run.path !== '.github/workflows/ios-tests.yml'
    || run.event !== 'workflow_dispatch' || run.head_branch !== 'develop'
    || run.head_sha !== checkpointSha
    || run.display_title !== `promotion-evidence:${checkpointSha}:${baseSha}`
    || run.status !== 'completed'
    || run.conclusion !== 'success') return 'run identity or conclusion does not match the exact develop checkpoint';

  const latestRequiredJobs = new Map<string, PromotionJob>();
  const { requiredJobs, requiredSteps } = obligations(requirements);
  for (const name of requiredJobs) {
    if (name === undefined) return 'typed workflow registry has no required promotion job name';
    const matches = runJobs.filter((job) => job.name === name);
    // `filter=all` includes previous executions. Select the newest attempt
    // for each obligation, retaining earlier passing jobs that were not rerun.
    const latestAttempt = Math.max(...matches.map((job) => job.run_attempt));
    const latestMatches = matches.filter((job) => job.run_attempt === latestAttempt);
    const matched = latestMatches[0];
    if (latestMatches.length !== 1 || matched === undefined || matched.run_attempt > run.run_attempt
      || matched.status !== 'completed' || matched.conclusion !== 'success') {
      return `required newest-attempt job did not pass exactly once: ${name}`;
    }
    latestRequiredJobs.set(name, matched);
  }
  for (const { job, step } of requiredSteps) {
    const matches = latestRequiredJobs.get(job)?.steps?.filter((item) => item.name === step) ?? [];
    if (matches.length !== 1 || matches[0]?.status !== 'completed'
      || matches[0].conclusion !== 'success') {
      return `required execution step was missing, skipped, or failed: ${job} / ${step}`;
    }
  }
  return null;
}

export interface PromotionEvidenceRequest {
  readonly api: string;
  readonly repository: string;
  readonly checkpointSha: string;
  readonly baseSha: string;
  readonly requirements: PromotionRequirements;
  readonly read: GithubReader;
}

export interface PromotionAttestation {
  readonly runId: number;
  readonly runAttempt: number;
}

/** Combine all attempts, then use the newest execution of each obligation. */
export async function findPromotionEvidence(input: PromotionEvidenceRequest): Promise<PromotionAttestation> {
  const { api, repository, checkpointSha, baseSha, requirements, read } = input;
  promotionRequirementsSchema.parse(requirements);
  const listingResponse = await read(promotionEvidenceRunsUrl(api, repository, checkpointSha));
  if (listingResponse.status !== 200) {
    throw new Error(`Could not read exact-develop iOS runs: HTTP ${listingResponse.statusLabel}.`);
  }
  const listing = listingSchema.parse(listingResponse.body);
  if (listing.total_count > listing.workflow_runs.length) {
    throw new Error('Exact-develop iOS run inventory exceeds one page; cannot prove completeness.');
  }
  const run = newestPromotionEvidenceRun(listing.workflow_runs, repository, checkpointSha, baseSha);
  if (run === undefined || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Newest exact-develop promotion evidence run is missing or did not pass at ${checkpointSha} against ${baseSha}.`);
  }
  const allJobs: PromotionJob[] = [];
  let totalCount: number | undefined;
  let inventoryGap: string | undefined;
  for (let page = 1; page <= 20; page += 1) {
    const jobUrl = `${api}/repos/${repository}/actions/runs/${run.id}`
      + `/jobs?filter=all&per_page=100&page=${page}`;
    const jobResponse = await read(jobUrl);
    if (jobResponse.status !== 200) {
      inventoryGap = `job inventory HTTP ${jobResponse.statusLabel}`;
      break;
    }
    const listing = jobsSchema.parse(jobResponse.body);
    if (totalCount !== undefined && listing.total_count !== totalCount) {
      inventoryGap = 'job inventory changed while reading attempts';
      break;
    }
    totalCount = listing.total_count;
    allJobs.push(...listing.jobs);
    if (allJobs.length === totalCount) break;
    if (listing.jobs.length === 0 || allJobs.length > totalCount || page === 20) {
      inventoryGap = 'job inventory is incomplete or exceeds 20 pages';
      break;
    }
  }
  if (inventoryGap !== undefined) throw new Error(`run ${run.id}: ${inventoryGap}`);
  const gap = promotionEvidenceGap(run, allJobs, repository, checkpointSha, baseSha, requirements);
  if (gap !== null) throw new Error(`run ${run.id}: ${gap}`);
  return { runId: run.id, runAttempt: run.run_attempt };
}

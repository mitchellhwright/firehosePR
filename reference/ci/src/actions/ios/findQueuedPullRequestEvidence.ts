import { z } from 'zod';

import { readMergeGroupEvent } from '../../ciEvent.ts';
import { reverifyMergeGroupCandidate } from '../../mergeGroupCandidate.ts';
import { appendStepOutputs, type StepOutputEntry } from '../../ios/shared/githubOutputs.ts';
import { createGithubReader, credentialTokens, type GithubReader } from '../../ios/shared/githubRest.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import {
  error, fail, info, pass, runAsyncStepProgram, type StepDecision,
} from '../../ios/shared/stepDecision.ts';
import { bindReplanRecord } from '../../ios/replanRecordBinding.ts';
import { choosePullRequestRun, readPullRequestRuns } from '../../ios/queueEvidenceReuse.ts';
import type { SourceRefusal } from '../../ios/queueEvidenceReuseRecord.ts';
import type { GitHubJson, GitHubJsonReader } from '../../../../scripts/ci/types/github.d.mts';

/**
 * "Find the queued pull request's Mac evidence".
 *
 * Runs on a merge queue candidate, from the queue base's trusted detector.
 * It re-proves the candidate's queue chain (the same walk the precheck made)
 * to learn the queued pull request and its exact head, then names the one
 * pull request run whose Mac evidence the candidate may consider: the newest
 * completed Test - iOS `pull_request` run on that exact head. It also binds
 * the attempt whose gate wrote that run's selection record and lists the
 * evidence jobs that succeeded in the run's latest attempt. Whether any lane
 * is reused is decided by the next step, which reads that record.
 */

const environmentSchema = z.object({
  GITHUB_API_URL: z.string().url(),
  REPOSITORY: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_FALLBACK_TOKEN: z.string().default(''),
});

const jobListingSchema = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(z.object({
    id: z.number().int().positive(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable().transform((value) => value ?? undefined),
    run_id: z.number().int().positive(),
    run_attempt: z.number().int().positive(),
    head_sha: z.string(),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    runner_id: z.number().int().nullable(),
  })),
});

/** The jobs reader `bindReplanRecord` takes, over the fallback-token reader, validated. */
function jobsReader(read: GithubReader, apiRoot: string): GitHubJsonReader {
  return async (path: string): Promise<GitHubJson> => {
    const response = await read(`${apiRoot}/${path}`);
    if (response.status !== 200) throw new Error(`GitHub API ${path} failed with HTTP ${response.statusLabel}.`);
    const listing = jobListingSchema.safeParse(response.body);
    if (!listing.success) throw new Error(`GitHub API ${path} returned an unexpected job listing.`);
    return listing.data;
  };
}

function unavailable(reason: SourceRefusal, detail: string, identity: readonly StepOutputEntry[]): StepDecision {
  appendStepOutputs([...identity, ['status', reason], ['detail', detail]]);
  return pass(info(`Queue evidence source: ${reason} (${detail}); every selected lane executes.`));
}

async function run(): Promise<StepDecision> {
  const environment = readStepEnvironment(environmentSchema);
  const event = readMergeGroupEvent();
  if (event === undefined) return fail(error('Queue evidence lookup ran outside a merge_group event.'));
  const read = createGithubReader({
    tokens: credentialTokens(environment.GITHUB_TOKEN, environment.GITHUB_FALLBACK_TOKEN),
  });
  // The precheck already proved this candidate. Failing to re-read it now
  // only costs the reuse: the queue ref names the pull request, its head
  // stays unknown, and every selected lane executes.
  const verification = await reverifyMergeGroupCandidate(event, environment.GITHUB_API_URL, read);
  if (verification.kind === 'unreadable') {
    return unavailable('candidate-unreadable', verification.detail,
      [['pr_number', event.prNumber], ['pr_head_sha', '']]);
  }
  if (verification.kind === 'rejected') {
    return fail(error(`Merge queue candidate rejected: ${verification.message}`));
  }
  const { candidate } = verification;
  const identity: StepOutputEntry[] = [
    ['pr_number', candidate.prNumber],
    ['pr_head_sha', candidate.prHeadSha],
  ];
  const apiRoot = `${environment.GITHUB_API_URL}/repos/${environment.REPOSITORY}`;
  const listing = await readPullRequestRuns(read, apiRoot, candidate.prHeadSha);
  if (listing.kind === 'unreadable') return unavailable('no-pull-request-run', listing.detail, identity);
  const choice = choosePullRequestRun(listing.runs, candidate.prHeadSha, environment.REPOSITORY);
  if (choice.kind === 'unavailable') return unavailable(choice.reason, choice.detail, identity);

  const binding = await bindReplanRecord({
    runId: choice.runId,
    runAttempt: choice.runAttempt,
    headSha: candidate.prHeadSha,
    request: jobsReader(read, apiRoot),
    token: undefined,
  }).catch((cause: unknown) => {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { recordAttempt: null, detail: `jobs-unreadable: ${reason}`, successfulJobs: [] };
  });
  if (binding.recordAttempt === null) {
    return unavailable('selection-record-unproven', `run ${choice.runId}: ${binding.detail}`, identity);
  }
  appendStepOutputs([
    ...identity,
    ['status', 'found'],
    ['detail', binding.detail],
    ['run_id', String(choice.runId)],
    ['run_attempt', String(choice.runAttempt)],
    ['record_attempt', String(binding.recordAttempt)],
    ['successful_jobs', JSON.stringify(binding.successfulJobs)],
  ]);
  return pass(info(`Queue evidence source: run ${choice.runId} attempt ${choice.runAttempt} on `
    + `${candidate.prHeadSha} (pull request #${candidate.prNumber}), selection record from attempt `
    + `${binding.recordAttempt}; successful evidence jobs ${JSON.stringify(binding.successfulJobs)}.`));
}

await runAsyncStepProgram('Find the queued pull request\'s Mac evidence', run);

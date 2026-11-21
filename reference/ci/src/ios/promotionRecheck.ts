import { z } from 'zod';
import {
  newestPromotionEvidenceRun, promotionEvidenceRunsUrl, promotionRunSchema,
} from './promotionEvidence.ts';
import type { GithubReader, GithubRequester } from './shared/githubRest.ts';

/**
 * Re-evaluates a production promotion pull request's iOS gate once its
 * exact-develop promotion evidence exists.
 *
 * The promotion PR's `Test - iOS` gate requires a successful
 * `promotion-evidence:<source>:<main>` dispatch. That dispatch takes far longer
 * than the gate, so the PR's first run fails for missing evidence and nothing
 * re-reads it later. Two `workflow_run` completions enter here:
 *
 *  - the evidence dispatch succeeding, which reruns the failed jobs of the PR
 *    run that already finished; and
 *  - a promotion PR run failing, which covers a run whose gate failed while it
 *    was still in progress when the evidence completed.
 *
 * Either way a run is rerun only when its latest attempt started before the
 * newest evidence completed. A rerun attempt starts after it, so a failure
 * with any other cause is never rerun twice.
 */

export const IOS_WORKFLOW_PATH = '.github/workflows/ios-tests.yml';
const SHA = /^[0-9a-f]{40}$/u;
const EVIDENCE_TITLE = /^promotion-evidence:([0-9a-f]{40}):([0-9a-f]{40})$/u;
const PROMOTION_BRANCH = /^promotion\/develop-([0-9a-f]{40})$/u;
const RERUNNABLE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out']);

const triggerEventSchema = z.object({
  workflow_run: z.object({
    id: z.number().int().positive(),
    name: z.string(),
    event: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    head_branch: z.string().nullable(),
    head_sha: z.string(),
    path: z.string(),
    display_title: z.string(),
    repository: z.object({ full_name: z.string() }),
    head_repository: z.object({ full_name: z.string() }).nullable(),
  }),
});

export type RecheckTrigger =
  | { readonly kind: 'evidence'; readonly runId: number; readonly sourceSha: string; readonly evidenceBaseSha: string }
  | { readonly kind: 'pull-request-run'; readonly runId: number; readonly sourceSha: string };

export type TriggerResult =
  | { readonly accepted: true; readonly trigger: RecheckTrigger }
  | { readonly accepted: false; readonly reason: string };

/**
 * Accepts only a successful exact-develop promotion-evidence dispatch or a
 * failed promotion PR run of this repository's iOS workflow. A malformed
 * payload throws; a well-formed payload for anything else is declined.
 */
export function parseRecheckTrigger(payload: unknown, repository: string): TriggerResult {
  const run = triggerEventSchema.parse(payload).workflow_run;
  const decline = (reason: string): TriggerResult => ({ accepted: false, reason });
  // A run-named dispatch reports its run-name as `name`, so the workflow is
  // identified by path alone.
  if (run.path !== IOS_WORKFLOW_PATH) {
    return decline(`run ${run.id} is not the ${IOS_WORKFLOW_PATH} workflow`);
  }
  if (run.repository.full_name !== repository || run.head_repository?.full_name !== repository) {
    return decline(`run ${run.id} does not belong to ${repository}`);
  }
  if (run.status !== 'completed') return decline(`run ${run.id} has not completed`);
  if (run.event === 'workflow_dispatch') {
    const title = EVIDENCE_TITLE.exec(run.display_title);
    if (title?.[1] === undefined || title[2] === undefined) {
      return decline(`run ${run.id} is not a promotion-evidence dispatch`);
    }
    if (run.head_branch !== 'develop' || run.head_sha !== title[1]) {
      return decline(`run ${run.id} did not run on develop at its titled source ${title[1]}`);
    }
    if (run.conclusion !== 'success') return decline(`evidence run ${run.id} concluded ${run.conclusion ?? 'null'}`);
    return { accepted: true, trigger: { kind: 'evidence', runId: run.id, sourceSha: title[1], evidenceBaseSha: title[2] } };
  }
  if (run.event === 'pull_request') {
    const branch = PROMOTION_BRANCH.exec(run.head_branch ?? '');
    if (branch?.[1] === undefined) return decline(`run ${run.id} is not for a promotion checkpoint branch`);
    if (!RERUNNABLE_CONCLUSIONS.has(run.conclusion ?? '')) {
      return decline(`promotion run ${run.id} concluded ${run.conclusion ?? 'null'}`);
    }
    return { accepted: true, trigger: { kind: 'pull-request-run', runId: run.id, sourceSha: branch[1] } };
  }
  return decline(`run ${run.id} came from a ${run.event} event`);
}

const evidenceRunSchema = promotionRunSchema.extend({ updated_at: z.iso.datetime() });
const evidenceListingSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(evidenceRunSchema),
});

export const pullRequestRunSchema = z.object({
  id: z.number().int().positive(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_sha: z.string(),
  path: z.string(),
  created_at: z.iso.datetime(),
  run_started_at: z.iso.datetime(),
  repository: z.object({ full_name: z.string() }),
});
export type PullRequestRun = z.infer<typeof pullRequestRunSchema>;
const pullRequestRunListingSchema = z.object({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(pullRequestRunSchema),
});

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }) }),
});
type PullRequest = z.infer<typeof pullRequestSchema>;

const refSchema = z.object({ object: z.object({ sha: z.string().regex(SHA) }) });

export interface RecheckDecision {
  readonly action: 'rerun' | 'none';
  readonly pullRequest?: number;
  readonly runId?: number;
  readonly reason: string;
}

export interface PullRequestRecheckInput {
  readonly pullRequest: number;
  readonly headSha: string;
  readonly repository: string;
  readonly runs: readonly PullRequestRun[];
  /** When the newest passing evidence run finished. */
  readonly evidenceCompletedAt: string;
}

/** Decides from the newest `pull_request` iOS run at the PR's current head. */
export function decidePullRequestRecheck(input: PullRequestRecheckInput): RecheckDecision {
  const { pullRequest } = input;
  const current = input.runs.filter((run) =>
    run.event === 'pull_request' && run.path === IOS_WORKFLOW_PATH
    && run.head_sha === input.headSha && run.repository.full_name === input.repository);
  current.sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id);
  const run = current[0];
  if (run === undefined) return { action: 'none', pullRequest, reason: 'no Test - iOS run at the current head' };
  const runId = run.id;
  if (run.status !== 'completed') {
    return { action: 'none', pullRequest, runId, reason: 'run still active; its own completion re-enters this check' };
  }
  if (run.conclusion === 'success') return { action: 'none', pullRequest, runId, reason: 'run already passed' };
  if (!RERUNNABLE_CONCLUSIONS.has(run.conclusion ?? '')) {
    return { action: 'none', pullRequest, runId, reason: `run concluded ${run.conclusion ?? 'null'}` };
  }
  if (Date.parse(run.run_started_at) >= Date.parse(input.evidenceCompletedAt)) {
    return {
      action: 'none', pullRequest, runId,
      reason: 'latest attempt started after the evidence completed, so evidence was not its failure',
    };
  }
  return { action: 'rerun', pullRequest, runId, reason: 'gate ran before the evidence completed' };
}

export function formatDecision(decision: RecheckDecision): string {
  const subject = [
    decision.pullRequest === undefined ? '' : ` #${decision.pullRequest}`,
    decision.runId === undefined ? '' : ` run ${decision.runId}`,
  ].join('');
  return `promotion-recheck: ${decision.action}${subject} (${decision.reason})`;
}

export interface RecheckContext {
  readonly api: string;
  readonly repository: string;
  readonly read: GithubReader;
}

async function readJson<T>(context: RecheckContext, url: string, schema: z.ZodType<T>, what: string): Promise<T> {
  const response = await context.read(url);
  if (response.status !== 200) throw new Error(`Could not read ${what}: HTTP ${response.statusLabel} from ${url}.`);
  return schema.parse(response.body);
}

function isCheckpointPullRequest(pull: PullRequest, repository: string, branch: string): boolean {
  return pull.state === 'open' && pull.head.ref === branch && pull.head.repo?.full_name === repository
    && pull.base.ref === 'main' && pull.base.repo.full_name === repository && SHA.test(pull.head.sha);
}

async function decideForPullRequest(
  context: RecheckContext,
  pull: PullRequest,
  mainSha: string,
  evidenceCompletedAt: string,
): Promise<RecheckDecision> {
  if (pull.base.sha !== mainSha) {
    return {
      action: 'none', pullRequest: pull.number,
      reason: `pull request base ${pull.base.sha} is not main ${mainSha}; the checkpoint update owns it`,
    };
  }
  const listing = await readJson(context,
    `${context.api}/repos/${context.repository}/actions/workflows/ios-tests.yml/runs`
    + `?event=pull_request&head_sha=${pull.head.sha}&per_page=100`,
    pullRequestRunListingSchema, `iOS runs for #${pull.number}`);
  if (listing.total_count > listing.workflow_runs.length) {
    throw new Error(`iOS runs for #${pull.number} exceed one page; cannot choose the newest.`);
  }
  return decidePullRequestRecheck({
    pullRequest: pull.number, headSha: pull.head.sha, repository: context.repository,
    runs: listing.workflow_runs, evidenceCompletedAt,
  });
}

/** Reads live GitHub state and decides, for every matching checkpoint PR, whether to rerun. */
export async function planPromotionRecheck(
  context: RecheckContext,
  trigger: RecheckTrigger,
): Promise<readonly RecheckDecision[]> {
  const { api, repository } = context;
  const mainSha = (await readJson(context, `${api}/repos/${repository}/git/ref/heads/main`, refSchema, 'main')).object.sha;
  if (trigger.kind === 'evidence' && trigger.evidenceBaseSha !== mainSha) {
    return [{
      action: 'none', runId: trigger.runId,
      reason: `main moved from evidence base ${trigger.evidenceBaseSha} to ${mainSha}; the checkpoint update owns it`,
    }];
  }
  const evidenceListing = await readJson(context, promotionEvidenceRunsUrl(api, repository, trigger.sourceSha),
    evidenceListingSchema, `promotion evidence for ${trigger.sourceSha}`);
  if (evidenceListing.total_count > evidenceListing.workflow_runs.length) {
    throw new Error(`Promotion evidence runs for ${trigger.sourceSha} exceed one page; cannot choose the newest.`);
  }
  const evidence = newestPromotionEvidenceRun(evidenceListing.workflow_runs, repository, trigger.sourceSha, mainSha);
  if (evidence?.status !== 'completed' || evidence.conclusion !== 'success') {
    return [{
      action: 'none', ...(evidence === undefined ? {} : { runId: evidence.id }),
      reason: `newest evidence for ${trigger.sourceSha} against main ${mainSha} is missing or has not passed`,
    }];
  }
  const branch = `promotion/develop-${trigger.sourceSha}`;
  const owner = repository.split('/')[0] ?? '';
  const pulls = await readJson(context,
    `${api}/repos/${repository}/pulls?state=open&base=main&head=${owner}:${branch}&per_page=100`,
    z.array(pullRequestSchema), `open pull requests for ${branch}`);
  const checkpoints = pulls.filter((pull) => isCheckpointPullRequest(pull, repository, branch));
  if (checkpoints.length === 0) return [{ action: 'none', reason: `no open ${branch} pull request into main` }];
  const decisions: RecheckDecision[] = [];
  for (const pull of checkpoints) {
    decisions.push(await decideForPullRequest(context, pull, mainSha, evidence.updated_at));
  }
  return decisions;
}

/** Reruns only the failed jobs, which reruns the gate and the jobs that depend on it. */
export async function applyRecheck(
  context: Omit<RecheckContext, 'read'> & { readonly request: GithubRequester },
  decisions: readonly RecheckDecision[],
): Promise<void> {
  for (const decision of decisions) {
    if (decision.action !== 'rerun' || decision.runId === undefined) continue;
    const url = `${context.api}/repos/${context.repository}/actions/runs/${decision.runId}/rerun-failed-jobs`;
    const response = await context.request('POST', url);
    if (response.status !== 201) {
      throw new Error(`Rerun of run ${decision.runId} for #${decision.pullRequest ?? '?'} returned HTTP ${response.statusLabel}.`);
    }
  }
}

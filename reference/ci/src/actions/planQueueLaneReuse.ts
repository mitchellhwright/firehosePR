import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readMergeGroupEvent, type MergeGroupEventTuple } from '../ciEvent.ts';
import { reverifyMergeGroupCandidate, type VerifiedMergeGroupCandidate } from '../mergeGroupCandidate.ts';
import { createJobLogReader } from '../actionsJobLog.ts';
import { createGithubReader, credentialTokens, type GithubReader } from '../ios/shared/githubRest.ts';
import { appendStepOutputs } from '../ios/shared/githubOutputs.ts';
import { readStepEnvironment } from '../ios/shared/stepEnvironment.ts';
import { appendStepSummary, logLine } from '../ios/shared/actionIo.ts';
import {
  gitBlobSha, laneEvidencePlanSchema, laneVerdictLine, linuxLaneInputDeclarationSha, linuxLaneInputEntries, parsePrChecksLaneEvidenceLog,
  planLinuxLaneReuse, readNewestCompletedRun, reusedLanes,
  type GitTreeEntry, type LaneInputEntry, type LaneReuseInput, type PrChecksLaneEvidence, type SourceRun, type TestedMerge,
} from '../queueLaneEvidence.ts';

/**
 * Decides, for a merge queue candidate, which selected Linux lanes reuse the
 * pull request's own PR Checks evidence. Every fact is read from GitHub
 * (run, jobs, the aggregate's log marker, immutable Git objects) and handed
 * to the pure decision in `queueLaneEvidence.ts`; this file only gathers.
 * On any event other than `merge_group` it writes no reuse at all.
 */

const VALIDATE_JOB_NAME = 'Validate pull request changes';

const environmentSchema = z.object({
  REPOSITORY: z.string().min(1),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_FALLBACK_TOKEN: z.string().default(''),
  PLAN_JSON: z.string().min(1),
});

const commitSchema = z.object({
  sha: z.string(),
  tree: z.object({ sha: z.string() }),
  parents: z.array(z.object({ sha: z.string() })),
});
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({
    path: z.string(), type: z.enum(['blob', 'tree', 'commit']), mode: z.string(), sha: z.string(),
  })),
});

const planSchema = z.object({
  serverTestMode: z.enum(['none', 'targeted', 'full']),
  targetedServerTests: z.array(z.string()),
  targetedIntegrationTests: z.array(z.string()),
  entitlementAcceptanceRequired: z.boolean().default(false),
  testOnlyHelpersToTypecheck: z.array(z.string()).default([]),
  processHeavyRequired: z.boolean().default(false),
  serverStaticRequired: z.boolean(),
  workflowContractsRequired: z.boolean(),
  iosContractsRequired: z.boolean(),
  databaseRequired: z.boolean(),
}).strip();

/** Keep only lane obligations from the full PR validation plan before strict evidence validation. */
export function parseLaneEvidencePlanJson(json: string): z.infer<typeof laneEvidencePlanSchema> {
  return laneEvidencePlanSchema.parse(planSchema.parse(JSON.parse(json)));
}

async function readJson<T>(read: GithubReader, url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await read(url);
  if (response.status !== 200) throw new Error(`GET ${url} answered HTTP ${response.statusLabel}.`);
  return schema.parse(response.body);
}

async function readMarker(run: SourceRun | { readonly error: string } | undefined, apiRoot: string, tokens: readonly string[]): Promise<PrChecksLaneEvidence | { error: string }> {
  if (run === undefined || 'error' in run || run.status !== 'completed' || run.conclusion !== 'success') {
    return { error: 'no successful source run' };
  }
  const validate = run.jobs.find((job) => job.name === VALIDATE_JOB_NAME);
  if (validate === undefined) return { error: `run ${run.id} has no ${VALIDATE_JOB_NAME} job` };
  try {
    const log = await createJobLogReader({ tokens })(`${apiRoot}/actions/jobs/${validate.id}/logs`);
    return parsePrChecksLaneEvidenceLog(log);
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function readMerge(read: GithubReader, apiRoot: string, sha: string): Promise<TestedMerge | { error: string }> {
  try {
    const commit = await readJson(read, `${apiRoot}/git/commits/${sha}`, commitSchema);
    return { sha: commit.sha, parents: commit.parents.map((parent) => parent.sha), treeSha: commit.tree.sha };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function treeReader(read: GithubReader, apiRoot: string): (sha: string) => Promise<readonly GitTreeEntry[]> {
  return async (sha) => {
    const tree = await readJson(read, `${apiRoot}/git/trees/${sha}`, treeSchema);
    if (tree.truncated) throw new Error(`Tree ${sha} was truncated by the API; refusing to digest it.`);
    return tree.tree;
  };
}

async function readEntries(read: GithubReader, apiRoot: string, treeSha: string): Promise<readonly LaneInputEntry[] | { error: string }> {
  try {
    return await linuxLaneInputEntries(treeSha, treeReader(read, apiRoot));
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The input declaration this planner runs with, against the candidate's own copy. */
async function readDeclaration(read: GithubReader, apiRoot: string, candidateTreeSha: string): Promise<LaneReuseInput['inputDeclaration']> {
  try {
    const running = gitBlobSha(readFileSync(new URL('../queueLaneEvidence.ts', import.meta.url)));
    const candidate = await linuxLaneInputDeclarationSha(candidateTreeSha, treeReader(read, apiRoot));
    return { running, candidate };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The candidate this step plans reuse for, or `undefined` when GitHub could
 * not be read usably. The gate's precheck already proved the candidate, so
 * an unreadable re-read only costs the reuse (every selected lane executes);
 * a candidate GitHub now proves invalid still fails the step.
 */
export async function reverifiedCandidate(
  event: MergeGroupEventTuple,
  apiUrl: string,
  read: GithubReader,
): Promise<VerifiedMergeGroupCandidate | undefined> {
  const verification = await reverifyMergeGroupCandidate(event, apiUrl, read);
  if (verification.kind === 'unreadable') {
    logLine(`Merge queue candidate could not be re-read (${verification.detail}); every selected lane executes.`);
    return undefined;
  }
  if (verification.kind === 'rejected') throw new Error(`Merge queue candidate rejected: ${verification.message}`);
  return verification.candidate;
}

async function main(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const event = readMergeGroupEvent();
  if (event === undefined) {
    logLine('Not a merge queue candidate; no PR Checks lane evidence is reused.');
    appendStepOutputs([['reused_lanes', '[]'], ['lane_evidence', '']]);
    return;
  }
  if (event.repository !== environment.REPOSITORY) throw new Error('Step repository does not match the merge_group payload.');
  const tokens = credentialTokens(environment.GITHUB_TOKEN, environment.GITHUB_FALLBACK_TOKEN);
  const read = createGithubReader({ tokens });
  const apiRoot = `${environment.GITHUB_API_URL}/repos/${event.repository}`;
  const candidate = await reverifiedCandidate(event, environment.GITHUB_API_URL, read);
  if (candidate === undefined) {
    appendStepOutputs([['reused_lanes', '[]'], ['lane_evidence', '']]);
    return;
  }
  const plan = parseLaneEvidencePlanJson(environment.PLAN_JSON);

  const sourceRun = await readNewestCompletedRun(read, apiRoot, candidate.prHeadSha);
  const marker = await readMarker(sourceRun, apiRoot, tokens);
  const testedMerge = 'error' in marker ? { error: 'no evidence marker' } : await readMerge(read, apiRoot, marker.mergeSha);
  const testedEntries = 'error' in testedMerge ? { error: 'no tested merge' } : await readEntries(read, apiRoot, testedMerge.treeSha);
  const candidateCommit = await readMerge(read, apiRoot, candidate.candidateSha);
  const candidateEntries = 'error' in candidateCommit ? candidateCommit : await readEntries(read, apiRoot, candidateCommit.treeSha);
  const inputDeclaration = 'error' in candidateCommit
    ? candidateCommit : await readDeclaration(read, apiRoot, candidateCommit.treeSha);

  const input: LaneReuseInput = {
    candidate: {
      prNumber: candidate.prNumber, prHeadSha: candidate.prHeadSha,
      candidateSha: candidate.candidateSha, queueBaseSha: candidate.queueBaseSha,
    },
    repository: event.repository, plan, sourceRun, marker, testedMerge, testedEntries, candidateEntries, inputDeclaration,
  };
  const record = planLinuxLaneReuse(input);
  const lines = record.lanes.map(laneVerdictLine);
  for (const line of lines) logLine(line);
  appendStepSummary('| Lane | Verdict |\n| --- | --- |');
  for (const lane of record.lanes) {
    const verdict = lane.verdict === 'reused'
      ? `reused from run ${lane.sourceRunId} attempt ${lane.sourceRunAttempt} (input digest \`${lane.inputDigest.slice(0, 12)}\`)`
      : lane.verdict === 'executed' ? `executed (${lane.reason})` : 'not selected';
    appendStepSummary(`| \`${lane.lane}\` | ${verdict} |`);
  }
  appendStepOutputs([
    ['reused_lanes', JSON.stringify(reusedLanes(record))],
    ['lane_evidence', JSON.stringify(record)],
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

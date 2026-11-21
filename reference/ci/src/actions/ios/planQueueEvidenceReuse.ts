import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { readMergeGroupEvent } from '../../ciEvent.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { createGithubReader, credentialTokens } from '../../ios/shared/githubRest.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import {
  error, fail, notice, pass, runAsyncStepProgram, warning, type StepDecision,
} from '../../ios/shared/stepDecision.ts';
import {
  NATIVE_SELECTION_RECORD_FILE, currentSelection, readNativeSelectionRecord, selectionEnvironmentSchema,
} from '../../ios/nativeSelectionRecord.ts';
import {
  planQueueEvidenceReuse, readGitTree, readWorkflowBlob, readWorkflowRevisionTree,
  reuseGateOutputs, type EvidenceSource,
} from '../../ios/queueEvidenceReuse.ts';
import {
  QUEUE_EVIDENCE_REUSE_FILE, SOURCE_REFUSALS, verdictLine,
} from '../../ios/queueEvidenceReuseRecord.ts';

/**
 * "Decide which Mac lanes the queue candidate reuses".
 *
 * Reads the pull request run the previous step named, its selection record
 * (downloaded beside this step), the candidate's own selection as the queue
 * base's selector computed it, and the two Git trees. Every selected lane
 * resolves to `reused` or `executed` with a machine-readable reason; only a
 * reused lane's gate outputs are replaced. The full record is published as a
 * step output, a job summary and a file the workflow uploads.
 */

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const optionalPositive = z.union([z.literal(''), z.coerce.number().int().positive()]);

const environmentSchema = selectionEnvironmentSchema.extend({
  GITHUB_API_URL: z.string().url(),
  GITHUB_WORKFLOW_SHA: sha,
  REPOSITORY: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  GITHUB_TOKEN: z.string().default(''),
  GITHUB_FALLBACK_TOKEN: z.string().default(''),
  SOURCE_STATUS: z.union([z.literal('found'), z.enum(SOURCE_REFUSALS), z.literal('')]),
  SOURCE_DETAIL: z.string().default(''),
  PR_NUMBER: z.string().regex(/^[1-9][0-9]*$/),
  PR_HEAD_SHA: z.union([z.literal(''), sha]),
  SOURCE_RUN_ID: optionalPositive,
  SOURCE_RUN_ATTEMPT: optionalPositive,
  RECORD_ATTEMPT: optionalPositive,
  SUCCESSFUL_JOBS: z.string().transform((value) => z.array(z.string()).parse(JSON.parse(value || '[]'))),
  RECORD_DIRECTORY: z.string().min(1),
  OUTPUT_DIRECTORY: z.string().min(1),
  BUDGET_E2E_ENABLED: z.enum(['true', 'false']).transform((value) => value === 'true'),
  GITHUB_STEP_SUMMARY: z.string().default(''),
});
type Environment = z.infer<typeof environmentSchema>;

function evidenceSource(environment: Environment): EvidenceSource {
  const status = environment.SOURCE_STATUS;
  if (status !== 'found') {
    return { kind: 'unavailable', reason: status === '' ? 'program-unavailable' : status,
      detail: environment.SOURCE_DETAIL || 'the evidence lookup produced no answer' };
  }
  const runId = environment.SOURCE_RUN_ID;
  const runAttempt = environment.SOURCE_RUN_ATTEMPT;
  const recordAttempt = environment.RECORD_ATTEMPT;
  if (runId === '' || runAttempt === '' || recordAttempt === '') {
    return { kind: 'unavailable', reason: 'selection-record-unproven', detail: 'run identity incomplete' };
  }
  const read = readNativeSelectionRecord(join(environment.RECORD_DIRECTORY, NATIVE_SELECTION_RECORD_FILE), {
    runId, runAttempt: recordAttempt, headSha: environment.PR_HEAD_SHA,
  });
  if (read.kind === 'missing') {
    return { kind: 'unavailable', reason: 'selection-record-missing', detail: `run ${runId}: ${read.detail}` };
  }
  return {
    kind: 'found',
    evidence: {
      runId, runAttempt, headSha: environment.PR_HEAD_SHA, recordAttempt,
      successfulJobs: environment.SUCCESSFUL_JOBS, record: read.record,
    },
  };
}

async function run(): Promise<StepDecision> {
  const environment = readStepEnvironment(environmentSchema);
  const event = readMergeGroupEvent();
  if (event === undefined) return fail(error('Queue evidence reuse ran outside a merge_group event.'));
  if (event.prNumber !== environment.PR_NUMBER) {
    return fail(error(`Evidence lookup named pull request #${environment.PR_NUMBER}; `
      + `the queue ref names #${event.prNumber}.`));
  }
  if (environment.SOURCE_STATUS === 'found' && environment.PR_HEAD_SHA === '') {
    return fail(error('Evidence lookup found a pull request run but named no pull request head.'));
  }
  const source = evidenceSource(environment);
  const read = createGithubReader({
    tokens: credentialTokens(environment.GITHUB_TOKEN, environment.GITHUB_FALLBACK_TOKEN),
  });
  const apiRoot = `${environment.GITHUB_API_URL}/repos/${environment.REPOSITORY}`;
  const treeWarnings: string[] = [];
  const warn = (message: string): void => { treeWarnings.push(message); };
  // Trees are only read when there is evidence to compare them for.
  const [headTree, candidateTree] = source.kind === 'found'
    ? await Promise.all([
      readGitTree(read, apiRoot, environment.PR_HEAD_SHA, warn),
      readGitTree(read, apiRoot, event.headSha, warn),
    ])
    : [null, null];
  const cachedTrees = [
    { sha: environment.PR_HEAD_SHA, tree: headTree },
    { sha: event.headSha, tree: candidateTree },
  ];
  const sourceWorkflowSha = source.kind === 'found' ? source.evidence.record.run.workflowSha : undefined;
  const [sourceWorkflowTree, candidateWorkflowTree] = sourceWorkflowSha === undefined
    ? [null, null]
    : await Promise.all([
      readWorkflowRevisionTree(read, apiRoot, sourceWorkflowSha, cachedTrees, warn),
      readWorkflowRevisionTree(read, apiRoot, environment.GITHUB_WORKFLOW_SHA, cachedTrees, warn),
    ]);
  const workflowBlobSha = (tree: typeof headTree): string | undefined => tree
    ?.find((entry) => entry.path === '.github/workflows/ios-tests.yml' && entry.type === 'blob')?.sha;
  const headWorkflowBlobSha = workflowBlobSha(sourceWorkflowTree);
  const candidateWorkflowBlobSha = workflowBlobSha(candidateWorkflowTree);
  const workflowSources = headWorkflowBlobSha !== undefined && candidateWorkflowBlobSha !== undefined
    && headWorkflowBlobSha !== candidateWorkflowBlobSha
    ? await Promise.all([
      readWorkflowBlob(read, apiRoot, sourceWorkflowTree, warn),
      readWorkflowBlob(read, apiRoot, candidateWorkflowTree, warn),
    ]).then(([head, candidate]) => head === null || candidate === null ? null : { head, candidate })
    : null;
  const workflowBlobs = headWorkflowBlobSha === undefined || candidateWorkflowBlobSha === undefined
    ? null : {
      headSha: headWorkflowBlobSha,
      candidateSha: candidateWorkflowBlobSha,
      sources: workflowSources,
    };
  const record = planQueueEvidenceReuse({
    candidateSha: event.headSha,
    queueBaseSha: event.trustedBaseSha,
    prNumber: event.prNumber,
    prHeadSha: environment.PR_HEAD_SHA === '' ? null : environment.PR_HEAD_SHA,
    current: currentSelection(environment),
    budgetE2eEnabled: environment.BUDGET_E2E_ENABLED,
    source,
    headTree,
    candidateTree,
    workflowBlobs,
  });
  const serialized = JSON.stringify(record);
  mkdirSync(environment.OUTPUT_DIRECTORY, { recursive: true });
  writeFileSync(join(environment.OUTPUT_DIRECTORY, QUEUE_EVIDENCE_REUSE_FILE), `${serialized}\n`);
  appendStepOutputs([...reuseGateOutputs(record), ['record', serialized]]);
  const lines = record.lanes.map(verdictLine);
  if (environment.GITHUB_STEP_SUMMARY !== '') {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, [
      `### Merge queue evidence reuse for #${record.prNumber}`,
      '',
      ...lines.map((line) => `- \`${line}\``),
      '',
    ].join('\n'));
  }
  return pass(...treeWarnings.map(warning), ...lines.map(notice));
}

await runAsyncStepProgram('Decide which Mac lanes the queue candidate reuses', run);

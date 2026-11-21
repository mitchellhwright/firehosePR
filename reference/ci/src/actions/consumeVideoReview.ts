import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createVideoFindingGitHub } from '../videoReview/github.ts';
import type { VideoComment } from '../videoReview/github.ts';
import { videoFindingIdentity } from '../videoReview/identities.ts';
import { loadVideoReview } from '../videoReview/load.ts';
import { planVideoOccurrence, recordVideoOccurrence } from '../videoReview/writer.ts';

interface VideoFinding extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
}

interface AgentReview {
  readonly agent: string;
  readonly verdict: string;
  readonly findings: readonly VideoFinding[];
}

interface LoadedVideoReview {
  readonly runId: string;
  readonly runAttempt: string;
  readonly artifactId: number;
  readonly artifactDigest: string;
  readonly context: unknown;
  readonly reviews: readonly AgentReview[];
}

interface VideoOutcome {
  readonly agent: string;
  readonly id?: string;
  action: string;
  reason?: string;
  issueNumber?: number;
  duplicate?: boolean;
  distinctRuns?: number;
  notification?: string;
}

interface ConsumerResult {
  readonly version: 1;
  status: 'running' | 'retry_required' | 'complete';
  readonly runId: string;
  readonly runAttempt: string;
  readonly artifactId: number;
  readonly artifactDigest: string;
  readonly writesEnabled: boolean;
  readonly outcomes: VideoOutcome[];
}

interface ConsumerCheckpoint {
  readonly review: LoadedVideoReview;
  readonly result: ConsumerResult;
}

interface VideoFindingApi {
  readonly writerLogin: string;
  readonly getIssue: (number: number) => Promise<unknown>;
  readonly listComments: (number: number) => Promise<readonly unknown[]>;
  readonly updateLedgerComment: (number: number, expected: VideoComment, body: string) => Promise<unknown>;
  readonly postComment: (number: number, body: string) => Promise<unknown>;
}

interface ConsumerDependencies {
  readonly load: (input: {
    readonly token: string | undefined;
    readonly runId: string | undefined;
    readonly runAttempt: string | undefined;
  }) => Promise<unknown>;
  readonly createApi: (input: {
    readonly token: string | undefined;
    readonly writerLogin: string;
  }) => VideoFindingApi;
}

type PersistCheckpoint = (value: ConsumerCheckpoint) => void | Promise<void>;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function requiredString(candidate: Readonly<Record<string, unknown>>, key: string): string {
  const value = candidate[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Video review ${key} is invalid`);
  }
  return value;
}

function loadedVideoReview(value: unknown): LoadedVideoReview {
  const candidate = record(value);
  if (candidate === undefined || !Array.isArray(candidate['reviews'])) {
    throw new Error('Video review evidence is invalid');
  }
  const artifactId = candidate['artifactId'];
  const artifactDigest = candidate['artifactDigest'];
  if (typeof artifactId !== 'number' || !Number.isSafeInteger(artifactId) || artifactId <= 0
    || typeof artifactDigest !== 'string' || artifactDigest.length === 0) {
    throw new Error('Video review artifact identity is invalid');
  }
  const reviews: AgentReview[] = candidate['reviews'].map((entry: unknown) => {
    const review = record(entry);
    if (review === undefined || !Array.isArray(review['findings'])) {
      throw new Error('Video agent review is invalid');
    }
    const findings: VideoFinding[] = review['findings'].map((item: unknown) => {
      const finding = record(item);
      if (finding === undefined) throw new Error('Video finding is invalid');
      return {
        ...finding,
        id: requiredString(finding, 'id'),
        kind: requiredString(finding, 'kind'),
        severity: requiredString(finding, 'severity'),
      };
    });
    return {
      agent: requiredString(review, 'agent'),
      verdict: requiredString(review, 'verdict'),
      findings,
    };
  });
  return {
    runId: requiredString(candidate, 'runId'),
    runAttempt: requiredString(candidate, 'runAttempt'),
    artifactId,
    artifactDigest,
    context: candidate['context'],
    reviews,
  };
}

function outcomeFields(value: unknown): Partial<VideoOutcome> {
  const candidate = record(value);
  if (candidate === undefined || typeof candidate['action'] !== 'string') {
    throw new Error('Video issue operation returned an invalid outcome');
  }
  const fields: Partial<VideoOutcome> = { action: candidate['action'] };
  if (typeof candidate['reason'] === 'string') fields.reason = candidate['reason'];
  if (typeof candidate['issueNumber'] === 'number') fields.issueNumber = candidate['issueNumber'];
  if (typeof candidate['duplicate'] === 'boolean') fields.duplicate = candidate['duplicate'];
  if (typeof candidate['distinctRuns'] === 'number') fields.distinctRuns = candidate['distinctRuns'];
  if (typeof candidate['notification'] === 'string') fields.notification = candidate['notification'];
  return fields;
}

export function saveVideoCheckpoint(file: string, value: unknown): void {
  const resolvedFile = path.resolve(file);
  const created = mkdirSync(path.dirname(resolvedFile), { recursive: true, mode: 0o700 });
  const temporary = `${resolvedFile}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, resolvedFile);
  let directory = path.dirname(resolvedFile);
  const lastDirectory = created === undefined ? directory : path.dirname(created);
  while (true) {
    const directoryFd = openSync(directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    if (directory === lastDirectory) break;
    directory = path.dirname(directory);
  }
}

/** Consumes authenticated evidence, checkpointing before every remote write. */
export async function consumeLoadedVideoReview(input: {
  readonly review: LoadedVideoReview;
  readonly api: VideoFindingApi;
  readonly persist: PersistCheckpoint;
  readonly writesEnabled?: boolean;
}): Promise<ConsumerResult> {
  const { review, api, persist, writesEnabled = false } = input;
  const result: ConsumerResult = {
    version: 1,
    status: 'running',
    runId: review.runId,
    runAttempt: review.runAttempt,
    artifactId: review.artifactId,
    artifactDigest: review.artifactDigest,
    writesEnabled,
    outcomes: [],
  };
  await persist({ review, result });
  for (const agent of review.reviews) {
    if (agent.verdict === 'unknown') {
      result.outcomes.push({ agent: agent.agent, action: 'triage', reason: 'unknown review evidence' });
      await persist({ review, result });
      continue;
    }
    for (const finding of agent.findings) {
      const outcome: VideoOutcome = { agent: agent.agent, id: finding.id, action: 'pending' };
      result.outcomes.push(outcome);
      await persist({ review, result });
      try {
        const identity = videoFindingIdentity(finding.id);
        if (identity === null || finding.kind !== 'product_defect'
          || !['important', 'critical'].includes(finding.severity)) {
          Object.assign(outcome, { action: 'triage', reason: 'unknown identity or non-material finding' });
        } else if (writesEnabled) {
          const operation = await recordVideoOccurrence({
            finding, context: review.context, runId: review.runId, api,
          });
          Object.assign(outcome, outcomeFields(operation));
        } else {
          const plan = planVideoOccurrence(
            await api.getIssue(identity.canonicalIssue),
            finding,
            review.runId,
            await api.listComments(identity.canonicalIssue),
            api.writerLogin,
          );
          const fields = outcomeFields(plan);
          Object.assign(outcome, fields.action === 'append'
            ? { action: 'would_record', issueNumber: fields.issueNumber, duplicate: fields.duplicate }
            : fields);
        }
      } catch {
        Object.assign(outcome, {
          action: 'retry_required',
          reason: 'Issue operation failed; replay this saved producer run',
        });
      }
      await persist({ review, result });
    }
  }
  result.status = result.outcomes.some(outcome => outcome.action === 'retry_required')
    ? 'retry_required'
    : 'complete';
  await persist({ review, result });
  return result;
}

const defaultDependencies: ConsumerDependencies = {
  load: input => loadVideoReview(input),
  createApi: input => createVideoFindingGitHub(input),
};

export async function consumeVideoReview(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: ConsumerDependencies = defaultDependencies,
): Promise<void> {
  const output = environment['VIDEO_WRITER_OUTPUT'];
  if (output === undefined || !path.isAbsolute(output)) {
    throw new Error('Absolute video writer output path required');
  }
  saveVideoCheckpoint(output, { status: 'loading', reason: 'Fetching authenticated producer evidence' });
  const requested = environment['VIDEO_WRITER_APPLY'] === '1';
  const inventory = record(JSON.parse(readFileSync(
    new URL('../../../docs/ci/video-finding-inventory-2026-09-05.json', import.meta.url), 'utf8',
  )));
  if (requested && (environment['GITHUB_ACTIONS'] !== 'true'
    || environment['ONBOARDING_VIDEO_ISSUE_FILING_ENABLED'] !== '1'
    || inventory?.['migrationComplete'] !== true
    || environment['VIDEO_NAVARCH_CONTROLS_VERIFIED'] !== '1')) {
    saveVideoCheckpoint(output, {
      status: 'held',
      reason: 'Filing requires enabled policy, completed canonical migration and verified owner controls',
    });
    throw new Error('Video filing rollout remains held');
  }
  let review: LoadedVideoReview;
  try {
    review = loadedVideoReview(await dependencies.load({
      token: environment['GITHUB_TOKEN'],
      runId: environment['VIDEO_PRODUCER_RUN_ID'],
      runAttempt: environment['VIDEO_PRODUCER_RUN_ATTEMPT'],
    }));
  } catch {
    saveVideoCheckpoint(output, {
      status: 'load_failed',
      reason: 'Producer evidence could not be authenticated or retrieved; no issue writes attempted',
    });
    throw new Error('Video evidence loading failed');
  }
  const api = dependencies.createApi({
    token: environment['GITHUB_TOKEN'], writerLogin: 'github-actions[bot]',
  });
  const result = await consumeLoadedVideoReview({
    review,
    api,
    writesEnabled: requested,
    persist: value => saveVideoCheckpoint(output, value),
  });
  if (result.status === 'retry_required') throw new Error('Video issue operations require replay');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  consumeVideoReview().catch(() => {
    console.error('Video consumer did not complete; inspect its saved outcome artifact.');
    process.exitCode = 1;
  });
}

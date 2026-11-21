import { z } from 'zod';

/**
 * The per-lane record a merge queue candidate's iOS Change Gate publishes:
 * each lane the candidate could run is `not-selected`, `reused` from a named
 * pull request run, or `executed` with the reason it could not be reused.
 *
 * Kept free of the planner's imports: the required aggregates validate and
 * print this record from their trusted checkout, which carries only `ci/`.
 */

export const QUEUE_EVIDENCE_REUSE_SCHEMA = 'example.ios-queue-evidence-reuse.v1';
export const QUEUE_EVIDENCE_REUSE_FILE = 'ios-queue-evidence-reuse.json';

export const QUEUE_REUSE_LANES = ['native', 'onboarding', 'chat-plaid', 'income', 'budget'] as const;
export type QueueReuseLane = typeof QUEUE_REUSE_LANES[number];
export type RealServerQueueLane = Exclude<QueueReuseLane, 'native'>;

/** Why the pull request run offers no evidence at all. */
export const SOURCE_REFUSALS = [
  'program-unavailable',
  'candidate-unreadable',
  'no-pull-request-run',
  'pull-request-run-in-progress',
  'pull-request-run-not-successful',
  'pull-request-run-mismatch',
  'selection-record-unproven',
  'selection-record-missing',
  'evidence-not-executed-on-head',
] as const;
export type SourceRefusal = typeof SOURCE_REFUSALS[number];

export const EXECUTE_REASONS = [
  ...SOURCE_REFUSALS,
  'lane-not-executed-on-pull-request',
  'selection-not-covered',
  'lane-job-not-successful',
  'tree-unreadable',
  'input-digest-changed',
] as const;
export type ExecuteReason = typeof EXECUTE_REASONS[number];

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const lane = z.enum(QUEUE_REUSE_LANES);

const laneVerdictSchema = z.discriminatedUnion('verdict', [
  z.object({ lane, verdict: z.literal('not-selected') }).strict(),
  z.object({
    lane,
    verdict: z.literal('reused'),
    sourceRunId: z.number().int().positive(),
    sourceRunAttempt: z.number().int().positive(),
    sourceHeadSha: sha,
    inputDigest: z.string().regex(/^[0-9a-f]{64}$/),
    jobs: z.array(z.string().min(1)).min(1),
  }).strict(),
  z.object({
    lane,
    verdict: z.literal('executed'),
    reason: z.enum(EXECUTE_REASONS),
    detail: z.string(),
  }).strict(),
]);
export type LaneVerdict = z.infer<typeof laneVerdictSchema>;

export const queueEvidenceReuseRecordSchema = z.object({
  schema: z.literal(QUEUE_EVIDENCE_REUSE_SCHEMA),
  candidateSha: sha,
  queueBaseSha: sha,
  prNumber: z.string().regex(/^[1-9][0-9]*$/),
  /** `null` only when the candidate could not be re-read, so its pull request head is unknown. */
  prHeadSha: sha.nullable(),
  lanes: z.array(laneVerdictSchema).length(QUEUE_REUSE_LANES.length)
    .refine((verdicts) => QUEUE_REUSE_LANES.every((name, index) => verdicts[index]?.lane === name),
      { message: 'lanes must list every queue lane once, in order' }),
}).strict();
export type QueueEvidenceReuseRecord = z.infer<typeof queueEvidenceReuseRecordSchema>;

function assertNever(value: never): never {
  throw new Error(`Unhandled queue lane verdict: ${JSON.stringify(value)}`);
}

/** The one-line, machine-readable reason each lane resolves with. */
export function verdictLine(verdict: LaneVerdict): string {
  switch (verdict.verdict) {
    case 'reused':
      return `reused: ${verdict.lane} from run ${verdict.sourceRunId} attempt ${verdict.sourceRunAttempt} `
        + `head ${verdict.sourceHeadSha}, input digest ${verdict.inputDigest} `
        + `(not executed on this candidate; jobs ${verdict.jobs.join(',')})`;
    case 'executed':
      return `executed: ${verdict.lane} (${verdict.reason}: ${verdict.detail})`;
    case 'not-selected':
      return `not selected: ${verdict.lane} is not selected for this candidate`;
    default:
      return assertNever(verdict);
  }
}

/** A lane the record calls reused while the gate still requires it, if any. */
export function reusedLaneStillRequired(
  record: QueueEvidenceReuseRecord,
  required: Readonly<Record<QueueReuseLane, boolean>>,
): QueueReuseLane | undefined {
  return record.lanes.find((verdict) => verdict.verdict === 'reused' && required[verdict.lane])?.lane;
}

/** A real-server lane among `contextLanes` that the record reuses, if any. */
export function reusedRealServerLane(
  record: QueueEvidenceReuseRecord,
  contextLanes: readonly QueueReuseLane[],
): RealServerQueueLane | undefined {
  for (const verdict of record.lanes) {
    if (verdict.verdict === 'reused' && verdict.lane !== 'native' && contextLanes.includes(verdict.lane)) {
      return verdict.lane;
    }
  }
  return undefined;
}

export type QueueReuseReport =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'schema-unverified'; readonly message: string; readonly lines: readonly string[] }
  | { readonly kind: 'report'; readonly record: QueueEvidenceReuseRecord; readonly lines: readonly string[] };

/**
 * What an aggregate says about the gate's record for the lanes its context
 * covers. A malformed record, or one that calls a lane reused while the gate
 * still requires it, does not describe what the run did.
 *
 * A reused real-server lane's evidence was produced against the shared
 * development database, which can drift after the pull request run. It
 * stands for the candidate only when `prepare-dev-e2e-schema` verified the
 * candidate's migrations against that database on this run, so any other
 * `schemaPreparationResult` (failed, skipped, missing) refuses it.
 */
export function queueReuseReport(
  rendered: string,
  required: Readonly<Record<QueueReuseLane, boolean>>,
  contextLanes: readonly QueueReuseLane[],
  schemaPreparationResult = '',
): QueueReuseReport {
  if (rendered.trim() === '') return { kind: 'none' };
  let raw: unknown;
  try {
    raw = JSON.parse(rendered);
  } catch {
    return { kind: 'invalid', message: 'the queue evidence reuse record is not JSON' };
  }
  const parsed = queueEvidenceReuseRecordSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', message: 'the queue evidence reuse record fails its schema' };
  const contradicted = reusedLaneStillRequired(parsed.data, required);
  if (contradicted !== undefined) {
    return { kind: 'invalid', message: `the record calls ${contradicted} reused, but the gate still requires it` };
  }
  const lines = parsed.data.lanes
    .filter((verdict) => contextLanes.includes(verdict.lane))
    .map(verdictLine);
  const realServer = reusedRealServerLane(parsed.data, contextLanes);
  if (realServer !== undefined && schemaPreparationResult !== 'success') {
    return {
      kind: 'schema-unverified',
      message: `${realServer} reuses pull request evidence, but prepare-dev-e2e-schema ended `
        + `${schemaPreparationResult || 'without a result'} on this candidate; reused real-server `
        + 'evidence stands only on a development database verified for the candidate',
      lines,
    };
  }
  return { kind: 'report', record: parsed.data, lines };
}

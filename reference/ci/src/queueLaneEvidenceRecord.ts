import type { ValidationLane } from './prValidationVerdict.ts';

/**
 * The records that pass between a pull request's PR Checks run and its merge
 * queue candidate, in a form the aggregate verdict can read without any
 * package installed: the verdict job checks out `ci/src` alone and runs on
 * bare Node. The zod schemas that validate these records on the planner side
 * live in `queueLaneEvidence.ts`, which re-exports everything here.
 */

export const REUSABLE_LINUX_LANES = [
  'workflow-contracts', 'server-static', 'server-process-tests', 'server-tests',
  'targeted-server-tests', 'ios-contracts', 'database-integration',
] as const satisfies readonly ValidationLane[];
export type ReusableLinuxLane = typeof REUSABLE_LINUX_LANES[number];

export function isReusableLinuxLane(lane: string): lane is ReusableLinuxLane {
  return (REUSABLE_LINUX_LANES as readonly string[]).includes(lane);
}

export const LANE_REUSE_REFUSALS = [
  'no-pull-request-run',
  'pull-request-run-unreadable',
  'pull-request-run-in-progress',
  'pull-request-run-not-successful',
  'pull-request-run-mismatch',
  'evidence-marker-missing',
  'evidence-marker-mismatch',
  'lane-not-executed-on-pull-request',
  'lane-job-not-successful',
  'selection-not-covered',
  'tested-tree-unreadable',
  'tested-merge-not-pr-head',
  'input-digest-changed',
  'input-declaration-changed',
] as const;
export type LaneReuseRefusal = typeof LANE_REUSE_REFUSALS[number];

/** The plan fields whose discharge on the PR run must cover the candidate's plan. */
export interface LaneEvidencePlan {
  readonly serverTestMode: 'none' | 'targeted' | 'full';
  readonly targetedServerTests: readonly string[];
  readonly targetedIntegrationTests: readonly string[];
  readonly entitlementAcceptanceRequired: boolean;
  readonly testOnlyHelpersToTypecheck: readonly string[];
  readonly processHeavyRequired: boolean;
  readonly serverStaticRequired: boolean;
  readonly workflowContractsRequired: boolean;
  readonly iosContractsRequired: boolean;
  readonly databaseRequired: boolean;
}

/** Printed by the PR run's aggregate, so a candidate can read what that run discharged. */
export interface PrChecksLaneEvidence {
  readonly schema: 'example.pr-checks-lane-evidence.v1';
  readonly repository: string;
  readonly prNumber: string;
  readonly prHeadSha: string;
  readonly prBaseSha: string;
  /** `github.sha` of the PR run: the merge commit every lane checked out. */
  readonly mergeSha: string;
  readonly workflowSha: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly plan: LaneEvidencePlan;
  readonly results: Readonly<Record<ValidationLane, string>>;
}

export const prChecksLaneEvidenceLogPrefix = 'EXAMPLE_PR_CHECKS_LANE_EVIDENCE_V1=';

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** The marker line; the SHAs and run identity are checked so a malformed run never prints one. */
export function encodePrChecksLaneEvidenceLog(evidence: PrChecksLaneEvidence): string {
  for (const [name, value] of [
    ['prHeadSha', evidence.prHeadSha], ['prBaseSha', evidence.prBaseSha],
    ['mergeSha', evidence.mergeSha], ['workflowSha', evidence.workflowSha],
  ] as const) {
    if (!COMMIT_SHA.test(value)) throw new Error(`Lane evidence ${name} is not a commit SHA: ${JSON.stringify(value)}`);
  }
  if (!/^[1-9][0-9]*$/.test(evidence.prNumber)) throw new Error(`Lane evidence prNumber is not a PR number: ${JSON.stringify(evidence.prNumber)}`);
  for (const [name, value] of [['runId', evidence.runId], ['runAttempt', evidence.runAttempt]] as const) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Lane evidence ${name} is not a positive integer: ${String(value)}`);
  }
  return prChecksLaneEvidenceLogPrefix + Buffer.from(JSON.stringify(evidence)).toString('base64url');
}

export type LaneVerdict =
  | { readonly lane: ReusableLinuxLane; readonly verdict: 'not-selected' }
  | {
    readonly lane: ReusableLinuxLane;
    readonly verdict: 'reused';
    readonly sourceRunId: number;
    readonly sourceRunAttempt: number;
    readonly sourceHeadSha: string;
    readonly testedMergeSha: string;
    readonly inputDigest: string;
    readonly jobs: readonly string[];
  }
  | { readonly lane: ReusableLinuxLane; readonly verdict: 'executed'; readonly reason: LaneReuseRefusal; readonly detail: string };

export interface QueueLaneEvidenceRecord {
  readonly schema: 'example.linux-queue-evidence-reuse.v1';
  readonly candidateSha: string;
  readonly queueBaseSha: string;
  readonly prNumber: string;
  readonly prHeadSha: string;
  readonly lanes: readonly LaneVerdict[];
}

export function reusedLanes(record: QueueLaneEvidenceRecord): ReusableLinuxLane[] {
  return record.lanes.filter((lane) => lane.verdict === 'reused').map((lane) => lane.lane);
}

/** The one line the aggregate prints for a lane; the Mac lanes print the same shapes. */
export function laneVerdictLine(verdict: LaneVerdict): string {
  switch (verdict.verdict) {
    case 'not-selected':
      return `not selected: ${verdict.lane} is not selected for this candidate`;
    case 'reused':
      return `reused: ${verdict.lane} from run ${verdict.sourceRunId} attempt ${verdict.sourceRunAttempt} `
        + `head ${verdict.sourceHeadSha}, input digest ${verdict.inputDigest} `
        + `(not executed on this candidate; tested merge ${verdict.testedMergeSha}; jobs ${verdict.jobs.join(', ') || 'none'})`;
    case 'executed':
      return `executed: ${verdict.lane} (${verdict.reason}: ${verdict.detail})`;
    default:
      return assertNever(verdict);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected lane verdict: ${JSON.stringify(value)}`);
}

/** What the aggregate needs from a reused lane, read from the planner's record. */
export interface ReusedLaneEvidence {
  readonly sourceRunId: number;
  readonly sourceRunAttempt: number;
  readonly sourceHeadSha: string;
  readonly testedMergeSha: string;
  readonly inputDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where} is not a positive integer: ${JSON.stringify(value)}`);
  }
  return value;
}

function matching(value: unknown, pattern: RegExp, where: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${where} is malformed: ${JSON.stringify(value)}`);
  return value;
}

/**
 * The reused lanes of a planner record, validated field by field without a
 * schema library. Anything else in the record is left to the planner-side
 * zod schema; a malformed reused entry fails the verdict closed.
 */
export function reusedLaneEvidence(raw: unknown): Partial<Record<ReusableLinuxLane, ReusedLaneEvidence>> {
  if (!isRecord(raw) || raw['schema'] !== 'example.linux-queue-evidence-reuse.v1' || !Array.isArray(raw['lanes'])) {
    throw new Error('Lane evidence is not a example.linux-queue-evidence-reuse.v1 record.');
  }
  const reused: Partial<Record<ReusableLinuxLane, ReusedLaneEvidence>> = {};
  for (const entry of raw['lanes'] as unknown[]) {
    if (!isRecord(entry) || entry['verdict'] !== 'reused') continue;
    const lane = entry['lane'];
    if (typeof lane !== 'string' || !isReusableLinuxLane(lane)) throw new Error(`Reused lane is not reusable: ${JSON.stringify(lane)}`);
    if (reused[lane] !== undefined) throw new Error(`Lane ${lane} is recorded as reused twice.`);
    reused[lane] = {
      sourceRunId: positiveInteger(entry['sourceRunId'], `${lane} sourceRunId`),
      sourceRunAttempt: positiveInteger(entry['sourceRunAttempt'], `${lane} sourceRunAttempt`),
      sourceHeadSha: matching(entry['sourceHeadSha'], COMMIT_SHA, `${lane} sourceHeadSha`),
      testedMergeSha: matching(entry['testedMergeSha'], COMMIT_SHA, `${lane} testedMergeSha`),
      inputDigest: matching(entry['inputDigest'], /^[0-9a-f]{64}$/, `${lane} inputDigest`),
    };
  }
  return reused;
}

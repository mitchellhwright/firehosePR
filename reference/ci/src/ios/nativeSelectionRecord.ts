import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

import { iosLaneSchema, selectionModeSchema } from '../nativeExecutionPlan.ts';

/**
 * What one iOS change gate selected, recorded so a later head can prove that
 * a re-planned selection asks for nothing the recorded run did not cover.
 *
 * A base update that changed only selection or controller code keeps the
 * earlier run's Mac evidence only when the selection the new code computes
 * for the unchanged patch is a subset of this record. A missing, unreadable,
 * or mismatched record never counts as coverage.
 */

export const NATIVE_SELECTION_RECORD_FILE = 'native-selection-record.json';

export { NATIVE_SELECTION_RECORD_ARTIFACT_PREFIX } from './runArtifactCleanup.ts';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const positiveInteger = z.number().int().positive();
const producerModeSchema = z.enum(['skip', 'unit-preflight', 'shared-products']);

const laneFlagsSchema = z.object({
  storekit: z.boolean(),
  main: z.boolean(),
  onboarding: z.boolean(),
  chatPlaid: z.boolean(),
  budget: z.boolean(),
  income: z.boolean(),
  evidence: z.boolean(),
}).strict();

const nativeSelectionSchema = z.object({
  mode: selectionModeSchema,
  shouldRun: z.boolean(),
  releaseArchiveRequired: z.boolean(),
  narrowPaywallRequired: z.boolean(),
  evidenceGroups: z.array(z.string().min(1)),
  onlyTesting: z.array(z.string().min(1)),
  /** What an evidence Mac lane runs: the selector's evidence-lane identifiers. */
  evidenceTesting: z.array(z.string().min(1)),
  /** native1's separate Wellness contract run and its identifiers. */
  wellnessRequired: z.boolean(),
  wellnessTesting: z.array(z.string().min(1)),
  producerMode: producerModeSchema,
  executionLanes: z.array(iosLaneSchema),
  /** Lanes that must build and run their full product rather than the affected tests. */
  fullExecutionLanes: z.array(iosLaneSchema),
  executionRequired: z.boolean(),
  uiRequired: z.boolean(),
  handoffRequired: z.boolean(),
}).strict();

export const selectionSchema = z.object({
  lanes: laneFlagsSchema,
  native: nativeSelectionSchema.nullable(),
}).strict();
export type RecordedSelection = z.infer<typeof selectionSchema>;

export const nativeSelectionRecordSchema = z.object({
  schema: z.literal('example.ios-native-selection-record.v1'),
  run: z.object({
    id: positiveInteger,
    attempt: positiveInteger,
    headSha: sha,
    verifierSha: sha,
    /** The commit that supplied the workflow executed by this run. */
    workflowSha: sha.optional(),
  }).strict(),
  /** sha256 over the verifier revision and the native changed-file inventory. */
  selectorInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('executed') }).strict(),
    z.object({
      kind: z.literal('retained'),
      runId: positiveInteger,
      runAttempt: positiveInteger,
    }).strict(),
  ]),
  selection: selectionSchema,
}).strict();
export type NativeSelectionRecord = z.infer<typeof nativeSelectionRecordSchema>;

export function selectorInputFingerprint(verifierSha: string, nativeChangedFiles: readonly string[]): string {
  const canonical = JSON.stringify({
    verifierSha,
    nativeChangedFiles: [...new Set(nativeChangedFiles)].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const flag = z.enum(['true', 'false', '']).transform(value => value === 'true');

/** The gate step outputs a selection is read from, as the workflow renders them. */
export const selectionEnvironmentSchema = z.object({
  SELECTION_STOREKIT_REQUIRED: flag,
  SELECTION_MAIN_REQUIRED: flag,
  SELECTION_ONBOARDING_REQUIRED: flag,
  SELECTION_CHAT_PLAID_REQUIRED: flag,
  SELECTION_BUDGET_REQUIRED: flag,
  SELECTION_INCOME_REQUIRED: flag,
  SELECTION_EVIDENCE_REQUIRED: flag,
  NATIVE_PLANNED: flag,
  NATIVE_MODE: z.string(),
  NATIVE_SHOULD_RUN: flag,
  NATIVE_RELEASE_ARCHIVE_REQUIRED: flag,
  NATIVE_NARROW_PAYWALL_REQUIRED: flag,
  NATIVE_EVIDENCE_GROUPS: z.string(),
  NATIVE_ONLY_TESTING_FILE: z.string(),
  NATIVE_EVIDENCE_ONLY_TESTING_FILE: z.string(),
  NATIVE_WELLNESS_REQUIRED: flag,
  NATIVE_WELLNESS_ONLY_TESTING_FILE: z.string(),
  NATIVE_PRODUCER_MODE: z.string(),
  NATIVE_EXECUTION_LANES: z.string(),
  NATIVE_FULL_EXECUTION_LANES: z.string(),
  NATIVE_EXECUTION_REQUIRED: flag,
  NATIVE_UI_REQUIRED: flag,
  NATIVE_HANDOFF_REQUIRED: flag,
});
export type SelectionEnvironment = z.infer<typeof selectionEnvironmentSchema>;

function lines(contents: string): string[] {
  return contents.split('\n').map(line => line.trim()).filter(line => line.length > 0);
}

function identifiers(file: string): string[] {
  if (file.length === 0) return [];
  if (!existsSync(file)) throw new Error(`The selection file ${file} is missing.`);
  return [...new Set(lines(readFileSync(file, 'utf8')))].sort();
}

/** Reads the current gate's selection; the planner ran only when `NATIVE_PLANNED` is true. */
export function currentSelection(environment: SelectionEnvironment): RecordedSelection {
  const lanes = {
    storekit: environment.SELECTION_STOREKIT_REQUIRED,
    main: environment.SELECTION_MAIN_REQUIRED,
    onboarding: environment.SELECTION_ONBOARDING_REQUIRED,
    chatPlaid: environment.SELECTION_CHAT_PLAID_REQUIRED,
    budget: environment.SELECTION_BUDGET_REQUIRED,
    income: environment.SELECTION_INCOME_REQUIRED,
    evidence: environment.SELECTION_EVIDENCE_REQUIRED,
  };
  if (!environment.NATIVE_PLANNED) return { lanes, native: null };
  return selectionSchema.parse({
    lanes,
    native: {
      mode: environment.NATIVE_MODE,
      shouldRun: environment.NATIVE_SHOULD_RUN,
      releaseArchiveRequired: environment.NATIVE_RELEASE_ARCHIVE_REQUIRED,
      narrowPaywallRequired: environment.NATIVE_NARROW_PAYWALL_REQUIRED,
      evidenceGroups: environment.NATIVE_EVIDENCE_GROUPS.split(',')
        .map(group => group.trim()).filter(group => group.length > 0).sort(),
      onlyTesting: identifiers(environment.NATIVE_ONLY_TESTING_FILE),
      evidenceTesting: identifiers(environment.NATIVE_EVIDENCE_ONLY_TESTING_FILE),
      wellnessRequired: environment.NATIVE_WELLNESS_REQUIRED,
      wellnessTesting: identifiers(environment.NATIVE_WELLNESS_ONLY_TESTING_FILE),
      producerMode: environment.NATIVE_PRODUCER_MODE,
      executionLanes: JSON.parse(environment.NATIVE_EXECUTION_LANES || '[]'),
      fullExecutionLanes: JSON.parse(environment.NATIVE_FULL_EXECUTION_LANES || '[]'),
      executionRequired: environment.NATIVE_EXECUTION_REQUIRED,
      uiRequired: environment.NATIVE_UI_REQUIRED,
      handoffRequired: environment.NATIVE_HANDOFF_REQUIRED,
    },
  });
}

export type RecordReadResult =
  | { readonly kind: 'record'; readonly record: NativeSelectionRecord }
  | { readonly kind: 'missing'; readonly detail: string };

/** A record is usable only when it names exactly the run the classifier retained. */
export function readNativeSelectionRecord(
  path: string,
  expected: { readonly runId: number; readonly runAttempt: number; readonly headSha: string },
): RecordReadResult {
  if (!existsSync(path)) return { kind: 'missing', detail: 'no-artifact' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { kind: 'missing', detail: 'unparseable' };
  }
  const result = nativeSelectionRecordSchema.safeParse(parsed);
  if (!result.success) return { kind: 'missing', detail: 'schema-invalid' };
  const { run } = result.data;
  if (run.id !== expected.runId || run.attempt !== expected.runAttempt
    || run.headSha !== expected.headSha) {
    return { kind: 'missing', detail: 'run-mismatch' };
  }
  return { kind: 'record', record: result.data };
}

export type Coverage =
  | { readonly covered: true }
  | { readonly covered: false; readonly uncovered: string };

const modeRank = { skip: 0, affected: 1, full: 2 } as const;
const producerRank = { skip: 0, 'unit-preflight': 1, 'shared-products': 2 } as const;

function uncoveredFlag(
  prior: Readonly<Record<string, boolean>>,
  current: Readonly<Record<string, boolean>>,
  prefix: string,
): string | undefined {
  const name = Object.keys(current).find(key => current[key] === true && prior[key] !== true);
  return name === undefined ? undefined : `${prefix}${name}`;
}

function identifierCovered(identifier: string, prior: readonly string[]): boolean {
  return prior.some(recorded => identifier === recorded || identifier.startsWith(`${recorded}/`));
}

function nativeRequiresWork(native: RecordedSelection['native']): boolean {
  return native !== null && (native.shouldRun || native.producerMode !== 'skip'
    || native.executionLanes.length > 0 || native.releaseArchiveRequired
    || native.wellnessRequired || native.evidenceTesting.length > 0);
}

function uncoveredTest(
  kind: string,
  current: readonly string[],
  prior: readonly string[],
): string | undefined {
  const test = current.find(identifier => !identifierCovered(identifier, prior));
  return test === undefined ? undefined : `native.${kind}:${test}`;
}

function uncoveredNative(
  prior: RecordedSelection['native'],
  current: RecordedSelection['native'],
): string | undefined {
  if (!nativeRequiresWork(current) || current === null) return undefined;
  if (prior === null) return 'native:not-recorded';
  if (modeRank[current.mode] > modeRank[prior.mode]) return `native.mode:${current.mode}`;
  if (producerRank[current.producerMode] > producerRank[prior.producerMode]) {
    return `native.producerMode:${current.producerMode}`;
  }
  const flags = uncoveredFlag({
    shouldRun: prior.shouldRun,
    releaseArchiveRequired: prior.releaseArchiveRequired,
    narrowPaywallRequired: prior.narrowPaywallRequired,
    uiRequired: prior.uiRequired,
    handoffRequired: prior.handoffRequired,
    executionRequired: prior.executionRequired,
    wellnessRequired: prior.wellnessRequired,
  }, {
    shouldRun: current.shouldRun,
    releaseArchiveRequired: current.releaseArchiveRequired,
    narrowPaywallRequired: current.narrowPaywallRequired,
    uiRequired: current.uiRequired,
    handoffRequired: current.handoffRequired,
    executionRequired: current.executionRequired,
    wellnessRequired: current.wellnessRequired,
  }, 'native.');
  if (flags !== undefined) return flags;
  const lane = current.executionLanes.find(candidate => !prior.executionLanes.includes(candidate));
  if (lane !== undefined) return `native.lane:${lane}`;
  // A lane that ran only its affected tests before does not cover a full run now.
  const fullLane = current.fullExecutionLanes
    .find(candidate => !prior.fullExecutionLanes.includes(candidate));
  if (fullLane !== undefined) return `native.fullLane:${fullLane}`;
  const group = current.evidenceGroups.find(candidate => !prior.evidenceGroups.includes(candidate));
  if (group !== undefined) return `native.evidenceGroup:${group}`;
  // The Wellness contract runs its own identifier list in every mode.
  const wellness = uncoveredTest('wellnessTest', current.wellnessTesting, prior.wellnessTesting);
  if (wellness !== undefined || prior.mode === 'full') return wellness;
  return uncoveredTest('test', current.onlyTesting, prior.onlyTesting)
    ?? uncoveredTest('evidenceTest', current.evidenceTesting, prior.evidenceTesting);
}

/** Whether every lane, test and product the current selection needs was part of the recorded one. */
export function selectionCoverage(prior: RecordedSelection, current: RecordedSelection): Coverage {
  const uncovered = uncoveredFlag(prior.lanes, current.lanes, 'lane.')
    ?? uncoveredNative(prior.native, current.native);
  return uncovered === undefined ? { covered: true } : { covered: false, uncovered };
}

/** Gate outputs a covered re-plan replaces: the retained run already proved this work. */
export const COVERED_REPLAN_OUTPUTS = {
  should_run: 'false',
  main_required: 'false',
  storekit_required: 'false',
  onboarding_required: 'false',
  chat_plaid_required: 'false',
  budget_required: 'false',
  income_required: 'false',
  evidence_required: 'false',
  native_should_run: 'false',
  native_mode: 'skip',
  native_ui_required: 'false',
  native_execution_required: 'false',
  native_execution_lanes: '[]',
  native_full_execution_lanes: '[]',
  native_release_archive_required: 'false',
  native_handoff_required: 'false',
  native_changed_files_explicit_empty: 'true',
} as const;
export type CoveredReplanOutput = keyof typeof COVERED_REPLAN_OUTPUTS;

export type ReplanReason = 'replan-covered' | 'replan-expanded' | 'replan-no-record';

export interface ReplanDecision {
  readonly reason: ReplanReason;
  readonly covered: boolean;
  readonly log: string;
}

/**
 * The jobs whose success in the retained run's successful attempt the record's
 * selection relies on, keyed as replanRecordBinding.ts lists them.
 */
export function requiredEvidenceJobs(selection: RecordedSelection): string[] {
  const { lanes, native } = selection;
  const jobs = new Set<string>();
  if (lanes.storekit) jobs.add('storekit');
  if (lanes.onboarding) jobs.add('e2e:onboarding');
  if (lanes.chatPlaid) jobs.add('e2e:chat-plaid');
  if (lanes.income) jobs.add('e2e:income');
  if (lanes.budget) jobs.add('e2e:budget');
  if (native !== null) {
    for (const lane of native.executionLanes) jobs.add(`native:${lane}`);
    if (native.producerMode !== 'skip') jobs.add('native-products');
    if (native.releaseArchiveRequired) jobs.add('release-archive');
    if (native.wellnessRequired) jobs.add('native:native1');
  }
  return [...jobs].sort();
}

export interface ReplanEvidence {
  readonly runId: number;
  /** The attempt whose gate wrote the record; `null` when the classifier could not prove it. */
  readonly recordAttempt: number | null;
  readonly successAttempt: number;
  readonly successfulJobs: readonly string[];
}

/**
 * Covered keeps the retained run's evidence and runs nothing new. Expanded and
 * no-record run the whole re-planned selection; nothing is reported as reused.
 * A record counts only when every job its selection relies on succeeded in the
 * attempt that made the run green.
 */
export function replanDecision(
  read: RecordReadResult,
  current: RecordedSelection,
  evidence: ReplanEvidence,
): ReplanDecision {
  const prior = `prior_run=${evidence.runId} record_attempt=${evidence.recordAttempt ?? 'unproven'} `
    + `success_attempt=${evidence.successAttempt}`;
  const noRecord = (detail: string): ReplanDecision => ({
    reason: 'replan-no-record',
    covered: false,
    log: `iOS selection replan: reason=replan-no-record ${prior} detail=${detail}`,
  });
  if (read.kind === 'missing') return noRecord(read.detail);
  const unproven = requiredEvidenceJobs(read.record.selection)
    .find(job => !evidence.successfulJobs.includes(job));
  if (unproven !== undefined) return noRecord(`required-job-not-successful:${unproven}`);
  const coverage = selectionCoverage(read.record.selection, current);
  const tests = `tests=${current.native?.onlyTesting.length ?? 0} `
    + `prior_tests=${read.record.selection.native?.onlyTesting.length ?? 0}`;
  if (coverage.covered) {
    return {
      reason: 'replan-covered',
      covered: true,
      log: `iOS selection replan: reason=replan-covered ${prior} ${tests}`,
    };
  }
  return {
    reason: 'replan-expanded',
    covered: false,
    log: `iOS selection replan: reason=replan-expanded ${prior} ${tests} uncovered=${coverage.uncovered}`,
  };
}

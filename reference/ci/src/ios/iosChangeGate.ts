import {
  jqAllElements,
  jqAnyElement,
  jqIndexPresent,
  jqJoin,
  jqLength,
  parseJqDocument,
} from './shared/jqSemantics.ts';
import { StepFailure } from './shared/stepFailure.ts';
import type { StepOutput } from './shared/stepIo.ts';
import {
  classifyIosChangedPaths,
  IOS_E2E_AUXILIARY_LANES,
  isIncomeE2EHarnessPath,
  type IosChangeClassification,
  type IosE2eAuxiliaryLane,
} from './iosChangeClassification.ts';

/**
 * The decisions the `Detect iOS Changes` step makes, with none of its I/O.
 *
 * The step is a pipeline with two unavoidable external reads in the middle —
 * the affected-test selector, run once per lane — so the decisions are exposed
 * as the three phases either side of them:
 *
 *   1. `detectEarlyExitOutputs`  before the changed-file inventory is resolved;
 *   2. `planIosChangeDetection`  once the inventory is in hand, either settling
 *      the run outright or reporting that the selectors must run;
 *   3. `completeIosChangeDetection` with the selectors' answers.
 *
 * Each phase returns the exact `$GITHUB_OUTPUT` lines the shell wrote, in the
 * order it wrote them, so a converted step is comparable line for line.
 */

/** Values every `write_outputs` call read from the environment rather than its arguments. */
export interface GateContext {
  /** `$FORCED_IOS_LANES`, echoed verbatim as `rerun_ios_lanes`. */
  readonly forcedIosLanesRaw: string;
  /**
   * `$CONTROLLER_BASE_UPDATE_REUSE_NATIVE_EVIDENCE`, echoed verbatim and used
   * to blank the native inventory.
   */
  readonly reuseNativeEvidenceRaw: string;
  /** `CHANGED_FILES_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}`. */
  readonly changedFilesDelimiter: string;
}

/** The positional arguments of the shell's `write_outputs`, with its defaults. */
export interface DetectOutputFields {
  readonly shouldRun: string;
  readonly summary: string;
  readonly storekitRequired?: string;
  readonly onboardingRequired?: string;
  readonly budgetRequired?: string;
  readonly evidenceRequired?: string;
  readonly changedFiles?: string;
  readonly mainRequired?: string;
  readonly chatPlaidRequired?: string;
  readonly incomeRequired?: string;
}

export const selectorDecisionErrors = {
  evidenceShouldRun: '::error::Evidence selector did not emit a valid should_run decision.',
  mainShouldRun: '::error::Main XCTest selector did not emit a valid should_run decision.',
  mainOnboarding:
    '::error::Main XCTest selector did not emit a valid onboarding_required decision.',
} as const;

export const auxiliaryRerunErrors = {
  invalidPlan: '::error::Retained auxiliary iOS evidence has an invalid rerun plan.',
  noProvenOwner: '::error::Retained native evidence has no proven auxiliary rerun owner.',
  withoutRetainedEvidence: '::error::Auxiliary reruns require retained native evidence.',
} as const;

/** Keep the income runner in E2E classification but out of native XCTest selection. */
export function nativeSelectorChangedFiles(changedFiles: string): string {
  return changedFiles.split('\n')
    .filter((path) => !isIncomeE2EHarnessPath(path))
    .join('\n');
}

export function buildDetectOutputs(
  context: GateContext,
  fields: DetectOutputFields,
): readonly StepOutput[] {
  const changedFiles = fields.changedFiles ?? '';
  const nativeSelectorFiles = nativeSelectorChangedFiles(changedFiles);
  // The E2E lanes route off the effective patch while the native planner
  // consumes only native-owned paths. A reuse run hands the native side an
  // explicitly empty inventory instead of the patch.
  const nativeChangedFiles = context.reuseNativeEvidenceRaw === 'true'
    ? ''
    : nativeSelectorFiles;
  const nativeChangedFilesExplicitEmpty = context.reuseNativeEvidenceRaw === 'true'
    || (changedFiles.trim() !== '' && nativeChangedFiles.trim() === '');
  const delimiter = context.changedFilesDelimiter;
  return [
    { key: 'should_run', value: fields.shouldRun },
    { key: 'storekit_required', value: fields.storekitRequired ?? 'false' },
    { key: 'onboarding_required', value: fields.onboardingRequired ?? 'false' },
    { key: 'budget_required', value: fields.budgetRequired ?? 'false' },
    { key: 'evidence_required', value: fields.evidenceRequired ?? 'false' },
    { key: 'main_required', value: fields.mainRequired ?? 'false' },
    { key: 'chat_plaid_required', value: fields.chatPlaidRequired ?? 'false' },
    { key: 'income_required', value: fields.incomeRequired ?? 'false' },
    { key: 'rerun_ios_lanes', value: context.forcedIosLanesRaw },
    { key: 'changed_files', value: changedFiles, delimiter },
    { key: 'native_changed_files', value: nativeChangedFiles, delimiter },
    { key: 'native_changed_files_explicit_empty', value: String(nativeChangedFilesExplicitEmpty) },
    { key: 'summary', value: fields.summary, delimiter: 'SUMMARY' },
  ];
}

/**
 * A queue candidate whose branch GitHub already deleted: a trusted job will
 * cancel the run, and until that lands nothing downstream may start.
 */
export function candidateGoneOutputs(context: GateContext): readonly StepOutput[] {
  return buildDetectOutputs(context, {
    shouldRun: 'false',
    summary: 'The merge queue deleted this candidate; a trusted job cancels the run.',
  });
}

export interface DetectEarlyExitInput {
  readonly eventName: string;
  readonly testScope?: string;
  readonly baseUpdateSuperseded: string;
  readonly baseUpdateDeferred: string;
}

/**
 * The three exits taken before any changed file is read: a manual run covers
 * everything, and a superseded or deferred head owns no checks at all.
 */
export function detectEarlyExitOutputs(
  context: GateContext,
  input: DetectEarlyExitInput,
): readonly StepOutput[] | undefined {
  // A pull request and a merge queue candidate are both planned from their changed files.
  if (input.eventName !== 'pull_request' && input.eventName !== 'merge_group'
    && input.testScope !== 'promotion-evidence') {
    return buildDetectOutputs(context, {
      shouldRun: 'true',
      summary: 'Manual run requested iOS checks.',
      storekitRequired: 'true',
      onboardingRequired: 'true',
      budgetRequired: 'true',
    });
  }
  if (input.baseUpdateSuperseded === 'true') {
    return buildDetectOutputs(context, {
      shouldRun: 'false',
      summary: 'Superseded by a newer pull-request head.',
    });
  }
  if (input.baseUpdateDeferred === 'true') {
    return buildDetectOutputs(context, {
      shouldRun: 'false',
      summary: 'Waiting for the patch-equivalent predecessor iOS run.',
    });
  }
  return undefined;
}

interface ForcedLaneFlags {
  readonly mainRequired: boolean;
  readonly evidenceRequired: boolean;
}

/**
 * `native1`…`native4` force the main XCTest lane; either evidence lane forces
 * the evidence lane.
 */
export function forcedLaneFlags(forcedIosLanesRaw: string): ForcedLaneFlags {
  const lanes = parseJqDocument(forcedIosLanesRaw);
  return {
    mainRequired: jqAnyElement(
      lanes,
      (lane) => typeof lane === 'string' && /^native[1-4]$/.test(lane),
    ),
    evidenceRequired: jqIndexPresent(lanes, 'evidence-account-update')
      || jqIndexPresent(lanes, 'evidence-account-update-2')
      || jqIndexPresent(lanes, 'evidence-visual'),
  };
}

export interface DetectPlanInput {
  /** `github.event_name`, retained for the gate's event input contract. */
  readonly eventName: string;
  /** The pull request's base branch (`GITHUB_BASE_REF`). */
  readonly baseRef: string;
  readonly changedFiles: string;
  readonly reuseNativeEvidence: string;
  readonly forcedIosAuxiliaryRaw: string;
}

export interface DetectSelectionPlan {
  readonly kind: 'needs-selectors';
  readonly changedFiles: string;
  readonly classification: IosChangeClassification;
  /** Classification's answer, raised by a retained-evidence auxiliary rerun. */
  readonly onboardingRequired: boolean;
}

/** Whether the classification requires one real-server lane. */
export function auxiliaryLaneRequired(
  classification: IosChangeClassification,
  lane: IosE2eAuxiliaryLane,
): boolean {
  const required: Readonly<Record<IosE2eAuxiliaryLane, boolean>> = {
    onboarding: classification.onboardingRequired,
    'chat-plaid': classification.chatPlaidRequired,
    income: classification.incomeRequired,
    budget: classification.budgetRequired,
  };
  return required[lane];
}

export type DetectPlan =
  | { readonly kind: 'final'; readonly outputs: readonly StepOutput[] }
  | DetectSelectionPlan;

/**
 * Classifies the inventory and settles every run that needs no selector: a
 * retained-evidence rerun, a lane-only rerun, and a change that touches no iOS
 * surface at all.
 */
export function planIosChangeDetection(context: GateContext, input: DetectPlanInput): DetectPlan {
  const paths = input.changedFiles.split('\n');
  const classified = classifyIosChangedPaths(paths);

  const auxiliary = parseJqDocument(input.forcedIosAuxiliaryRaw);
  const allowedAuxiliary = new Set<string>(IOS_E2E_AUXILIARY_LANES);
  const auxiliaryIsValid = Array.isArray(auxiliary)
    && jqLength(auxiliary) <= IOS_E2E_AUXILIARY_LANES.length
    && new Set(auxiliary).size === auxiliary.length
    && jqAllElements(auxiliary, (entry) => (
      typeof entry === 'string' && allowedAuxiliary.has(entry)
    ));
  if (!auxiliaryIsValid) throw new StepFailure(auxiliaryRerunErrors.invalidPlan);

  if (input.reuseNativeEvidence === 'true') {
    if (jqLength(auxiliary) === 0) {
      throw new StepFailure(auxiliaryRerunErrors.noProvenOwner);
    }
  } else if (jqLength(auxiliary) > 0) {
    throw new StepFailure(auxiliaryRerunErrors.withoutRetainedEvidence);
  }

  // Retained-evidence routing is the controller's exact, provenance-backed
  // lane plan. Reclassifying the diagnostic changed-file inventory here could
  // silently widen that plan (for example the chat registry also matches the
  // ordinary Budget wildcard), defeating lane-specific reuse.
  const classification: IosChangeClassification = input.reuseNativeEvidence === 'true'
    ? {
      ...classified,
      onboardingRequired: jqIndexPresent(auxiliary, 'onboarding'),
      chatPlaidRequired: jqIndexPresent(auxiliary, 'chat-plaid'),
      incomeRequired: jqIndexPresent(auxiliary, 'income'),
      budgetRequired: jqIndexPresent(auxiliary, 'budget'),
    }
    : classified;

  const forced = forcedLaneFlags(context.forcedIosLanesRaw);
  if (input.reuseNativeEvidence === 'true') {
    return {
      kind: 'final',
      outputs: buildDetectOutputs(context, {
        shouldRun: 'true',
        summary: 'Reusing retained native evidence while rerunning its proven auxiliary checks.',
        storekitRequired: 'false',
        onboardingRequired: String(classification.onboardingRequired),
        chatPlaidRequired: String(classification.chatPlaidRequired),
        incomeRequired: String(classification.incomeRequired),
        budgetRequired: String(classification.budgetRequired),
        evidenceRequired: String(forced.evidenceRequired),
        changedFiles: input.changedFiles,
        mainRequired: String(forced.mainRequired),
      }),
    };
  }

  if (classification.iosChangedFiles.length > 0) {
    return {
      kind: 'needs-selectors',
      changedFiles: input.changedFiles,
      classification,
      onboardingRequired: classification.onboardingRequired,
    };
  }

  const forcedLanes = parseJqDocument(context.forcedIosLanesRaw);
  // A path outside the selector inventory can still own a real-server lane
  // (server/routes/plaid.yaml owns onboarding). That lane runs without any
  // native selection; dropping it here would skip it on every event.
  const laneOnly = IOS_E2E_AUXILIARY_LANES.filter((lane) => auxiliaryLaneRequired(classification, lane));
  if (laneOnly.length > 0) {
    return {
      kind: 'final',
      outputs: buildDetectOutputs(context, {
        shouldRun: 'true',
        summary: `Real-server E2E required without native iOS changes: ${laneOnly.join(', ')}.`,
        storekitRequired: 'false',
        onboardingRequired: String(classification.onboardingRequired),
        chatPlaidRequired: String(classification.chatPlaidRequired),
        incomeRequired: String(classification.incomeRequired),
        budgetRequired: String(classification.budgetRequired),
        evidenceRequired: String(forced.evidenceRequired),
        changedFiles: input.changedFiles,
        mainRequired: String(forced.mainRequired),
      }),
    };
  }

  if (jqLength(forcedLanes) > 0) {
    return {
      kind: 'final',
      outputs: buildDetectOutputs(context, {
        shouldRun: 'true',
        summary: 'Reusing prior successful iOS lanes and rerunning only: '
          + `${jqJoin(forcedLanes, ', ')}.`,
        storekitRequired: 'false',
        onboardingRequired: 'false',
        budgetRequired: 'false',
        evidenceRequired: String(forced.evidenceRequired),
        changedFiles: input.changedFiles,
        mainRequired: String(forced.mainRequired),
      }),
    };
  }

  return {
    kind: 'final',
    outputs: buildDetectOutputs(context, {
      shouldRun: 'false',
      summary: 'No iOS app, iOS test, or iOS test infrastructure files changed.',
      storekitRequired: 'false',
      onboardingRequired: 'false',
      budgetRequired: 'false',
      evidenceRequired: 'false',
      changedFiles: input.changedFiles,
    }),
  };
}

/** A selector writes `true` or `false`; anything else is a selector defect, not a skip. */
export function readSelectorDecision(value: string, annotation: string): boolean {
  if (value !== 'true' && value !== 'false') throw new StepFailure(annotation);
  return value === 'true';
}

export interface DetectLaneFlags {
  readonly storekitRequired: boolean;
  readonly mainRequired: boolean;
  readonly onboardingRequired: boolean;
  readonly chatPlaidRequired: boolean;
  readonly budgetRequired: boolean;
  readonly incomeRequired: boolean;
  readonly evidenceRequired: boolean;
}

export function buildDetectSummary(
  iosChangedFiles: readonly string[],
  flags: DetectLaneFlags,
): string {
  const lines = ['iOS checks required because these files changed:', ...iosChangedFiles];
  if (flags.storekitRequired) {
    lines.push('StoreKit purchase check required by targeted path changes.');
  }
  if (flags.mainRequired) lines.push('Main XCTest lane required by targeted path changes.');
  if (flags.onboardingRequired) lines.push('Onboarding E2E required by targeted path changes.');
  if (flags.chatPlaidRequired) lines.push('Chat-Plaid E2E required by targeted path changes.');
  if (flags.budgetRequired) lines.push('Budget real-server E2E required by targeted path changes.');
  if (flags.incomeRequired) lines.push('Income real-server E2E required by targeted path changes.');
  if (flags.evidenceRequired) {
    lines.push('Account-update acceptance lane required by targeted path changes.');
  }
  return lines.join('\n');
}

export interface SelectorDecisions {
  readonly evidenceRequired: boolean;
  readonly mainRequired: boolean;
  readonly onboardingRequired: boolean;
}

/**
 * Folds the selectors' answers into the classification. Retained native
 * evidence suppresses the native, StoreKit and evidence lanes it already
 * proved; a lane the retained evidence recorded as failed is then re-enabled.
 */
export function completeIosChangeDetection(
  context: GateContext,
  plan: DetectSelectionPlan,
  selectors: SelectorDecisions,
  reuseNativeEvidence: string,
): readonly StepOutput[] {
  const { classification } = plan;
  let storekitRequired = classification.storekitRequired;
  let mainRequired = selectors.mainRequired;
  let evidenceRequired = selectors.evidenceRequired;
  const onboardingRequired = plan.onboardingRequired || selectors.onboardingRequired;

  if (reuseNativeEvidence === 'true') {
    storekitRequired = false;
    mainRequired = false;
    evidenceRequired = false;
  }
  const forced = forcedLaneFlags(context.forcedIosLanesRaw);
  if (forced.mainRequired) mainRequired = true;
  if (forced.evidenceRequired) evidenceRequired = true;

  const flags: DetectLaneFlags = {
    storekitRequired,
    mainRequired,
    onboardingRequired,
    chatPlaidRequired: classification.chatPlaidRequired,
    budgetRequired: classification.budgetRequired,
    incomeRequired: classification.incomeRequired,
    evidenceRequired,
  };
  return buildDetectOutputs(context, {
    shouldRun: 'true',
    summary: buildDetectSummary(classification.iosChangedFiles, flags),
    storekitRequired: String(storekitRequired),
    onboardingRequired: String(onboardingRequired),
    budgetRequired: String(classification.budgetRequired),
    evidenceRequired: String(evidenceRequired),
    changedFiles: plan.changedFiles,
    mainRequired: String(mainRequired),
    chatPlaidRequired: String(classification.chatPlaidRequired),
    incomeRequired: String(classification.incomeRequired),
  });
}

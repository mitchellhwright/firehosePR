import {
  isTrustedDispatchRef,
  isTrustedPullRequestSurface,
  orDefault,
  orMissing,
} from './shared/jobResults.ts';
import { error, fail, info, notSelected, pass, type StepDecision } from './shared/stepDecision.ts';

/**
 * The "Verify iOS test lanes" decision: the required `Test - iOS` context.
 *
 * It aggregates the change gate, the macOS runner resolution, the exact-head
 * Release archive and the one consolidated XCTest execution into a single pass
 * or fail. The rules are evaluated in the order the replaced shell wrote them,
 * because several overlap and the first match wins.
 */

export interface NativeTestLaneStatusInput {
  readonly eventName: string;
  readonly testScope: string;
  readonly dispatchRef: string;
  readonly repository: string;
  readonly headRepository: string;
  readonly baseBranch: string;
  readonly baseUpdateDeferred: string;
  readonly changeGateResult: string;
  readonly changeGateShouldRun: string;
  readonly macRunnerResolutionResult: string;
  readonly nativePreparationResult: string;
  readonly nativeBuildResult: string;
  readonly nativeExecutionRequired: string;
  readonly releaseArchiveRequired: string;
  readonly releaseArchiveResult: string;
  readonly mainExecutionResult: string;
  readonly mainRequired: string;
  readonly evidenceRequired: string;
}

/** The input with the one value the shell reassigned resolved to its effective form. */
interface ResolvedInput extends NativeTestLaneStatusInput {
  readonly effectiveMainExecutionResult: string;
}

/**
 * A prepared, built product that the classifier decided needs no execution has
 * nothing left to run, so its skipped execution counts as a success. Resolved
 * once, up front, because every later rule and both failure messages read the
 * reassigned value, exactly as the shell variable did.
 */
function resolveMainExecutionResult(input: NativeTestLaneStatusInput): string {
  const prepared = orDefault(input.nativePreparationResult, 'skipped') === 'success';
  const built = orDefault(input.nativeBuildResult, 'skipped') === 'success';
  const executionWaived = orDefault(input.nativeExecutionRequired, 'false') === 'false';
  if (prepared && built && executionWaived && input.mainExecutionResult === 'skipped') {
    return 'success';
  }
  return input.mainExecutionResult;
}

type Rule = (input: ResolvedInput) => StepDecision | undefined;

const isDispatch = (input: ResolvedInput): boolean => input.eventName === 'workflow_dispatch';
/**
 * A pull request and a develop merge queue candidate are both reviewed changes
 * on their way into a protected branch, and are judged by the same rules.
 */
const isPullRequest = (input: ResolvedInput): boolean =>
  input.eventName === 'pull_request' || input.eventName === 'merge_group';

/**
 * A deferred head has no evidence of its own yet. It must conclude failure so
 * resumeRetainedIosPredecessor.ts reruns it once the retained predecessor
 * completes; the rerun's classifier then reuses or replaces that evidence.
 */
const retainedPredecessorDeferral: Rule = (input) =>
  orDefault(input.baseUpdateDeferred, 'false') === 'true'
    ? fail(error('The retained predecessor has not completed yet.'))
    : undefined;

const schemaDiagnostic: Rule = (input) => {
  if (!isDispatch(input) || input.testScope !== 'development-e2e-schema') return undefined;
  if (!isTrustedDispatchRef(input.dispatchRef)) {
    return fail(
      error('Development E2E schema verification requires a trusted develop or main ref.'),
    );
  }
  return pass(info('Native iOS tests are outside the development E2E schema verification scope.'));
};

const changeGate: Rule = (input) =>
  input.changeGateResult === 'success'
    ? undefined
    : fail(error(`iOS selection did not complete successfully: ${input.changeGateResult}`));

/**
 * The Release archive is only demanded on the surfaces that ship: a
 * same-repository pull request into develop or main, and a dispatch from one of
 * those refs. Anywhere else the archive job is absent by design.
 */
function releaseArchiveIsDemanded(input: ResolvedInput): boolean {
  if (isPullRequest(input) && isTrustedPullRequestSurface(input)) return true;
  return isDispatch(input) && isTrustedDispatchRef(input.dispatchRef);
}

const releaseArchive: Rule = (input) => {
  if (!releaseArchiveIsDemanded(input)) return undefined;
  if (orDefault(input.releaseArchiveRequired, 'false') !== 'true') return undefined;
  if (orDefault(input.releaseArchiveResult, 'skipped') === 'success') return undefined;
  return fail(
    error(
      'The required exact-head Release archive did not pass: ' +
        `${orMissing(input.releaseArchiveResult)}`,
    ),
  );
};

/**
 * Explicitly absent native selection is independent of deferred real-server
 * journey requirements, so this reports a pass without claiming any lane ran.
 */
const noNativeSelection: Rule = (input) => {
  if (!isPullRequest(input) || (input.baseBranch !== 'develop' && input.baseBranch !== 'main')) {
    return undefined;
  }
  if (input.headRepository !== input.repository) return undefined;
  if (input.changeGateResult !== 'success') return undefined;
  if (input.mainRequired !== 'false' || input.evidenceRequired !== 'false') return undefined;
  const resolverSettled = input.macRunnerResolutionResult === 'success'
    || (input.baseBranch === 'develop' && input.macRunnerResolutionResult === 'skipped');
  if (!resolverSettled || input.effectiveMainExecutionResult !== 'skipped') return undefined;
  return pass(
    notSelected('no native XCTest lane is selected; real-server E2E is evaluated independently.'),
  );
};

const selectedPullRequestLane: Rule = (input) => {
  if (!isPullRequest(input)) return undefined;
  if (input.mainRequired !== 'true' && input.evidenceRequired !== 'true') return undefined;
  if (input.effectiveMainExecutionResult === 'success') return undefined;
  return fail(
    error(
      'Selected PR XCTest did not execute successfully: ' +
        `${input.effectiveMainExecutionResult}`,
    ),
  );
};

const untrustedPullRequest: Rule = (input) => {
  if (!isPullRequest(input) || isTrustedPullRequestSurface(input)) return undefined;
  return pass(
    info('iOS execution is intentionally unavailable for this pull request source or base.'),
  );
};

/** A promotion whose change gate selected nothing never resolved a Mac runner. */
const unaffectedPromotion: Rule = (input) => {
  if (!isPullRequest(input) || input.baseBranch !== 'main') return undefined;
  if (input.headRepository !== input.repository) return undefined;
  if (input.changeGateResult !== 'success') return undefined;
  if (input.changeGateShouldRun === 'true') return undefined;
  if (input.macRunnerResolutionResult !== 'skipped') return undefined;
  if (input.effectiveMainExecutionResult !== 'skipped') return undefined;
  return pass(info('No affected iOS XCTest lane is required for this production promotion.'));
};

const runnerResolution: Rule = (input) =>
  input.macRunnerResolutionResult === 'success'
    ? undefined
    : fail(
        error(`iOS macOS runner resolution did not pass: ${input.macRunnerResolutionResult}`),
      );

/** Dispatch scopes whose evidence the consolidated XCTest lane itself produces. */
const executedEvidenceDispatchMessages: ReadonlyMap<string, string> = new Map([
  ['mortgage-assignment-evidence', 'Issue #4001 mortgage-assignment evidence passed.'],
  [
    'onboarding-copy-evidence',
    'Issue #4549 onboarding-copy accessibility evidence passed from the main XCTest lane.',
  ],
]);

const executedEvidenceDispatch: Rule = (input) => {
  if (!isDispatch(input) || input.changeGateResult !== 'success') return undefined;
  if (input.effectiveMainExecutionResult !== 'success') return undefined;
  const message = executedEvidenceDispatchMessages.get(input.testScope);
  return message === undefined ? undefined : pass(info(message));
};

const consolidatedProductPass =
  'Affected iOS tests and account-update acceptance passed from one compiled product.';

const pullRequestPass: Rule = (input) => {
  if (!isPullRequest(input) || input.baseBranch !== 'develop') return undefined;
  if (input.headRepository !== input.repository) return undefined;
  if (input.changeGateResult !== 'success') return undefined;
  if (input.effectiveMainExecutionResult !== 'success') return undefined;
  return pass(info(consolidatedProductPass));
};

/** Dispatch scopes that deliberately allocate no consolidated native lane. */
const skippedLaneDispatchMessages: ReadonlyMap<string, string> = new Map([
  ['e2e', 'Real-server iOS E2E runs without the consolidated native XCTest lane.'],
  [
    'debt-card-evidence',
    'Issues #3998 and #3999 backend/archive evidence excludes the already-covered ' +
      'frontend XCTest matrices.',
  ],
]);

const skippedLaneDispatch: Rule = (input) => {
  if (!isDispatch(input) || input.changeGateResult !== 'success') return undefined;
  if (input.effectiveMainExecutionResult !== 'skipped') return undefined;
  if (input.testScope === 'promotion-evidence'
    && isTrustedDispatchRef(input.dispatchRef)
    && input.nativePreparationResult === 'success'
    && input.nativeExecutionRequired === 'false'
    && input.mainRequired === 'false'
    && input.evidenceRequired === 'false') {
    return pass(info('Typed exact-develop plan selected no native XCTest execution.'));
  }
  const message = skippedLaneDispatchMessages.get(input.testScope);
  return message === undefined ? undefined : pass(info(message));
};

const executedLanePass: Rule = (input) =>
  input.changeGateResult === 'success' && input.effectiveMainExecutionResult === 'success'
    ? pass(info(consolidatedProductPass))
    : undefined;

const executionFailure: Rule = (input) =>
  input.effectiveMainExecutionResult === 'success'
    ? undefined
    : fail(
        error(
          'The consolidated iOS XCTest execution did not pass: ' +
            `main=${input.effectiveMainExecutionResult}`,
        ),
      );

/** Evaluated in the order the replaced shell wrote them; the first match wins. */
const rules: readonly Rule[] = [
  retainedPredecessorDeferral,
  schemaDiagnostic,
  changeGate,
  releaseArchive,
  noNativeSelection,
  selectedPullRequestLane,
  untrustedPullRequest,
  unaffectedPromotion,
  runnerResolution,
  executedEvidenceDispatch,
  pullRequestPass,
  skippedLaneDispatch,
  executedLanePass,
  executionFailure,
];

export function deriveNativeTestLaneStatus(input: NativeTestLaneStatusInput): StepDecision {
  const resolved: ResolvedInput = {
    ...input,
    effectiveMainExecutionResult: resolveMainExecutionResult(input),
  };
  for (const rule of rules) {
    const decision = rule(resolved);
    if (decision !== undefined) return decision;
  }
  return pass(info('All required iOS XCTest lanes passed.'));
}

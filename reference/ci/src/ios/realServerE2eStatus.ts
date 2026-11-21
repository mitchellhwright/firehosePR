import { z } from 'zod';

import {
  isTrustedDispatchRef,
  isTrustedPullRequestSurface,
  orMissing,
} from './shared/jobResults.ts';
import {
  error,
  fail,
  info,
  notSelected,
  pass,
  type StepDecision,
  type StepMessage,
} from './shared/stepDecision.ts';

/**
 * The "Verify onboarding execution result" decision, shared by both aggregates
 * that make it.
 *
 * `test-ios` and `onboarding-e2e-status` each end with a step of this name,
 * and the two shell blocks were identical but for which dispatch scopes they
 * report as out of scope. One decision module serves both; the aggregate is an
 * input, and `outOfScopeDispatchMessages` is the only place they differ.
 *
 * Every lane result here is a `needs.<job>.result` string. The rules are
 * evaluated in the order the shell wrote them, because several overlap and the
 * first match wins.
 */

export const realServerE2eAggregateSchema = z.enum(['test-ios', 'onboarding-e2e-status']);

export type RealServerE2eAggregate = z.infer<typeof realServerE2eAggregateSchema>;

/** One real-server lane: whether the change gate selected it, and how it ended. */
export interface LaneStatus {
  readonly required: boolean;
  readonly result: string;
}

export interface RealServerE2eStatusInput {
  readonly aggregate: RealServerE2eAggregate;
  readonly eventName: string;
  readonly testScope: string;
  readonly dispatchRef: string;
  readonly changeGateResult: string;
  readonly headRepository: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly budgetE2eEnabled: boolean;
  readonly onboarding: LaneStatus;
  readonly chatPlaid: LaneStatus;
  readonly income: LaneStatus;
  readonly budget: LaneStatus;
  /** `needs.prepare-dev-e2e-schema.result`: the first job that holds `development-e2e`. */
  readonly schemaPreparationResult?: string;
}

/**
 * Typed reason for a queue candidate whose real-server lanes could not reach
 * the `development-e2e` environment. Its branch policy admits develop, main
 * and PR merge refs; `gh-readonly-queue/develop/*` has to be added before the
 * queue is enabled (merge-queue plan S2).
 */
export const DEVELOPMENT_E2E_NOT_ADMITTED = 'development-e2e-not-admitted';

function outOfScope(scope: string): string {
  return `Real-server E2E is outside the ${scope} scope.`;
}

/**
 * Dispatch scopes each aggregate reports as expecting no real-server E2E, with
 * the exact line it prints. `test-ios` covers the shared-CTA evidence scope
 * because its own native lane runs there; `onboarding-e2e-status` instead
 * covers the onboarding-copy scope, whose native evidence `test-ios` reports
 * as a pass of its own earlier on. A scope absent from an aggregate's table
 * falls through to the unexpected-results failure, which is the fail-closed
 * end of both blocks.
 */
export const outOfScopeDispatchMessages: Record<
  RealServerE2eAggregate,
  ReadonlyMap<string, string>
> = {
  'test-ios': new Map([
    ['mortgage-assignment-evidence', outOfScope('mortgage-assignment-evidence')],
    ['financial-independence-evidence', outOfScope('financial-independence-evidence')],
    ['shared-cta-evidence', outOfScope('shared-cta-evidence')],
  ]),
  'onboarding-e2e-status': new Map([
    ['mortgage-assignment-evidence', outOfScope('mortgage-assignment-evidence')],
    ['financial-independence-evidence', outOfScope('financial-independence-evidence')],
    ['onboarding-copy-evidence', 'Real-server E2E is outside the onboarding-copy evidence scope.'],
  ]),
};

type Rule = (input: RealServerE2eStatusInput) => StepDecision | undefined;

const isDispatch = (input: RealServerE2eStatusInput): boolean =>
  input.eventName === 'workflow_dispatch';

const allLanesSkipped = (input: RealServerE2eStatusInput): boolean =>
  input.onboarding.result === 'skipped' &&
  input.chatPlaid.result === 'skipped' &&
  input.income.result === 'skipped' &&
  input.budget.result === 'skipped';

/** The three lanes whose "skipped" the pre-income evidence rules still test. */
const coreLanesSkipped = (input: RealServerE2eStatusInput): boolean =>
  input.onboarding.result === 'skipped' &&
  input.chatPlaid.result === 'skipped' &&
  input.budget.result === 'skipped';

/**
 * The manual schema diagnostic runs no lane at all, so it reports a pass — but
 * only from a trusted ref, because an off-branch dispatch could otherwise
 * report a green required context without running anything.
 */
const schemaDiagnostic: Rule = (input) => {
  if (!isDispatch(input) || input.testScope !== 'development-e2e-schema') return undefined;
  if (!isTrustedDispatchRef(input.dispatchRef)) {
    return fail(
      error('Development E2E schema verification requires a trusted develop or main ref.'),
    );
  }
  return pass(info('Real-server E2E is outside the development E2E schema verification scope.'));
};

/** `verify_lane`: a selected lane must pass, an unselected one must not have run. */
function verifyLane(name: string, lane: LaneStatus): StepMessage | undefined {
  if (lane.required) {
    if (lane.result === 'success') return undefined;
    return error(`Selected ${name} E2E did not pass: ${orMissing(lane.result)}`);
  }
  if (lane.result === 'skipped') return undefined;
  return error(`Unselected ${name} E2E had unexpected result: ${orMissing(lane.result)}`);
}

/**
 * Budget E2E is switched off by a repository variable while the feature
 * changes. Disabled, the lane must still be skipped: a run of it would mean
 * the switch did not reach the job that reads it.
 */
function verifyBudgetLane(input: RealServerE2eStatusInput): StepMessage | undefined {
  if (input.budgetE2eEnabled) return verifyLane('budget', input.budget);
  if (input.budget.result !== 'skipped') {
    return error(`Disabled budget E2E had unexpected result: ${orMissing(input.budget.result)}`);
  }
  return info('Budget E2E is temporarily disabled while the feature is changing.');
}

function pullRequestLaneDecision(input: RealServerE2eStatusInput): StepDecision {
  const messages: StepMessage[] = [];
  for (const [name, lane] of [
    ['onboarding', input.onboarding],
    ['chat-plaid', input.chatPlaid],
    ['income', input.income],
  ] as const) {
    const failure = verifyLane(name, lane);
    if (failure !== undefined) messages.push(failure);
  }
  // The budget verdict prints before the collected failures are acted on, so a
  // disabled-budget notice still appears alongside another lane's error.
  const budget = verifyBudgetLane(input);
  if (budget !== undefined) messages.push(budget);
  if (messages.some((message) => message.level === 'error')) {
    return { messages, exitCode: 1 };
  }
  messages.push(info('All selected pull-request real-server E2E lanes passed.'));
  return { messages, exitCode: 0 };
}

/** Some selected lane exists; with the schema job not passing, none of them could deploy. */
function anyLaneSelected(input: RealServerE2eStatusInput): boolean {
  return input.onboarding.required || input.chatPlaid.required || input.income.required
    || (input.budgetE2eEnabled && input.budget.required);
}

/**
 * A queue candidate whose selected real-server lanes never got the
 * environment fails closed with a reason that names the missing setting,
 * rather than a bare "did not pass: skipped".
 */
const mergeGroupEnvironmentBlocked: Rule = (input) => {
  if (input.eventName !== 'merge_group' || input.changeGateResult !== 'success') return undefined;
  if (!anyLaneSelected(input) || input.schemaPreparationResult === 'success') return undefined;
  return fail(error(
    `${DEVELOPMENT_E2E_NOT_ADMITTED}: selected real-server E2E could not run for this merge queue `
      + `candidate; prepare-dev-e2e-schema ended ${orMissing(input.schemaPreparationResult ?? '')}. `
      + 'The development-e2e environment must admit gh-readonly-queue/develop/* branches '
      + '(merge-queue plan S2).',
  ));
};

/** A pull request and a develop merge queue candidate are judged by the same lane rules. */
const isReviewedChange = (input: RealServerE2eStatusInput): boolean =>
  input.eventName === 'pull_request' || input.eventName === 'merge_group';

const pullRequestLanes: Rule = (input) => {
  if (!isReviewedChange(input) || input.changeGateResult !== 'success') return undefined;
  if (!isTrustedPullRequestSurface(input)) {
    if (allLanesSkipped(input)) {
      return pass(info('Real-server E2E is unavailable for this pull request source or base.'));
    }
    return fail(error('An untrusted pull request unexpectedly executed real-server E2E.'));
  }
  if (input.baseBranch === 'main' && !input.onboarding.required) {
    return fail(error('A production promotion must select and pass onboarding E2E.'));
  }
  const nothingSelected =
    !input.onboarding.required &&
    !input.chatPlaid.required &&
    !input.income.required &&
    !input.budget.required;
  if (nothingSelected && allLanesSkipped(input)) {
    return pass(notSelected('no real-server E2E lane is selected for these changes.'));
  }
  return pullRequestLaneDecision(input);
};

/** An untrusted dispatch never allocates a privileged runner; four skips prove it. */
const deferredDispatch: Rule = (input) => {
  if (!isDispatch(input) || isTrustedDispatchRef(input.dispatchRef)) return undefined;
  if (input.changeGateResult !== 'success' || !allLanesSkipped(input)) return undefined;
  return pass(
    info(
      'Privileged real-server E2E requires a trusted develop or main ref; ' +
        'this dispatch is deferred, not executed.',
    ),
  );
};

/** Promotion evidence always executes onboarding; impact selects other journeys. */
const promotionEvidenceDispatch: Rule = (input) => {
  if (!isDispatch(input) || input.testScope !== 'promotion-evidence') return undefined;
  if (!isTrustedDispatchRef(input.dispatchRef) || input.changeGateResult !== 'success'
    || !input.onboarding.required || input.onboarding.result !== 'success') {
    return fail(error('Exact-develop promotion evidence requires successful real-server onboarding.'));
  }
  return pullRequestLaneDecision(input);
};

/** The focused `e2e` dispatch runs every lane the budget switch allows. */
const focusedE2eDispatch: Rule = (input) => {
  if (!isDispatch(input) || input.testScope !== 'e2e') return undefined;
  const coreSucceeded =
    input.onboarding.result === 'success' &&
    input.chatPlaid.result === 'success' &&
    input.income.result === 'success';
  if (!coreSucceeded) return undefined;
  const budgetMatchesSwitch = input.budgetE2eEnabled
    ? input.budget.result === 'success'
    : input.budget.result === 'skipped';
  if (!budgetMatchesSwitch) return undefined;
  return pass(info('All selected manual real-server E2E lanes passed.'));
};

/** Kept silent by the shell it replaces: a bare `exit 0` with no line printed. */
const budgetRanWithoutIncome: Rule = (input) => {
  if (
    input.onboarding.result === 'success' &&
    input.chatPlaid.result === 'success' &&
    input.income.result === 'skipped' &&
    input.budget.result === 'success'
  ) {
    return pass();
  }
  return undefined;
};

const budgetDisabledPass: Rule = (input) => {
  if (input.budgetE2eEnabled) return undefined;
  if (
    input.onboarding.result === 'success' &&
    input.chatPlaid.result === 'success' &&
    input.income.result === 'skipped' &&
    input.budget.result === 'skipped'
  ) {
    return pass(info('Onboarding and Chat Plaid E2E passed; Budget E2E is temporarily disabled.'));
  }
  return undefined;
};

const evidenceDispatch: Rule = (input) => {
  if (!isDispatch(input) || input.testScope !== 'evidence') return undefined;
  if (
    input.onboarding.result === 'success' &&
    input.chatPlaid.result === 'success' &&
    input.income.result === 'skipped' &&
    input.budget.result === 'skipped'
  ) {
    return pass(info('Account-update acceptance completed without allocating the Budget runner.'));
  }
  return undefined;
};

const debtCardDispatch: Rule = (input) => {
  if (!isDispatch(input) || input.testScope !== 'debt-card-evidence') return undefined;
  if (
    input.onboarding.result === 'skipped' &&
    input.chatPlaid.result === 'skipped' &&
    input.budget.result === 'success'
  ) {
    return pass(
      info('Debt-card evidence completed without allocating the onboarding or Chat Plaid runners.'),
    );
  }
  return undefined;
};

const outOfScopeDispatch: Rule = (input) => {
  if (!isDispatch(input) || !coreLanesSkipped(input)) return undefined;
  const message = outOfScopeDispatchMessages[input.aggregate].get(input.testScope);
  return message === undefined ? undefined : pass(info(message));
};

/** Evaluated in the order the replaced shell wrote them; the first match wins. */
const rules: readonly Rule[] = [
  schemaDiagnostic,
  mergeGroupEnvironmentBlocked,
  pullRequestLanes,
  deferredDispatch,
  promotionEvidenceDispatch,
  focusedE2eDispatch,
  budgetRanWithoutIncome,
  budgetDisabledPass,
  evidenceDispatch,
  debtCardDispatch,
  outOfScopeDispatch,
];

export function deriveRealServerE2eStatus(input: RealServerE2eStatusInput): StepDecision {
  for (const rule of rules) {
    const decision = rule(input);
    if (decision !== undefined) return decision;
  }
  return fail(
    error(
      `Unexpected real-server E2E results: onboarding=${input.onboarding.result} ` +
        `chat-plaid=${input.chatPlaid.result} income=${input.income.result} ` +
        `budget=${input.budget.result}`,
    ),
  );
}

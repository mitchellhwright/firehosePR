import { z } from 'zod';

import { isTrue, renderedEnvironmentValue } from '../../ios/shared/jobResults.ts';
import { runStepProgram } from '../../ios/shared/stepDecision.ts';
import {
  deriveRealServerE2eStatus,
  realServerE2eAggregateSchema,
} from '../../ios/realServerE2eStatus.ts';

/**
 * "Verify onboarding execution result", for both aggregates that run it.
 *
 * `test-ios` and `onboarding-e2e-status` invoke this same program and differ
 * only in `STATUS_AGGREGATE`, which selects which dispatch scopes count as out
 * of scope. Every other input keeps the env name the replaced shell read.
 *
 * Absent values default to the empty string rather than failing validation,
 * because that is what GitHub renders for a `needs.<job>.result` the run never
 * produced, and the empty string matches neither "success" nor "skipped" — so
 * a missing input still falls through to the fail-closed unexpected-results
 * error instead of silently passing.
 */
const environmentSchema = z.object({
  STATUS_AGGREGATE: realServerE2eAggregateSchema,
  EVENT_NAME: renderedEnvironmentValue,
  TEST_SCOPE: renderedEnvironmentValue,
  DISPATCH_REF: renderedEnvironmentValue,
  CHANGE_GATE_RESULT: renderedEnvironmentValue,
  HEAD_REPOSITORY: renderedEnvironmentValue,
  REPOSITORY: renderedEnvironmentValue,
  BASE_BRANCH: renderedEnvironmentValue,
  BUDGET_E2E_ENABLED: renderedEnvironmentValue,
  EXECUTION_RESULT: renderedEnvironmentValue,
  CHAT_PLAID_EXECUTION_RESULT: renderedEnvironmentValue,
  INCOME_EXECUTION_RESULT: renderedEnvironmentValue,
  BUDGET_EXECUTION_RESULT: renderedEnvironmentValue,
  ONBOARDING_REQUIRED: renderedEnvironmentValue,
  CHAT_PLAID_REQUIRED: renderedEnvironmentValue,
  INCOME_REQUIRED: renderedEnvironmentValue,
  BUDGET_REQUIRED: renderedEnvironmentValue,
  SCHEMA_PREPARATION_RESULT: renderedEnvironmentValue,
});

runStepProgram('Real-server E2E status verification', () => {
  const environment = environmentSchema.parse(process.env);
  return deriveRealServerE2eStatus({
    aggregate: environment.STATUS_AGGREGATE,
    eventName: environment.EVENT_NAME,
    testScope: environment.TEST_SCOPE,
    dispatchRef: environment.DISPATCH_REF,
    changeGateResult: environment.CHANGE_GATE_RESULT,
    headRepository: environment.HEAD_REPOSITORY,
    repository: environment.REPOSITORY,
    baseBranch: environment.BASE_BRANCH,
    budgetE2eEnabled: isTrue(environment.BUDGET_E2E_ENABLED),
    onboarding: {
      required: isTrue(environment.ONBOARDING_REQUIRED),
      result: environment.EXECUTION_RESULT,
    },
    chatPlaid: {
      required: isTrue(environment.CHAT_PLAID_REQUIRED),
      result: environment.CHAT_PLAID_EXECUTION_RESULT,
    },
    income: {
      required: isTrue(environment.INCOME_REQUIRED),
      result: environment.INCOME_EXECUTION_RESULT,
    },
    budget: {
      required: isTrue(environment.BUDGET_REQUIRED),
      result: environment.BUDGET_EXECUTION_RESULT,
    },
    schemaPreparationResult: environment.SCHEMA_PREPARATION_RESULT,
  });
});

import {
  byEvent, ciEventField, expr, github, typedJob, typedStep,
} from '../lib/index.ts';
import { budgetE2e } from './budget-e2e.ts';
import { chatPlaidE2e } from './chat-plaid-e2e.ts';
import { incomeE2e } from './income-e2e.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { onboardingE2e } from './onboarding-e2e.ts';
import { prepareDevE2eSchema } from './prepare-dev-e2e-schema.ts';
import { promotionVerdict } from './promotion-verdict.ts';
import { queueEvidenceReportAt } from './queue-evidence-report.ts';
import {
  controlLane, installTypedCiDependencies, iosCompletionVerdictRunner, iosGateOutput, setupNode,
  STATUS_AGGREGATE_IF, trustedBaseCheckout,
} from './shared.ts';

/**
 * The required check that says whether the real-server E2E lanes passed.
 *
 * Four lanes drive a real backend through onboarding, chat, income and budget,
 * and each of them is selected independently — so the verdict is not "did they
 * all pass" but "did every lane this change required pass". The decision needs
 * the gate's four selection outputs as much as the four results, which is why
 * it is one typed program rather than a condition on this job.
 */

const verifyOnboardingResult = typedStep({
  name: 'Verify onboarding execution result',
  doc: {
    purpose: 'Decides whether every real-server E2E lane this change required finished successfully.',
    recovery: 'read the lane the step names; a failing E2E lane is fixed in the branch, not here',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("needs.ios-change-gate.outputs.production_promotion != 'true'"),
  env: {
    // Both aggregates run the same program; this is how it knows which of the
    // two verdicts it is publishing.
    STATUS_AGGREGATE: 'onboarding-e2e-status',
    CHANGE_GATE_RESULT: expr('needs.ios-change-gate.result'),
    EVENT_NAME: github('event_name'),
    EXECUTION_RESULT: expr('needs.onboarding-e2e.result'),
    CHAT_PLAID_EXECUTION_RESULT: expr('needs.chat-plaid-e2e.result'),
    BUDGET_EXECUTION_RESULT: expr('needs.budget-e2e.result'),
    INCOME_EXECUTION_RESULT: expr('needs.income-e2e.result'),
    ONBOARDING_REQUIRED: iosGateOutput('onboarding_required'),
    CHAT_PLAID_REQUIRED: iosGateOutput('chat_plaid_required'),
    BUDGET_REQUIRED: iosGateOutput('budget_required'),
    INCOME_REQUIRED: iosGateOutput('income_required'),
    BUDGET_E2E_ENABLED: expr("vars.IOS_ENABLE_BUDGET_E2E == 'true'"),
    HEAD_REPOSITORY: ciEventField('headRepository'),
    REPOSITORY: github('repository'),
    BASE_BRANCH: ciEventField('baseBranch'),
    DISPATCH_REF: github('ref'),
    TEST_SCOPE: expr("inputs.test_scope || ''"),
    SCHEMA_PREPARATION_RESULT: expr('needs.prepare-dev-e2e-schema.result'),
  },
  command: 'node ci/src/actions/ios/verifyRealServerE2eStatus.ts',
});

export const onboardingE2eStatus = typedJob('onboarding-e2e-status', {
  // A manual run reports under its own name, so a dispatch can never satisfy
  // the required context a pull request has to earn.
  name: byEvent({ workflow_dispatch: 'Manual - Onboarding E2E' }, 'Onboarding E2E'),
  requiredCheckContext: 'Onboarding E2E',
  doc: {
    purpose: 'Publishes the real-server E2E verdict the develop and main rulesets list as a required check.',
    successMeaning: 'Every real-server E2E lane this change required drove a live backend successfully.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'suite',
  needs: [iosChangeGate, onboardingE2e, chatPlaidE2e, incomeE2e, budgetE2e, prepareDevE2eSchema],
  if: STATUS_AGGREGATE_IF,
  runsOn: iosCompletionVerdictRunner,
  timeoutMinutes: 10,
  lane: controlLane,
  steps: [
    // The aggregate below is a typed program under ci/, so this job needs a
    // tree and that layer's dependencies. It checks out the trusted base, not
    // the pull request head, so the required verdict comes from reviewed code.
    trustedBaseCheckout(),
    setupNode('Setup Node for the typed aggregates'),
    installTypedCiDependencies('Install typed aggregate dependencies', 'ci'),
    promotionVerdict,
    queueEvidenceReportAt(['onboarding', 'chat-plaid', 'income', 'budget']),
    verifyOnboardingResult,
  ],
});

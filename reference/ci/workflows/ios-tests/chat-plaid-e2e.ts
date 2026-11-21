import { expr, typedJob } from '../lib/index.ts';
import { buildIosE2eTestProducts } from './build-ios-e2e-test-products.ts';
import { confirmCurrentIosPr } from './confirm-current-ios-pr.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { prepareDevE2eSchema } from './prepare-dev-e2e-schema.ts';
import {
  DISPATCHED_FROM_TARGET_BRANCH, LANE_COMMIT_SHA, LANE_ENVIRONMENT, LANE_PERMISSIONS,
  LANE_PREREQUISITES, NOT_A_FOCUSED_EVIDENCE_SCOPE, SAME_REPOSITORY_TARGET_BRANCH,
  realServerE2eSteps,
} from './real-server-e2e-steps.ts';
import { e2eMacLane, laneConcurrency, reviewedPrMacs } from './shared.ts';

/**
 * Linking a bank from inside the chat, against a real development backend.
 *
 * The chat is the only place in the product where a Plaid link is started by
 * a model deciding to start one, so it is the only journey that proves the
 * tool call, the Link handoff and the backend write still line up. The lane
 * signs in as a throwaway account it creates on its own backend and deletes
 * afterwards, and a passing XCTest is not enough on its own: the evidence
 * step below reads the backend log to prove the link really happened.
 */

export const chatPlaidE2e = typedJob('chat-plaid-e2e', {
  name: 'Real-server E2E execution (chat-plaid)',
  doc: {
    purpose: 'Runs the chat-driven Plaid linking journey against a real development backend.',
    successMeaning: 'A person can link a bank from the chat and the backend recorded the link.',
  },
  owner: 'product',
  category: 'coordination',
  unit: 'suite',
  concurrency: laneConcurrency('chat-plaid'),
  needs: [iosChangeGate, confirmCurrentIosPr, buildIosE2eTestProducts, prepareDevE2eSchema],
  runsOn: reviewedPrMacs,
  permissions: LANE_PERMISSIONS,
  environment: LANE_ENVIRONMENT,
  env: {
    E2E_LANE: 'chat-plaid',
    ONBOARDING_DEV_BACKEND_PORT: '3200',
    ONBOARDING_E2E_COMMIT_SHA: LANE_COMMIT_SHA,
    TEST_RUNNER_UI_TEST_API_BASE_URL: 'http://127.0.0.1:3200/api',
    VERIFY_APPLE_AUTHORIZATION_SCHEMA: 'false',
  },
  if: expr(
    'always() && !cancelled() '
    + "&& needs.confirm-current-ios-pr.outputs.current == 'true' "
    + `&& ${LANE_PREREQUISITES} `
    + "&& (needs.ios-change-gate.outputs.chat_plaid_required == 'true' "
    + "|| (github.event_name == 'workflow_dispatch' && inputs.test_scope == 'evidence')) "
    + `&& ((${SAME_REPOSITORY_TARGET_BRANCH}) `
    + `|| (${DISPATCHED_FROM_TARGET_BRANCH} && ${NOT_A_FOCUSED_EVIDENCE_SCOPE}))`,
  ),
  lane: e2eMacLane,
  steps: realServerE2eSteps,
});

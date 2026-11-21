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
 * Income activation, checked in the app and then in the database.
 *
 * The other lanes finish when the app says they did. This one does not: it
 * opens a Cloud SQL connection and reads the rows activation was supposed to
 * write, because an income activation that looks right on screen and stored
 * nothing is exactly the failure a UI test cannot see. That connection is why
 * the lane carries the proxy and psql steps the others skip.
 *
 * It is also the only lane whose tuple check is conditional. The two other
 * required lanes refuse to run when the pull request has moved; this one is
 * selected by changed paths and dispatched by scope, so a non-pull-request
 * event has no tuple to compare and is admitted on the gate's answer alone.
 */

export const incomeE2e = typedJob('income-e2e', {
  name: 'Real-server E2E execution (income)',
  doc: {
    purpose: 'Runs income activation against a real backend and verifies the rows it wrote.',
    successMeaning: 'Income activation both completes on screen and persists at this head.',
  },
  owner: 'product',
  category: 'coordination',
  unit: 'suite',
  concurrency: laneConcurrency('income'),
  needs: [iosChangeGate, confirmCurrentIosPr, buildIosE2eTestProducts, prepareDevE2eSchema],
  runsOn: reviewedPrMacs,
  permissions: LANE_PERMISSIONS,
  environment: LANE_ENVIRONMENT,
  env: {
    E2E_LANE: 'income',
    ONBOARDING_DEV_BACKEND_PORT: '3300',
    ONBOARDING_E2E_COMMIT_SHA: LANE_COMMIT_SHA,
    TEST_RUNNER_UI_TEST_API_BASE_URL: 'http://127.0.0.1:3300/api',
    VERIFY_APPLE_AUTHORIZATION_SCHEMA: 'false',
  },
  if: expr(
    'always() && !cancelled() '
    // A dispatch has no tuple to confirm; a PR and a queue candidate do.
    + "&& (github.event_name == 'workflow_dispatch' "
    + "|| needs.confirm-current-ios-pr.outputs.current == 'true') "
    + `&& ${LANE_PREREQUISITES} `
    + "&& needs.ios-change-gate.outputs.income_required == 'true' "
    + `&& ((${SAME_REPOSITORY_TARGET_BRANCH}) `
    + `|| (${DISPATCHED_FROM_TARGET_BRANCH} && ${NOT_A_FOCUSED_EVIDENCE_SCOPE}))`,
  ),
  lane: e2eMacLane,
  steps: realServerE2eSteps,
});

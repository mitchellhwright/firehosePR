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
 * The FullOnboarding journey, against a real development backend.
 *
 * This is the lane a person would run by hand if they had an hour: sign up,
 * link an institution through Plaid Sandbox, complete activation, and land on
 * a dashboard with real data behind it. It is the one required E2E context on
 * develop and main, which is why it owns port 3000 and the lowest-numbered
 * lane key — a run that has to queue queues behind nothing else.
 *
 * FullOnboarding, Chat Plaid, and Budget/debt execute as independent jobs on
 * their lane-owned runners. The status job aggregates all three results so
 * every selected executable regression remains blocking. Same-repository
 * develop and promotion PRs enter only when changed-path ownership selects
 * this lane; external PRs cannot reach development credentials. Every
 * pull-request lane stays on development services with Plaid Sandbox;
 * production onboarding is isolated in trusted-production-onboarding-e2e.yml.
 */

export const onboardingE2e = typedJob('onboarding-e2e', {
  name: 'Real-server E2E execution (onboarding)',
  doc: {
    purpose: 'Runs the FullOnboarding journey end to end against a real development backend.',
    successMeaning: 'A person can sign up, link a bank and reach an activated dashboard at this head.',
  },
  owner: 'product',
  category: 'coordination',
  unit: 'suite',
  concurrency: laneConcurrency('onboarding'),
  needs: [iosChangeGate, confirmCurrentIosPr, buildIosE2eTestProducts, prepareDevE2eSchema],
  runsOn: reviewedPrMacs,
  permissions: LANE_PERMISSIONS,
  environment: LANE_ENVIRONMENT,
  env: {
    E2E_LANE: 'onboarding',
    ONBOARDING_DEV_BACKEND_PORT: '3000',
    ONBOARDING_E2E_COMMIT_SHA: LANE_COMMIT_SHA,
    TEST_RUNNER_UI_TEST_API_BASE_URL: 'http://127.0.0.1:3000/api',
    VERIFY_APPLE_AUTHORIZATION_SCHEMA: 'false',
  },
  if: expr(
    'always() && !cancelled() '
    + "&& needs.confirm-current-ios-pr.outputs.current == 'true' "
    + `&& ${LANE_PREREQUISITES} `
    + "&& (needs.ios-change-gate.outputs.onboarding_required == 'true' "
    + "|| (github.event_name == 'workflow_dispatch' && inputs.test_scope == 'evidence')) "
    + `&& ((${SAME_REPOSITORY_TARGET_BRANCH}) `
    + `|| (${DISPATCHED_FROM_TARGET_BRANCH} && ${NOT_A_FOCUSED_EVIDENCE_SCOPE}))`,
  ),
  lane: e2eMacLane,
  steps: realServerE2eSteps,
});

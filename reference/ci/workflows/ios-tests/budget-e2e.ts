import { concat, expr, fromJSON, suffixed, typedJob } from '../lib/index.ts';
import { buildIosE2eTestProducts } from './build-ios-e2e-test-products.ts';
import { confirmCurrentIosPr } from './confirm-current-ios-pr.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { prepareDevE2eSchema } from './prepare-dev-e2e-schema.ts';
import {
  DISPATCHED_FROM_TARGET_BRANCH, LANE_COMMIT_SHA, LANE_ENVIRONMENT, LANE_PERMISSIONS,
  SAME_REPOSITORY_TARGET_BRANCH, realServerE2eSteps,
} from './real-server-e2e-steps.ts';
import { e2eMacLane, laneConcurrency, reviewedPrMacs } from './shared.ts';

/**
 * The Budget and debt journeys, in two shards on two Macs.
 *
 * Budget is the largest E2E surface in the product and the only lane that
 * does not fit one Mac in a reasonable wall clock, so it is sharded. Two
 * shards run at a time and no more: a third would compete for the same
 * physical hosts the two required lanes are queued for, and Budget is not
 * required — `IOS_ENABLE_BUDGET_E2E` is the lever that turns it on.
 *
 * The debt-card evidence dispatch reuses this job rather than adding another:
 * it runs one focused backend case and a Release archive instead of the
 * journeys, so it needs only the first shard and narrows the matrix to it.
 * That is also why this job's admission rule is spelled out rather than built
 * from the shared prerequisites the other three lanes use — the repository
 * variable and the evidence scope sit between the producer's result and the
 * gate's answer, and one of the two has to hold before either matters.
 */

/** The shard that owns the debt-history acceptance evidence, and its partner. */
const SHARDS = fromJSON(expr(
  "github.event_name == 'workflow_dispatch' && inputs.test_scope == 'debt-card-evidence' "
  + '&& \'["a"]\' || \'["a","b"]\'',
));

/** One shard identifier, which names the job, its lane key and its artifacts. */
const SHARD = expr('matrix.shard');

export const budgetE2e = typedJob('budget-e2e', {
  name: suffixed('Real-server E2E execution', concat('budget-', SHARD)),
  doc: {
    purpose: 'Runs one shard of the Budget and debt journeys against a real development backend.',
    successMeaning: 'The Budget and debt surfaces this shard covers still work at this head.',
  },
  owner: 'product',
  category: 'coordination',
  unit: 'shard',
  concurrency: laneConcurrency('budget-', SHARD),
  needs: [iosChangeGate, confirmCurrentIosPr, buildIosE2eTestProducts, prepareDevE2eSchema],
  strategy: {
    // A failing shard says nothing about its partner, and both answers are
    // wanted: stopping the other one only costs a rerun to learn the same.
    failFast: false,
    maxParallel: 2,
    matrix: { shard: String(SHARDS) },
  },
  runsOn: reviewedPrMacs,
  permissions: LANE_PERMISSIONS,
  environment: LANE_ENVIRONMENT,
  env: {
    E2E_LANE: 'budget',
    BUDGET_E2E_SHARD: SHARD,
    BUDGET_E2E_ARTIFACT_SUFFIX: concat('-', SHARD),
    ONBOARDING_DEV_BACKEND_PORT: '3100',
    ONBOARDING_E2E_COMMIT_SHA: LANE_COMMIT_SHA,
    TEST_RUNNER_UI_TEST_API_BASE_URL: 'http://127.0.0.1:3100/api',
    VERIFY_APPLE_AUTHORIZATION_SCHEMA: 'false',
  },
  if: expr(
    'always() && !cancelled() '
    + "&& needs.confirm-current-ios-pr.outputs.current == 'true' "
    + "&& needs.build-ios-e2e-test-products.result == 'success' "
    + "&& needs.prepare-dev-e2e-schema.result == 'success' "
    + "&& (vars.IOS_ENABLE_BUDGET_E2E == 'true' "
    + "|| (github.event_name == 'workflow_dispatch' && inputs.test_scope == 'debt-card-evidence')) "
    + "&& needs.ios-change-gate.outputs.should_run == 'true' "
    + "&& needs.ios-change-gate.outputs.budget_required == 'true' "
    + `&& ((${SAME_REPOSITORY_TARGET_BRANCH}) `
    + `|| (${DISPATCHED_FROM_TARGET_BRANCH} `
    + "&& inputs.test_scope != 'mortgage-assignment-evidence' "
    + "&& inputs.test_scope != 'evidence'))",
  ),
  lane: e2eMacLane,
  steps: realServerE2eSteps,
});

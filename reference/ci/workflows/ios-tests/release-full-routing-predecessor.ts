import {
  ciEventCondition, expr, github, pullRequestOnly, typedJob, typedStep,
} from '../lib/index.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import {
  controlLane, installTypedCiDependencies, iosControlRunner, setupNode, TRUSTED_VERIFIER_SHA,
  typedLayerCheckout,
} from './shared.ts';

/**
 * Let go of the runs this head is not reusing.
 *
 * A deferred head keeps its predecessor alive so its evidence can be reused.
 * When the classifier says this head is *not* a verified increment — no reuse,
 * nothing superseded, nothing deferred — this job asks the single `Test - iOS`
 * cancellation owner (`ci/src/actions/cancelObsoleteIosRuns.ts`) to decide the
 * same `synchronize` again with that verdict (`full-routing` in
 * `ci/src/tupleLifecycle.ts`), as soon as the gate says so rather than at the
 * end of the run.
 */

const TRUSTED_ROOT = '.ci/trusted-predecessor-verifier';

/**
 * Bootstrap: a pull request's workflow file comes from its own merge ref, but
 * the owner runs from the trusted verifier revision (the base). A revision that
 * still carries the retired controller predates the owner's `full-routing`
 * rule, so the release is skipped there and the synchronize decision of
 * `refresh-pr-ci-after-base-edit.yml` stands alone. That covers the change that
 * folded the controller in (its own runs verify with the prior develop) and any
 * base that has not received it yet.
 */
const OWNER_HAS_FULL_ROUTING =
  `hashFiles('${TRUSTED_ROOT}/ci/src/ios/controllers/cancelBlockedPrCi.ts') == ''`;

const releaseUnreusedPredecessors = typedStep({
  name: 'Cancel retained predecessors',
  doc: {
    purpose: 'Cancels the older-head runs this fully routed head will not reuse, keeping a verified predecessor only while it executes.',
    recovery: 'read the step log: it names every run it cancelled, retained or left alone, with a reason code',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'step',
  if: expr(OWNER_HAS_FULL_ROUTING),
  env: {
    GITHUB_TOKEN: github('token'),
    IOS_GATE_FULL_ROUTING: 'true',
  },
  command: `node ${TRUSTED_ROOT}/ci/src/actions/cancelObsoleteIosRuns.ts`,
});

export const releaseFullRoutingPredecessor = typedJob('release-full-routing-predecessor', {
  name: 'Release retained iOS predecessor',
  doc: {
    purpose: 'Releases the predecessor run a fully routed head is holding but cannot reuse.',
    successMeaning: 'No earlier run of this pull request is still occupying a lane for this head.',
  },
  owner: 'automation',
  category: 'release',
  unit: 'job',
  needs: [iosChangeGate],
  if: expr(
    `${pullRequestOnly.isSynchronize} `
    + "&& needs.ios-change-gate.result == 'success' "
    + `&& ${ciEventCondition('sameRepositoryPullRequest')} `
    + "&& needs.ios-change-gate.outputs.base_update_valid != 'true' "
    + "&& needs.ios-change-gate.outputs.base_update_superseded != 'true' "
    + "&& needs.ios-change-gate.outputs.base_update_deferred != 'true'",
  ),
  runsOn: iosControlRunner,
  timeoutMinutes: 5,
  permissions: { actions: 'write', contents: 'read', 'pull-requests': 'read' },
  lane: controlLane,
  steps: [
    typedLayerCheckout({
      name: 'Checkout proven predecessor verifier',
      path: TRUSTED_ROOT,
      ref: TRUSTED_VERIFIER_SHA,
      // The owner reads the generated workflow names and the iOS workflow it classifies inputs from.
      sparseCheckout: 'scripts\n.github/workflows\nci\n',
    }),
    setupNode('Setup Node for the typed predecessor release', { if: expr(OWNER_HAS_FULL_ROUTING) }),
    installTypedCiDependencies(
      'Install cancellation owner dependencies',
      `${TRUSTED_ROOT}/ci`,
      { if: expr(OWNER_HAS_FULL_ROUTING) },
    ),
    releaseUnreusedPredecessors,
  ],
});

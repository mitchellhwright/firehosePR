import {
  github, trustedControlLinuxRunner, typedJob,
  typedStep, typedWorkflow,
} from './lib/index.ts';
import { maintenanceNode } from './lib/maintenanceNode.ts';
import {
  PR_TERMINAL_CLEANUP_JOB_NAME, PR_VALIDATION_WORKFLOW_NAMES,
} from '../src/terminalPrCleanupContract.ts';

/**
 * GitHub's native review and conversation rules are the sole merge authority.
 * Native concurrency signals cancel validation of merged PRs before runner
 * assignment. This controller rechecks live PR state for unmerged closes and
 * draft conversions, and cleans up any merged run left by event delivery or
 * queued-work ordering.
 */

const controlRunner = trustedControlLinuxRunner;

/** The checkout every job does: the controller runs from the default branch, never the head. */
const checkoutController = () => typedStep({
  name: 'Checkout trusted controller',
  doc: {
    purpose: 'Puts the controller on the runner from the default branch rather than from the pull request head.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: 'actions/checkout@v7.0.1',
  with: {
    ref: github('event.repository.default_branch'),
    'persist-credentials': false,
    'sparse-checkout': 'ci/src\n',
  },
});

const terminalCleanup = typedJob('cancel-blocked-pr-ci', {
  name: PR_TERMINAL_CLEANUP_JOB_NAME,
  doc: {
    purpose: 'Cancels validation work abandoned by a closed or draft pull request.',
    successMeaning: 'No active validation remains for the terminal pull-request state.',
  },
  owner: 'infrastructure',
  category: 'coordination',
  unit: 'job',
  runsOn: controlRunner,
  timeoutMinutes: 10,
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'none',
    selectionOwner: 'controller',
  },
  steps: [
    checkoutController(),
    maintenanceNode,
    typedStep({
      name: 'Cancel abandoned pull-request validation',
      doc: {
        purpose: 'Cancels active workflow runs that can no longer contribute merge evidence.',
        recovery: 'retry; the error identifies the Actions API request that failed',
      },
      owner: 'infrastructure',
      category: 'coordination',
      unit: 'step',
      command: 'node ci/src/actions/cancelTerminalPrRuns.ts',
      env: {
        CI_WORKFLOW_NAMES: PR_VALIDATION_WORKFLOW_NAMES,
        GITHUB_TOKEN: github('token'),
      },
    }),
  ],
});

export const cancelBlockedPrCi = typedWorkflow({
  path: '.github/workflows/cancel-blocked-pr-ci.yml',
  source: 'ci/workflows/cancel-blocked-pr-ci.ts',
  name: 'PR terminal cleanup',
  doc: { purpose: 'Cancels abandoned validation after a pull request closes or returns to draft.' },
  on: {
    // Only merged PRs have a native fast path. Recheck live state and ownership
    // before cancelling abandoned runs from all other terminal events.
    pull_request_target: { types: ['closed', 'converted_to_draft'] },
  },
  permissions: {
    actions: 'write',
    contents: 'read',
    'pull-requests': 'read',
  },
  // Close and draft events may arrive out of order. Run both controllers:
  // each rechecks the current PR state before touching validation runs.
  jobs: [terminalCleanup],
});

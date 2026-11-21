import { ciEventCondition, expr, github, typedJob, typedStep } from '../lib/index.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import {
  controlLane, iosControlRunner, setupNode, typedLayerCheckout, installTypedCiDependencies,
} from './shared.ts';

/**
 * End a run whose merge queue candidate GitHub already deleted.
 *
 * The gate's detector finds the deleted branch but runs with a read-only
 * token, because on a pull request it executes the head's code. This job
 * holds `actions: write` instead, runs only on `merge_group`, and executes
 * nothing but the default branch's typed program, which re-proves the branch is
 * gone before it cancels the run. The run then ends cancelled, not red.
 */
const TRUSTED_ROOT = '.ci/trusted-queue-candidate-cancel';

export const cancelDeletedQueueCandidate = typedJob('cancel-deleted-queue-candidate', {
  name: 'Cancel deleted queue candidate',
  doc: {
    purpose: 'Cancels this run when the merge queue deleted its candidate before the run reached it.',
    successMeaning: 'The run was cancelled, or the candidate still exists and nothing was cancelled.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  needs: [iosChangeGate],
  if: expr(`${ciEventCondition('mergeGroup')} `
    + "&& needs.ios-change-gate.outputs.merge_queue_candidate_gone == 'true'"),
  runsOn: iosControlRunner,
  timeoutMinutes: 5,
  permissions: { actions: 'write', contents: 'read' },
  lane: controlLane,
  steps: [
    typedLayerCheckout({
      name: 'Checkout trusted queue candidate controller',
      path: TRUSTED_ROOT,
      ref: github('event.repository.default_branch'),
    }),
    setupNode('Setup Node for the queue candidate controller'),
    installTypedCiDependencies('Install queue candidate controller dependencies', `${TRUSTED_ROOT}/ci`),
    typedStep({
      name: 'Cancel this run for a deleted candidate',
      doc: {
        purpose: 'Re-proves the queue branch is gone and cancels this run.',
        recovery: 'an HTTP error names the GitHub call; a 403 means the job lost actions: write',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      env: { GITHUB_TOKEN: github('token') },
      command: `node ${TRUSTED_ROOT}/ci/src/actions/ios/cancelDeletedQueueCandidate.ts`,
    }),
  ],
});

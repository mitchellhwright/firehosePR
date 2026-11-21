import {
  concat, expr, github, trustedControlLinuxRunner, typedJob, typedStep, typedWorkflow,
} from './lib/index.ts';
import { maintenanceNode } from './lib/maintenanceNode.ts';
import { PR_VALIDATION_WORKFLOW_NAMES } from '../src/terminalPrCleanupContract.ts';
import { MERGE_QUEUE_BASE_BRANCH } from '../src/mergeQueueRef.ts';

/**
 * GitHub deletes a merge queue candidate's ref whenever its entry leaves the
 * queue (merged, failed, timed out or dequeued) but never cancels the
 * candidate's runs. This workflow owns that gap: on the `delete` event for a
 * queue ref it cancels the candidate's still-active validation runs, keeping
 * any run whose candidate landed on develop.
 */

const cancelCandidate = typedJob('cancel-dequeued-candidate', {
  name: 'Cancel dequeued candidate work',
  doc: {
    purpose: 'Cancels validation runs of a merge queue candidate whose entry GitHub removed.',
    successMeaning: 'No active validation remains for a candidate no queue entry can read.',
  },
  owner: 'infrastructure',
  category: 'coordination',
  unit: 'job',
  if: expr(`github.event.ref_type == 'branch' && startsWith(github.event.ref, 'gh-readonly-queue/${MERGE_QUEUE_BASE_BRANCH}/')`),
  runsOn: trustedControlLinuxRunner,
  timeoutMinutes: 10,
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'none',
    selectionOwner: 'controller',
  },
  steps: [
    typedStep({
      name: 'Checkout trusted controller',
      doc: {
        purpose: 'Puts the controller on the runner from the default branch, which a delete event runs on.',
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
    }),
    maintenanceNode,
    typedStep({
      name: 'Cancel the dequeued candidate validation runs',
      doc: {
        purpose: 'Cancels active merge_group runs for the deleted ref whose candidate is not on develop.',
        recovery: 'read the step log; it names every run it cancelled or kept and why',
      },
      owner: 'infrastructure',
      category: 'coordination',
      unit: 'step',
      command: 'node ci/src/actions/cancelDequeuedCandidateRuns.ts',
      env: {
        CI_WORKFLOW_NAMES: PR_VALIDATION_WORKFLOW_NAMES,
        GITHUB_TOKEN: github('token'),
      },
    }),
  ],
});

export const cancelDequeuedCandidate = typedWorkflow({
  path: '.github/workflows/cancel-dequeued-candidate.yml',
  source: 'ci/workflows/cancel-dequeued-candidate.ts',
  name: 'Merge queue candidate cleanup',
  doc: { purpose: 'Cancels validation runs GitHub leaves behind when a merge queue entry is removed.' },
  on: { delete: {} },
  permissions: { actions: 'write', contents: 'read' },
  concurrency: {
    group: concat('cancel-dequeued-candidate-', github('event.ref')),
    cancelInProgress: false,
  },
  jobs: [cancelCandidate],
});

import { typedJob, typedStep, typedWorkflow } from './lib/index.ts';
import { hostedLinuxRunnerLabels } from '../src/runnerPolicy.ts';

/**
 * A successful job is the only repository-local proof that GitHub admitted a
 * hosted Linux allocation. Billing and spending-limit failures happen before
 * any step starts, so the PR resolver accepts only a recent completed probe
 * with a runner name and a successful step.
 */

const probe = typedJob('probe', {
  name: 'Hosted Linux admission probe',
  doc: {
    purpose: 'Proves GitHub currently admits this repository to the hosted Linux pool.',
    successMeaning: 'A hosted Ubuntu runner started and completed a step recently.',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'runner-lease',
  runsOn: hostedLinuxRunnerLabels,
  timeoutMinutes: 3,
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'none',
    selectionOwner: 'controller',
  },
  steps: [
    typedStep({
      name: 'Confirm hosted Linux admission',
      doc: {
        purpose: 'Records that GitHub assigned the probe to a hosted Ubuntu runner.',
        recovery: 'check the Actions billing and spending-limit state before retrying',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      command: 'echo "GitHub-hosted Linux admission is available."',
    }),
  ],
});

export const hostedLinuxAdmission = typedWorkflow({
  path: '.github/workflows/hosted-linux-admission.yml',
  source: 'ci/workflows/hosted-linux-admission.ts',
  name: 'Hosted Linux admission',
  doc: { purpose: 'Proves GitHub-hosted Linux admission when a busy external fleet needs overflow.' },
  // The read-only iOS gate cannot request admission itself. A half-hour probe
  // leaves slack inside the 60-minute evidence window; PR planning dispatches sooner
  // when its selected Linux fan-out needs overflow.
  on: { workflow_dispatch: {}, schedule: [{ cron: '0,30 * * * *' }] },
  permissions: {},
  // Concurrent planners may request the same proof. Keep the running probe;
  // GitHub coalesces pending runs without throwing away its evidence.
  concurrency: { group: 'hosted-linux-admission', cancelInProgress: false },
  jobs: [probe],
});

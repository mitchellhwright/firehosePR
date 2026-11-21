import { runner, runnerLabels, typedJob, typedStep, typedWorkflow, type LaneMetadata } from './lib/index.ts';
import {
  sharedDatabaseLinuxRunnerLabels,
  sharedPortableLinuxRunnerLabels,
} from '../src/runnerPolicy.ts';

/**
 * Every five minutes, prove that each class of external Linux runner is
 * online and taking work. The heartbeat is the difference between "the lane
 * is slow" and "no runner of that class exists", which is the first question
 * anyone asks when a pull request sits queued.
 */

const lane: LaneMetadata = {
  runnerClass: 'linux-external-preferred',
  costClass: 'light',
  evidencePolicy: 'none',
  selectionOwner: 'controller',
};

function heartbeat(
  id: 'portable-heartbeat' | 'database-heartbeat',
  name: string,
  labelsVariable: string,
  fallbackLabels: readonly string[],
  runnerClassName: string,
) {
  return typedJob(id, {
    name,
    doc: {
      purpose: 'Takes a job on this runner class so its availability is recorded every five minutes.',
      successMeaning: 'A runner of this class was online and took the job.',
    },
    owner: 'infrastructure',
    category: 'coordination',
    unit: 'job',
    runsOn: runnerLabels(labelsVariable, fallbackLabels),
    lane,
    steps: [
      typedStep({
        name: 'Report healthy runner',
        doc: {
          purpose: 'Logs the runner name so the heartbeat names the host that answered.',
          recovery: 'no runner of this class took the job; check the hosts listed in docs/ci/self-hosted-linux-runner.md',
        },
        owner: 'infrastructure',
        category: 'environment',
        unit: 'step',
        // Deliberately not a script: this job has no checkout, because a
        // heartbeat must prove a runner is online without depending on the
        // repository being on it. A one-line command needs nothing on disk.
        command: `echo "${runnerClassName} external Linux runner is healthy: $RUNNER_NAME"`,
        env: { RUNNER_NAME: runner('name') },
      }),
    ],
  });
}

export const linuxRunnerHeartbeat = typedWorkflow({
  path: '.github/workflows/linux-runner-heartbeat.yml',
  source: 'ci/workflows/linux-runner-heartbeat.ts',
  name: 'Linux runner heartbeat',
  doc: { purpose: 'Keeps a five-minute record that each external Linux runner class is online.' },
  on: { schedule: [{ cron: '*/5 * * * *' }], workflow_dispatch: {} },
  permissions: { contents: 'read' },
  // One heartbeat at a time: a backlog of scheduled runs proves nothing that
  // the newest run does not, and each one occupies a lane slot.
  concurrency: { group: 'linux-runner-heartbeat', cancelInProgress: true },
  jobs: [
    heartbeat(
      'portable-heartbeat',
      'External Linux heartbeat (portable)',
      'PR_PORTABLE_RUNNER_LABELS',
      sharedPortableLinuxRunnerLabels,
      'Portable',
    ),
    heartbeat(
      'database-heartbeat',
      'External Linux heartbeat (database)',
      'PR_DATABASE_RUNNER_LABELS',
      sharedDatabaseLinuxRunnerLabels,
      'Database',
    ),
  ],
});

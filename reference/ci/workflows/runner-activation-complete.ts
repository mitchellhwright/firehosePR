import { maintainedHostLabels } from '../src/maintainedRunnerHosts.ts';
import { maintenanceNode } from './lib/maintenanceNode.ts';
import { concat, expr, github, typedJob, typedStep, typedWorkflow } from './lib/index.ts';


const hostLabel = github('event.client_payload.host_label');

/**
 * The detached activation process on a maintained host restarts that host's
 * listener and then dispatches this event with its scoped App token. Nothing
 * waits for it from another runner: the event itself queues the job, and the
 * restarted listener is the only one that can take it, which is the proof
 * that activation released the host. The payload only routes the event; the
 * job trusts the marker and log the detached process left on the host.
 */
export const runnerActivationComplete = typedWorkflow({
  path: '.github/workflows/runner-activation-complete.yml',
  source: 'ci/workflows/runner-activation-complete.ts',
  name: 'Complete runner activation',
  doc: { purpose: 'Confirms on the host that its restarted listener carries the installed cleanup hook.' },
  on: { repository_dispatch: { types: ['example-runner-activated'] } },
  runName: concat(
    'Runner activation - ', hostLabel, ' (', github('event.client_payload.context'), ')',
  ),
  permissions: { contents: 'read' },
  concurrency: {
    group: concat('install-runner-cleanup-hook-', hostLabel),
    cancelInProgress: false,
  },
  jobs: [
    typedJob('activation-complete', {
      name: 'Confirm runner activation',
      doc: {
        purpose: 'Reads the activation marker the detached process left on this host.',
        successMeaning: 'The restarted listener took a job and carries the installed cleanup hook.',
      },
      owner: 'infrastructure',
      category: 'coordination',
      unit: 'runner-lease',
      // An event naming any other label must not queue a job that no runner
      // will ever take.
      if: expr(`contains(fromJSON('${JSON.stringify(maintainedHostLabels)}'), github.event.client_payload.host_label)`),
      runsOn: ['self-hosted', String(hostLabel)],
      timeoutMinutes: 10,
      env: {
        ACTIVATION_CONTEXT: github('event.client_payload.context'),
        EXPECTED_PLATFORM: github('event.client_payload.platform'),
        HOST_LABEL: hostLabel,
      },
      lane: {
        runnerClass: 'self-hosted-dynamic',
        costClass: 'medium',
        evidencePolicy: 'none',
        selectionOwner: 'controller',
      },
      steps: [
        typedStep({
          name: 'Check out trusted activation controller',
          doc: {
            purpose: 'Puts the confirmation script on the host at the default branch.',
            recovery: 'retry; a repeated failure is a GitHub or host network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/checkout@v7.0.1',
          with: { 'persist-credentials': false },
        }),
        maintenanceNode,
        typedStep({
          name: 'Confirm the exact activation this listener serves',
          doc: {
            purpose: 'Waits for the detached process to finish and reads the marker it left.',
            recovery: 'read the activation log named in the error; it says why activation stopped',
          },
          owner: 'infrastructure',
          category: 'coordination',
          unit: 'step',
          shell: 'bash',
          summaryTitle: 'Runner activation',
          script: 'scripts/ci/runner-activation-complete/activation-complete/confirm-the-exact-activation-this-listener-serves.sh',
        }),
        typedStep({
          name: 'Verify the restarted listener loaded the cleanup hook',
          doc: {
            purpose: 'Proves the listener that took this job has the hook and the persistent environment.',
            recovery: 'the listener restarted without the installed environment; rerun runner maintenance for this host',
          },
          owner: 'infrastructure',
          category: 'quality',
          unit: 'step',
          command: 'node ci/src/actions/auditRunnerEnvironment.ts',
        }),
      ],
    }),
  ],
});

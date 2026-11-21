import { maintainedRunnerHosts } from '../src/maintainedRunnerHosts.ts';
import {
  expr, github, matrixSuffixed, trustedControlLinuxRunner, typedJob, typedStep, typedWorkflow,
} from './lib/index.ts';
import { maintenanceNode } from './lib/maintenanceNode.ts';

/**
 * Fan out runner maintenance to every durable host. A dispatch is one API
 * call: each host's run is its own visible run, and the host's restarted
 * listener reports activation through runner-activation-complete.yml, so
 * nothing here waits for a host and no job holds a runner while a listener
 * restarts.
 */
export const installRunnerCleanupHooks = typedWorkflow({
  path: '.github/workflows/install-runner-cleanup-hooks.yml',
  source: 'ci/workflows/install-runner-cleanup-hooks.ts',
  name: 'Install runner cleanup hooks',
  doc: { purpose: 'Dispatches cleanup-hook maintenance to every durable runner host.' },
  on: {
    workflow_dispatch: {
      inputs: {
        audit_only: {
          description: 'Verify that every active listener loaded the installed cleanup hook',
          required: false,
          default: false,
          type: 'boolean',
        },
      },
    },
    push: {
      branches: ['develop', 'main'],
      paths: [
        // Controller-only changes do not alter installed host state. The
        // shared host inventory does: a new listener must receive its hook.
        'ci/src/maintainedRunnerHosts.ts',
        '.github/workflows/install-runner-cleanup-host.yml',
        '.github/workflows/runner-activation-complete.yml',
        'ci/src/runnerHooks/jobCompleted.ts',
        'ci/src/actions/installJobCompletedHook.ts',
        'scripts/ci/install-runner-cleanup-host/install/install-completed-job-cleanup-hook.sh',
        'ci/src/actions/auditRunnerEnvironment.ts',
        'scripts/activate-github-actions-runner-environment.sh',
        'ci/src/actions/confirmRunnerActivation.ts',
        'ci/src/actions/removeOrphanActivationMarkers.ts',
        'ci/src/actions/awaitLogLine.ts',
        'ci/src/ios/shared/awaitLogLine.ts',
        'scripts/setup-github-linux-runner.sh',
        'scripts/setup-github-macos-runner.sh',
        'scripts/provision-github-macos-runner-tools.sh',
      ],
    },
  },
  permissions: { contents: 'read' },
  jobs: [
    typedJob('reconcile-host', {
      name: matrixSuffixed('Dispatch runner maintenance', 'host_label'),
      doc: {
        purpose: 'Asks one durable host to reinstall and activate its cleanup hook.',
        successMeaning: 'The exact-host maintenance run was dispatched for this host.',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'job',
      strategy: {
        failFast: false,
        maxParallel: 5,
        matrix: {
          include: maintainedRunnerHosts.map((host) => ({
            host_label: host.hostLabel,
            platform: host.platform,
          })),
        },
      },
      runsOn: trustedControlLinuxRunner,
      timeoutMinutes: 2,
      permissions: { actions: 'write', contents: 'read' },
      lane: {
        runnerClass: 'hosted-control',
        costClass: 'control',
        evidencePolicy: 'none',
        selectionOwner: 'controller',
      },
      steps: [
        typedStep({
          name: 'Check out the dispatcher scripts',
          doc: {
            purpose: 'Puts the dispatcher scripts this job runs in the workspace; without it they are absent or stale.',
            recovery: 'retry; a repeated failure is a GitHub or runner network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/checkout@v7.0.1',
          with: { 'persist-credentials': false, 'fetch-depth': 1 },
        }),
        maintenanceNode,
        typedStep({
          // install-runner-cleanup-host.yml forwards this ref to the
          // dispatched child and restricts its executable job to develop and
          // main. A dispatch from any other ref would still forward that ref,
          // so the child would skip everything and conclude successfully with
          // nothing installed or audited. Fail here instead of dispatching a
          // run doomed to a false success.
          name: 'Validate maintenance dispatch ref',
          doc: {
            purpose: 'Refuses a maintenance dispatch from a ref the host job would skip.',
            recovery: 'dispatch runner maintenance from develop or main; another ref cannot install anything',
          },
          owner: 'security',
          category: 'quality',
          unit: 'step',
          command: 'node ci/src/actions/validateMaintenanceDispatchRef.ts',
          env: { DISPATCH_REF: github('ref') },
        }),
        typedStep({
          name: 'Dispatch isolated exact-host maintenance',
          doc: {
            purpose: 'Starts one exact-host maintenance run, tagged so it can be found later.',
            recovery: 'read the gh api error; a 403 means the job token lost actions: write',
          },
          owner: 'automation',
          category: 'coordination',
          unit: 'step',
          command: 'node ci/src/actions/dispatchRunnerMaintenance.ts',
          env: {
            AUDIT_ONLY: expr('inputs.audit_only == true'),
            GH_TOKEN: github('token'),
            HOST_LABEL: expr('matrix.host_label'),
            PLATFORM: expr('matrix.platform'),
          },
        }),
      ],
    }),
  ],
});

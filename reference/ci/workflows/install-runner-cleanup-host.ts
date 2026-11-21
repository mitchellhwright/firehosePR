import { maintenanceNode } from './lib/maintenanceNode.ts';
import {
  concat, expr, github, inputs, secret, suffixed, typedJob, typedStep, typedWorkflow,
} from './lib/index.ts';

const hostLabel = inputs('host_label');

const installer = typedStep({
  id: 'installer',
  name: 'Install completed-job cleanup hook',
  doc: {
    purpose: 'Installs the hook and hands a bounded token to a detached process that restarts the listener.',
    recovery: 'read the activation log named in the error; the listener is left online if activation cannot start',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr('inputs.audit_only != true'),
  outputs: ['activation_required', 'token_handed_off'] as const,
  script: 'scripts/ci/install-runner-cleanup-host/install/install-completed-job-cleanup-hook.sh',
  env: {
    ACTIVATION_CONTEXT: concat('runner-environment/', hostLabel, '/', github('run_id'), '/', github('run_attempt')),
    EXPECTED_PLATFORM: inputs('platform'),
    GITHUB_TOKEN_VALUE: expr('steps.activation-token.outputs.token'),
    HOST_LABEL: hostLabel,
  },
});

/**
 * Maintain one physical runner host. Host labels are the durable routing
 * contract: organization runners are deliberately invisible to the repository
 * runner-list endpoint here, so a repository-side preflight would silently
 * skip every real host. The job queues directly for the exact host and fails
 * closed once GitHub assigns it.
 *
 * The listener restart happens outside this job, in a detached process that
 * waits for this very worker to exit; `runner-activation-complete.yml`
 * reports the result from the restarted listener.
 */
export const installRunnerCleanupHost = typedWorkflow({
  path: '.github/workflows/install-runner-cleanup-host.yml',
  source: 'ci/workflows/install-runner-cleanup-host.ts',
  name: 'Install runner cleanup hook host',
  doc: { purpose: 'Installs and activates the completed-job cleanup hook on one durable runner host.' },
  on: {
    workflow_dispatch: {
      inputs: {
        host_label: { description: 'Durable physical runner host label', required: true, type: 'string' },
        platform: {
          description: 'Host operating system',
          required: true,
          type: 'choice',
          options: ['macos', 'linux'],
        },
        audit_only: {
          description: 'Verify the active hook without changing the listener',
          required: true,
          type: 'boolean',
        },
        correlation_id: {
          description: 'Opaque token the dispatching fleet run uses to find this run',
          required: false,
          type: 'string',
        },
      },
    },
  },
  runName: concat(
    'Runner maintenance - ', hostLabel,
    expr("inputs.correlation_id && format(' ({0})', inputs.correlation_id) || ''"),
  ),
  permissions: { actions: 'read', contents: 'read' },
  concurrency: { group: concat('install-runner-cleanup-hook-', hostLabel), cancelInProgress: false },
  jobs: [
    typedJob('install', {
      name: suffixed('Install runner cleanup hook', hostLabel),
      doc: {
        purpose: 'Installs the cleanup hook on this host and starts its out-of-band activation.',
        successMeaning: 'The host carries the hook and its activation has been handed off or was unnecessary.',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'runner-lease',
      if: expr("github.ref == 'refs/heads/develop' || github.ref == 'refs/heads/main'"),
      runsOn: ['self-hosted', String(hostLabel)],
      timeoutMinutes: 10,
      outputs: { activation_required: installer.outputs.activation_required },
      lane: {
        runnerClass: 'self-hosted-dynamic',
        costClass: 'medium',
        evidencePolicy: 'none',
        selectionOwner: 'controller',
      },
      steps: [
        typedStep({
          name: 'Check out trusted cleanup source',
          doc: {
            purpose: 'Puts the hook, the activation script and the audit on the host.',
            recovery: 'retry; a repeated failure is a GitHub or host network problem',
          },
          owner: 'infrastructure',
          category: 'environment',
          unit: 'step',
          uses: 'actions/checkout@v7.0.1',
        }),
        maintenanceNode,
        typedStep({
          id: 'activation-token',
          name: 'Create bounded runner activation handoff token',
          doc: {
            purpose: 'Mints the scoped token the detached activation uses to report completion.',
            recovery: 'check the App installation still grants contents: write to this repository',
          },
          owner: 'automation',
          category: 'coordination',
          unit: 'step',
          if: expr('inputs.audit_only != true'),
          uses: 'actions/create-github-app-token@v3.2.0',
          with: {
            'app-id': secret('PROMOTION_CHECKPOINT_APP_ID'),
            'private-key': secret('PROMOTION_CHECKPOINT_APP_PRIVATE_KEY'),
            'permission-contents': 'write',
            // The installer ends before the detached listener restart. The
            // helper revokes this installation token after publishing its
            // completion signal, within the bounded activation window.
            'skip-token-revoke': true,
          },
        }),
        typedStep({
          name: 'Audit active completed-job cleanup hook',
          doc: {
            purpose: 'Proves the active listener already carries the hook, without changing anything.',
            recovery: 'run this workflow again without audit_only to install and activate the hook',
          },
          owner: 'product',
          category: 'quality',
          unit: 'step',
          if: expr('inputs.audit_only == true'),
          command: 'node ci/src/actions/auditRunnerEnvironment.ts',
          env: { EXPECTED_PLATFORM: inputs('platform') },
        }),
        installer,
        typedStep({
          name: 'Revoke unhanded activation token',
          doc: {
            purpose: 'Revokes the scoped token when the detached activation never claimed it.',
            recovery: 'revoke the installation token by hand if this keeps failing; it expires within the hour regardless',
          },
          owner: 'automation',
          category: 'coordination',
          unit: 'step',
          if: expr(
            "always() && steps.activation-token.outcome == 'success' "
            + "&& steps.installer.outputs.token_handed_off != 'true'",
          ),
          shell: 'bash',
          summaryTitle: 'Activation token revocation',
          script: 'scripts/ci/install-runner-cleanup-host/install/revoke-unhanded-activation-token.sh',
          env: {
            EXPECTED_PLATFORM: inputs('platform'),
            GH_TOKEN: expr('steps.activation-token.outputs.token'),
            HOST_LABEL: hostLabel,
          },
        }),
      ],
    }),
  ],
});

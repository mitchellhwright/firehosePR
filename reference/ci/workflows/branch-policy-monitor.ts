import {
  concat, expr, github, hostedLinuxRunner, inputs, runner, secret, trustedControlLinuxRunner, typedJob, typedNodeActionStep, typedStep,
  typedWorkflow, vars,
} from './lib/index.ts';
import type { WorkflowConfig } from 'gagen';
import { maintenanceNode } from './lib/maintenanceNode.ts';

/**
 * Which triggers the monitor has. It merges dispatch-only; the #4085 operator
 * switches it to `scheduled` in a reviewed pull request after approving the
 * baseline, settling decision 7 and provisioning read-only access. A test
 * refuses `scheduled` while the activation gate refuses the committed state.
 */
export type MonitorTrigger = 'dispatch-only' | 'scheduled';
export const MONITOR_TRIGGER: MonitorTrigger = 'dispatch-only';

/** Hourly at an off-peak minute, away from the top-of-hour scheduling spike. */
export const PROPOSED_SCHEDULE = [{ cron: '43 * * * *' }] as const;

export const MONITOR_ENVIRONMENT = 'branch-policy-monitor';

/**
 * Manual dispatch is always available. Its one input proves the failure
 * notification path by comparing against a baseline with one deliberately
 * unmet expectation, so no live setting is weakened to test it.
 */
const manualDispatch = {
  inputs: {
    synthetic_drift: {
      description: 'Report a synthetic drift failure to test notifications; changes no setting',
      type: 'boolean',
      required: false,
      default: false,
    },
  },
} as const;

/** The workflow triggers for a trigger mode. */
export function monitorTriggers(trigger: MonitorTrigger): WorkflowConfig['on'] {
  return trigger === 'scheduled'
    ? { schedule: [...PROPOSED_SCHEDULE], workflow_dispatch: manualDispatch }
    : { workflow_dispatch: manualDispatch };
}

const defaultBranchCheckout = typedStep({
  name: 'Check out the default-branch monitor',
  doc: {
    purpose: 'Runs the reviewed default-branch checker and baseline, whichever ref started the run.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: 'actions/checkout@v7.0.1',
  with: { ref: github('event.repository.default_branch'), 'persist-credentials': false, 'fetch-depth': 1 },
});

/** The activation gate holds no credential, so it stays on trusted control capacity. */
const activationLane = {
  runnerClass: 'linux-self-hosted',
  costClass: 'light',
  evidencePolicy: 'none',
  selectionOwner: 'controller',
} as const;

/**
 * The credentialed job runs on a fresh GitHub-hosted VM. The persistent
 * trusted-control pool also runs same-repository pull-request jobs, which
 * could leave state behind that reads the token or falsifies the result.
 */
const inspectionLane = {
  runnerClass: 'hosted-control',
  costClass: 'control',
  evidencePolicy: 'none',
  selectionOwner: 'controller',
} as const;

const confirmActivation = typedJob('confirm-activation', {
  name: 'Confirm branch policy monitor activation',
  doc: {
    purpose: 'Refuses to start live inspection until the baseline is approved, the blocking decisions are '
      + 'settled and the operator has enabled the monitor.',
    successMeaning: 'The approved baseline, settled decisions, default-branch ref and operator switch all permit a live read.',
  },
  owner: 'infrastructure',
  category: 'quality',
  unit: 'job',
  runsOn: trustedControlLinuxRunner,
  permissions: { contents: 'read' },
  timeoutMinutes: 5,
  lane: activationLane,
  steps: [
    defaultBranchCheckout,
    maintenanceNode,
    typedNodeActionStep({
      name: 'Confirm the monitor is activated',
      doc: {
        purpose: 'Checks the operator switch, the default-branch ref, the baseline approval and the blocking '
          + 'decisions before any credential is used.',
        recovery: 'follow docs/security/branch-policy-monitor.md activation; an inactive monitor is expected until #4085 enables it',
      },
      owner: 'infrastructure',
      category: 'quality',
      unit: 'step',
      entry: 'ci/src/actions/confirmBranchPolicyMonitorActivation.ts',
      env: {
        BRANCH_POLICY_MONITOR_ENABLED: vars('BRANCH_POLICY_MONITOR_ENABLED'),
        DEFAULT_BRANCH: github('event.repository.default_branch'),
      },
    }),
  ],
});

const inspect = typedJob('inspect', {
  name: 'Inspect branch protection and admin access',
  doc: {
    purpose: 'Reads branch protection, rulesets and admin grants with a read-only App token and compares them with the baseline.',
    successMeaning: 'Every inspected control matches the approved baseline at the recorded acquisition time.',
  },
  owner: 'infrastructure',
  category: 'quality',
  unit: 'job',
  runsOn: hostedLinuxRunner,
  needs: [confirmActivation],
  // The inspection credential lives only in this environment, whose
  // deployment-branch policy admits the default branch alone.
  environment: MONITOR_ENVIRONMENT,
  permissions: { contents: 'read' },
  timeoutMinutes: 10,
  lane: inspectionLane,
  steps: [
    defaultBranchCheckout,
    maintenanceNode,
    typedStep({
      id: 'inspection-token',
      name: 'Create read-only inspection token',
      doc: {
        purpose: 'Mints a short-lived App token limited to administration and metadata read for this repository.',
        recovery: 'check the monitor App installation and environment secrets; never add a write permission to fix it',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: 'actions/create-github-app-token@v3.2.0',
      with: {
        'app-id': secret('BRANCH_POLICY_MONITOR_APP_ID'),
        'private-key': secret('BRANCH_POLICY_MONITOR_APP_PRIVATE_KEY'),
        owner: github('repository_owner'),
        repositories: github('event.repository.name'),
        'permission-administration': 'read',
        'permission-metadata': 'read',
      },
    }),
    typedNodeActionStep({
      name: 'Compare live controls with the approved baseline',
      doc: {
        purpose: 'Reports compliance, policy drift or an inspection failure; it never changes a setting.',
        recovery: 'drift: escalate to #4085; inspection failure: repair read access, never grant write or edit the baseline',
      },
      owner: 'infrastructure',
      category: 'quality',
      unit: 'step',
      entry: 'ci/src/actions/checkBranchPolicyDrift.ts',
      env: {
        BRANCH_POLICY_MONITOR_TOKEN: expr('steps.inspection-token.outputs.token'),
        BRANCH_POLICY_REPORT_PATH: concat(runner('temp'), '/branch-policy-report.json'),
        GITHUB_API_URL: github('api_url'),
        GITHUB_REPOSITORY: github('repository'),
        // Empty on a scheduled run, which has no inputs.
        BRANCH_POLICY_SYNTHETIC_DRIFT: inputs('synthetic_drift'),
      },
    }),
    typedStep({
      name: 'Keep the observation report',
      doc: {
        purpose: 'Stores the scrubbed report so the last successful observation and any drift stay reviewable.',
        recovery: 'retry; the comparison result above stands even if the upload failed',
      },
      owner: 'infrastructure',
      category: 'artifact',
      unit: 'step',
      if: expr('always()'),
      uses: 'actions/upload-artifact@v7.0.1',
      with: {
        name: 'branch-policy-report',
        path: concat(runner('temp'), '/branch-policy-report.json'),
        'if-no-files-found': 'warn',
        'retention-days': 90,
      },
    }),
  ],
});

/**
 * Detects drift in branch protection, rulesets and repository admin grants
 * against a human-approved baseline. It is detection, not enforcement: it
 * holds read access only, and GitHub schedules can be delayed or dropped.
 */
export const branchPolicyMonitor = typedWorkflow({
  path: '.github/workflows/branch-policy-monitor.yml',
  source: 'ci/workflows/branch-policy-monitor.ts',
  name: 'Branch Policy Drift Monitor',
  doc: { purpose: 'Compares live branch protection and admin access with the approved baseline, read-only.' },
  on: monitorTriggers(MONITOR_TRIGGER),
  permissions: {},
  concurrency: { group: 'branch-policy-monitor', cancelInProgress: false },
  jobs: [confirmActivation, inspect],
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';

import {
  UNSETTLED_ACTIVATION_DECISIONS, activationBlockers,
} from '../src/actions/confirmBranchPolicyMonitorActivation.ts';
import { branchPolicyBaseline } from '../src/branchPolicy/baseline.ts';
import { hostedLinuxRunnerLabels, trustedControlLinuxRunnerLabels } from '../src/runnerPolicy.ts';
import {
  MONITOR_ENVIRONMENT, MONITOR_TRIGGER, PROPOSED_SCHEDULE, branchPolicyMonitor, monitorTriggers,
} from '../workflows/branch-policy-monitor.ts';
import { definitions } from '../workflows/all.ts';
import { requiredContextsFrom } from '../workflows/lib/projections.ts';

/**
 * The generated workflow is what GitHub runs, so these assertions read the
 * committed YAML rather than the definition: they prove PR code cannot reach
 * the inspection credential and that merging cannot start a live read.
 */

type Json = Record<string, unknown>;

function record(value: unknown, what: string): Json {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${what} is an object`);
  return value as Json;
}

const text = readFileSync(branchPolicyMonitor.config.path, 'utf8');
const workflow = record(load(text), 'workflow');
const triggers = record(workflow['on'], 'on');
const jobs = record(workflow['jobs'], 'jobs');

/** Whether the committed code refuses activation even with the operator switch on. */
const committedActivationRefused = activationBlockers({
  enabled: 'true',
  ref: 'refs/heads/develop',
  defaultBranch: 'develop',
  baseline: branchPolicyBaseline,
  unsettledDecisions: UNSETTLED_ACTIVATION_DECISIONS,
}).length > 0;

function steps(jobId: string): Json[] {
  const job = record(jobs[jobId], jobId);
  assert.ok(Array.isArray(job['steps']));
  return job['steps'].map((step, index) => record(step, `${jobId} step ${index}`));
}

test('the monitor has no pull-request trigger and no schedule until activation', () => {
  assert.ok('workflow_dispatch' in triggers);
  if (committedActivationRefused) {
    assert.deepEqual(Object.keys(triggers), ['workflow_dispatch']);
    assert.equal(MONITOR_TRIGGER, 'dispatch-only');
  }
  assert.doesNotMatch(text, /pull_request/);
});

test('the schedule cannot be enabled while activation is refused', () => {
  assert.ok(committedActivationRefused, 'decision 7 keeps the committed monitor inactive');
  assert.equal(MONITOR_TRIGGER, 'dispatch-only');
  const scheduled = record(monitorTriggers('scheduled'), 'scheduled triggers');
  assert.deepEqual(Object.keys(scheduled).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(scheduled['schedule'], [...PROPOSED_SCHEDULE]);
  assert.match(PROPOSED_SCHEDULE[0].cron, /^([1-9]|[1-5][0-9]) \* \* \* \*$/, 'hourly, off the top of the hour');
});

test('the workflow grants no token scopes beyond contents read', () => {
  assert.deepEqual(workflow['permissions'], {});
  for (const id of Object.keys(jobs)) {
    assert.deepEqual(record(jobs[id], id)['permissions'], { contents: 'read' }, `${id} permissions`);
  }
  assert.doesNotMatch(text, /github\.token|secrets\.GITHUB_TOKEN/);
});

test('only the inspection job, behind activation and its environment, can read the credential', () => {
  const inspect = record(jobs['inspect'], 'inspect');
  assert.equal(inspect['environment'], MONITOR_ENVIRONMENT);
  assert.deepEqual(inspect['needs'], ['confirm-activation']);
  const confirm = record(jobs['confirm-activation'], 'confirm-activation');
  assert.equal(confirm['environment'], undefined);
  assert.doesNotMatch(JSON.stringify(confirm), /secrets\./);
  const secretSteps = steps('inspect').filter((step) => JSON.stringify(step).includes('secrets.'));
  assert.deepEqual(secretSteps.map((step) => step['name']), ['Create read-only inspection token']);
});

test('only the credentialed job runs on an ephemeral GitHub-hosted runner', () => {
  assert.deepEqual(record(jobs['inspect'], 'inspect')['runs-on'], [...hostedLinuxRunnerLabels]);
  assert.deepEqual(
    record(jobs['confirm-activation'], 'confirm-activation')['runs-on'],
    [...trustedControlLinuxRunnerLabels],
  );
  for (const [id, job] of Object.entries(jobs)) {
    const runsOn = record(job, id)['runs-on'];
    const usesSecrets = JSON.stringify(job).includes('secrets.');
    assert.ok(!usesSecrets || !JSON.stringify(runsOn).includes('self-hosted'), `${id} holds a credential on a persistent runner`);
  }
});

test('the inspection token requests read permissions only', () => {
  const tokenStep = steps('inspect').find((step) => step['id'] === 'inspection-token');
  const inputs = record(tokenStep?.['with'], 'token inputs');
  const permissions = Object.entries(inputs).filter(([key]) => key.startsWith('permission-'));
  assert.deepEqual(permissions, [['permission-administration', 'read'], ['permission-metadata', 'read']]);
});

test('every job runs the default-branch revision without persisted credentials', () => {
  for (const id of Object.keys(jobs)) {
    const checkouts = steps(id).filter((step) => String(step['uses']).startsWith('actions/checkout@'));
    assert.equal(checkouts.length, 1, `${id} checks out once`);
    const inputs = record(checkouts[0]?.['with'], 'checkout inputs');
    assert.equal(inputs['ref'], '${{ github.event.repository.default_branch }}');
    assert.equal(inputs['persist-credentials'], false);
  }
});

test('third-party actions are pinned to full commit SHAs', () => {
  for (const id of Object.keys(jobs)) {
    for (const step of steps(id)) {
      const uses = step['uses'];
      if (typeof uses !== 'string' || uses.startsWith('./')) continue;
      assert.match(uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${id}: ${uses}`);
    }
  }
});

test('the monitor adds no required check context', () => {
  assert.equal(branchPolicyMonitor.config.requiredContexts, undefined);
  const withoutMonitor = definitions.filter((definition) => definition !== branchPolicyMonitor);
  assert.deepEqual(requiredContextsFrom(definitions), requiredContextsFrom(withoutMonitor));
});

test('the synthetic drift input exists only on manual dispatch and defaults off', () => {
  const inputs = record(record(triggers['workflow_dispatch'], 'workflow_dispatch')['inputs'], 'inputs');
  const synthetic = record(inputs['synthetic_drift'], 'synthetic_drift');
  assert.equal(synthetic['type'], 'boolean');
  assert.equal(synthetic['default'], false);
  const compare = steps('inspect').find((step) => step['name'] === 'Compare live controls with the approved baseline');
  assert.equal(
    record(compare?.['env'], 'compare env')['BRANCH_POLICY_SYNTHETIC_DRIFT'],
    '${{ inputs.synthetic_drift }}',
  );
});

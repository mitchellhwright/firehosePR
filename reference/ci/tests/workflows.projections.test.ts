import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowContractRegistrySchema } from '../src/workflowContract.ts';
import {
  contractSourcesFrom, laneContractFrom, registryFrom, requiredContextsFrom, resolveStepOwner, stepOwnerIndexFrom,
} from '../workflows/lib/projections.ts';
import {
  byEvent, matrixSuffixed, typedJob, typedStep, typedWorkflow, type LaneMetadata,
} from '../workflows/lib/index.ts';

const lane: LaneMetadata = {
  runnerClass: 'linux-self-hosted', costClass: 'medium', evidencePolicy: 'none', selectionOwner: 'typed-pr-validation',
};

const checkout = typedStep({
  name: 'Check out the repository',
  doc: { purpose: 'Puts the shard scripts in the workspace.', recovery: 'retry; a repeated failure is a GitHub problem' },
  owner: 'infrastructure', category: 'environment', unit: 'step',
  uses: 'actions/checkout@v7.0.1',
});
const install = typedStep({
  name: 'Install Node.js dependencies',
  doc: { purpose: 'Installs the pinned dependencies for the shard.', recovery: 're-run once; then check the runner npm cache' },
  owner: 'infrastructure', category: 'environment', unit: 'step',
  script: 'scripts/ci/pr-checks/server-tests/install.sh',
});
const shard = typedStep({
  id: 'shard',
  name: 'Run the server test shard',
  doc: { purpose: 'Runs one quarter of the server suite.', recovery: 'read the failing test in the log' },
  owner: 'product', category: 'quality', unit: 'shard',
  script: 'scripts/ci/pr-checks/server-tests/shard.sh',
});
const shards = typedJob('server-tests', {
  name: matrixSuffixed('Server tests', 'shard'),
  doc: { purpose: 'Runs the server suite in four shards.', successMeaning: 'Every server shard passed.' },
  owner: 'product', category: 'quality', unit: 'shard', runsOn: 'ubuntu-24.04', lane, steps: [checkout, install, shard],
});
const gate = typedJob('onboarding-e2e', {
  name: byEvent({ workflow_dispatch: 'Manual - Onboarding E2E' }, 'Onboarding E2E'),
  doc: { purpose: 'Aggregates every required lane into one status.', successMeaning: 'Every required lane passed.' },
  owner: 'automation', category: 'coordination', unit: 'job', runsOn: 'ubuntu-24.04', lane,
  needs: [shards],
  steps: [typedStep({
    name: 'Verify every required lane passed',
    doc: { purpose: 'Fails when any required lane failed.', recovery: 'open the failing lane named in the summary' },
    owner: 'automation', category: 'coordination', unit: 'step', command: 'echo ok',
  })],
});
const definition = typedWorkflow({
  path: '.github/workflows/pr-checks.yml',
  source: 'ci/workflows/pr-checks.ts',
  name: 'Validate pull request changes',
  doc: { purpose: 'Validates every pull request before it can merge.' },
  on: { pull_request: {} },
  permissions: { contents: 'read' },
  concurrency: { group: 'pr-checks', cancelInProgress: true },
  jobs: [shards, gate],
  requiredContexts: ['onboarding-e2e'],
});

test('the registry projection satisfies the registry schema, including its digest and lane cross-checks', () => {
  const registry = registryFrom([definition]);
  assert.doesNotThrow(() => workflowContractRegistrySchema.parse(registry));
  const job = registry.workflows[0]?.jobs.find((entry) => entry.id === 'server-tests');
  assert.deepEqual(
    job?.steps.map((step) => [step.position, step.displayName, step.failureOwner, step.id]),
    [
      [1, 'Check out the repository', 'infrastructure', 'check-out-the-repository'],
      [2, 'Install Node.js dependencies', 'infrastructure', 'install-node-js-dependencies'],
      [3, 'Run the server test shard', 'product', 'shard'],
    ],
  );
  assert.equal(job?.steps[2]?.workflowStepId, 'shard');
  assert.equal(job?.purpose, 'Runs the server suite in four shards.');
  assert.equal(job?.successMeaning, 'Every server shard passed.');
});

test('a failing step points at its owner and the definition own recovery sentence', () => {
  const registry = registryFrom([definition]);
  const step = registry.workflows[0]?.jobs[0]?.steps[1];
  assert.equal(step?.nextAction, 'Infrastructure owner: for Install Node.js dependencies, re-run once; then check the runner npm cache.');
});

test('lanes carry the routing metadata, the job dependencies and the required-check context', () => {
  const [shardLane, gateLane] = laneContractFrom([definition]);
  assert.equal(shardLane?.id, 'pr.server-shards');
  assert.equal(shardLane?.displayName, 'Server tests');
  assert.equal(shardLane?.runnerClass, 'linux-self-hosted');
  assert.deepEqual(shardLane?.dependencies, []);
  assert.equal(shardLane?.checkContext, undefined);
  assert.deepEqual(gateLane?.dependencies, ['server-tests']);
  assert.equal(gateLane?.checkContext, 'Onboarding E2E');
});

test('the step-owner index resolves every rendered job name, by step name and by position', () => {
  const index = stepOwnerIndexFrom([definition]);
  const at = (jobName: string, stepName: string, stepNumber?: number) => resolveStepOwner(index, {
    workflowPath: '.github/workflows/pr-checks.yml',
    jobName,
    stepName,
    ...(stepNumber === undefined ? {} : { stepNumber }),
  });
  assert.equal(at('Server tests (1/4)', 'Install Node.js dependencies'), 'infrastructure');
  assert.equal(at('Server tests (3/4)', 'Run the server test shard'), 'product');
  // A step renamed since the run started still resolves by its position.
  assert.equal(at('Server tests (3/4)', 'Renamed since the run', 2), 'infrastructure');
  // Both literals of an event-keyed job name resolve.
  assert.equal(at('Onboarding E2E', 'Verify every required lane passed'), 'automation');
  assert.equal(at('Manual - Onboarding E2E', 'Verify every required lane passed'), 'automation');
  // Anything unplaceable is product-owned, so no automation acts on it.
  assert.equal(at('Unknown job', 'Verify every required lane passed'), 'product');
  assert.equal(at('Server tests (1/4)', 'Unknown step'), 'product');
  assert.equal(resolveStepOwner(index, { workflowPath: '.github/workflows/other.yml', jobName: 'Server tests (1/4)', stepName: 'Install Node.js dependencies' }), 'product');
});

test('required contexts come from the definitions, and an unknown one names the ruleset change it needs', () => {
  assert.deepEqual(requiredContextsFrom([definition]), ['Onboarding E2E']);
  const registry = registryFrom([definition]);
  assert.deepEqual(registry.requiredChecks.develop, ['Onboarding E2E']);
  assert.deepEqual(registry.requiredChecks.main, ['Onboarding E2E']);

  const unknown = typedWorkflow({
    ...definition.config,
    jobs: [typedJob('renamed', { ...gate.config, name: 'Validate the pull request thoroughly' })],
    requiredContexts: ['renamed'],
  });
  assert.throws(() => requiredContextsFrom([unknown]), /not a known required check context/);
});

test('today\'s bare required-check names cannot be job names, so migrating them is a rename plus a ruleset change', () => {
  // lint, validate and Test - iOS are required contexts on develop today and
  // every one of them fails the readability rule. T2 and T3 rename them and
  // update the branch ruleset in the same change; this test is the reminder.
  //
  // A job may keep such a name only by declaring `requiredCheckContext` and
  // being listed in its workflow's `requiredContexts`, which is how the iOS
  // aggregate publishes "Test - iOS"; undeclared, as here, it stays refused.
  // `workflows.model.test.ts` holds that path to both halves of the rule.
  for (const name of ['lint', 'validate', 'Test - iOS']) {
    assert.throws(
      () => typedJob('gate', { ...gate.config, name }),
      /too generic/,
      `${name} must be renamed before its job can be defined`,
    );
  }
});

test('compact contracts follow typed workflow renames and preserve lane identities', () => {
  const original = contractSourcesFrom([definition]);
  const renamed = contractSourcesFrom([{
    ...definition,
    config: { ...definition.config, name: 'Validate updated pull request changes' },
  }]);
  assert.notEqual(renamed.get('ci/contracts/workflow-ui-contract.v2.json'),
    original.get('ci/contracts/workflow-ui-contract.v2.json'));
  assert.match(renamed.get('ci/contracts/workflow-ui-contract.v2.json') ?? '',
    /Validate updated pull request changes/);
  assert.equal(renamed.get('ci/contracts/workflow-lane-contract.v2.json'),
    original.get('ci/contracts/workflow-lane-contract.v2.json'));
});

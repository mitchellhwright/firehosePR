import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STEP_RUNNER, byEvent, jobOf, matrixSuffixed, needsOutput, typedJob, typedNodeActionStep, typedScriptActionStep, typedStep, typedWorkflow,
  type LaneMetadata, type TypedStep, type TypedStepConfig,
} from '../workflows/lib/index.ts';

const lane: LaneMetadata = {
  runnerClass: 'hosted-control', costClass: 'control', evidencePolicy: 'none', selectionOwner: 'controller',
};

const stepDefaults: TypedStepConfig = {
  name: 'Report the healthy runner',
  doc: {
    purpose: 'Prints the runner name so the heartbeat names the host that answered.',
    recovery: 'no runner of this class is online; check the hosts in the runbook',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  script: 'scripts/ci/linux-runner-heartbeat/portable-heartbeat/report-healthy-runner.sh',
};

const aStep = (overrides: Partial<TypedStepConfig> = {}): TypedStep<string> =>
  typedStep({ ...stepDefaults, ...overrides } as TypedStepConfig);

/** A job that runs a script needs one of these first; most fixtures here do. */
const aCheckout = (name = 'Check out the repository'): TypedStep<string> => typedStep({
  ...stepDefaults, name, script: undefined, uses: 'actions/checkout@v7.0.1',
} as TypedStepConfig);

const aJob = (steps: readonly TypedStep<string>[], overrides: Record<string, unknown> = {}) => typedJob('heartbeat', {
  name: 'External Linux heartbeat',
  doc: { purpose: 'Proves an external Linux runner is online.', successMeaning: 'A runner of this class took the job.' },
  owner: 'infrastructure', category: 'environment', unit: 'job', runsOn: 'ubuntu-24.04', lane, steps,
  ...overrides,
});

test('a step runs exactly one of a script, a typed entry, a one-line command or an action', () => {
  assert.doesNotThrow(() => aStep());
  assert.throws(() => aStep({ uses: 'actions/checkout@v7.0.1' }), /exactly one of script, entry, command or uses/);
  assert.throws(() => typedStep({ ...stepDefaults, script: undefined } as TypedStepConfig), /exactly one of script, entry, command or uses/);
  assert.throws(
    () => typedStep({ ...stepDefaults, script: undefined, command: 'echo a\necho b' } as TypedStepConfig),
    /a command is one line/,
  );
});

test('workflow steps cannot invoke untyped mjs entrypoints', () => {
  assert.throws(
    () => aStep({ script: undefined, command: 'node scripts/controller.mjs' }),
    /typechecked TypeScript entrypoint/,
  );
  assert.throws(
    () => aStep({ script: 'scripts/controller.mjs', command: undefined }),
    /typechecked TypeScript entrypoint/,
  );
});

test('only a script step may pin the job names it spells out of band', () => {
  assert.doesNotThrow(() => aStep({ pinnedNames: ['Capture a Dependabot base edit'] }));
  assert.throws(
    () => typedStep({
      ...stepDefaults, script: undefined, command: 'echo ok', pinnedNames: ['Capture a Dependabot base edit'],
    } as TypedStepConfig),
    /pinnedNames belongs on a script step/,
  );
  assert.throws(() => aStep({ pinnedNames: ['  '] }), /every pinned name must be a name the script contains/);
});

test('a script step cannot also set a working directory, which would hide both paths from it', () => {
  // `run` resolves against `working-directory`, so the step runner and the
  // script it wraps would both be looked for beneath it.
  assert.throws(() => aStep({ workingDirectory: 'ios' }), /cannot set workingDirectory/);
  assert.doesNotThrow(
    () => typedStep({ ...stepDefaults, script: undefined, command: 'swift build', workingDirectory: 'ios' } as TypedStepConfig),
  );
});

test('a script step carries its own failure annotation and the declared environment', () => {
  const built = aStep({ env: { RUNNER_NAME: 'fixture' } }).step.toYaml() as Record<string, unknown>;
  assert.equal(built.run, `bash ${STEP_RUNNER} scripts/ci/linux-runner-heartbeat/portable-heartbeat/report-healthy-runner.sh`);
  assert.deepEqual(built.env, {
    EXAMPLE_STEP_NAME: 'Report the healthy runner',
    EXAMPLE_STEP_OWNER: 'infrastructure',
    EXAMPLE_STEP_NEXT_ACTION: 'no runner of this class is online; check the hosts in the runbook',
    RUNNER_NAME: 'fixture',
  });
});

test('a typed script action keeps the script input and annotation contract together', () => {
  const built = typedScriptActionStep({
    name: stepDefaults.name,
    doc: stepDefaults.doc,
    owner: stepDefaults.owner,
    category: stepDefaults.category,
    unit: stepDefaults.unit,
    script: 'scripts/ci/linux-runner-heartbeat/portable-heartbeat/report-healthy-runner.sh',
  }).step.toYaml() as Record<string, unknown>;
  assert.equal(built.uses, './.github/actions/typed-step-runner');
  assert.deepEqual(built.with, {
    script: 'scripts/ci/linux-runner-heartbeat/portable-heartbeat/report-healthy-runner.sh',
  });
  assert.equal(built.run, undefined);
  assert.throws(() => aStep({ scriptExecution: 'typed-action', shell: 'bash' }), /owns its input and Bash interpreter/);
  assert.throws(() => aStep({ scriptExecution: 'typed-action', with: { script: 'other.sh' } }), /owns its input/);
  assert.throws(() => aStep({ script: undefined, command: 'echo ok', scriptExecution: 'typed-action' }), /requires a script/);
});

test('a typed Node action pins its checked entrypoint and rejects conflicting execution settings', () => {
  const built = typedNodeActionStep({
    name: 'Run the typed probe', doc: stepDefaults.doc, owner: stepDefaults.owner,
    category: stepDefaults.category, unit: stepDefaults.unit,
    entry: 'ci/src/actions/runPrValidationPolicyTests.ts',
  }).step.toYaml() as Record<string, unknown>;
  assert.equal(built.uses, './.github/actions/typed-step-runner');
  assert.deepEqual(built.with, { entry: 'ci/src/actions/runPrValidationPolicyTests.ts' });
  assert.equal(built.run, undefined);
  assert.deepEqual(built.env, {
    EXAMPLE_STEP_NAME: 'Run the typed probe',
    EXAMPLE_STEP_OWNER: stepDefaults.owner,
    EXAMPLE_STEP_NEXT_ACTION: stepDefaults.doc.recovery,
  });
  assert.throws(() => typedStep({ ...stepDefaults, script: undefined, entry: 'ci/src/actions/../probe.ts' }),
    /entry must be a typechecked TypeScript file/);
  assert.throws(() => typedStep({ ...stepDefaults, script: undefined, entry: 'ci/src/actions/missing.ts' }),
    /entry does not exist/);
  assert.throws(() => typedStep({ ...stepDefaults, script: undefined, entry: 'ci/src/actions/runPrValidationPolicyTests.ts', shell: 'bash' }),
    /typed entry owns its action input/);
  assert.throws(() => aJob([typedNodeActionStep({
    name: 'Run the typed probe', doc: stepDefaults.doc, owner: stepDefaults.owner,
    category: stepDefaults.category, unit: stepDefaults.unit, entry: 'ci/src/actions/runPrValidationPolicyTests.ts',
  })]), /needs an actions\/checkout step before it/);
  assert.throws(() => aJob([aCheckout(), typedNodeActionStep({
    name: 'Run the typed probe', doc: stepDefaults.doc, owner: stepDefaults.owner,
    category: stepDefaults.category, unit: stepDefaults.unit, entry: 'ci/src/actions/runPrValidationPolicyTests.ts',
  })]), /needs actions\/setup-node before it/);
});

test('names are readable and unique, and a controller must say what it decided', () => {
  assert.throws(() => aStep({ name: 'run' }), /too generic/);
  assert.throws(() => aStep({ doc: { purpose: 'Prints the runner name for the heartbeat.', recovery: '' } }), /doc: recovery/);
  assert.throws(() => aJob([aCheckout(), aStep(), aStep()]), /duplicate step name/);
  assert.throws(() => aStep({ category: 'coordination' }), /summaryTitle is required/);
  assert.doesNotThrow(() => aJob([aCheckout(), aStep({ category: 'coordination', summaryTitle: 'Heartbeat' })]));
  assert.throws(() => aJob([]), /at least one step/);
  assert.throws(() => typedJob('Heartbeat', { ...aJob([aCheckout(), aStep()]).config }), /kebab-case/);
});

test('a workflow rejects duplicate jobs and unknown required contexts, and renders suffixed names', () => {
  const shardJob = (name: Parameters<typeof typedJob>[1]['name'], id: string) => typedJob(id, {
    name,
    doc: { purpose: 'Runs a shard of the server suite.', successMeaning: 'The shard passed.' },
    owner: 'product', category: 'quality', unit: 'shard', runsOn: 'ubuntu-24.04', lane, steps: [aCheckout(), aStep()],
  });
  const base = {
    path: '.github/workflows/fixture.yml', source: 'ci/workflows/fixture.ts', name: 'Fixture workflow',
    doc: { purpose: 'Fixture for the model tests.' }, on: { push: {} }, permissions: {},
  } as const;
  assert.throws(
    () => typedWorkflow({ ...base, jobs: [shardJob('Server tests', 'a'), shardJob('Server tests', 'b')] }),
    /duplicate job name/,
  );
  assert.throws(
    () => typedWorkflow({ ...base, jobs: [shardJob('Server tests', 'a')], requiredContexts: ['missing'] }),
    /requiredContexts names unknown job/,
  );
  const definition = typedWorkflow({ ...base, jobs: [shardJob(matrixSuffixed('Server tests', 'shard'), 'a')] });
  assert.match(definition.workflow.toYamlString(), /name: 'Server tests \(\$\{\{ matrix\.shard \}\}\)'/);
  // One workflow reads another's job by id rather than restating its name.
  assert.equal(jobOf(definition, 'a').id, 'a');
  assert.throws(() => jobOf(definition, 'gone'), /has no job "gone"/);
});

test('a generic job name is publishable only where the workflow requires that exact context', () => {
  const contextJob = (overrides: Record<string, unknown> = {}) => typedJob('test-ios', {
    name: byEvent({ workflow_dispatch: 'Manual - Test - iOS' }, 'Test - iOS'),
    doc: { purpose: 'Reports whether the iOS lanes are fit to merge.', successMeaning: 'The iOS lanes passed.' },
    owner: 'product', category: 'quality', unit: 'job', runsOn: 'ubuntu-24.04', lane, steps: [aCheckout(), aStep()],
    ...overrides,
  });
  const base = {
    path: '.github/workflows/fixture.yml', source: 'ci/workflows/fixture.ts', name: 'Fixture workflow',
    doc: { purpose: 'Fixture for the model tests.' }, on: { push: {} }, permissions: {},
  } as const;

  // The generic name is refused until the job says which context it publishes.
  assert.throws(() => contextJob(), /too generic/);
  const declared = contextJob({ requiredCheckContext: 'Test - iOS' });

  // Declaring it is not enough: this workflow has to require the job under it.
  assert.throws(
    () => typedWorkflow({ ...base, jobs: [declared] }),
    /declares the required context "Test - iOS" but requiredContexts does not list it/,
  );
  assert.doesNotThrow(
    () => typedWorkflow({ ...base, jobs: [declared], requiredContexts: ['test-ios'] }),
  );

  // A context this job never renders is a mismatch, not a second name for it.
  assert.throws(
    () => typedWorkflow({
      ...base,
      jobs: [contextJob({ name: 'Report the iOS verdict', requiredCheckContext: 'Onboarding E2E' })],
      requiredContexts: ['test-ios'],
    }),
    /declares the required context "Onboarding E2E" but never renders that name/,
  );

  // The exemption reaches the declared context only; a generic name that is
  // not one stays refused however the job is declared.
  assert.throws(
    () => typedJob('lint', {
      ...declared.config, name: 'lint', requiredCheckContext: 'Test - iOS',
    }),
    /too generic/,
  );
  assert.throws(
    () => typedJob('lint', { ...declared.config, name: 'Lint', requiredCheckContext: 'Lint changed code' }),
    /too generic/,
  );
});

test('a workflow name a subscriber matches on is readable through its display name', () => {
  // `PR Checks` is what two controllers subscribe to by string, so the name
  // GitHub runs under cannot be rewritten for readability; the readable name
  // rides alongside it, and is held to the same rule.
  const base = {
    path: '.github/workflows/fixture.yml', source: 'ci/workflows/fixture.ts', name: 'PR Checks',
    doc: { purpose: 'Fixture for the model tests.' }, on: { push: {} }, permissions: {},
    jobs: [typedJob('a', {
      name: 'Run the fixture shard',
      doc: { purpose: 'Runs a shard of the server suite.', successMeaning: 'The shard passed.' },
      owner: 'product', category: 'quality', unit: 'shard', runsOn: 'ubuntu-24.04', lane,
      steps: [aCheckout(), aStep()],
    })],
  } as const;
  assert.throws(() => typedWorkflow(base), /displayName.*too generic/);
  const definition = typedWorkflow({ ...base, displayName: 'Validate pull request changes' });
  assert.equal(definition.config.name, 'PR Checks');
  assert.match(definition.workflow.toYamlString(), /^name: PR Checks$/m);
});

test('job outputs are typed from step outputs so a consumer cannot name one that does not exist', () => {
  const producing = typedStep({
    ...stepDefaults, id: 'probe', outputs: ['runner_name'] as const,
  });
  const producer = typedJob('heartbeat', {
    name: 'External Linux heartbeat',
    doc: { purpose: 'Proves an external Linux runner is online.', successMeaning: 'A runner of this class took the job.' },
    owner: 'infrastructure', category: 'environment', unit: 'job', runsOn: 'ubuntu-24.04', lane,
    steps: [aCheckout(), producing],
    outputs: { runner_name: producing.outputs.runner_name },
  });
  assert.equal(String(producer.outputs.runner_name), '${{ needs.heartbeat.outputs.runner_name }}');
  assert.equal(String(needsOutput(producer, 'runner_name')), '${{ needs.heartbeat.outputs.runner_name }}');
  // @ts-expect-error a step output that was never declared is a compile error
  producing.outputs.missing;
  // @ts-expect-error a job output that was never declared is a compile error
  producer.outputs.missing;
  const invalidConsumer = () => {
    // @ts-expect-error a consumer cannot reference an undeclared producer output
    needsOutput(producer, 'missing');
  };
  void invalidConsumer;
});

test('a job that runs a script must check the repository out before it', () => {
  // Inline shell needs nothing on disk; an extracted script does, so this is
  // the rule that stops a migration from silently breaking a scheduled job.
  assert.throws(() => aJob([aStep()]), /needs an actions\/checkout step before it/);
  assert.doesNotThrow(() => aJob([aCheckout(), aStep()]));
  // Order matters: a checkout after the script is no checkout at all.
  assert.throws(() => aJob([aStep(), aCheckout()]), /needs an actions\/checkout step before it/);
});

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkDefinitions, emitYaml, writeDefinitions } from '../workflows/lib/emit.ts';
import { typedJob, typedStep, typedWorkflow, type LaneMetadata } from '../workflows/lib/index.ts';

const lane: LaneMetadata = {
  runnerClass: 'hosted-control', costClass: 'control', evidencePolicy: 'none', selectionOwner: 'controller',
};

const definition = typedWorkflow({
  path: '.github/workflows/fixture.yml',
  source: 'ci/workflows/fixture.ts',
  name: 'Emitter fixture',
  doc: { purpose: 'Exercises the emitter end to end.' },
  on: { push: { branches: ['develop'] } },
  permissions: { contents: 'read' },
  jobs: [typedJob('probe', {
    name: 'Probe the emitter',
    doc: { purpose: 'Runs the fixture steps.', successMeaning: 'The fixture steps ran.' },
    owner: 'infrastructure', category: 'environment', unit: 'job', runsOn: 'ubuntu-24.04', lane,
    steps: [
      typedStep({
        name: 'Check out the repository',
        doc: { purpose: 'Puts the source on the runner.', recovery: 'retry; then check GitHub status' },
        owner: 'infrastructure', category: 'environment', unit: 'step',
        uses: 'actions/checkout@v7.0.1', with: { 'persist-credentials': false },
      }),
      typedStep({
        name: 'Report the fixture result',
        doc: { purpose: 'Prints a line so the fixture has output.', recovery: 'read the script output' },
        owner: 'infrastructure', category: 'environment', unit: 'step',
        script: 'scripts/ci/fixture/probe/report.sh', env: { WHO: 'fixture' },
      }),
    ],
  })],
});

const pins = new Map([['actions/checkout@v7.0.1', '3d3c42e5aac5ba805825da76410c181273ba90b1']]);

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'workflows-emit-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, 'ci/workflows'), { recursive: true });
  mkdirSync(join(root, 'ci/src/actions'), { recursive: true });
  copyFileSync(
    join(process.cwd(), 'ci/src/actions/runWorkflowStep.ts'),
    join(root, 'ci/src/actions/runWorkflowStep.ts'),
  );
  writeFileSync(join(root, 'ci/workflows/action-pins.json'), `${JSON.stringify(Object.fromEntries(pins))}\n`);
  return root;
}

test('emitted YAML names its source, pins the action with its tag, and routes the script through the runner', () => {
  const yaml = emitYaml(definition, { pins });
  assert.match(yaml, /^# GENERATED from ci\/workflows\/fixture\.ts — edit the source, not this file\./);
  assert.match(yaml, /# Regenerate with: npm run ci:workflows/);
  assert.match(yaml, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\.0\.1/);
  assert.match(yaml, /run: bash scripts\/ci\/lib\/run-step\.sh scripts\/ci\/fixture\/probe\/report\.sh/);
  assert.match(yaml, /EXAMPLE_STEP_OWNER: infrastructure/);
  assert.match(yaml, /EXAMPLE_STEP_NEXT_ACTION: read the script output/);
  assert.match(yaml, /WHO: fixture/);
  assert.equal(emitYaml(definition, { pins }), yaml, 'rendering the same definition twice gives the same bytes');
});

test('an action the lockfile does not pin is an error naming the command that fixes it', () => {
  assert.throws(
    () => emitYaml(definition, { pins: new Map() }),
    /Unpinned action actions\/checkout@v7\.0\.1: run npm run workflows:pins/,
  );
});

test('write then check reports no drift, and an edited file is reported with the differing lines', () => {
  const root = fixtureRoot();
  // The names the controllers import are generated alongside the YAML, so a
  // rename cannot reach GitHub without reaching the programs that read it back.
  assert.deepEqual(writeDefinitions([definition], root), [
    'ci/contracts/workflow-ui-contract.v2.json',
    'ci/contracts/workflow-lane-contract.v2.json',
    'scripts/ci/generated/workflow-names.ts',
    '.github/actions/typed-step-runner/action.yml',
    '.github/actions/typed-step-runner/bundle/index.cjs',
    '.github/workflows/fixture.yml',
  ]);
  assert.deepEqual(checkDefinitions([definition], root), []);

  const names = join(root, 'scripts/ci/generated/workflow-names.ts');
  writeFileSync(names, readFileSync(names, 'utf8').replace('Probe the emitter', 'Probe the stale emitter'));
  const [stale] = checkDefinitions([definition], root);
  assert.equal(stale?.path, 'scripts/ci/generated/workflow-names.ts');
  assert.equal(stale?.reason, 'differs');
  writeDefinitions([definition], root);

  const path = join(root, '.github/workflows/fixture.yml');
  writeFileSync(path, readFileSync(path, 'utf8').replace('WHO: fixture', 'WHO: edited'));
  const [drift] = checkDefinitions([definition], root);
  assert.equal(drift?.path, '.github/workflows/fixture.yml');
  assert.equal(drift?.reason, 'differs');
  assert.match(drift?.diff ?? '', /WHO: edited/);
  assert.match(drift?.diff ?? '', /WHO: fixture/);
});

test('a workflow that was never generated is reported as missing', () => {
  const [drift] = checkDefinitions([definition], fixtureRoot());
  assert.equal(drift?.reason, 'missing');
});

test('a malformed lockfile fails loudly instead of rendering unpinned actions', () => {
  const root = fixtureRoot();
  writeFileSync(join(root, 'ci/workflows/action-pins.json'), '{"actions/checkout@v7.0.1": "v7.0.1"}');
  assert.throws(() => checkDefinitions([definition], root), /must map to a 40-hex commit SHA/);
});

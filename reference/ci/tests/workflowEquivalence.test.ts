import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { equivalenceIssues, normaliseWorkflow } from '../src/workflowEquivalence.ts';

function root(reportBody = 'echo "hello $WHO"'): string {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-equivalence-'));
  mkdirSync(join(directory, 'scripts/ci/fixture/probe'), { recursive: true });
  writeFileSync(
    join(directory, 'scripts/ci/fixture/probe/report.sh'),
    `#!/usr/bin/env bash\nset -euo pipefail\n${reportBody}\n`,
  );
  return directory;
}

const handWritten = `name: Fixture
on:
  push:
    branches: [develop]
permissions: {}
jobs:
  probe:
    name: probe
    runs-on: ubuntu-24.04
    if: >-
      github.actor == 'dependabot[bot]' &&
      github.event.changes.base != null
    steps:
      - name: Report
        env:
          WHO: world
        run: |
          set -euo pipefail
          echo "hello $WHO"
`;

const generated = `# GENERATED from ci/workflows/fixture.ts — edit the source, not this file.
name: Fixture
on:
  push:
    branches:
      - develop
permissions: {}
jobs:
  probe:
    name: Probe the fixture
    runs-on: ubuntu-24.04
    if: "github.actor == 'dependabot[bot]' && github.event.changes.base != null"
    steps:
      - name: Report
        env:
          EXAMPLE_STEP_NAME: Report
          EXAMPLE_STEP_OWNER: infrastructure
          EXAMPLE_STEP_NEXT_ACTION: read the script output
          WHO: world
        run: bash scripts/ci/lib/run-step.sh scripts/ci/fixture/probe/report.sh
`;

test('the generated workflow is equivalent modulo comments, quoting, folding and the listed rename', () => {
  const directory = root();
  const before = normaliseWorkflow(handWritten, { root: directory, renames: { probe: 'Probe the fixture' } });
  const after = normaliseWorkflow(generated, { root: directory });
  assert.deepEqual(equivalenceIssues(before, after), []);
});

test('a typed local action preserves the same extracted script body', () => {
  const directory = root();
  const actionGenerated = generated.replace(
    'run: bash scripts/ci/lib/run-step.sh scripts/ci/fixture/probe/report.sh',
    'uses: ./.github/actions/typed-step-runner\n        with:\n          script: scripts/ci/fixture/probe/report.sh',
  );
  const before = normaliseWorkflow(generated, { root: directory });
  const after = normaliseWorkflow(actionGenerated, { root: directory });
  assert.deepEqual(equivalenceIssues(before, after), []);
  assert.throws(
    () => normaliseWorkflow(actionGenerated.replace('script: scripts/ci/fixture/probe/report.sh', 'other: probe'), { root: directory }),
    /must declare one repository script or typed entry input/,
  );
  assert.throws(
    () => normaliseWorkflow(actionGenerated.replace('script: scripts/ci/fixture/probe/report.sh', 'script: scripts/ci/fixture/probe/report.sh\n          other: probe'), { root: directory }),
    /must declare one repository script or typed entry input/,
  );
  assert.throws(
    () => normaliseWorkflow(actionGenerated.replace('script: scripts/ci/fixture/probe/report.sh', 'script: scripts/ci/../ci/fixture/probe/report.sh'), { root: directory }),
    /must declare one repository script or typed entry input/,
  );
});

test('a typed entry is validated and is not silently equated with a shell script', () => {
  const directory = root();
  const entryGenerated = generated.replace(
    'run: bash scripts/ci/lib/run-step.sh scripts/ci/fixture/probe/report.sh',
    'uses: ./.github/actions/typed-step-runner\n        with:\n          entry: ci/src/actions/probe.ts',
  );
  const entry = normaliseWorkflow(entryGenerated, { root: directory });
  const shell = normaliseWorkflow(generated, { root: directory });
  assert.ok(equivalenceIssues(shell, entry).length > 0);
  assert.throws(
    () => normaliseWorkflow(entryGenerated.replace('entry: ci/src/actions/probe.ts', 'entry: ci/src/actions/../probe.ts'), { root: directory }),
    /must declare one repository script or typed entry input/,
  );
});

test('a rename that was not declared is reported rather than silently accepted', () => {
  const directory = root();
  const issues = equivalenceIssues(
    normaliseWorkflow(handWritten, { root: directory }),
    normaliseWorkflow(generated, { root: directory }),
  );
  assert.ok(issues.some((issue) => issue.startsWith('jobs.probe.name differs')), issues.join('\n'));
});

test('a job that had no name is compared by the id GitHub showed instead', () => {
  const directory = root();
  const nameless = handWritten.replace('    name: probe\n', '');
  const before = normaliseWorkflow(nameless, { root: directory, renames: { probe: 'Probe the fixture' } });
  assert.deepEqual(equivalenceIssues(before, normaliseWorkflow(generated, { root: directory })), []);
});

test('a declared rename applies to steps as well as jobs', () => {
  const directory = root();
  const renamedStep = generated.replace('      - name: Report', '      - name: Report the fixture result');
  const before = normaliseWorkflow(handWritten, { root: directory, renames: { probe: 'Probe the fixture' } });
  assert.ok(equivalenceIssues(before, normaliseWorkflow(renamedStep, { root: directory })).length > 0);
  const declared = normaliseWorkflow(handWritten, {
    root: directory,
    renames: { probe: 'Probe the fixture', Report: 'Report the fixture result' },
  });
  assert.deepEqual(equivalenceIssues(declared, normaliseWorkflow(renamedStep, { root: directory })), []);
});

test('a change to the extracted shell is reported at the step that moved', () => {
  const directory = root('echo "goodbye $WHO"');
  const issues = equivalenceIssues(
    normaliseWorkflow(handWritten, { root: directory, renames: { probe: 'Probe the fixture' } }),
    normaliseWorkflow(generated, { root: directory }),
  );
  assert.deepEqual(issues, ['jobs.probe.steps[1].shellBody differs: "echo \\"hello $WHO\\"" -> "echo \\"goodbye $WHO\\""']);
});

test('a trigger with no filters is the same trigger however it is written', () => {
  const directory = root();
  const withNull = normaliseWorkflow('name: F\non:\n  workflow_dispatch:\n  push: { branches: [develop] }\njobs: {}\n', { root: directory });
  const withEmpty = normaliseWorkflow('name: F\non:\n  workflow_dispatch: {}\n  push: { branches: [develop] }\njobs: {}\n', { root: directory });
  assert.deepEqual(equivalenceIssues(withNull, withEmpty), []);
});

test('a dropped step, a dropped job and a changed trigger are each reported', () => {
  const directory = root();
  const before = normaliseWorkflow(handWritten, { root: directory, renames: { probe: 'Probe the fixture' } });

  const withoutStep = normaliseWorkflow(generated.replace(/ {6}- name: Report[\s\S]*$/, '      []\n'), { root: directory });
  assert.ok(equivalenceIssues(before, withoutStep).some((issue) => issue.includes('steps count 1 -> 0')));

  const withoutJob = normaliseWorkflow(generated.replace('  probe:', '  renamed-job:'), { root: directory });
  const jobIssues = equivalenceIssues(before, withoutJob);
  assert.ok(jobIssues.includes('jobs.probe removed'));
  assert.ok(jobIssues.includes('jobs.renamed-job added'));

  const otherBranch = normaliseWorkflow(generated.replace('      - develop', '      - main'), { root: directory });
  assert.ok(equivalenceIssues(before, otherBranch).some((issue) => issue.startsWith('triggers.push.branches')));
});

test('renaming a workflow is reported, because a workflow_run trigger subscribes to the name', () => {
  const directory = root();
  const before = normaliseWorkflow('name: Capture Dependabot base edit\non: { push: {} }\npermissions: {}\njobs: {}\n', { root: directory });
  const after = normaliseWorkflow('name: Capture a Dependabot base edit\non: { push: {} }\npermissions: {}\njobs: {}\n', { root: directory });
  assert.deepEqual(equivalenceIssues(before, after), [
    'name differs: "Capture Dependabot base edit" -> "Capture a Dependabot base edit"',
  ]);
  // A rename the migration declares is still equivalent.
  const declared = normaliseWorkflow(
    'name: Capture Dependabot base edit\non: { push: {} }\npermissions: {}\njobs: {}\n',
    { root: directory, renames: { 'Capture Dependabot base edit': 'Capture a Dependabot base edit' } },
  );
  assert.deepEqual(equivalenceIssues(declared, after), []);
});

test('omitting top-level permissions is not the same as declaring none', () => {
  const directory = root();
  const inherited = normaliseWorkflow('name: F\non: { push: {} }\njobs: {}\n', { root: directory });
  const none = normaliseWorkflow('name: F\non: { push: {} }\npermissions: {}\njobs: {}\n', { root: directory });
  assert.ok(equivalenceIssues(inherited, none).some((issue) => issue.startsWith('permissions differs')));
  assert.deepEqual(equivalenceIssues(none, none), []);
});

test('whitespace is collapsed inside expressions and preserved everywhere else', () => {
  const directory = root();
  const workflow = (shell: string, env: string, condition: string) =>
    `name: F\non: { push: {} }\npermissions: {}\njobs:\n  probe:\n    name: Probe the fixture\n    runs-on: ubuntu-24.04\n`
    + `    if: ${condition}\n    steps:\n      - name: Report the fixture result\n        run: ${shell}\n        env:\n          WHO: ${env}\n`;

  // Two spaces in a command echo two spaces; that is a behaviour change.
  const spaced = normaliseWorkflow(workflow('echo "a  b"', 'fixture', "github.event_name    ==    'push'"), { root: directory });
  const single = normaliseWorkflow(workflow('echo "a b"', 'fixture', "github.event_name == 'push'"), { root: directory });
  assert.ok(equivalenceIssues(spaced, single).some((issue) => issue.includes('shellBody differs')));

  // The condition differs only by the whitespace YAML folding moves around.
  const folded = normaliseWorkflow(workflow('echo "a  b"', 'fixture', "github.event_name\n      ==   'push'"), { root: directory });
  assert.deepEqual(equivalenceIssues(spaced, folded), []);

  // An environment value is data too.
  const spacedEnv = normaliseWorkflow(workflow('echo "a  b"', "'two  spaces'", "github.event_name == 'push'"), { root: directory });
  const singleEnv = normaliseWorkflow(workflow('echo "a  b"', "'two spaces'", "github.event_name == 'push'"), { root: directory });
  assert.ok(equivalenceIssues(spacedEnv, singleEnv).some((issue) => issue.includes('env.WHO differs')));
});

test('an added step must be declared, and a declaration that matches nothing is reported', () => {
  const directory = root();
  const steps = (extra: string) =>
    `name: F\non: { push: {} }\npermissions: {}\njobs:\n  probe:\n    name: Probe the fixture\n    runs-on: ubuntu-24.04\n    steps:\n`
    + `${extra}      - name: Report the fixture result\n        run: echo done\n`;
  const before = normaliseWorkflow(steps(''), { root: directory });
  const after = normaliseWorkflow(steps('      - name: Check out the fixture\n        uses: actions/checkout@v7.0.1\n'), { root: directory });

  // Undeclared, the added step is a difference like any other.
  assert.ok(equivalenceIssues(before, after).some((issue) => issue.includes('steps count 1 -> 2')));
  // Declared with its content, it is recorded rather than reported.
  const declared = { name: 'Check out the fixture', uses: 'actions/checkout@v7.0.1' };
  assert.deepEqual(equivalenceIssues(before, after, { addedSteps: { probe: [declared] } }), []);
  // The content is compared, not waved through. A step the old workflow never
  // had cannot be proved correct against the old workflow, so the declaration
  // is the only account of what it should be — and an added checkout that
  // takes the pull request head with credentials is the shape that matters.
  const unsafe = normaliseWorkflow(
    steps('      - name: Check out the fixture\n        uses: actions/checkout@v7.0.1\n'
      + '        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n'
      + '          persist-credentials: true\n'),
    { root: directory },
  );
  const leaked = equivalenceIssues(before, unsafe, { addedSteps: { probe: [declared] } }).join('; ');
  assert.match(leaked, /steps\[added "Check out the fixture"\]/);
  assert.match(leaked, /ref/);
  assert.match(leaked, /persist-credentials/);
  // A declaration for a step that was never added is itself an issue, so a
  // stale allowance cannot sit there excusing a future change.
  assert.deepEqual(
    equivalenceIssues(before, before, { addedSteps: { probe: [declared] } }),
    ['jobs.probe.steps declares an added step "Check out the fixture" that is not there'],
  );
});

test('a single dependency is the same dependency however it is written', () => {
  const directory = root();
  const job = (needs: string) =>
    `name: F\non: { push: {} }\npermissions: {}\njobs:\n  a:\n    name: Build the thing\n    runs-on: ubuntu-24.04\n    steps: []\n`
    + `  b:\n    name: Use the thing\n    runs-on: ubuntu-24.04\n    needs: ${needs}\n    steps: []\n`;
  const scalar = normaliseWorkflow(job('a'), { root: directory });
  const sequence = normaliseWorkflow(job('[a]'), { root: directory });
  assert.deepEqual(equivalenceIssues(scalar, sequence), []);
  // A dependency that was actually added is still reported.
  const extra = normaliseWorkflow(job('[a, c]'), { root: directory });
  assert.ok(equivalenceIssues(scalar, extra).some((issue) => issue.startsWith('jobs.b.needs')));
});

test('two added steps sharing a name are tracked separately', () => {
  const directory = root();
  const body = (extra: string) =>
    `name: F\non: { push: {} }\npermissions: {}\njobs:\n  probe:\n    name: Probe the fixture\n    runs-on: ubuntu-24.04\n    steps:\n`
    + `${extra}      - name: Report the fixture result\n        run: echo done\n`;
  const one = '      - name: Check out\n        uses: actions/checkout@v7.0.1\n';
  const before = normaliseWorkflow(body(''), { root: directory });
  const declared = { name: 'Check out', uses: 'actions/checkout@v7.0.1' };

  // Two declarations, two steps: both consumed, nothing reported.
  assert.deepEqual(
    equivalenceIssues(before, normaliseWorkflow(body(one + one), { root: directory }),
      { addedSteps: { probe: [declared, declared] } }),
    [],
  );
  // Two declarations but only one step: the surplus declaration is reported
  // rather than silently satisfied by the one that is there.
  assert.deepEqual(
    equivalenceIssues(before, normaliseWorkflow(body(one), { root: directory }),
      { addedSteps: { probe: [declared, declared] } }),
    ['jobs.probe.steps declares an added step "Check out" that is not there'],
  );
});

test('a declared added step may be written in ordinary workflow syntax', () => {
  const directory = root('echo ready');
  const body = (extra: string) =>
    `name: F\non: { push: {} }\npermissions: {}\njobs:\n  probe:\n    name: Probe the fixture\n    runs-on: ubuntu-24.04\n    steps:\n`
    + `${extra}      - name: Report the fixture result\n        run: echo done\n`;
  const before = normaliseWorkflow(body(''), { root: directory });
  const after = normaliseWorkflow(body('      - name: Prepare\n        run: echo ready\n'), { root: directory });

  // `run` on the declaration, `shell` after normalisation — the comparison
  // normalises the declaration too, so these are the same step.
  assert.deepEqual(
    equivalenceIssues(before, after, { root: directory, addedSteps: { probe: [{ name: 'Prepare', run: 'echo ready' }] } }),
    [],
  );
  // And a declaration that says something else about the shell still fails.
  const wrong = equivalenceIssues(before, after, {
    root: directory,
    addedSteps: { probe: [{ name: 'Prepare', run: 'echo something-else' }] },
  });
  assert.ok(wrong.some((issue) => issue.includes('shellBody')), wrong.join('; '));
});

/**
 * A workflow migrated one job at a time: `probe` is generated, `audit` is
 * still hand-written and absent from the definition until its own commit.
 */
function twoJobs(probe: string, audit = 'echo audited'): string {
  return `name: F\non: { push: {} }\npermissions: {}\njobs:\n`
    + `  probe:\n    name: Probe the fixture\n    runs-on: ubuntu-24.04\n    steps:\n`
    + `      - name: Report the fixture result\n        run: ${probe}\n`
    + `  audit:\n    name: Audit the fixture\n    runs-on: ubuntu-24.04\n    steps:\n`
    + `      - name: Record the fixture audit\n        run: ${audit}\n`;
}

/** The generated half: `probe` alone, because `audit` has not been migrated yet. */
const probeOnly = `name: F\non: { push: {} }\npermissions: {}\njobs:\n`
  + `  probe:\n    name: Probe the fixture\n    runs-on: ubuntu-24.04\n    steps:\n`
  + `      - name: Report the fixture result\n        run: echo done\n`;

test('a migration in progress compares only the jobs it names', () => {
  const directory = root();
  const before = normaliseWorkflow(twoJobs('echo done'), { root: directory });
  const after = normaliseWorkflow(probeOnly, { root: directory });

  // Unfiltered, the job that has not been migrated yet reads as a deletion.
  assert.ok(equivalenceIssues(before, after).includes('jobs.audit removed'));
  assert.deepEqual(equivalenceIssues(before, after, { jobs: ['probe'] }), []);
});

test('a difference inside a selected job is still reported', () => {
  const directory = root();
  const before = normaliseWorkflow(twoJobs('echo done'), { root: directory });
  const after = normaliseWorkflow(probeOnly.replace('run: echo done', 'run: echo something-else'), { root: directory });
  assert.deepEqual(
    equivalenceIssues(before, after, { jobs: ['probe'] }),
    ['jobs.probe.steps[1].shellBody differs: "echo done" -> "echo something-else"'],
  );
});

test('a job the comparison does not select is not compared', () => {
  const directory = root();
  const before = normaliseWorkflow(twoJobs('echo done'), { root: directory });
  const after = normaliseWorkflow(twoJobs('echo done', 'echo something-else'), { root: directory });

  // The un-migrated job differs, which the unfiltered comparison reports.
  assert.ok(equivalenceIssues(before, after).some((issue) => issue.startsWith('jobs.audit.steps[1]')));
  assert.deepEqual(equivalenceIssues(before, after, { jobs: ['probe'] }), []);
});

test('selecting a job neither workflow declares is reported rather than silently filtering everything out', () => {
  const directory = root();
  const before = normaliseWorkflow(twoJobs('echo done'), { root: directory });
  assert.deepEqual(equivalenceIssues(before, before, { jobs: ['prboe'] }), [
    'jobs.prboe is selected for comparison but neither workflow declares it',
  ]);
});

test('a step keeps its declared shell interpreter distinct from its shell body', () => {
  const directory = root();
  const step = (shell: string) =>
    `name: F\non: { push: {} }\npermissions: {}\njobs:\n  probe:\n    name: Probe the fixture\n    runs-on: ubuntu-24.04\n    steps:\n`
    + `      - name: Report the fixture result\n${shell}        run: echo done\n`;
  const declared = normaliseWorkflow(step('        shell: bash\n'), { root: directory });
  const absent = normaliseWorkflow(step(''), { root: directory });

  // `shell:` names the interpreter; the body is synthesised under another key.
  // Writing the body under `shell` shadowed the real field, so dropping
  // `shell: bash` from a step changed the workflow and the proof said nothing.
  assert.deepEqual(equivalenceIssues(declared, absent), ['jobs.probe.steps[1].shell differs: "bash" -> null']);
  assert.deepEqual(equivalenceIssues(declared, declared), []);

  // And a changed interpreter is reported too, not just a removed one.
  const python = normaliseWorkflow(step('        shell: python\n'), { root: directory });
  assert.deepEqual(equivalenceIssues(declared, python), ['jobs.probe.steps[1].shell differs: "bash" -> "python"']);
});

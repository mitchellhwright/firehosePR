import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseWorkflowGraph } from '../src/workflowOutputs.ts';
import {
  envIssuesFor,
  envValidatedWorkflows,
  optionalEnv,
  scriptStepEnv,
  validateEnvContract,
  writtenEnvNames,
} from '../src/envContract.ts';

test('every validated workflow resolves each env reference in step order', () => {
  for (const path of envValidatedWorkflows) {
    assert.deepEqual(envIssuesFor(path), [], path);
  }
});

test('every pinned workflow is a validated workflow', () => {
  for (const path of [...Object.keys(scriptStepEnv), ...Object.keys(optionalEnv)]) {
    assert.ok((envValidatedWorkflows as readonly string[]).includes(path), path);
  }
});

test('a pin on a typed program is evidenced by the record it exports through, not by shell text', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-contract-typed-'));
  mkdirSync(join(root, 'ci', 'src', 'actions'), { recursive: true });
  mkdirSync(join(root, 'ci', 'src', 'lane'), { recursive: true });
  writeFileSync(
    join(root, 'ci', 'src', 'lane', 'exports.ts'),
    "export const laneEnvironment = { FROM_RECORD: '1' };\n",
  );
  writeFileSync(
    join(root, 'ci', 'src', 'actions', 'start.ts'),
    [
      "import { laneEnvironment } from '../lane/exports.ts';",
      'appendGithubEnv(laneEnvironment);',
      "const DIRECT_ASSIGNMENT = '2';",
    ].join('\n'),
  );
  const graph = parseWorkflowGraph(`
jobs:
  lane:
    steps:
      - name: start
        run: node ci/src/actions/start.ts
      - name: reads
        run: echo "\${{ env.FROM_RECORD }} \${{ env.DIRECT_ASSIGNMENT }} \${{ env.NEVER_WRITTEN }}"
`);
  const pins = { lane: { start: ['FROM_RECORD', 'DIRECT_ASSIGNMENT', 'NEVER_WRITTEN'] } };
  assert.deepEqual(
    validateEnvContract(graph, 'synthetic.yml', root, pins, {}).map((issue) => issue.message),
    [
      // `const DIRECT_ASSIGNMENT = '2'` is a local, not a write to $GITHUB_ENV.
      // The narrower check accepted the bare identifier as evidence; following
      // the program's imports means a pin is evidenced by the record it
      // actually exports through, so both unwritten names are reported.
      'pins env.DIRECT_ASSIGNMENT as written by step "start"\'s script, but no source the step reaches names "DIRECT_ASSIGNMENT"',
      'pins env.NEVER_WRITTEN as written by step "start"\'s script, but no source the step reaches names "NEVER_WRITTEN"',
    ],
  );
});

test('a typed step action entry is followed like the run command that names it', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-contract-entry-'));
  mkdirSync(join(root, 'ci', 'src', 'actions'), { recursive: true });
  writeFileSync(join(root, 'ci', 'src', 'lane.ts'), "export const exported = { FROM_ENTRY: '1' };\n");
  writeFileSync(join(root, 'ci', 'src', 'actions', 'start.ts'), "import { exported } from '../lane.ts';\n");
  const graph = parseWorkflowGraph(`
jobs:
  lane:
    steps:
      - name: start
        uses: ./.github/actions/typed-step-runner
        with:
          entry: ci/src/actions/start.ts
      - name: reads
        if: env.FROM_ENTRY != ''
        run: echo "\${{ env.UNPINNED }}"
`);
  assert.deepEqual(
    validateEnvContract(graph, 'synthetic.yml', root, { lane: { start: ['FROM_ENTRY', 'NOT_EXPORTED'] } }, {})
      .map((issue) => issue.message),
    [
      'pins env.NOT_EXPORTED as written by step "start"\'s script, but no source the step reaches names "NOT_EXPORTED"',
      'step "reads" reads env.UNPINNED, which no env block or earlier GITHUB_ENV write in this job defines',
    ],
  );
});

test('GITHUB_ENV writes are parsed from direct, grouped, heredoc and multi-line forms', () => {
  const names = writtenEnvNames(`
    echo "DIRECT=1" >> "$GITHUB_ENV"
    { echo "GROUPED=1"; printf 'FORMATTED=%s\\n' "$v"; } >> "$GITHUB_ENV"
    cat >> "$GITHUB_ENV" <<EOF
    HEREDOC=1
    EOF
    echo "MULTI<<DELIM" >> "$GITHUB_ENV"
  `);
  assert.deepEqual([...names].sort(), ['DIRECT', 'FORMATTED', 'GROUPED', 'HEREDOC', 'MULTI']);
  assert.deepEqual([...writtenEnvNames('echo "X=1"')], []);
});

test('an undefined name, a name written only later, a stale pin, an unevidenced pin and an unused optional are each reported', () => {
  const root = mkdtempSync(join(tmpdir(), 'env-contract-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'emit.sh'), 'echo "FROM_SCRIPT=1" >> "$GITHUB_ENV"\n');
  const graph = parseWorkflowGraph(`
env:
  WORKFLOW_VAR: 1
jobs:
  lane:
    env:
      JOB_VAR: \${{ env.WORKFLOW_VAR }}
      BROKEN: \${{ env.NOT_IN_WORKFLOW }}
    steps:
      - name: reads early
        if: env.LATER == 'x' && env.JOB_VAR == '1'
        run: echo "\${{ env.WORKFLOW_VAR }} \${{ env.STEP_VAR }} \${{ env.MISSING }}"
        env:
          STEP_VAR: 1
      - name: writes later
        run: echo "LATER=1" >> "$GITHUB_ENV"
      - name: reads after write
        run: echo "\${{ env.LATER }}"
      - name: delegate
        run: bash scripts/emit.sh
      - name: reads delegated
        run: echo "\${{ env.FROM_SCRIPT }} \${{ env.NOT_FROM_SCRIPT }}"
      - name: not a reference
        run: mktemp "$dir/.env.cleanup.XXXXXX"
`);
  const pins = { lane: { delegate: ['FROM_SCRIPT', 'NOT_FROM_SCRIPT'], vanished: ['X'] } };
  const optional = { lane: ['UNUSED_OPTIONAL'] };
  const messages = validateEnvContract(graph, 'synthetic.yml', root, pins, optional)
    .map((issue) => `${issue.job}: ${issue.message}`).sort();
  assert.deepEqual(messages, [
    'lane: job env reads env.NOT_IN_WORKFLOW, which the workflow env does not define',
    'lane: lists env.UNUSED_OPTIONAL as optional, but no step reads it without a definition',
    'lane: pins env.NOT_FROM_SCRIPT as written by step "delegate"\'s script, but no source the step reaches names "NOT_FROM_SCRIPT"',
    'lane: pins script env for step "vanished", which is not a step in this job',
    'lane: step "reads early" reads env.LATER, which no env block or earlier GITHUB_ENV write in this job defines',
    'lane: step "reads early" reads env.MISSING, which no env block or earlier GITHUB_ENV write in this job defines',
  ]);
});

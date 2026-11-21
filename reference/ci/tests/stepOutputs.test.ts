import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseWorkflowGraph } from '../src/workflowOutputs.ts';
import {
  scriptStepOutputs,
  stepOutputIssuesFor,
  stepOutputValidatedWorkflows,
  validateStepOutputs,
  writtenOutputKeys,
} from '../src/stepOutputs.ts';

test('every validated workflow reads only step outputs that the step writes', () => {
  for (const path of stepOutputValidatedWorkflows) {
    assert.deepEqual(stepOutputIssuesFor(path), [], path);
  }
});

test('every pinned script-delegated step belongs to a validated workflow', () => {
  for (const path of Object.keys(scriptStepOutputs)) {
    assert.ok((stepOutputValidatedWorkflows as readonly string[]).includes(path), path);
  }
});

test('shell output keys are parsed from direct, grouped, printf, heredoc and multi-line writes', () => {
  const keys = writtenOutputKeys(`
    echo "direct=1" >> "$GITHUB_OUTPUT"
    {
      echo "grouped_a=1"
      echo 'grouped_b=2'
    } >> "$GITHUB_OUTPUT"
    printf 'formatted=%s\\n' "$value" >> "$GITHUB_OUTPUT"
    cat >> "$GITHUB_OUTPUT" <<EOF
    heredoc_key=value
    EOF
    echo "multi<<DELIM" >> "$GITHUB_OUTPUT"
    if [ -n "$x" ]; then echo "branch=1" >> "$GITHUB_OUTPUT"; fi
    echo "not an output: logging=only"
  `);
  assert.deepEqual([...keys].sort(), [
    'branch', 'direct', 'formatted', 'grouped_a', 'grouped_b', 'heredoc_key', 'multi',
  ]);
  assert.deepEqual([...writtenOutputKeys('echo "plain=1"')], [], 'a block that never touches GITHUB_OUTPUT writes nothing');
});

test('an unwritten key, an undeclared action output, an unpinned action and a stale pin are each reported', () => {
  const root = mkdtempSync(join(tmpdir(), 'step-outputs-'));
  mkdirSync(join(root, '.github', 'actions', 'local'), { recursive: true });
  writeFileSync(join(root, '.github', 'actions', 'local', 'action.yml'), 'outputs:\n  known: {}\n');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'emit.mjs'), "writeOutput('emitted', value);\n");
  const graph = parseWorkflowGraph(`
jobs:
  gate:
    outputs:
      a: \${{ steps.shell.outputs.written }}
      b: \${{ steps.shell.outputs.typo }}
      c: \${{ steps.local.outputs.known }}
      d: \${{ steps.local.outputs.unknown }}
      e: \${{ steps.external.outputs.token }}
      f: \${{ steps.mystery.outputs.value }}
      g: \${{ steps.delegated.outputs.emitted }}
      h: \${{ steps.delegated.outputs.never }}
    steps:
      - id: shell
        run: echo "written=1" >> "$GITHUB_OUTPUT"
      - id: local
        uses: ./.github/actions/local
      - id: external
        uses: actions/create-github-app-token@abc123
      - id: mystery
        uses: someone/unpinned-action@v1
      - id: delegated
        run: node scripts/emit.mjs
`);
  const pinned = { gate: { delegated: ['emitted', 'never'], vanished: ['x'] } };
  const messages = validateStepOutputs(graph, 'synthetic.yml', root, pinned)
    .map((issue) => `${issue.job}: ${issue.message}`).sort();
  assert.deepEqual(messages, [
    'gate: pins script outputs for steps.vanished, which is not a step id in this job',
    'gate: pins steps.delegated.outputs.never as script-written, but no script the step invokes names "never"',
    'gate: reads steps.local.outputs.unknown, which action "./.github/actions/local" does not declare',
    'gate: reads steps.mystery.outputs.value from "someone/unpinned-action", whose outputs are not pinned in externalActionOutputs',
    'gate: reads steps.shell.outputs.typo, which the step\'s shell never writes to GITHUB_OUTPUT',
  ]);
});

test('a typed step action entry writes the outputs pinned to it and evidenced by its sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'step-outputs-entry-'));
  mkdirSync(join(root, 'ci', 'src', 'actions'), { recursive: true });
  writeFileSync(join(root, 'ci', 'src', 'actions', 'engine.ts'), "appendStepOutputs([['container_cmd', engine]]);\n");
  const graph = parseWorkflowGraph(`
jobs:
  lane:
    steps:
      - id: engine
        uses: ./.github/actions/typed-step-runner
        with:
          entry: ci/src/actions/engine.ts
      - run: echo "\${{ steps.engine.outputs.container_cmd }} \${{ steps.engine.outputs.unpinned }}"
`);
  assert.deepEqual(
    validateStepOutputs(graph, 'synthetic.yml', root, { lane: { engine: ['container_cmd', 'renamed'] } })
      .map((issue) => issue.message),
    [
      'pins steps.engine.outputs.renamed as script-written, but no script the step invokes names "renamed"',
      "reads steps.engine.outputs.unpinned, which the step's shell never writes to GITHUB_OUTPUT",
    ],
  );
});

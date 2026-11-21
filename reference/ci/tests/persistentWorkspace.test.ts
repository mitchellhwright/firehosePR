import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkflowGraph } from '../src/workflowOutputs.ts';
import { persistentWorkspaceIssues, validatePersistentWorkspace } from '../src/persistentWorkspace.ts';

test('no job that can run on the control runners checks out with a partial-clone filter', () => {
  assert.deepEqual(persistentWorkspaceIssues(), []);
});

test('a filtered checkout is reported for legacy, fixed, and reviewed control routes only', () => {
  const graph = parseWorkflowGraph(`
jobs:
  legacy-gate:
    runs-on: \${{ fromJson(vars.CI_CONTROL_RUNNER_LABELS || '["ubuntu-24.04"]') }}
    steps:
      - name: Checkout legacy change selector
        uses: actions/checkout@sha
        with:
          fetch-depth: 1
          filter: blob:none
  fixed-gate:
    runs-on: [self-hosted, Linux, example-trusted-control]
    steps:
      - name: Checkout fixed change selector
        uses: actions/checkout@sha
        with:
          filter: blob:none
  reviewed-gate:
    runs-on: \${{ fromJson(github.event.pull_request.head.repo.full_name == github.repository && '["self-hosted","Linux","example-trusted-control"]' || '["ubuntu-24.04"]') }}
    steps:
      - name: Checkout reviewed change selector
        uses: actions/checkout@sha
        with:
          filter: tree:0
      - name: Checkout trusted base
        uses: actions/checkout@sha
        with:
          fetch-depth: 0
  mac:
    runs-on: [self-hosted, macOS]
    steps:
      - uses: actions/checkout@sha
        with:
          filter: blob:none
  hosted:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@sha
        with:
          filter: tree:0
`);
  const issues = validatePersistentWorkspace(graph, 'wf.yml');
  assert.deepEqual(issues.map((issue) => [issue.workflow, issue.job]), [
    ['wf.yml', 'legacy-gate'],
    ['wf.yml', 'fixed-gate'],
    ['wf.yml', 'reviewed-gate'],
  ]);
  assert.match(issues[0]?.message ?? '', /Checkout legacy change selector sets filter: blob:none/);
  assert.match(issues[1]?.message ?? '', /Checkout fixed change selector sets filter: blob:none/);
  assert.match(issues[2]?.message ?? '', /Checkout reviewed change selector sets filter: tree:0/);
});

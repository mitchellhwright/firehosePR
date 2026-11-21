import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { definitions } from '../workflows/all.ts';
import { parseWorkflowGraph } from '../src/workflowOutputs.ts';
import { sparseCheckoutIssuesFor, validateSparseCheckouts } from '../src/sparseCheckouts.ts';

test('every authored workflow sparse checkout contains its local actions, scripts, and files they read', () => {
  for (const { config: { path } } of definitions) {
    assert.deepEqual(sparseCheckoutIssuesFor(path), [], path);
  }
});

test('artifact cleanup cannot run when the iOS gate was skipped before verifier admission', () => {
  const workflow = parseWorkflowGraph(
    readFileSync(join(process.cwd(), '.github/workflows/ios-tests.yml'), 'utf8'),
  );
  const cleanup = workflow.jobs['remove-run-artifacts-after-success'];
  assert.ok(cleanup);
  assert.match(String(cleanup.if ?? ''), /needs\.ios-change-gate\.result == 'success'/);
  assert.match(String(cleanup.if ?? ''), /needs\.ios-change-gate\.outputs\.verifier_sha != ''/);
});

test('a script run through a step env variable that names the checkout is followed', () => {
  const root = mkdtempSync(join(tmpdir(), 'sparse-checkouts-env-'));
  mkdirSync(join(root, 'ci', 'src'), { recursive: true });
  writeFileSync(join(root, 'ci', 'src', 'detect.ts'), "readFileSync(new URL('../../.github/workflows/lane.yml', import.meta.url));\n");
  const workflow = (sparse: string) => parseWorkflowGraph(`
jobs:
  gate:
    steps:
      - uses: actions/checkout@sha
        with:
          path: .ci/trusted
          sparse-checkout: ${sparse}
      - env:
          DETECTOR_ROOT: "\${{ fromJSON((github.event_name == 'merge_group' && toJSON('.ci/trusted')) || toJSON('.')) }}"
        run: node "$DETECTOR_ROOT/ci/src/detect.ts"
`);
  assert.deepEqual(validateSparseCheckouts(workflow('ci'), root).map((issue) => issue.message), [
    'ci/src/detect.ts reads .github/workflows/lane.yml, which the sparse checkout [ci] at .ci/trusted does not contain',
  ]);
  assert.deepEqual(validateSparseCheckouts(workflow('".github/workflows\\nci"'), root), []);
});

test('a script outside the sparse set and a file a script reads outside it are each reported', () => {
  const root = mkdtempSync(join(tmpdir(), 'sparse-checkouts-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'classifier.mjs'), "readFileSync(new URL('../.github/workflows/lane.yml', import.meta.url));\nresolve(here, '../scripts/data.json');\n");
  const graph = parseWorkflowGraph(`
jobs:
  gate:
    steps:
      - name: Checkout trusted base
        uses: actions/checkout@sha
        with:
          path: .ci/trusted
          sparse-checkout: scripts
      - run: |
          trusted="\${GITHUB_WORKSPACE:?}/.ci/trusted"
          node "$trusted/scripts/classifier.mjs" && node .ci/trusted/ci/src/planner.ts
      - name: Full checkout is not checked
        uses: actions/checkout@sha
        with:
          path: full
      - run: node full/anything.mjs
`);
  assert.deepEqual(validateSparseCheckouts(graph, root).map((issue) => issue.message).sort(), [
    'runs .ci/trusted/ci/src/planner.ts, which the sparse checkout [scripts] does not contain',
    'scripts/classifier.mjs reads .github/workflows/lane.yml, which the sparse checkout [scripts] at .ci/trusted does not contain',
  ]);
  const widened = parseWorkflowGraph(`
jobs:
  gate:
    steps:
      - uses: actions/checkout@sha
        with:
          path: .ci/trusted
          sparse-checkout: |
            scripts
            .github/workflows
      - run: node .ci/trusted/scripts/classifier.mjs
`);
  assert.deepEqual(validateSparseCheckouts(widened, root), []);
});

test('a root checkout is validated and reads are followed through sibling imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'sparse-checkouts-root-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'controller.mjs'), "import { helper } from './delta.mjs';\nhelper();\n");
  writeFileSync(join(root, 'scripts', 'delta.mjs'), "import './controller.mjs';\nreadFileSync(new URL('../.github/workflows/lane.yml', import.meta.url));\n");
  const narrow = parseWorkflowGraph(`
jobs:
  controller:
    steps:
      - name: Checkout trusted controller
        uses: actions/checkout@sha
        with:
          ref: develop
          sparse-checkout: scripts
      - run: node scripts/controller.mjs
      - name: A later root checkout replaces the first
        uses: actions/checkout@sha
        with:
          ref: develop
      - run: node scripts/anything-goes.mjs
`);
  assert.deepEqual(validateSparseCheckouts(narrow, root).map((issue) => issue.message), [
    'scripts/controller.mjs reads .github/workflows/lane.yml, which the sparse checkout [scripts] at the workspace root does not contain',
  ]);
  const widened = parseWorkflowGraph(`
jobs:
  controller:
    steps:
      - uses: actions/checkout@sha
        with:
          ref: develop
          sparse-checkout: |
            scripts
            .github/workflows
      - run: node scripts/controller.mjs
`);
  assert.deepEqual(validateSparseCheckouts(widened, root), []);
});

test('a root sparse checkout must contain the local action used by a later step', () => {
  const workflow = (sparse: string) => parseWorkflowGraph(`
jobs:
  continuity:
    steps:
      - uses: actions/checkout@sha
        with:
          sparse-checkout: |
${sparse.split('\n').map(path => `            ${path}`).join('\n')}
      - uses: ./.github/actions/typed-step-runner
  `);
  assert.deepEqual(validateSparseCheckouts(workflow('ci\nscripts')).map(issue => issue.message), [
    'uses local action .github/actions/typed-step-runner, which the sparse checkout [ci, scripts] does not contain',
  ]);
  assert.deepEqual(validateSparseCheckouts(workflow('ci\nscripts\n.github/actions/typed-step-runner')), []);
});

test('a typed step action entry and its imports must be inside the sparse set', () => {
  const root = mkdtempSync(join(tmpdir(), 'sparse-checkouts-entry-'));
  mkdirSync(join(root, 'ci', 'src', 'actions'), { recursive: true });
  writeFileSync(join(root, 'ci', 'src', 'actions', 'start.ts'), "import { plan } from '../../workflows/plan.ts';\n");
  const workflow = (sparse: string) => parseWorkflowGraph(`
jobs:
  lane:
    steps:
      - uses: actions/checkout@sha
        with:
          sparse-checkout: |
${sparse.split('\n').map(path => `            ${path}`).join('\n')}
      - uses: ./.github/actions/typed-step-runner
        with:
          entry: ci/src/actions/start.ts
  `);
  assert.deepEqual(validateSparseCheckouts(workflow('.github/actions/typed-step-runner\nscripts'), root)
    .map(issue => issue.message), [
    'runs ci/src/actions/start.ts, which the sparse checkout [.github/actions/typed-step-runner, scripts] does not contain',
  ]);
  assert.deepEqual(validateSparseCheckouts(workflow('.github/actions/typed-step-runner\nci/src'), root)
    .map(issue => issue.message), [
    'ci/src/actions/start.ts reads ci/workflows/plan.ts, which the sparse checkout [.github/actions/typed-step-runner, ci/src] at the workspace root does not contain',
  ]);
  assert.deepEqual(validateSparseCheckouts(workflow('.github/actions/typed-step-runner\nci'), root), []);
});

test('relative imports across directories are required and followed recursively', () => {
  const root = mkdtempSync(join(tmpdir(), 'sparse-checkouts-relative-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'ci', 'src', 'actions'), { recursive: true });
  mkdirSync(join(root, 'ci', 'src', 'policy'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'controller.mjs'),
    "import { trust } from '../ci/src/actions/dependabotTrust.ts';\ntrust();\n",
  );
  writeFileSync(
    join(root, 'ci', 'src', 'actions', 'dependabotTrust.ts'),
    "import { policy } from '../policy/dependabotPolicy.ts';\nexport const trust = policy;\n",
  );
  writeFileSync(
    join(root, 'ci', 'src', 'policy', 'dependabotPolicy.ts'),
    'export const policy = () => true;\n',
  );
  const workflow = (sparse: string) => parseWorkflowGraph(`
jobs:
  controller:
    steps:
      - uses: actions/checkout@sha
        with:
          sparse-checkout: |
${sparse.split('\n').map((line) => `            ${line}`).join('\n')}
      - run: node scripts/controller.mjs
`);
  assert.deepEqual(validateSparseCheckouts(workflow('scripts'), root).map(issue => issue.message), [
    'scripts/controller.mjs reads ci/src/actions/dependabotTrust.ts, which the sparse checkout [scripts] at the workspace root does not contain',
    'scripts/controller.mjs reads ci/src/policy/dependabotPolicy.ts, which the sparse checkout [scripts] at the workspace root does not contain',
  ]);
  assert.deepEqual(validateSparseCheckouts(workflow('scripts\nci/src/actions\nci/src/policy'), root), []);
});

test('cone-mode rejects a file even when it covers every invoked dependency', () => {
  const root = mkdtempSync(join(tmpdir(), 'sparse-checkout-cone-'));
  mkdirSync(join(root, 'ci/src'), { recursive: true });
  writeFileSync(join(root, 'ci/src/controller.ts'), 'export {};');
  const graph = (mode: string) => parseWorkflowGraph(`
jobs:
  controller:
    steps:
      - uses: actions/checkout@sha
        with:
          sparse-checkout: ci/src/controller.ts
          ${mode}
      - run: node ci/src/controller.ts
`);
  for (const mode of ['', 'sparse-checkout-cone-mode: true']) {
    assert.deepEqual(validateSparseCheckouts(graph(mode), root).map(issue => issue.message),
      ['cone-mode sparse checkout requires a directory, received file ci/src/controller.ts']);
  }
  assert.deepEqual(validateSparseCheckouts(graph('sparse-checkout-cone-mode: false'), root), []);
});

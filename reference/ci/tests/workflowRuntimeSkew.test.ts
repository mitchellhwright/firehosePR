import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { workflowJob } from '../src/workflowStepShell.ts';
import {
  changedPathsFromTrees, changedRuntimeSourcesFromTrees,
  newlyRequiredRuntimeSourceFiles, newlyRequiredWorkflowRuntimeFiles,
  newlyRequiredPrHeadWorkflowRuntimeFiles, prHeadWorkflowRuntimeFiles, filesFromGithubTree,
  missingWorkflowRuntimeFiles, protectedPrRuntimeWorkflows, runtimeSourceFiles,
  workflowRuntimeClosure, workflowRuntimeFiles,
} from '../src/workflowRuntimeSkew.ts';

test('runtime fan-out considers only protected workflows that run exact PR heads', () => {
  assert.deepEqual([...protectedPrRuntimeWorkflows].sort(), [
    '.github/workflows/ios-tests.yml', '.github/workflows/pr-checks.yml',
  ]);
  assert.equal(protectedPrRuntimeWorkflows.has('.github/workflows/trusted-production-onboarding-e2e.yml'), false);
});

test('Mac admission inventories the workflow GitHub executed, including promotion merge changes', () => {
  const job = workflowJob('ios-tests.yml', 'confirm-current-ios-pr') as {
    steps?: readonly { name?: string; with?: Readonly<Record<string, unknown>> }[];
  };
  const checkout = job.steps?.find((step) => step.name === 'Checkout executing iOS workflow inventory');
  assert.equal(checkout?.with?.ref, '${{ github.workflow_sha }}');
});

test('the live tuple guard installs its trusted-checkout packages before either typed program', () => {
  const job = workflowJob('ios-tests.yml', 'confirm-current-ios-pr') as {
    steps?: readonly { name?: string; run?: string; if?: string }[];
  };
  const steps = job.steps ?? [];
  const install = steps.findIndex((step) => step.name === 'Install trusted live tuple guard dependencies');
  const current = steps.findIndex((step) => step.name === 'Compare the queued tuple with the live pull request');
  const verify = steps.findIndex((step) => step.name === 'Verify workflow executables exist at the exact head');
  // Both programs import zod through ciEvent.ts, so the install is unconditional.
  assert.ok(install >= 0 && current > install && verify > current);
  assert.equal(steps[install]?.run,
    'npm ci --prefix .ci/trusted-live-tuple-guard/ci --no-audit --no-fund --ignore-scripts');
  assert.equal(steps[install]?.if, undefined);
});

test('iOS change gate keeps shallow checkout and defers history proof to affected-file detection', () => {
  const job = workflowJob('ios-tests.yml', 'ios-change-gate') as {
    steps?: readonly { name?: string; with?: Readonly<Record<string, unknown>>; run?: string; if?: string }[];
  };
  const steps = job.steps ?? [];
  const checkout = steps.find((step) => step.name === 'Checkout iOS change selector');
  const detect = steps.find((step) => step.name === 'Detect iOS Changes');
  const nativeCheckout = steps.find((step) => step.name === 'Checkout exact native test revision');
  assert.equal(checkout?.with?.['fetch-depth'], 1);
  assert.match(detect?.run ?? '', /detectIosChanges\.ts/);
  const detection = readFileSync('ci/src/actions/ios/detectIosChanges.ts', 'utf8');
  assert.ok(detection.indexOf("plan.kind === 'final'") < detection.indexOf('ensureIosMergeBase({'));
  assert.match(nativeCheckout?.if ?? '', /workflow_dispatch/);
  const selector = readFileSync('scripts/select-ios-affected-tests.ts', 'utf8');
  assert.match(selector, /tryGit\(\['merge-base', base, head\]\)/);
});

test('workflow runtime inventory excludes trusted base commands and deduplicates head commands', () => {
  assert.deepEqual(workflowRuntimeFiles(`
    run: node ../ci/src/actions/ios/selectXcode.ts
    run: node ci/src/actions/ios/selectXcode.ts
    run: bash scripts/confirm-current-ios-pr.sh
    run: node .ci/trusted-live-tuple-guard/ci/src/actions/ios/verifyWorkflowRuntimeFiles.ts
    run: node trusted-verifier/ci/src/actions/ios/checkSchemaRevisionVerifier.ts
    if: hashFiles('ci/src/actions/ios/optional.ts') != ''
    run: gh api repos/example/repo/contents/scripts/trusted-only.sh
    # run: node ci/src/actions/ios/commented.ts
  `), ['ci/src/actions/ios/selectXcode.ts', 'scripts/confirm-current-ios-pr.sh']);
});

test('native producer trusted controls do not force old PR heads to refresh', () => {
  const job = workflowJob('ios-tests.yml', 'build-ios-native-test-products') as {
    steps?: readonly { name?: string; run?: string }[];
  };
  const selector = job.steps?.find((step) => step.name === 'Determine native build selection');
  const enumeration = job.steps?.find((step) => step.name === 'Measure unfiltered compiled iOS tests');
  assert.match(selector?.run ?? '', /\.ci\/trusted-native-controls\/scripts\/select-ios-affected-tests\.ts/);
  assert.match(enumeration?.run ?? '', /\.ci\/trusted-native-controls\/ci\/src\/actions\/ios\/measureCompiledTestEnumeration\.ts/);
  const workflowSource = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
  assert.equal(workflowRuntimeFiles(workflowSource).includes(
    'ci/src/actions/ios/measureCompiledTestEnumeration.ts'), false);
  assert.deepEqual(newlyRequiredWorkflowRuntimeFiles(
    ['run: node ../ci/src/actions/ios/measureCompiledTestEnumeration.ts'],
    [`run: ${selector?.run}\nrun: ${enumeration?.run}`],
  ), []);
});

test('a trusted verdict checkout cannot demand its newly added executable from unrelated PR heads', () => {
  const before = `jobs:\n  verdict:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: '\${{ needs.gate.outputs.verifier_sha || env.EXAMPLE_CI_TRUSTED_BASE_SHA }}'\n      - run: node ci/src/actions/ios/verifyRealServerE2eStatus.ts\n`;
  const after = `${before}      - run: node ci/src/actions/ios/verifyPromotionVerdict.ts\n`;
  assert.deepEqual(newlyRequiredPrHeadWorkflowRuntimeFiles([before], [after]), []);
  assert.deepEqual(prHeadWorkflowRuntimeFiles(after), []);
  assert.deepEqual(workflowRuntimeClosure(after, () => undefined), []);

  const current = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
  assert.equal(prHeadWorkflowRuntimeFiles(current).includes('ci/src/actions/ios/verifyPromotionVerdict.ts'), false);
});

test('every promotion verdict runs from the same checkout that supplied its typed program', () => {
  for (const jobId of ['test-ios', 'storekit-purchase-status', 'onboarding-e2e-status']) {
    const job = workflowJob('ios-tests.yml', jobId) as {
      steps?: readonly { run?: string; uses?: string; with?: Readonly<Record<string, unknown>> }[];
    };
    const steps = job.steps ?? [];
    const verdictIndex = steps.findIndex((step) => step.run?.includes('verifyPromotionVerdict.ts'));
    assert.ok(verdictIndex > 0, `${jobId} must run the promotion verdict`);
    const checkout = steps.slice(0, verdictIndex).findLast((step) => step.uses?.startsWith('actions/checkout@'));
    assert.ok(checkout, `${jobId} must check out its verdict program`);
    const checkoutPath = checkout.with?.['path'];
    assert.equal(steps[verdictIndex]?.run,
      `node ${typeof checkoutPath === 'string' ? `${checkoutPath}/` : ''}ci/src/actions/ios/verifyPromotionVerdict.ts`);
  }
});

test('a new executable after an exact-head checkout still requires PR-head refresh', () => {
  const before = `jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v7\n        with:\n          ref: '\${{ github.event.pull_request.head.sha }}'\n      - run: node ci/src/actions/existing.ts\n`;
  const after = `${before}      - run: node ci/src/actions/new.ts\n`;
  assert.deepEqual(newlyRequiredPrHeadWorkflowRuntimeFiles([before], [after]), ['ci/src/actions/new.ts']);
  assert.deepEqual(workflowRuntimeClosure(after, (path) => path === 'ci/src/actions/existing.ts'
    || path === 'ci/src/actions/new.ts' ? '' : undefined), [
    'ci/src/actions/existing.ts', 'ci/src/actions/new.ts',
  ]);
});

test('path-scoped trusted checkout and root PR checkout have separate executable ownership', () => {
  const workflow = `jobs:
  mixed:
    steps:
      - uses: actions/checkout@v7
        with:
          path: .ci/trusted
          ref: '\${{ env.EXAMPLE_CI_TRUSTED_BASE_SHA }}'
      - run: node .ci/trusted/ci/src/actions/ios/trusted.ts
      - run: node ci/src/actions/ios/trusted-directory.ts
        working-directory: .ci/trusted
      - uses: actions/checkout@v7
        with:
          ref: '\${{ github.event.pull_request.head.sha }}'
      - run: node ci/src/actions/ios/head.ts
      - uses: actions/checkout@v7
        with:
          path: .ci/head
          ref: '\${{ github.event.pull_request.head.sha }}'
      - run: node .ci/head/ci/src/actions/ios/head-scoped.ts
      - run: node ci/src/actions/ios/head-directory.ts
        working-directory: .ci/head
`;
  assert.deepEqual(prHeadWorkflowRuntimeFiles(workflow), [
    'ci/src/actions/ios/head-directory.ts',
    'ci/src/actions/ios/head-scoped.ts',
    'ci/src/actions/ios/head.ts',
  ]);
});

test('workflow_sha checkout is head-owned because PR workflows may use a synthetic merge', () => {
  const workflow = `jobs:
  inventory:
    steps:
      - uses: actions/checkout@v7
        with:
          path: .ci/executing-ios-workflow
          ref: '\${{ github.workflow_sha }}'
      - run: node .ci/executing-ios-workflow/ci/src/actions/ios/future-runtime.ts
`;
  assert.deepEqual(prHeadWorkflowRuntimeFiles(workflow), ['ci/src/actions/ios/future-runtime.ts']);
});

test('base fan-out selects only executable references newly required by a workflow', () => {
  const required = newlyRequiredWorkflowRuntimeFiles(
    ['run: bash scripts/old.sh'],
    ['run: node ../ci/src/actions/ios/selectXcode.ts\nrun: bash scripts/old.sh'],
  );
  assert.deepEqual(required, ['ci/src/actions/ios/selectXcode.ts']);
  assert.deepEqual(missingWorkflowRuntimeFiles(required, new Set(['scripts/old.sh'])), required);
  assert.deepEqual(missingWorkflowRuntimeFiles(required, new Set(required)), []);
  assert.deepEqual(newlyRequiredWorkflowRuntimeFiles(
    ['run: node ci/src/actions/shared.ts', ''],
    ['run: node ci/src/actions/shared.ts', 'run: node ci/src/actions/shared.ts'],
  ), ['ci/src/actions/shared.ts']);
  assert.throws(() => newlyRequiredWorkflowRuntimeFiles([], ['run: node ci/src/actions/shared.ts']), /paired/);
});

test('exact-head inventory refuses truncated or malformed GitHub trees', () => {
  assert.deepEqual([...filesFromGithubTree({ truncated: false, tree: [
    { path: 'ci/src/actions/ios/selectXcode.ts', type: 'blob' },
    { path: 'scripts', type: 'tree' },
  ] })], ['ci/src/actions/ios/selectXcode.ts']);
  assert.throws(() => filesFromGithubTree({ truncated: true, tree: [] }), /complete head file tree/);
  assert.throws(() => filesFromGithubTree({ truncated: false, tree: [{ type: 'blob' }] }), /malformed/);
});

test('runtime source inventory remains complete beyond the compare file cap', () => {
  const before = { truncated: false, tree: [
    { path: 'ci/src/actions/existing.ts', type: 'blob', sha: 'old', mode: '100644' },
    { path: 'scripts/unchanged.sh', type: 'blob', sha: 'same', mode: '100644' },
    { path: 'scripts/mode-only.sh', type: 'blob', sha: 'same', mode: '100644' },
    { path: 'scripts/deleted.sh', type: 'blob', sha: 'deleted', mode: '100755' },
  ] };
  const after = { truncated: false, tree: [
    { path: 'ci/src/actions/existing.ts', type: 'blob', sha: 'new', mode: '100644' },
    { path: 'ci/src/actions/new.ts', type: 'blob', sha: 'added', mode: '100644' },
    { path: 'scripts/unchanged.sh', type: 'blob', sha: 'same', mode: '100644' },
    { path: 'scripts/mode-only.sh', type: 'blob', sha: 'same', mode: '100755' },
    { path: 'src/product.ts', type: 'blob', sha: 'changed', mode: '100644' },
  ] };
  assert.deepEqual(changedPathsFromTrees(before, after), [
    'ci/src/actions/existing.ts', 'ci/src/actions/new.ts', 'scripts/deleted.sh',
    'scripts/mode-only.sh', 'src/product.ts',
  ]);
  assert.deepEqual(changedRuntimeSourcesFromTrees(before, after), [
    { filename: 'ci/src/actions/existing.ts', status: 'modified' },
    { filename: 'ci/src/actions/new.ts', status: 'added' },
    { filename: 'scripts/mode-only.sh', status: 'modified' },
  ]);
  assert.throws(() => changedRuntimeSourcesFromTrees(before, { ...after, truncated: true }),
    /complete push file tree/);
});

test('workflow reaches a helper through a typed action and shell adapter before Mac allocation', () => {
  const action = 'ci/src/actions/ios/executePrecompiledTests.ts';
  const shell = 'scripts/run-ios-ci-main-tests.sh';
  const helper = 'ci/src/actions/ios/partitionUiTests.ts';
  const workflow = `run: node ../${action}`;
  const sources = new Map([
    [action, "await runCommand('bash', [scriptPath('run-ios-ci-main-tests.sh')]);"],
    [shell, 'node ../ci/src/actions/ios/partitionUiTests.ts "$test_plan_path" example-iosUITests'],
    [helper, 'export {};'],
  ]);
  assert.deepEqual(runtimeSourceFiles(sources.get(action) ?? ''), [shell]);
  assert.deepEqual(newlyRequiredRuntimeSourceFiles(
    ['python3 ../scripts/old-partitioner.py --test-plan "$test_plan_path"'], [sources.get(shell) ?? ''],
  ), [helper]);
  const required = workflowRuntimeClosure(workflow, (path) => sources.get(path));
  assert.deepEqual(required, [action, helper, shell]);
  assert.deepEqual(missingWorkflowRuntimeFiles(required, new Set([action, shell])), [helper]);
  assert.throws(() => workflowRuntimeClosure(workflow, (path) =>
    path === helper ? undefined : sources.get(path)), /runtime file is missing:.*partitionUiTests/);
});

test('runtime closure ignores metadata-only path listings and terminates on cycles', () => {
  assert.deepEqual(runtimeSourceFiles(`
    const fullRunFiles = [
      'scripts/run-ios-ci-main-tests.sh',
      'ci/src/actions/ios/partitionUiTests.ts',
    ];
  `), []);
  const action = 'ci/src/actions/ios/first.ts';
  const other = 'ci/src/actions/ios/second.ts';
  const sources = new Map([
    [action, `await runCommand('node', ['${other}']);`],
    [other, `await runCommand('node', ['${action}']);`],
  ]);
  assert.deepEqual(workflowRuntimeClosure(`run: node ${action}`, (path) => sources.get(path)), [action, other]);
});

test('runtime inventory follows multiline typed process launches, not nearby metadata', () => {
  assert.deepEqual(runtimeSourceFiles(`
    const metadata = ['ci/src/actions/debt/notExecuted.ts'];
    const preflight = await runCommand(process.execPath, [
      'ci/src/actions/debt/runDebtProjectionPreflight.ts',
      '--output-dir', destination,
    ]);
  `), ['ci/src/actions/debt/runDebtProjectionPreflight.ts']);
});

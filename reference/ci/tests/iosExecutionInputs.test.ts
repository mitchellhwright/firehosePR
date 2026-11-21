import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dump, load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  iosBaseLineageReusePlan,
  iosE2eProductInputDigest as productDigest,
  iosExecutionScopeChanged,
  iosExecutionScopeChangedPaths,
  isIosRealServerRuntimeInput,
  isIosTypedCiExecutionInput,
} from '../src/ios/iosExecutionInputs.ts';

const files = (paths: readonly string[]) => paths.map((filename) => ({ filename }));

describe('typed iOS base-lineage reuse', () => {
  it('keeps PR 5785 evidence across PR Checks-only base changes', () => {
    const lineage = files([
      '.github/workflows/pr-checks.yml',
      'ci/contracts/typing-coverage-floor.json',
      'ci/contracts/workflow-ui-contract.v2.json',
      'ci/src/prValidationPlan.ts',
      'ci/tests/prValidationPlan.test.ts',
      'ci/tests/workflows.migrations.test.ts',
      'ci/workflows/pr-checks.ts',
      'docs/evidence/ci-infrastructure-contracts.md',
      'scripts/ci/pr-checks/database-integration/prove-plaid-scheduler-verifier-rejects-schema-drift.sh',
      'ci/src/actions/provePlaidSchedulerSchemaDrift.ts',
      'ci/src/plaidSchedulerSchemaDrift.ts',
      'server/tests/gcpPlatformMigration.contract.test.ts',
      'server/tests/observabilityDeploymentSecrets.contract.test.ts',
      'server/tests/plaidSchedulerMigration.test.ts',
      'server/tests/utils/plaidSchedulerDriftHarness.ts',
    ]);

    assert.equal(iosExecutionScopeChanged(lineage), false);
    assert.deepEqual(iosExecutionScopeChangedPaths(lineage), []);
    assert.deepEqual(iosBaseLineageReusePlan(lineage), {
      invalidatingPaths: [], replanPaths: [], changedFiles: [], rerunAuxiliary: [],
    });
  });

  it('keeps native evidence across iOS documentation-only base changes', () => {
    const lineage = files(['ios/docs/IOS_UI_IMPLEMENTATION_STANDARDS.md', 'ios/README.md', 'ios/AGENTS.md']);
    assert.deepEqual(iosBaseLineageReusePlan(lineage), {
      invalidatingPaths: [], replanPaths: [], changedFiles: [], rerunAuxiliary: [],
    });
  });

  it('re-plans runner maintenance but retains #6175 native evidence across the #6527 base update', () => {
    const lineage = files([
      '.github/workflows/install-runner-cleanup-hooks.yml',
      '.github/workflows/xcode-cloud-build-tags.yml',
      'scripts/ci/xcode-cloud-build-tags/reconcile/validate-app-store-connect-configuration.sh',
      'ci/src/actions/validateMaintenanceDispatchRef.ts',
      'ci/src/actions/validateAppStoreConnectConfiguration.ts',
      'ci/tests/workflowRunnerRoutes.test.ts',
      'ci/tests/xcodeCloudReconciliation.test.ts',
    ]);
    assert.deepEqual(iosBaseLineageReusePlan(lineage), {
      invalidatingPaths: [],
      replanPaths: ['.github/workflows/install-runner-cleanup-hooks.yml'],
      changedFiles: [],
      rerunAuxiliary: [],
    });
  });

  it('still discards native evidence when the host environment or iOS execution changes', () => {
    const lineage = files([
      'scripts/activate-github-actions-runner-environment.sh',
      'scripts/setup-github-macos-runner.sh',
      'scripts/provision-github-macos-runner-tools.sh',
      '.github/workflows/ios-tests.yml',
      'ci/src/actions/ios/verifyExactIosRevision.ts',
    ]);
    assert.deepEqual(iosBaseLineageReusePlan(lineage)?.invalidatingPaths,
      lineage.map((file) => file.filename));
  });

  it('retains lane ownership for registry changes in a server-only base advance', () => {
    const lineage = files([
      'server/services/chat/tools/registry.ts',
      'server/tests/chatRefinanceAprIngress.test.ts',
      'server/tests/utils/autoRefinanceFixtures.ts',
      'server/services/debt/refinanceAnalysisService.test.ts',
    ]);

    assert.equal(iosExecutionScopeChanged(lineage), false);
    assert.deepEqual(iosBaseLineageReusePlan(lineage), {
      invalidatingPaths: [],
      replanPaths: [],
      changedFiles: ['server/services/chat/tools/registry.ts'],
      rerunAuxiliary: ['chat-plaid', 'budget'],
    });
  });

  it('reruns every real-server lane for an unclaimed input every lane loads or reads', () => {
    for (const path of [
      // Loaded at boot: the chat tool registry imports the debt services.
      'server/services/debt/refinanceAnalysisService.ts',
      'server/data/activation-flows/budget-flow.json',
      'server/db/migrations/0000_puzzling_sentry.sql',
      'shared/schemas/userProfile.ts',
      'src/security/contentSecurityPolicy.ts',
      'next.config.mjs',
    ]) {
      assert.deepEqual(iosBaseLineageReusePlan(files([path])), {
        invalidatingPaths: [],
        replanPaths: [],
        changedFiles: [path],
        rerunAuxiliary: ['onboarding', 'chat-plaid', 'income', 'budget'],
      }, path);
    }
  });

  it('reruns only Chat-Plaid for chat docs and the Chat Plaid seed', () => {
    for (const path of ['server/docs/CHAT_ARCHITECTURE.md', 'server/testdata/chat-plaid-e2e-seed.json']) {
      assert.deepEqual(iosBaseLineageReusePlan(files([path])), {
        invalidatingPaths: [],
        replanPaths: [],
        changedFiles: [path],
        rerunAuxiliary: ['chat-plaid'],
      }, path);
    }
    assert.deepEqual(iosBaseLineageReusePlan(files([
      'server/docs/CHAT_ARCHITECTURE.md',
      'server/services/users/userProfileService.ts',
    ]))?.rerunAuxiliary, ['onboarding', 'chat-plaid', 'income', 'budget']);
  });

  it('reruns no real-server lane for backend files no lane loads or reads', () => {
    const lineage = files([
      'pages/index.tsx',
      'server/services/debt/index.ts',
      'server/services/chat/services/docs.ts',
      'server/scripts/index-docs-rag.ts',
      // Imported only as types, which erase.
      'shared/observability.ts',
    ]);
    assert.deepEqual(iosBaseLineageReusePlan(lineage), {
      invalidatingPaths: [], replanPaths: [], changedFiles: [], rerunAuxiliary: [],
    });
  });

  it('counts a backend file the contract does not know for every lane', () => {
    for (const lane of ['onboarding', 'chat-plaid', 'income', 'budget'] as const) {
      assert.equal(isIosRealServerRuntimeInput('server/services/debt/notYetGenerated.ts', lane), true, lane);
      assert.equal(isIosRealServerRuntimeInput('docs/notYetGenerated.md', lane), false, lane);
    }
    assert.equal(isIosRealServerRuntimeInput('server/tests/docs.test.ts', 'chat-plaid'), false);
  });

  it('keeps real-server evidence for test-only backend changes', () => {
    const lineage = files([
      'server/tests/chatRefinanceAprIngress.test.ts',
      'server/tests/utils/autoRefinanceFixtures.ts',
      'server/vitest.config.ts',
      'server/services/debt/refinanceAnalysisService.test.ts',
      'shared/schemas/userProfile.test.ts',
      'pages/api/health.test.tsx',
    ]);

    assert.deepEqual(iosBaseLineageReusePlan(lineage), {
      invalidatingPaths: [], replanPaths: [], changedFiles: [], rerunAuxiliary: [],
    });
  });

  it('reruns Chat-Plaid for the extracted institution suggestion tool', () => {
    assert.deepEqual(iosBaseLineageReusePlan(files([
      'server/services/chat/tools/institutionSuggestionTool.ts',
    ])), {
      invalidatingPaths: [],
      replanPaths: [],
      changedFiles: ['server/services/chat/tools/institutionSuggestionTool.ts'],
      rerunAuxiliary: ['chat-plaid', 'budget'],
    });
  });

  it('keeps the existing budget owner for other chat service changes', () => {
    assert.deepEqual(iosBaseLineageReusePlan(files([
      'server/services/chat/chatService.ts',
    ])), {
      invalidatingPaths: [],
      replanPaths: [],
      changedFiles: ['server/services/chat/chatService.ts'],
      rerunAuxiliary: ['budget'],
    });
  });

  it('re-plans the trusted Linux classifier without invalidating compiled products or test execution', () => {
    const owners = ['ci/src/ios/controllers/baseUpdateDelta.ts', 'ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts'];
    assert.deepEqual(iosBaseLineageReusePlan(files(owners)), {
      invalidatingPaths: [], replanPaths: owners, changedFiles: [], rerunAuxiliary: [],
    });
    assert.equal(iosExecutionScopeChanged(files(owners)), true, 'current-head selection must still be re-planned');
    assert.deepEqual(iosBaseLineageReusePlan([{
      filename: 'ci/src/ios/shared/processRunner.ts', previous_filename: owners[0], status: 'renamed',
    }])?.invalidatingPaths, ['ci/src/ios/shared/processRunner.ts'], 'moving into compiler execution still invalidates products');
  });

  it('invalidates predecessor evidence when Test - iOS itself changed', () => {
    const lineage = files([
      '.github/workflows/ios-tests.yml',
      'ci/src/actions/ios/detectIosChanges.ts',
      'ci/src/ios/iosChangeGate.ts',
    ]);

    assert.equal(iosExecutionScopeChanged(lineage), true);
    assert.deepEqual(iosExecutionScopeChangedPaths(lineage), lineage.map((file) => file.filename));
  });

  it('uses the generated workflow as the runtime boundary for generator-only changes', () => {
    const generatorOnly = files([
      'ci/workflows/ios-tests/index.ts',
      'ci/workflows/ios-tests/shared.ts',
      'ci/workflows/lib/typedJob.ts',
    ]);

    assert.equal(iosExecutionScopeChanged(generatorOnly), false);
    assert.deepEqual(iosExecutionScopeChangedPaths(generatorOnly), []);
    assert.equal(iosExecutionScopeChanged(files(['.github/workflows/ios-tests.yml'])), true);
  });

  it('fails closed for missing or capped comparisons and rename origins', () => {
    assert.equal(iosExecutionScopeChanged(undefined), true);
    assert.equal(iosExecutionScopeChanged(Array.from({ length: 300 }, (_, index) => ({
      filename: `docs/${index}.md`,
    }))), true);
    assert.deepEqual(iosExecutionScopeChangedPaths([{
      filename: 'docs/new.md', previous_filename: 'ios/Old.swift', status: 'renamed',
    }]), ['ios/Old.swift']);
  });
});

describe('E2E product content identity', () => {
  const workflow = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
  function payload(source: string) {
    return { encoding: 'base64', size: Buffer.byteLength(source), content: Buffer.from(source).toString('base64') };
  }
  function workflowSha(source: string) {
    return createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
  }
  const iosE2eProductInputDigest = (value: unknown) => productDigest(value, payload(workflow));

  const blob = (path: string, sha: string) => ({
    path, type: 'blob', mode: '100644', sha,
  });
  const tree = (
    iosSha: string,
    unrelatedCiSha = '5'.repeat(40),
    generatorSha = '2'.repeat(40),
  ) => ({
    truncated: false,
    tree: [
      blob('.github/workflows/ios-tests.yml', workflowSha(workflow)),
      blob('ci/workflows/ios-tests/build-ios-e2e-test-products.ts', generatorSha),
      blob('ci/src/actions/ios/packE2eTestProducts.ts', '3'.repeat(40)),
      blob('ios/example-ios/App.swift', iosSha),
      blob('scripts/build-ios-e2e-test-products.sh', '4'.repeat(40)),
      blob('ci/workflows/pr-checks.ts', unrelatedCiSha),
    ],
  });

  it('binds every typed product input while excluding unrelated CI sources', () => {
    const predecessor = iosE2eProductInputDigest(tree('2'.repeat(40)));
    assert.match(predecessor ?? '', /^[a-f0-9]{64}$/);
    assert.equal(iosE2eProductInputDigest(tree('2'.repeat(40))), predecessor);
    assert.equal(
      iosE2eProductInputDigest(tree('2'.repeat(40), '6'.repeat(40))),
      predecessor,
      'unrelated typed PR Checks sources are not compiled-product inputs',
    );
    assert.equal(
      iosE2eProductInputDigest(tree('2'.repeat(40), '5'.repeat(40), '6'.repeat(40))),
      predecessor,
      'generator-only source changes are represented by the generated workflow artifact',
    );
    const withRunnerPolicy = (policySha: string) => ({
      ...tree('2'.repeat(40)),
      tree: [...tree('2'.repeat(40)).tree, blob('ci/src/runnerPolicy.ts', policySha)],
    });
    assert.equal(
      iosE2eProductInputDigest(withRunnerPolicy('7'.repeat(40))),
      iosE2eProductInputDigest(withRunnerPolicy('8'.repeat(40))),
      'control-runner policy does not change compiled E2E products',
    );
    for (const owner of ['ci/src/ios/controllers/baseUpdateDelta.ts', 'ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts']) {
      const withController = (sha: string) => ({ ...tree('2'.repeat(40)), tree: [...tree('2'.repeat(40)).tree, blob(owner, sha)] });
      assert.equal(iosE2eProductInputDigest(withController('7'.repeat(40))),
        iosE2eProductInputDigest(withController('8'.repeat(40))), 'trusted Linux planning is not a compiler input');
    }
    for (const owner of ['ci/src/ios/shared/processRunner.ts', 'ci/src/actions/ios/guardIosIncrementalBuild.ts']) {
      const withRuntime = (sha: string) => ({ ...tree('2'.repeat(40)), tree: [...tree('2'.repeat(40)).tree, blob(owner, sha)] });
      assert.notEqual(iosE2eProductInputDigest(withRuntime('7'.repeat(40))),
        iosE2eProductInputDigest(withRuntime('8'.repeat(40))), 'the compiler supervisor remains a product input');
    }
    const withPackAction = (actionSha: string) => ({
      ...tree('2'.repeat(40)),
      tree: tree('2'.repeat(40)).tree.map((entry) => (
        entry.path === 'ci/src/actions/ios/packE2eTestProducts.ts'
          ? { ...entry, sha: actionSha }
          : entry
      )),
    });
    assert.notEqual(
      iosE2eProductInputDigest(withPackAction('7'.repeat(40))),
      iosE2eProductInputDigest(withPackAction('8'.repeat(40))),
      'Mac product execution actions remain part of the product identity',
    );
    assert.notEqual(iosE2eProductInputDigest(tree('4'.repeat(40))), predecessor);
    assert.equal(iosE2eProductInputDigest({ truncated: true, tree: [] }), null);
  });

  it('preserves products for an unrelated downstream workflow edit but invalidates producer inputs', () => {
    const baseline = tree('2'.repeat(40));
    const originalDigest = productDigest(baseline, payload(workflow));
    assert.ok(originalDigest);
    function changed(edit: (jobs: Record<string, Record<string, unknown>>) => void) {
      const document = load(workflow) as { jobs: Record<string, Record<string, unknown>> };
      edit(document.jobs);
      const source = dump(document, { lineWidth: -1 });
      return productDigest({ ...baseline, tree: baseline.tree.map((entry) => entry.path === '.github/workflows/ios-tests.yml'
        ? { ...entry, sha: workflowSha(source) } : entry) }, payload(source));
    }
    assert.equal(changed((jobs) => { jobs['budget-e2e-video-processing']!['timeout-minutes'] = 123; }), originalDigest);
    assert.notEqual(changed((jobs) => { jobs['build-ios-e2e-test-products']!.env = { DIFFERENT_BUILD: 'true' }; }), originalDigest);
    assert.notEqual(changed((jobs) => { jobs['prepare-dev-e2e-schema']!.env = { DIFFERENT_SCHEMA: 'true' }; }), originalDigest);
    assert.equal(productDigest(baseline, payload(workflow + '\n# comment')), null,
      'semantically equivalent bytes must still match the tree blob before they are trusted');
    assert.equal(productDigest(baseline, undefined), null);
    assert.equal(productDigest({ ...baseline, tree: [...baseline.tree, baseline.tree[0]] }, payload(workflow)), null);
    assert.equal(productDigest({ truncated: false, tree: [null] }, payload(workflow)), null);
  });

  it('frames unusual Git paths without digest-line ambiguity', () => {
    const ordinary = tree('2'.repeat(40));
    const unusual = {
      ...ordinary,
      tree: [
        ...ordinary.tree,
        blob(`ios/fixture\n100644 ios/second=${'7'.repeat(40)}`, '8'.repeat(40)),
      ],
    };
    assert.notEqual(iosE2eProductInputDigest(unusual), iosE2eProductInputDigest(ordinary));
  });
});

it('classifies every transitive typed Test - iOS runtime action as an execution input', () => {
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const importPattern = /(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g;
  const queue = [...readFileSync(join(repositoryRoot, '.github/workflows/ios-tests.yml'), 'utf8')
    .matchAll(/(?:^|\s)(ci\/src\/actions\/ios\/[\w./-]+\.ts)(?:\s|$)/gm)]
    .flatMap((match) => match[1] === undefined ? [] : [match[1]]);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const candidate = queue.shift();
    if (candidate === undefined || visited.has(candidate)) continue;
    visited.add(candidate);
    assert.equal(isIosTypedCiExecutionInput(candidate), true, candidate);
    const source = readFileSync(join(repositoryRoot, candidate), 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const imported = relative(
        repositoryRoot,
        resolve(repositoryRoot, dirname(candidate), specifier),
      );
      if (imported.startsWith('ci/')) queue.push(imported);
    }
  }
});

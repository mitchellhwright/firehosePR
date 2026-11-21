import { prValidationPlanning } from '../src/prValidationPlanning.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { describe, it } from 'node:test';

import { load } from 'js-yaml';

import {
  curatedDatabaseIntegrationTests,
  derivePrValidationPlan as compilePrValidationPlan,
  errorMonitorDeploymentGuardInputs,
  forbiddenPresentationContractTests,
  infrastructureContractTests,
  referencesWebsiteFromServerTest,
  websiteSourceSpecifiersFromServerTest,
  migrationArtifactContractTests,
  realEnvironmentIntegrationTests,
  reviewOwnershipControlFiles,
  selectedInfrastructureContractTests,
  selectedPrWebsiteContractTests,
  selectedPresentationContractTests,
  serverTestRuntimeManifestSchema,
  specificMigrationArtifactContracts,
  webPresentationContractTests,
} from '../src/prValidationPlan.ts';
import { distributedDatabaseSuites } from '../src/databaseLaneSuites.ts';
import { repositoryScriptSources, scriptConsumers, scriptValidationImpact, workflowOnlyScripts } from '../src/scriptConsumers.ts';
import {
  deriveServerSourceTestImpact, isServerProductSource, serverProcessHeavyTests,
} from '../src/serverSourceTestOwnership.ts';
import { workflowContractTests } from '../src/workflowContractTests.ts';
import { prValidationPolicyTests } from '../src/prValidationPolicyTests.ts';

const runtimeManifest = serverTestRuntimeManifestSchema.parse(JSON.parse(
  readFileSync('ci/contracts/server-test-runtimes.json', 'utf8'),
));
const trustedTestSources = repositoryScriptSources(process.cwd());

function derivePrValidationPlan(input: Parameters<typeof compilePrValidationPlan>[0]) {
  const sourcePaths = [...new Set([...(input.changedFiles ?? []), ...(input.deletedFiles ?? [])]
    .filter(isServerProductSource))];
  if (sourcePaths.length === 0 || input.serverSourceImpact !== undefined) {
    return compilePrValidationPlan(input, runtimeManifest);
  }
  const impact = deriveServerSourceTestImpact(trustedTestSources, trustedTestSources,
    input.changedFiles ?? [], input.deletedFiles ?? [], new Set([
      ...runtimeManifest.tests.map((test) => test.path),
      ...curatedDatabaseIntegrationTests,
    ]));
  return compilePrValidationPlan({
    ...input,
    serverSourceImpact: {
      ownedSources: [...impact.ownedSources],
      affectedUnitTests: [...impact.affectedUnitTests],
      affectedIntegrationTests: [...impact.affectedIntegrationTests],
      totalUnitTests: impact.totalUnitTests,
    },
  }, runtimeManifest);
}

interface WorkflowStep { readonly name?: string; readonly run?: string; readonly env?: Record<string, string> }
const PR_CHECKS = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as {
  jobs: Record<string, { steps?: WorkflowStep[] }>;
};
const SCRIPT_INVOCATION = /^bash (?:scripts\/ci\/lib\/run-step\.sh )?(scripts\/\S+\.sh)$/;

/**
 * The shell a `pr-checks` step runs. The workflow is generated and its longer
 * blocks live in `scripts/ci`, so reading the YAML text alone would look at a
 * one-line script invocation and conclude the suites are not run at all.
 */
function stepShell(jobId: string, stepName: string): string {
  const step = (PR_CHECKS.jobs[jobId]?.steps ?? []).find((candidate) => candidate.name === stepName);
  assert.ok(step?.run, `pr-checks.yml:${jobId} must still have a step "${stepName}" that runs shell`);
  const invoked = SCRIPT_INVOCATION.exec(step.run.trim());
  return invoked?.[1] === undefined ? step.run : readFileSync(invoked[1], 'utf8');
}

describe('derivePrValidationPlan', () => {
  it('keeps presentation-only base updates out of server and database suites', () => {
    const changedFiles = [
      'pages/index.tsx',
      'pages/marketing-og.tsx',
      'src/website/Marketing-x.tsx',
      'ci/src/actions/selectPrLinuxRunners.ts',
    ];
    const plan = derivePrValidationPlan({ changedFiles, metadataOnly: false });
    assert.equal(plan.docsOnly, false);
    assert.equal(plan.serverStaticRequired, true, 'workspace type-check still covers web sources');
    assert.equal(plan.workflowContractsRequired, true, 'CI changes keep their own contracts');
    assert.equal(plan.serverTestMode, 'none', 'server shards only include server/tests');
    assert.equal(plan.processHeavyRequired, false);
    assert.equal(plan.databaseRequired, false);

    const deleted = derivePrValidationPlan({
      changedFiles: ['pages/marketing-og.tsx', 'src/website/Marketing-og.tsx'],
      deletedFiles: ['pages/marketing-og.tsx', 'src/website/Marketing-og.tsx'],
      metadataOnly: false,
    });
    assert.equal(deleted.serverStaticRequired, true, 'type-check catches stale imports');
    assert.equal(deleted.serverTestMode, 'none');
  });

  it('runs the server contracts that import changed or deleted website modules', () => {
    for (const [test, sources] of Object.entries(webPresentationContractTests)) {
      for (const source of sources) {
        for (const deletedFiles of [[], [source]]) {
          const plan = derivePrValidationPlan({
            changedFiles: [source], deletedFiles, metadataOnly: false,
          });
          assert.equal(plan.serverTestMode, 'targeted', source);
          assert.deepEqual(plan.targetedServerTests, [test], source);
          assert.equal(plan.databaseRequired, false, source);
          assert.equal(plan.serverStaticRequired, true, source);
        }
      }
    }
    for (const shared of ['src/website/Footer.tsx', 'src/website/utils/brand.tsx']) {
      assert.deepEqual(selectedPresentationContractTests([shared], []), [
        'server/tests/askExampleDisclosureCopy.test.ts',
        'server/tests/storeKitTermsConsistency.test.ts',
      ], shared);
    }
  });

  it('keeps website test ownership aligned and rejects indirect readers in test helpers', () => {
    const imported = new Map<string, string[]>();
    for (const [path, text] of repositoryScriptSources()) {
      if (!/^server\/tests\/.+\.ts$/.test(path)) continue;
      const specifiers = websiteSourceSpecifiersFromServerTest(text);
      if (!/^server\/tests\/.+\.test\.ts$/.test(path)) {
        assert.deepEqual(specifiers, [],
          `Website readers in ${path} must live in an owned .test.ts suite`);
        continue;
      }
      for (const specifier of specifiers) {
        const module = specifier.startsWith('src/website/') ? posix.normalize(specifier)
          : posix.normalize(posix.join(posix.dirname(path), specifier));
        const base = module.replace(/\.[jt]sx?$/, '');
        const source = [...new Set([
          module, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
          `${base}/index.ts`, `${base}/index.tsx`,
        ])].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
        assert.ok(source, `Website import in ${path} must resolve: ${module}`);
        imported.set(path, [...(imported.get(path) ?? []), source].sort());
      }
    }
    assert.deepEqual([...Object.entries(webPresentationContractTests)].sort(), [...imported].sort());
    for (const test of Object.keys(webPresentationContractTests)) {
      assert.equal(test.endsWith('.integration.test.ts'), false, test);
      assert.equal(serverProcessHeavyTests.has(test), false, test);
      assert.equal(curatedDatabaseIntegrationTests.has(test), false, test);
      assert.equal(realEnvironmentIntegrationTests.has(test), false, test);
      assert.equal(runtimeManifest.tests.some((contract) => contract.path === test), false, test);
    }
    assert.deepEqual(selectedPresentationContractTests(['src/website/Marketing.tsx'], []), []);
  });

  it('routes restoration of the forbidden page-based health handler to its absence contract', () => {
    for (const path of forbiddenPresentationContractTests['server/tests/healthRoute.test.ts']) {
      const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
      assert.equal(plan.serverTestMode, 'targeted');
      assert.deepEqual(plan.targetedServerTests, ['server/tests/healthRoute.test.ts']);
      assert.equal(plan.databaseRequired, false);
      assert.ok(readFileSync('server/tests/healthRoute.test.ts', 'utf8')
        .includes(`existsSync(new URL('${path}', repositoryRoot))`));
    }
  });

  it('runs the website ownership guard when a server test adds a website import', () => {
    const path = 'server/tests/newWebsiteContract.test.ts';
    const ordinary = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
    assert.equal(ordinary.workflowContractsRequired, false);
    const owned = derivePrValidationPlan({
      changedFiles: [path], metadataOnly: false, websiteContractTestChanged: true,
    });
    assert.equal(owned.workflowContractsRequired, true);
    assert.deepEqual(owned.targetedServerTests, [path]);
    assert.equal(referencesWebsiteFromServerTest("import Legal from '../../src/website/legal/PrivacyPolicy';"), true);
    assert.equal(referencesWebsiteFromServerTest("import Legal from '../../../src/website/legal/PrivacyPolicy';"), true);
    assert.equal(referencesWebsiteFromServerTest("const Legal = await import('../../src/website/legal/PrivacyPolicy');"), true);
    assert.equal(referencesWebsiteFromServerTest("const Legal = await vi.importActual('../../src/website/legal/PrivacyPolicy');"), true);
    assert.equal(referencesWebsiteFromServerTest("const Legal = require('../../src/website/legal/PrivacyPolicy');"), true);
    assert.equal(referencesWebsiteFromServerTest("readFileSync(new URL('../../src/website/legal/PrivacyPolicy.tsx', import.meta.url));"), true);
    assert.equal(referencesWebsiteFromServerTest("readFileSync('src/website/legal/PrivacyPolicy.tsx');"), true);
    assert.equal(referencesWebsiteFromServerTest("// import Legal from '../../src/website/legal/PrivacyPolicy';"), false);
    assert.equal(referencesWebsiteFromServerTest("import Service from '../../server/services/account';"), false);
    const sourcePath = websiteSourceSpecifiersFromServerTest(
      "readFileSync(new URL('../../src/website/legal/PrivacyPolicy.tsx', import.meta.url));",
    );
    assert.deepEqual(sourcePath, ['../../src/website/legal/PrivacyPolicy.tsx']);
  });

  it('runs PR-owned website readers when a base update changes their imported module', () => {
    const test = 'server/tests/newWebsiteContract.test.ts';
    const sources = new Map([[test,
      "const Legal = await import('../../src/website/legal/PrivacyPolicy');",
    ]]);
    const selected = selectedPrWebsiteContractTests(
      ['src/website/legal/PrivacyPolicy.tsx'], [], sources,
    );
    assert.deepEqual(selected, [test]);
    const plan = derivePrValidationPlan({
      changedFiles: ['src/website/legal/PrivacyPolicy.tsx', ...selected],
      metadataOnly: false,
      websiteContractTestChanged: true,
    });
    assert.deepEqual(plan.targetedServerTests, [test,
      'server/tests/askExampleDisclosureCopy.test.ts'].sort());
    assert.equal(plan.workflowContractsRequired, true);
    assert.deepEqual(selectedPrWebsiteContractTests(
      ['src/website/hero/modalFocusContainment.ts'], [], sources,
    ), []);
    assert.deepEqual(selectedPrWebsiteContractTests(
      ['src/website/legal/PrivacyPolicy.tsx'], [], new Map([[test,
        "readFileSync(new URL('../../src/website/legal/PrivacyPolicy.tsx', import.meta.url));",
      ]]),
    ), [test], 'file-based website readers own the changed source');
    const websiteSources = new Map([
      ['src/website/legal/PrivacyPolicy.tsx', "import Footer from '../Footer';"],
      ['src/website/Footer.tsx', "import { BRAND } from './utils/newBrand';"],
      ['src/website/utils/newBrand.ts', 'export const BRAND = true;'],
    ]);
    assert.deepEqual(selectedPrWebsiteContractTests(
      ['src/website/utils/newBrand.ts'], [], sources, websiteSources,
    ), [test], 'the exact-head dependency graph includes PR-owned website imports');
    assert.deepEqual(selectedPresentationContractTests(
      ['src/website/utils/newBrand.ts'], [], websiteSources,
    ), ['server/tests/askExampleDisclosureCopy.test.ts']);
  });

  it('preserves conservative routing for API and unclassified shared source', () => {
    for (const path of [
      'pages/api/example.ts', 'pages/api-docs.tsx', 'pages/_app.tsx',
      'pages/auth/sign-in.tsx', 'pages/dashboard.tsx', 'pages/sitemap.xml.ts',
      'src/components/Unknown.tsx',
    ]) {
      const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
      assert.equal(plan.serverTestMode, 'full', path);
      assert.equal(plan.serverStaticRequired, true, path);
    }
    const mixed = derivePrValidationPlan({
      changedFiles: ['src/website/Marketing.tsx', 'server/tests/webRequestSecurity.test.ts'],
      metadataOnly: false,
    });
    assert.equal(mixed.serverTestMode, 'targeted');
    assert.deepEqual(mixed.targetedServerTests, ['server/tests/webRequestSecurity.test.ts']);
  });

  it('routes migration artifacts to static and database validation', () => {
    const migration = [
      'server/db/migrations/0057_confirmed_vehicle_links.sql',
      'server/db/migrations/meta/0057_snapshot.json',
      'server/db/migrations/meta/_journal.json',
    ];
    for (const changedFiles of [
      migration,
      ['server/db/migrations/0057_confirmed_vehicle_links.sql'],
      ['server/db/migrations/meta/0057_snapshot.json'],
    ]) {
      const plan = derivePrValidationPlan({ changedFiles, metadataOnly: false });
      assert.equal(plan.serverTestMode, 'targeted');
      assert.equal(plan.serverStaticRequired, true);
      assert.equal(plan.databaseRequired, true);
      assert.ok(plan.targetedServerTests.includes('server/tests/chatPendingStateMigration.test.ts'));
      assert.ok(plan.targetedServerTests.includes('server/tests/cloudSqlRuntimeFunctions.test.ts'));
      assert.ok(plan.targetedServerTests.includes('server/tests/notificationPlanningStateIndexes.test.ts'));
      assert.ok(plan.targetedServerTests.includes('server/tests/investmentSnapshotCascadeMigration.test.ts'));
      assert.ok(plan.targetedServerTests.includes('server/tests/transactionRuleRetryMigration.test.ts'));
      assert.ok(!plan.targetedServerTests.includes('server/tests/exampleInsightsService.test.ts'));
      assert.ok(!plan.targetedServerTests.includes('server/tests/retiredWellnessStepMigration.test.ts'));
    }

    const historicalBaseline = derivePrValidationPlan({
      changedFiles: ['server/db/migrations/0001_shallow_firebrand.sql'], metadataOnly: false,
    });
    assert.equal(historicalBaseline.serverTestMode, 'targeted');
    assert.ok(historicalBaseline.targetedServerTests.includes('server/tests/exampleInsightsService.test.ts'));
  });

  it('owns every unit suite that reads versioned database migration artifacts', () => {
    const directConsumers = readdirSync('server/tests', { recursive: true })
      .filter((path): path is string => typeof path === 'string'
        && path.endsWith('.test.ts')
        && !path.endsWith('.integration.test.ts'))
      .map((path) => `server/tests/${path}`)
      .filter((path) => readFileSync(path, 'utf8').includes('db/migrations'))
      .sort();
    const ownedConsumers = [
      ...migrationArtifactContractTests,
      ...Object.keys(specificMigrationArtifactContracts),
    ].sort();
    assert.deepEqual(ownedConsumers, directConsumers);
  });

  it('retains application coverage when migration artifacts accompany executable changes', () => {
    const migration = 'server/db/migrations/0057_confirmed_vehicle_links.sql';
    const runtimeChange = derivePrValidationPlan({
      changedFiles: [migration, 'server/services/plaid/plaidService.ts'],
      metadataOnly: false,
    });
    assert.equal(runtimeChange.serverTestMode, 'targeted');
    assert.ok(runtimeChange.targetedServerTests.includes('server/tests/plaidService.aiHooks.test.ts'));
    assert.equal(runtimeChange.serverStaticRequired, true);
    assert.equal(runtimeChange.databaseRequired, true);

    for (const changedFiles of [
      ['server/db/schema/schema.ts'],
      [migration, 'server/db/schema/schema.ts'],
    ]) {
      const plan = derivePrValidationPlan({ changedFiles, metadataOnly: false });
      assert.equal(plan.serverTestMode, 'full', changedFiles.join(', '));
      assert.equal(plan.serverStaticRequired, true);
      assert.equal(plan.databaseRequired, true);
    }

    const migratorChange = derivePrValidationPlan({
      changedFiles: ['server/db/migrate.ts'], metadataOnly: false,
    });
    assert.equal(migratorChange.serverTestMode, 'targeted');
    assert.ok(migratorChange.targetedServerTests.includes('server/tests/plaidSchedulerMigration.test.ts'));
    assert.equal(migratorChange.databaseRequired, true);

    for (const validator of [
      'server/db/schema/wellnessState.ts',
      'server/db/schema/notificationEvaluationState.ts',
    ]) {
      const validatorChange = derivePrValidationPlan({
        changedFiles: [validator], metadataOnly: false,
      });
      assert.equal(validatorChange.serverTestMode, 'full', validator);
      assert.equal(validatorChange.databaseRequired, true, validator);
    }

    assert.throws(() => derivePrValidationPlan({
      changedFiles: [migration], metadataOnly: false, fileStatusAvailable: false,
    }), /Changed-file status is unavailable/);

    const targetedTest = derivePrValidationPlan({
      changedFiles: [migration, 'server/tests/relationshipService.test.ts'],
      metadataOnly: false,
    });
    assert.equal(targetedTest.serverTestMode, 'targeted');
    assert.ok(targetedTest.targetedServerTests.includes('server/tests/relationshipService.test.ts'));
    assert.ok(targetedTest.targetedServerTests.includes('server/tests/chatPendingStateMigration.test.ts'));
    assert.equal(targetedTest.databaseRequired, true);
  });

  it('classifies nested text files by owning directory instead of suffix', () => {
    const iosSelection = derivePrValidationPlan({
      changedFiles: ['ios/ci/ui-test-primary-exclusions.txt'], metadataOnly: false,
    });
    assert.equal(iosSelection.docsOnly, false);
    assert.equal(iosSelection.iosContractsRequired, true);
    assert.equal(iosSelection.serverTestMode, 'none');
    assert.equal(iosSelection.databaseRequired, false);

    const trainingData = derivePrValidationPlan({
      changedFiles: ['server/data/training/phi35/sample.txt'], metadataOnly: false,
    });
    assert.equal(trainingData.docsOnly, false);
    assert.equal(trainingData.serverStaticRequired, true);

    for (const path of ['notes.txt', 'ios/docs/evidence/issue-4750/guardrails.txt',
      'server/docs/prompts-for-optimization.txt']) {
      const documentation = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
      assert.equal(documentation.docsOnly, true, path);
    }
  });

  it('runs the error monitor deployment guard without unrelated server or iOS work', () => {
    for (const path of [
      errorMonitorDeploymentGuardInputs.retiredDeploy,
      errorMonitorDeploymentGuardInputs.manifest,
      errorMonitorDeploymentGuardInputs.retiredTest,
    ]) {
      const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
      assert.equal(plan.workflowContractsRequired, true, path);
      assert.equal(plan.serverTestMode, 'none', path);
      assert.equal(plan.serverStaticRequired, false, path);
      assert.equal(plan.databaseRequired, false, path);
      assert.equal(plan.iosContractsRequired, false, path);
    }
  });

  it('executes mortgage persistence acceptance in the database lane with required credentials', () => {
    const path = 'server/tests/mortgagePlanConfirmation.postgres.integration.test.ts';
    const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
    assert.equal(plan.databaseRequired, true);
    assert.deepEqual(plan.targetedIntegrationTests, [path]);
    assert.deepEqual(plan.targetedServerTests, []);
    const execution = PR_CHECKS.jobs['database-integration']?.steps?.find(
      (step) => step.name === 'Run selected database acceptance tests',
    );
    assert.equal(execution?.env?.MORTGAGE_PLAN_TEST_DATABASE_URL, '${{ env.DATABASE_URL }}');
    assert.equal(execution?.env?.REQUIRE_MORTGAGE_PLAN_POSTGRES_TESTS, '1');
  });

  it('runs dashboard generator contracts when their generator, regression suite, or schemas change', () => {
    for (const changedFile of [
      'scripts/generate-api-types.js',
      'ci/tests/dashboardManualAccountGeneration.test.ts',
      'server/routes/dashboard.yaml',
      'server/swagger/userProfile.yaml',
    ]) {
      const plan = derivePrValidationPlan({ changedFiles: [changedFile], metadataOnly: false });
      assert.equal(plan.iosContractsRequired, true, changedFile);
    }
    assert.match(
      stepShell('ios-contracts', 'Test dashboard manual account generation'),
      /^node --test ci\/tests\/dashboardManualAccountGeneration\.test\.ts$/,
    );
  });

  it('validates generated type files when a generator input or generated file changes', () => {
    for (const changedFile of [
      'server/routes/dashboard.yaml',
      'server/swagger/userProfile.yaml',
      'server/routes/chatAdmin.yaml',
      'scripts/generate-api-types.js',
      'scripts/generate-all-types.js',
      'server/scripts/generate-budget-category-types.ts',
      'server/scripts/validate-generated-types.ts',
      'server/generated/openapi.json',
      'src/types/dashboardTypes.generated.ts',
      'ios/example-ios/Models/Generated/UsersTypes.generated.swift',
    ]) {
      const plan = derivePrValidationPlan({ changedFiles: [changedFile], metadataOnly: false });
      assert.equal(plan.serverStaticRequired, true, changedFile);
    }
    for (const changedFile of [
      'ios/example-ios/Models/Generated/BudgetCategoryEnumsCompat.swift',
      'ci/generated/cloudbuild/testflight-feedback.yaml',
    ]) {
      const plan = derivePrValidationPlan({ changedFiles: [changedFile], metadataOnly: false });
      assert.equal(plan.serverStaticRequired, false, changedFile);
    }
    assert.equal(stepShell('server-static', 'Validate generated type files'), 'npm run validate:generated-types');
  });

  it('keeps the iOS impact selector out of the full server suite', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['scripts/select-ios-affected-tests.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.iosContractsRequired, false);
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, [
      'server/tests/gcpPlatformMigration.contract.test.ts',
    ]);
    assert.equal(plan.databaseRequired, false);
  });

  it('reuses prior evidence for a verified metadata-only target update', () => {
    const plan = derivePrValidationPlan({ changedFiles: [], metadataOnly: true });
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.policyRequired, false);
    assert.equal(plan.databaseRequired, false);
  });

  it('routes a CI-only change to workflow contracts without server tests', () => {
    const plan = derivePrValidationPlan({
      changedFiles: [
        '.github/workflows/cancel-blocked-pr-ci.yml',
        'ci/src/prValidationPlan.ts',
        'ci/src/actions/selectPrLinuxRunners.ts',
        'ci/tests/prLinuxRunnerSelection.test.ts',
      ],
      metadataOnly: false,
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.databaseRequired, false);
  });

  it('routes hook changes to workflow contracts without product validation', () => {
    for (const changedFiles of [
      ['.husky/pre-commit'],
      ['.husky/pre-commit', 'ci/tests/preCommit.test.ts'],
      ['.husky/new-hook'],
    ]) {
      const plan = derivePrValidationPlan({ changedFiles, metadataOnly: false });
      assert.equal(plan.workflowContractsRequired, true, changedFiles.join(', '));
      assert.equal(plan.serverStaticRequired, false);
      assert.equal(plan.serverTestMode, 'none');
      assert.deepEqual(plan.targetedServerTests, []);
      assert.deepEqual(plan.targetedIntegrationTests, []);
      assert.equal(plan.databaseRequired, false);
      assert.equal(plan.iosContractsRequired, false);
    }
  });

  it('routes promotion checkpoint transaction coverage to workflow contracts alone', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['ci/tests/stagingPromotion.test.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.databaseRequired, false);
  });

  it('keeps debt policy tests in their owning lane without broad server validation', () => {
    for (const path of prValidationPolicyTests) {
      assert.equal(existsSync(path), true, `${path} must exist for policy execution`);
      const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
      assert.equal(plan.policyRequired, true, path);
      assert.equal(plan.workflowContractsRequired, true, path);
      assert.equal(plan.serverStaticRequired, false, path);
      assert.equal(plan.serverTestMode, 'none', path);
      assert.equal(plan.databaseRequired, false, path);
    }
  });

  it('keeps the #5905 debt CI migration out of application test lanes', () => {
    const plan = derivePrValidationPlan({
      changedFiles: [
        'ci/contracts/typing-coverage-floor.json',
        'ci/src/actions/debt/runDebtProjectionPreflight.ts',
        'ci/src/actions/debt/validateDebtProjectionTickets.ts',
        'scripts/ci/pr-checks/validation-policy/validate-debt-dependency-preflight.sh',
        ...prValidationPolicyTests,
        'server/docs/audits/DEBT-PROJECTION-TICKET-IMPLEMENTATION-CONTRACT-2026-08-27.md',
      ],
      metadataOnly: false,
    });
    assert.equal(plan.policyRequired, true);
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.databaseRequired, false);
    assert.deepEqual(plan.targetedServerTests, []);
    assert.deepEqual(plan.targetedIntegrationTests, []);
  });

  it('routes the typed debt preflight cutover to policy, workflow, and the owning server contract', () => {
    const legacyWrapper = 'scripts/ci/pr-checks/validation-policy/validate-debt-dependency-preflight.sh';
    const plan = derivePrValidationPlan({
      changedFiles: [
        'ci/src/actions/debt/runDebtDependencyPreflight.ts',
        '.github/actions/typed-step-runner/action.yml',
        '.github/workflows/pr-checks.yml',
      ],
      deletedFiles: [legacyWrapper],
      metadataOnly: false,
      scriptImpact: { ciOnlyScripts: [legacyWrapper], affectedServerTests: [] },
    });
    assert.equal(plan.policyRequired, true);
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, ['server/tests/plaidSchedulerMigration.test.ts']);
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.databaseRequired, false);
  });

  it('owns tooling tests by directory while unknown scripts and mixed runtime changes remain conservative', () => {
    for (const path of [
      'scripts/tests/unowned.test.mjs',
      'scripts/tests/ios-ci-image_test.py',
    ]) {
      for (const deletedFiles of [[], [path]]) {
        const plan = derivePrValidationPlan({ changedFiles: [path], deletedFiles, metadataOnly: false });
        assert.equal(plan.workflowContractsRequired, true, path);
        assert.equal(plan.serverTestMode, 'none', path);
        assert.equal(plan.serverStaticRequired, false, path);
        assert.equal(plan.databaseRequired, false, path);
      }
    }
    for (const changedFiles of [
      ['scripts/unowned.mjs'],
      [...prValidationPolicyTests, 'server/services/plaid/plaidService.ts'],
    ]) {
      const plan = derivePrValidationPlan({ changedFiles, metadataOnly: false });
      assert.ok(['full', 'targeted'].includes(plan.serverTestMode));
      assert.equal(plan.serverStaticRequired, true);
    }
    const mixed = derivePrValidationPlan({
      changedFiles: [...prValidationPolicyTests, 'server/persistence/repositories/actionItemsRepository.ts'],
      metadataOnly: false,
    });
    assert.equal(mixed.databaseRequired, true);
  });

  it('routes the typed promotion transaction and its removed shell adapters only to workflow contracts', () => {
    const deleted = [
      'scripts/ci/promotion-checkpoint/checkpoint/create-immutable-checkpoint-pull-request.sh',
      'scripts/ci/promotion-checkpoint/checkpoint/summarize-promotion-checkpoint.sh',
      'scripts/ci/promotion-checkpoint/checkpoint/validate-promotion-automation-configuration.sh',
    ];
    const plan = derivePrValidationPlan({
      changedFiles: [
        '.github/workflows/promotion-checkpoint.yml',
        'ci/src/promotion/checkpointApi.ts',
        'ci/src/promotion/checkpointTransaction.ts',
        'ci/src/workflowContractTests.ts',
        'ci/tests/stagingPromotion.test.ts',
        ...deleted,
      ],
      deletedFiles: deleted,
      metadataOnly: false,
      scriptImpact: { ciOnlyScripts: [], affectedServerTests: [] },
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.databaseRequired, false);
  });

  it('discovers relative controller helpers without widening to application tests', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['ci/src/ios/baseUpdateDelta.ts'],
      scriptImpact: { ciOnlyScripts: workflowOnlyScripts(scriptConsumers()), affectedServerTests: [] },
      metadataOnly: false,
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.databaseRequired, false);
    assert.equal(plan.serverStaticRequired, false);
  });

  it('routes newly generated scripts/ci programs without relying on the trusted base inventory', () => {
    // The planner executes from the trusted base checkout. A script first
    // introduced by the PR therefore cannot be discovered by
    // `scriptConsumers(base)`, even though its generated location proves that
    // it belongs to the workflow control plane. The path contract must be
    // sufficient on its own and must not depend on an exact-head checkout.
    for (const changedFile of [
      'scripts/ci/generated/new-workflow-projection.mjs',
      'scripts/ci/pr-checks/plan-pr-validation/new-typed-step.sh',
    ]) {
      const plan = derivePrValidationPlan({
        changedFiles: [changedFile],
        metadataOnly: false,
        scriptImpact: { ciOnlyScripts: [], affectedServerTests: [] },
      });
      assert.equal(plan.workflowContractsRequired, true, changedFile);
      assert.equal(plan.serverStaticRequired, false, changedFile);
      assert.equal(plan.serverTestMode, 'none', changedFile);
      assert.deepEqual(plan.targetedServerTests, [], changedFile);
      assert.deepEqual(plan.targetedIntegrationTests, [], changedFile);
      assert.equal(plan.databaseRequired, false, changedFile);
      assert.equal(plan.iosContractsRequired, false, changedFile);
    }
  });

  it('keeps unknown top-level scripts fail-closed while known controllers stay CI-only', () => {
    const knownController = derivePrValidationPlan({
      changedFiles: ['scripts/cancel-blocked-pr-ci.mjs'],
      metadataOnly: false,
      scriptImpact: { ciOnlyScripts: [], affectedServerTests: [] },
    });
    assert.equal(knownController.workflowContractsRequired, true);
    assert.equal(knownController.serverStaticRequired, false);
    assert.equal(knownController.serverTestMode, 'none');
    assert.equal(knownController.databaseRequired, false);

    const unknown = derivePrValidationPlan({
      changedFiles: ['scripts/new-unclassified-runtime.mjs'],
      metadataOnly: false,
      scriptImpact: { ciOnlyScripts: [], affectedServerTests: [] },
    });
    assert.equal(unknown.workflowContractsRequired, true);
    assert.equal(unknown.serverStaticRequired, true);
    assert.equal(unknown.serverTestMode, 'full');
    assert.equal(unknown.databaseRequired, true);
  });

  it('keeps the health-route contract with its error-boundary checker', () => {
    for (const path of ['scripts/check-error-envelope-boundary.mjs', 'scripts/check-error-envelope-boundary.ts']) {
      const plan = derivePrValidationPlan({
        changedFiles: [path],
        metadataOnly: false,
        scriptImpact: { ciOnlyScripts: [], affectedServerTests: [] },
      });
      assert.equal(plan.serverStaticRequired, true);
      assert.equal(plan.serverTestMode, 'targeted');
      assert.deepEqual(plan.targetedServerTests, ['server/tests/healthRoute.test.ts']);
      assert.equal(plan.databaseRequired, false);
    }
  });

  it('routes tracked validation programs to only their owned test and acceptance lanes', () => {
    const changedFiles = [
      'scripts/check-error-envelope-boundary.mjs',
      'ci/src/actions/runEntitlementRepositoryTests.ts',
      'scripts/source-text.mjs',
      'scripts/ios-workflow-native-selection.mjs',
      'scripts/ios-workflow-native-selection.ts',
      'scripts/swift-test-impact.mjs',
      'scripts/swift-test-impact.ts',
      'ci/tests/iosAffectedEvidenceSelection.test.ts',
      'server/tests/helpers/sourceText.ts',
    ];
    const plan = derivePrValidationPlan({
      changedFiles,
      metadataOnly: false,
      packageManifestRuntimeNeutral: true,
      scriptImpact: scriptValidationImpact(scriptConsumers(), changedFiles),
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverStaticRequired, true);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, [
      'server/tests/containerSecurity.test.ts',
      'server/tests/gcpPlatformMigration.contract.test.ts',
      'server/tests/healthRoute.test.ts',
      'server/tests/monitoringContract.test.ts',
    ]);
    assert.equal(plan.databaseRequired, true);
    assert.equal(plan.entitlementAcceptanceRequired, true);
    assert.equal(plan.iosContractsRequired, false);
    const sourceTextConsumers = plan.targetedServerTests.filter(
      path => path !== 'server/tests/gcpPlatformMigration.contract.test.ts',
    );
    for (const testPath of sourceTextConsumers) {
      assert.match(readFileSync(testPath, 'utf8'), /['"]\.\/helpers\/sourceText['"]/, testPath);
    }
    const actualConsumers = readdirSync('server/tests', { recursive: true })
      .filter((path): path is string => typeof path === 'string' && path.endsWith('.test.ts'))
      .map((path) => `server/tests/${path}`)
      .filter((path) => /['"][./]*helpers\/sourceText['"]/.test(readFileSync(path, 'utf8')))
      .sort();
    assert.deepEqual(sourceTextConsumers, actualConsumers);
    assert.ok(workflowContractTests.includes('ci/tests/iosAffectedEvidenceSelection.test.ts'));
  });

  it('keeps the typed validation-program migration out of full server shards', () => {
    const changedFiles = [
      'package.json',
      'scripts/check-error-envelope-boundary.ts',
      'ci/src/actions/runEntitlementRepositoryTests.ts',
      'scripts/source-text.ts',
      'server/tests/healthRoute.test.ts',
      'server/tests/helpers/sourceText.ts',
    ];
    const plan = derivePrValidationPlan({
      changedFiles,
      metadataOnly: false,
      packageManifestRuntimeNeutral: true,
      scriptImpact: scriptValidationImpact(scriptConsumers(), changedFiles),
    });
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, [
      'server/tests/containerSecurity.test.ts',
      'server/tests/gcpPlatformMigration.contract.test.ts',
      'server/tests/healthRoute.test.ts',
      'server/tests/monitoringContract.test.ts',
    ]);
    assert.equal(plan.entitlementAcceptanceRequired, true);
  });

  it('keeps tracked iOS selection helpers in workflow contracts only', () => {
    for (const changedFile of [
      'scripts/ios-workflow-native-selection.mjs',
      'scripts/swift-test-impact.mjs',
    ]) {
      const plan = derivePrValidationPlan({ changedFiles: [changedFile], metadataOnly: false });
      assert.equal(plan.iosContractsRequired, false, changedFile);
      assert.equal(plan.serverTestMode, 'none', changedFile);
    }
  });

  it('does not narrow unknown package tooling or silently omit entitlement acceptance', () => {
    const unknown = derivePrValidationPlan({
      changedFiles: ['scripts/new-package-validation.ts'], metadataOnly: false,
      scriptImpact: { ciOnlyScripts: [], affectedServerTests: [] },
    });
    assert.equal(unknown.serverTestMode, 'full');
    const entitlement = derivePrValidationPlan({
      changedFiles: ['ci/src/actions/runEntitlementRepositoryTests.ts'], metadataOnly: false,
      scriptImpact: { ciOnlyScripts: [], affectedServerTests: [] },
    });
    assert.equal(entitlement.serverTestMode, 'none');
    assert.equal(entitlement.databaseRequired, true);
    assert.equal(entitlement.entitlementAcceptanceRequired, true);
    const npmAlias = derivePrValidationPlan({
      changedFiles: ['package.json'], metadataOnly: false,
      packageManifestRuntimeNeutral: true,
      entitlementAcceptanceScriptChanged: true,
    });
    assert.equal(npmAlias.serverTestMode, 'targeted');
    assert.deepEqual(npmAlias.targetedServerTests, ['server/tests/gcpPlatformMigration.contract.test.ts']);
    assert.equal(npmAlias.databaseRequired, true);
    assert.equal(npmAlias.entitlementAcceptanceRequired, true);
    // packageManifestLaneImpact's classification of a base-delta manifest change.
    const baseDeltaManifest = derivePrValidationPlan({
      changedFiles: ['package.json'], metadataOnly: false,
      packageManifestRuntimeNeutral: false,
      entitlementAcceptanceScriptChanged: true,
    });
    assert.equal(baseDeltaManifest.serverTestMode, 'full');
    assert.equal(baseDeltaManifest.databaseRequired, true);
    assert.equal(baseDeltaManifest.entitlementAcceptanceRequired, true);
  });

  it('keeps the #5872 CI-only delta out of broad server and database validation', () => {
    // This is the representative changed/deleted mix that exposed the bug.
    // The trusted-base consumer index can identify the old top-level
    // controller, but cannot possibly contain the newly generated scripts/ci
    // program. A deleted contract test is absent from the current execution
    // inventory as well. Every path is still owned by the CI control plane.
    const plan = derivePrValidationPlan({
      changedFiles: [
        '.github/workflows/cancel-blocked-pr-ci.yml',
        '.github/workflows/ios-tests.yml',
        '.github/workflows/pr-checks.yml',
        '.github/workflows/refresh-pr-ci-after-base-edit.yml',
        'ci/src/actions/ios/cancelPriorBaseRuns.ts',
        'ci/tests/cancelPriorBaseRuns.test.ts',
        'ci/workflows/refresh-pr-ci-after-base-edit.ts',
        'scripts/cancel-blocked-pr-ci.mjs',
        'scripts/ci/generated/workflow-names.ts',
        'scripts/ci/pr-checks/validate/require-every-selected-validation-lane.sh',
        'scripts/ci/refresh-pr-ci-after-base-edit/confirm-capture/confirm-one-successful-dependabot-base-edit-capture.sh',
        'scripts/refresh-pr-ci-after-base-edit.mjs',
        'scripts/stop-onboarding-dev-backend.sh',
      ],
      deletedFiles: [
        'scripts/ci/refresh-pr-ci-after-base-edit/confirm-capture/confirm-one-successful-dependabot-base-edit-capture.sh',
        'scripts/refresh-pr-ci-after-base-edit.mjs',
      ],
      metadataOnly: false,
      // What the trusted base can know. The generated head-only script is
      // intentionally absent.
      scriptImpact: { ciOnlyScripts: ['scripts/refresh-pr-ci-after-base-edit.mjs'], affectedServerTests: [] },
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, [
      'server/tests/plaidSchedulerMigration.test.ts',
    ]);
    assert.deepEqual(plan.targetedIntegrationTests, []);
    assert.equal(plan.databaseRequired, false);
    assert.equal(plan.iosContractsRequired, false);
  });

  it('routes every workflow-contract suite through its owning lane only', () => {
    assert.ok(workflowContractTests.includes('ci/tests/chatPlaidLane.test.ts'));
    for (const path of workflowContractTests) {
      assert.equal(existsSync(path), true, `${path} must exist before the executor can invoke it`);
      const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
      assert.equal(plan.workflowContractsRequired, true, path);
      assert.equal(plan.serverStaticRequired, false, path);
      assert.equal(plan.serverTestMode, 'none', path);
      assert.equal(plan.databaseRequired, false, path);
    }
  });

  it('keeps the Chat/Plaid validator migration off unrelated full server shards', () => {
    const plan = derivePrValidationPlan({
      changedFiles: [
        'ci/src/actions/ios/validateChatPlaidE2eLog.ts',
        'ci/tests/chatPlaidLane.test.ts',
        'scripts/ios-test-income-e2e.sh',
      ],
      deletedFiles: ['scripts/validate-chat-plaid-e2e-log.mjs'],
      metadataOnly: false,
      scriptImpact: {
        ciOnlyScripts: [
          'scripts/validate-chat-plaid-e2e-log.mjs',
          'scripts/ios-test-income-e2e.sh',
        ],
        affectedServerTests: ['server/tests/gcpPlatformMigration.contract.test.ts'],
      },
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, ['server/tests/gcpPlatformMigration.contract.test.ts']);
    assert.equal(plan.databaseRequired, false);
  });

  it('routes the Income iOS E2E harness to its owning lanes without server shards', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['scripts/ios-test-income-e2e.sh'],
      metadataOnly: false,
    });
    assert.equal(plan.iosContractsRequired, false);
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.databaseRequired, false);
  });

  it('routes review-ownership control files to workflow contracts without server validation', () => {
    // `ci/tests/reviewOwnership.test.ts` asserts that no CODEOWNERS file exists
    // in any of the three locations GitHub reads and that the decision stays
    // stated in the security document. It runs only inside `Workflow contracts`,
    // so each of those paths has to route there on its own — a pull request that
    // adds root `CODEOWNERS` and nothing else previously skipped the job that
    // would have caught it. They must also stay out of server validation: none
    // of them describe server behaviour, and classifying them as ordinary source
    // would spin up the full suite and a database for a one-line change.
    //
    // Iterated off the routed set itself rather than a second copy of it: a
    // path added to `reviewOwnershipControlFiles` is pinned here on every shape
    // and every flag without anyone remembering to extend a literal list.
    assert.ok(reviewOwnershipControlFiles.size > 0, 'the routed set must not be empty');
    for (const guardedPath of reviewOwnershipControlFiles) {
      // A rename reports only its new path as changed and its previous path as
      // deleted, so routing on the changed list alone lets a pull request move
      // the security document out from under the guard that records why it is
      // there. Without file status the planner cannot identify deletions, but
      // these paths still select no server work, so they must not escalate.
      const shapes: [string, Parameters<typeof derivePrValidationPlan>[0]][] = [
        ['changed', { changedFiles: [guardedPath], metadataOnly: false }],
        ['renamed away', { changedFiles: ['docs/moved.md'], deletedFiles: [guardedPath], metadataOnly: false }],
        ['deleted', { changedFiles: [guardedPath], deletedFiles: [guardedPath], metadataOnly: false }],
        ['no file status', { changedFiles: [guardedPath], fileStatusAvailable: false, metadataOnly: false }],
      ];

      for (const [shape, input] of shapes) {
        const plan = derivePrValidationPlan(input);
        const because = `${guardedPath} (${shape})`;
        assert.equal(plan.workflowContractsRequired, true, because);
        assert.equal(plan.docsOnly, false, because);
        assert.equal(plan.serverStaticRequired, false, because);
        assert.equal(plan.serverTestMode, 'none', because);
        assert.equal(plan.databaseRequired, false, because);
        assert.equal(plan.iosContractsRequired, false, because);
      }
    }
  });

  it('rejects an unrelated change that lacks file status', () => {
    assert.throws(() => derivePrValidationPlan({
      changedFiles: ['ci/src/prValidationPlan.ts'],
      fileStatusAvailable: false,
      metadataOnly: false,
    }), /Changed-file status is unavailable/);
  });

  it('routes iOS CI control changes without unrelated server-to-iOS payload tests', () => {
    for (const changedFile of [
      '.github/workflows/ios-tests.yml',
      'ci/src/actions/cancelObsoleteIosRuns.ts',
      'scripts/reclaim-ios-runner-disk.sh',
      'ci/src/actions/resumeRetainedIosPredecessor.ts',
      'scripts/run-ios-ci-main-tests.sh',
    ]) {
      const plan = derivePrValidationPlan({
        changedFiles: [changedFile],
        metadataOnly: false,
      });
      assert.equal(plan.workflowContractsRequired, true, changedFile);
      assert.equal(plan.iosContractsRequired, false, changedFile);
      assert.equal(plan.serverStaticRequired, false, changedFile);
      // A generated workflow change is validated by workflow contracts;
      // unrelated server tests must not enter the runner queue.
      const infrastructureTests = selectedInfrastructureContractTests([changedFile], []);
      assert.equal(plan.serverTestMode, infrastructureTests.length > 0 ? 'targeted' : 'none', changedFile);
      assert.deepEqual(plan.targetedServerTests, infrastructureTests, changedFile);
      assert.deepEqual(plan.targetedIntegrationTests, [], changedFile);
      assert.equal(plan.databaseRequired, false, changedFile);
    }
  });

  it('runs migrated typed selector contracts only in the workflow-contract lane', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['ci/tests/iosAffectedEvidenceSelection.test.ts',
        'ci/src/workflowContractTests.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.databaseRequired, false);
    assert.deepEqual(plan.targetedServerTests, []);
  });

  it('runs the server contract test that reads an infrastructure file the change touches', () => {
    // Only contracts whose inputs were touched need the server test lane.
    const targetedCases: Array<[string, string[]]> = [
      ['.github/workflows/pr-checks.yml', ['server/tests/plaidSchedulerMigration.test.ts']],
      ['docs/private-profile-media-migration.md', ['server/tests/privateProfileMediaInfrastructure.test.ts']],
    ];
    for (const [changedFile, expected] of targetedCases) {
      const plan = derivePrValidationPlan({ changedFiles: [changedFile], metadataOnly: false });
      assert.equal(plan.serverTestMode, 'targeted', changedFile);
      assert.deepEqual(plan.targetedServerTests, expected, changedFile);
      assert.equal(plan.docsOnly, false, changedFile);
    }
    for (const changedFile of ['terraform/platform/main.tf', 'terraform/monitoring/main.tf']) {
      const plan = derivePrValidationPlan({ changedFiles: [changedFile], metadataOnly: false });
      assert.equal(plan.serverTestMode, 'targeted', changedFile);
      assert.deepEqual(plan.targetedServerTests, selectedInfrastructureContractTests([changedFile], []), changedFile);
      assert.equal(plan.workflowContractsRequired, true, changedFile);
      assert.equal(plan.serverStaticRequired, false, changedFile);
      assert.equal(plan.databaseRequired, false, changedFile);
    }
    const generatedTriggerInput = derivePrValidationPlan({
      changedFiles: ['terraform/platform/generated-cloud-build-ignored-files.json'],
      metadataOnly: false,
    });
    assert.equal(generatedTriggerInput.workflowContractsRequired, true);
    assert.equal(generatedTriggerInput.serverTestMode, 'none');
    assert.equal(generatedTriggerInput.databaseRequired, false);
    const unknownTerraformInput = derivePrValidationPlan({
      changedFiles: ['terraform/platform/new-runtime-resource.tf'],
      metadataOnly: false,
    });
    assert.equal(unknownTerraformInput.serverTestMode, 'full');
    assert.equal(unknownTerraformInput.databaseRequired, true);
    for (const changedFile of ['cloudbuild.yaml', 'cloudbuild-prod.yaml', 'cloudbuild-plaid-sync.yaml']) {
      const plan = derivePrValidationPlan({ changedFiles: [changedFile], metadataOnly: false });
      assert.equal(plan.workflowContractsRequired, true, changedFile);
      assert.equal(plan.serverStaticRequired, false, changedFile);
      assert.equal(plan.serverTestMode, 'targeted', changedFile);
      assert.deepEqual(plan.targetedServerTests,
        selectedInfrastructureContractTests([changedFile], []), changedFile);
      assert.equal(plan.databaseRequired, false, changedFile);
    }
    for (const input of [
      { changedFiles: ['ci/generated/cloudbuild/testflight-feedback.yaml'] },
      { changedFiles: ['ci/generated/cloudbuild/testflight-feedback.yaml'], deletedFiles: ['ci/generated/cloudbuild/testflight-feedback.yaml'] },
      { changedFiles: ['ci/generated/cloudbuild/future-lane.yaml'] },
      { changedFiles: ['scripts/deploy-testflight-feedback-scheduler.sh'] },
      { changedFiles: [
        'ci/cloudbuild/testflightFeedback.ts',
        'ci/cloudbuild/lib/emit.ts',
        'ci/cloudbuild/lib/types.ts',
        'ci/scripts/cloudbuild.ts',
        'ci/tests/cloudBuild.test.ts',
        'ci/generated/cloudbuild/testflight-feedback.yaml',
        'scripts/deploy-testflight-feedback-scheduler.sh',
      ] },
    ]) {
      const plan = derivePrValidationPlan({ ...input, metadataOnly: false,
        fileStatusAvailable: true });
      assert.equal(plan.workflowContractsRequired, true);
      assert.equal(plan.serverTestMode, 'none');
      assert.equal(plan.serverStaticRequired, false);
      assert.equal(plan.databaseRequired, false);
      assert.equal(plan.iosContractsRequired, false);
    }
    const unrelatedRootYaml = derivePrValidationPlan({
      changedFiles: ['unclassified-runtime.yaml'], metadataOnly: false,
    });
    assert.equal(unrelatedRootYaml.serverTestMode, 'full');
    assert.equal(unrelatedRootYaml.databaseRequired, true);
    const deleted = derivePrValidationPlan({
      changedFiles: ['terraform/monitoring/main.tf', 'server/tests/monitoringContract.test.ts'],
      deletedFiles: ['server/tests/monitoringContract.test.ts'],
      metadataOnly: false,
      fileStatusAvailable: true,
    });
    assert.deepEqual(deleted.targetedServerTests, [], 'a deleted contract test is not scheduled');
  });

  it('selects the scheduler contract for a workflow-only edit or removal', () => {
    const schedulerContract = 'server/tests/plaidSchedulerMigration.test.ts';
    // Iterating only registered contracts would silently pass if this entry disappeared.
    assert.deepEqual(infrastructureContractTests[schedulerContract], [
      '.github/workflows/pr-checks.yml',
      'cloudbuild-plaid-sync.yaml',
      'cloudbuild-prod.yaml',
      'cloudbuild.yaml',
    ]);
    for (const input of [
      { changedFiles: ['.github/workflows/pr-checks.yml', 'ci/workflows/pr-checks.ts'] },
      { changedFiles: ['ci/workflows/pr-checks.ts'], deletedFiles: ['.github/workflows/pr-checks.yml'] },
    ]) {
      const plan = derivePrValidationPlan({ ...input, metadataOnly: false, fileStatusAvailable: true });
      assert.equal(plan.serverTestMode, 'targeted');
      assert.deepEqual(plan.targetedServerTests, [schedulerContract]);
      assert.equal(plan.workflowContractsRequired, true);
      assert.equal(plan.serverStaticRequired, false);
      assert.equal(plan.databaseRequired, false);
    }
    for (const pipeline of ['cloudbuild-plaid-sync.yaml', 'cloudbuild-prod.yaml', 'cloudbuild.yaml']) {
      assert.ok(selectedInfrastructureContractTests([pipeline], []).includes(schedulerContract));
      assert.ok(selectedInfrastructureContractTests([], [pipeline]).includes(schedulerContract));
    }
  });

  it('keeps observability credential workflow contracts on the CI lane', () => {
    for (const path of [
      '.github/workflows/ios-tests.yml',
      'ci/workflows/ios-tests/sync-observability-github-token.ts',
      'ci/src/actions/ios/syncObservabilityCredential.ts',
      'ci/src/ios/observabilityCredentialSync.ts',
      'ci/tests/observabilityCredentialSync.test.ts',
    ]) {
      const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
      assert.equal(plan.workflowContractsRequired, true, path);
      assert.equal(plan.serverTestMode, 'none', path);
      assert.deepEqual(plan.targetedServerTests, [], path);
    }
  });

  it('keeps a typed Cloud Build ownership migration out of full server and database lanes', () => {
    const deletedFiles = [
      'scripts/select-newer-cloud-build.py',
      'ci/tests/stagingPromotion.test.ts',
    ];
    const plan = derivePrValidationPlan({
      changedFiles: [
        'ci/cloudbuild/develop.ts',
        'ci/cloudbuild/runtime/stagingPromotion.ts',
        'cloudbuild.yaml',
        'server/tests/observabilityDeploymentSecrets.contract.test.ts',
        ...deletedFiles,
      ],
      deletedFiles,
      metadataOnly: false,
      fileStatusAvailable: true,
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverStaticRequired, true);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, selectedInfrastructureContractTests(['cloudbuild.yaml'], [])
      .concat('server/tests/observabilityDeploymentSecrets.contract.test.ts')
      .filter((value, index, all) => all.indexOf(value) === index).sort());
    assert.equal(plan.databaseRequired, false);
  });

  it('routes the Plaid drift harness to its owning contract test', () => {
    const changedFiles = [
      '.github/workflows/pr-checks.yml',
      'ci/src/actions/provePlaidSchedulerSchemaDrift.ts',
      'ci/src/plaidSchedulerSchemaDrift.ts',
      'server/tests/plaidSchedulerMigration.test.ts',
      'server/tests/utils/plaidSchedulerDriftHarness.ts',
      'scripts/ci/pr-checks/database-integration/prove-plaid-scheduler-verifier-rejects-schema-drift.sh',
    ];
    const plan = derivePrValidationPlan({
      changedFiles,
      deletedFiles: [
        'scripts/ci/pr-checks/database-integration/prove-plaid-scheduler-verifier-rejects-schema-drift.sh',
      ],
      metadataOnly: false,
      fileStatusAvailable: true,
      scriptImpact: scriptValidationImpact(scriptConsumers(), changedFiles),
    });
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, ['server/tests/plaidSchedulerMigration.test.ts']);
    assert.equal(plan.databaseRequired, false);
    assert.equal(plan.serverStaticRequired, true);
    assert.equal(plan.workflowContractsRequired, true);
  });

  it('type-checks a changed TypeScript test helper and targets its owning test', () => {
    const changedFiles = ['server/tests/utils/plaidSchedulerDriftHarness.ts'];
    const plan = derivePrValidationPlan({
      changedFiles,
      metadataOnly: false,
      fileStatusAvailable: true,
      scriptImpact: scriptValidationImpact(scriptConsumers(), changedFiles),
    });
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, ['server/tests/plaidSchedulerMigration.test.ts']);
    assert.equal(plan.serverStaticRequired, true);
    assert.equal(plan.workflowContractsRequired, false);
    assert.equal(plan.databaseRequired, false);
  });

  it('pins exactly the infrastructure files each contract test reads', () => {
    const readPattern = /(?:source|readFileSync|readdirSync|existsSync)\((?:resolve|join)?\(?[^'")]*?'([^']+)'\)/g;
    for (const [testPath, pinned] of Object.entries(infrastructureContractTests)) {
      const source = readFileSync(testPath, 'utf8');
      const readOutsideServer = [...new Set(
        [...source.matchAll(readPattern)].map((match) => match[1] ?? '')
          .filter((path) => path.length > 0 && path !== 'utf8'
            && !path.startsWith('server/') && !path.startsWith('./') && !path.startsWith('../') && !path.startsWith('/')),
      )].sort();
      assert.deepEqual([...pinned].sort(), readOutsideServer, testPath);
    }
  });

  it('routes dependency manifests through bundle contract validation', () => {
    for (const changedFile of ['package.json', 'package-lock.json']) {
      const plan = derivePrValidationPlan({
        changedFiles: [changedFile],
        metadataOnly: false,
      });
      assert.equal(plan.workflowContractsRequired, true);
      assert.equal(plan.serverTestMode, 'full');
      assert.equal(plan.serverStaticRequired, true);
    }
  });

  it('the typed installer cutover beside the PR workflow adds no server work beyond its contract', () => {
    const plan = derivePrValidationPlan({
      changedFiles: [
        'scripts/install-node-dependencies.sh',
        'ci/src/actions/installNodeDependencies.ts',
        '.github/workflows/pr-checks.yml',
      ],
      deletedFiles: ['scripts/install-node-dependencies.sh'],
      metadataOnly: false,
      scriptImpact: { ciOnlyScripts: ['scripts/install-node-dependencies.sh'], affectedServerTests: [] },
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, ['server/tests/plaidSchedulerMigration.test.ts']);
    assert.equal(plan.serverStaticRequired, false);
    const typedOnly = derivePrValidationPlan({
      changedFiles: ['ci/src/actions/installNodeDependencies.ts'],
      metadataOnly: false,
    });
    assert.equal(typedOnly.workflowContractsRequired, true);
    assert.equal(typedOnly.serverTestMode, 'none');
    const unknown = derivePrValidationPlan({
      changedFiles: ['scripts/install-node-dependencies.sh'],
      metadataOnly: false,
    });
    assert.equal(unknown.serverTestMode, 'full', 'without the consumer index a script keeps full routing');
  });

  it('a runtime-neutral package.json change runs only contracts that inspect its contents', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['package.json', '.github/workflows/pr-checks.yml', 'ci/src/prValidationPlan.ts'],
      metadataOnly: false,
      packageManifestRuntimeNeutral: true,
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, [
      'server/tests/gcpPlatformMigration.contract.test.ts',
      'server/tests/plaidSchedulerMigration.test.ts',
    ]);
    assert.equal(plan.serverStaticRequired, false);
    assert.equal(plan.docsOnly, false);
    // The changed workflow contract is verified in its narrow targeted suite;
    // changing its definition alone does not execute the database suite.
    assert.equal(plan.databaseRequired, false);
    const withoutWorkflow = derivePrValidationPlan({
      changedFiles: ['package.json', 'ci/src/prValidationPlan.ts'],
      metadataOnly: false,
      packageManifestRuntimeNeutral: true,
    });
    assert.equal(withoutWorkflow.databaseRequired, false);
    assert.deepEqual(withoutWorkflow.targetedServerTests, ['server/tests/gcpPlatformMigration.contract.test.ts']);
    // The lockfile is never neutral: it only changes when dependencies do.
    const lockfile = derivePrValidationPlan({
      changedFiles: ['package.json', 'package-lock.json'],
      metadataOnly: false,
      packageManifestRuntimeNeutral: true,
    });
    assert.equal(lockfile.serverTestMode, 'full');
  });

  it('runs only directly changed server tests for a test-only change', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['server/tests/observabilityDeploymentSecrets.contract.test.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.serverStaticRequired, true);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, [
      'server/tests/observabilityDeploymentSecrets.contract.test.ts',
    ]);
    assert.deepEqual(plan.targetedIntegrationTests, []);
    assert.equal(plan.databaseRequired, false);
  });

  it('targets local HTTP suites without external services', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['server/tests/actionItems.test.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, ['server/tests/actionItems.test.ts']);
  });

  it('routes changed integration tests through isolated database execution', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['server/tests/dashboardCashflowEndpoints.integration.test.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.serverTestMode, 'none');
    assert.deepEqual(plan.targetedServerTests, []);
    assert.ok(plan.targetedIntegrationTests.includes(
      'server/tests/dashboardCashflowEndpoints.integration.test.ts'));
    assert.equal(plan.databaseRequired, true);
  });

  it('routes a newly declared integration suite through the conservative database runtime', () => {
    const path = 'server/tests/serviceTierLatency.integration.test.ts';
    const plan = compilePrValidationPlan(
      { changedFiles: [path], metadataOnly: false },
      {
        schema: 'example.server-test-runtimes.v1',
        tests: [{ path, profile: 'isolated-postgres' }],
      },
    );
    assert.equal(plan.serverTestMode, 'none');
    assert.deepEqual(plan.targetedIntegrationTests, [path]);
    assert.equal(plan.databaseRequired, true);
  });

  it('routes mocked chat stress locally and the SQL runtime suite through isolated PostgreSQL', () => {
    const stressPath = 'server/tests/chatStreamingStressTest.test.ts';
    assert.equal(runtimeManifest.tests.some((contract) => contract.path === stressPath), false);
    const stressPlan = derivePrValidationPlan({ changedFiles: [stressPath], metadataOnly: false });
    assert.equal(stressPlan.serverTestMode, 'targeted');
    assert.deepEqual(stressPlan.targetedServerTests, [stressPath]);
    assert.deepEqual(stressPlan.targetedIntegrationTests, []);
    assert.equal(stressPlan.databaseRequired, false);

    const sqlPath = 'server/tests/conversationRuntimeSql.integration.test.ts';
    assert.deepEqual(
      runtimeManifest.tests.find((contract) => contract.path === sqlPath),
      { path: sqlPath, profile: 'isolated-postgres' },
    );
    const sqlPlan = derivePrValidationPlan({ changedFiles: [sqlPath], metadataOnly: false });
    assert.equal(sqlPlan.serverTestMode, 'none');
    assert.deepEqual(sqlPlan.targetedServerTests, []);
    assert.deepEqual(sqlPlan.targetedIntegrationTests, [sqlPath]);
    assert.equal(sqlPlan.databaseRequired, true);
  });

  it('runs durable web chat action endpoints only with their isolated PostgreSQL fixture', () => {
    const path = 'server/tests/webChatActionEndpoints.integration.test.ts';
    assert.deepEqual(
      runtimeManifest.tests.find((contract) => contract.path === path),
      { path, profile: 'isolated-postgres' },
    );
    const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
    assert.equal(plan.serverTestMode, 'none');
    assert.deepEqual(plan.targetedServerTests, []);
    assert.deepEqual(plan.targetedIntegrationTests, [path]);
    assert.equal(plan.databaseRequired, true);
  });

  it('plans the runtime repair with stress in the targeted lane and SQL in the database lane', () => {
    const renamedStressPath = 'server/tests/chatStreamingStressTest.test.ts';
    const deletedStressPath = 'server/tests/chatStreamingStressTest.integration.test.ts';
    const sqlPath = 'server/tests/conversationRuntimeSql.integration.test.ts';
    const plan = derivePrValidationPlan({
      changedFiles: [
        '.github/workflows/pr-checks.yml',
        'ci/contracts/server-test-runtimes.json',
        'ci/tests/prValidationPlan.test.ts',
        'ci/tests/workflowRunnerRoutes.test.ts',
        renamedStressPath,
      ],
      deletedFiles: [deletedStressPath],
      metadataOnly: false,
    });

    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, [renamedStressPath, 'server/tests/plaidSchedulerMigration.test.ts']);
    assert.ok(plan.targetedIntegrationTests.includes(sqlPath));
    assert.equal(plan.targetedIntegrationTests.includes(deletedStressPath), false);
    assert.equal(plan.databaseRequired, true);
  });

  it('routes a new server integration suite by directory and suffix without a manifest entry', () => {
    const path = 'server/tests/isolated-postgres/plaidWebhookClaim.integration.test.ts';
    const plan = compilePrValidationPlan(
      { changedFiles: [path], fileStatusAvailable: true, metadataOnly: false },
      { schema: 'example.server-test-runtimes.v1', tests: [] },
    );
    assert.deepEqual(plan.targetedIntegrationTests, [path]);
    assert.equal(plan.databaseRequired, true);
    assert.equal(plan.serverTestMode, 'none');
    assert.throws(() => compilePrValidationPlan(
      { changedFiles: [path], fileStatusAvailable: false, metadataOnly: false },
      { schema: 'example.server-test-runtimes.v1', tests: [] },
    ), /Changed-file status is unavailable/);
  });

  it('does not treat a root integration suite with external calls as isolated PostgreSQL', () => {
    assert.throws(
      () => compilePrValidationPlan(
        { changedFiles: ['server/tests/serviceTierLatency.integration.test.ts'], metadataOnly: false },
        { schema: 'example.server-test-runtimes.v1', tests: [] },
      ),
      /runtime contract is not declared: server\/tests\/serviceTierLatency\.integration\.test\.ts/,
    );
  });

  it('rejects commands and unknown executor profiles in the data-only manifest', () => {
    assert.throws(
      () => compilePrValidationPlan(
        { changedFiles: ['server/tests/example.integration.test.ts'], metadataOnly: false },
        {
          schema: 'example.server-test-runtimes.v1',
          tests: [{
            path: 'server/tests/example.integration.test.ts',
            profile: 'shell',
            command: 'curl example.invalid',
          }],
        },
      ),
      /Invalid input/,
    );
  });

  it('executes every declared suite when the runtime manifest changes', () => {
    const plan = compilePrValidationPlan(
      {
        changedFiles: ['ci/contracts/server-test-runtimes.json'],
        metadataOnly: false,
      },
      {
        schema: 'example.server-test-runtimes.v1',
        tests: [
          {
            path: 'server/tests/dashboardCashflowEndpoints.integration.test.ts',
            profile: 'isolated-postgres',
          },
        ],
      },
    );
    assert.deepEqual(plan.targetedIntegrationTests, [
      'server/tests/dashboardCashflowEndpoints.integration.test.ts',
    ]);
    assert.equal(plan.databaseRequired, true);
  });

  it('keeps a same-PR manifest declaration out of full server validation', () => {
    const path = 'server/tests/serviceTierLatency.integration.test.ts';
    const plan = compilePrValidationPlan(
      {
        changedFiles: ['ci/contracts/server-test-runtimes.json', path],
        metadataOnly: false,
      },
      {
        schema: 'example.server-test-runtimes.v1',
        tests: [
          { path, profile: 'isolated-postgres' },
          {
            path: 'server/tests/alerts.integration.test.ts',
            profile: 'isolated-postgres',
          },
        ],
      },
    );
    assert.equal(plan.serverTestMode, 'none');
    assert.deepEqual(plan.targetedIntegrationTests, [
      path,
      'server/tests/alerts.integration.test.ts',
    ]);
    assert.equal(plan.databaseRequired, true);
  });

  it('routes database-backed schema tests through isolated database execution', () => {
    const path = 'server/tests/schema/creditLimits.schema.test.ts';
    const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
    assert.equal(plan.serverTestMode, 'none');
    assert.deepEqual(plan.targetedServerTests, []);
    assert.deepEqual(plan.targetedIntegrationTests, [path]);
    assert.equal(plan.databaseRequired, true);
  });

  it('rejects opt-in tests whose paid external runtime is undeclared', () => {
    assert.throws(
      () => derivePrValidationPlan({
        changedFiles: ['server/tests/modelBenchmark.test.ts'],
        metadataOnly: false,
      }),
      /Test runtime contract is not declared: server\/tests\/modelBenchmark\.test\.ts/,
    );
  });

  it('type-checks a changed real-environment suite without booking a runtime lane', () => {
    const changedFiles = [
      'server/tests/integration/cardActivationAlerts.integration.test.ts',
      'server/tests/vehicleAlertCopy.test.ts',
    ];
    const plan = derivePrValidationPlan({ changedFiles, metadataOnly: false });
    assert.equal(plan.serverStaticRequired, true);
    // The root tsconfig excludes server/tests; only the focused checker compiles the suite.
    assert.deepEqual(plan.testOnlyHelpersToTypecheck, [changedFiles[0]]);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, ['server/tests/vehicleAlertCopy.test.ts']);
    assert.deepEqual(plan.targetedIntegrationTests, []);
    assert.equal(plan.databaseRequired, false);

    const alone = derivePrValidationPlan({ changedFiles: [changedFiles[0]!], metadataOnly: false });
    assert.equal(alone.serverTestMode, 'none');
    assert.equal(alone.databaseRequired, false);
    assert.equal(alone.serverStaticRequired, true);
    assert.deepEqual(alone.testOnlyHelpersToTypecheck, [changedFiles[0]]);
  });

  it('keeps real-environment suites credential-gated and out of every CI lane', () => {
    const declared = new Set(runtimeManifest.tests.map((contract) => contract.path));
    for (const path of realEnvironmentIntegrationTests) {
      assert.equal(declared.has(path) || curatedDatabaseIntegrationTests.has(path), false, path);
      assert.match(readFileSync(path, 'utf8'), /process\.env\.RUN_INTEGRATION_TESTS/, path);
    }
  });

  it('allows deleting an integration test without requiring its runtime', () => {
    const path = 'server/tests/serviceTierLatency.integration.test.ts';
    const plan = derivePrValidationPlan({
      changedFiles: [path],
      deletedFiles: [path],
      metadataOnly: false,
    });
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.serverStaticRequired, false);
    assert.deepEqual(plan.targetedIntegrationTests, []);
    assert.equal(plan.databaseRequired, false);
  });

  it('rejects missing file status before applying edit-only contracts', () => {
    const path = 'server/tests/dashboardCashflowEndpoints.integration.test.ts';
    assert.throws(() => derivePrValidationPlan({
      changedFiles: [path],
      fileStatusAvailable: false,
      metadataOnly: false,
    }), /Changed-file status is unavailable/);
  });

  it('requires file status before classifying new integration suites', () => {
    const path = 'server/tests/isolated-postgres/newSuite.integration.test.ts';
    assert.throws(() => compilePrValidationPlan(
      { changedFiles: [path], fileStatusAvailable: false, metadataOnly: false },
      { schema: 'example.server-test-runtimes.v1', tests: [] },
    ), /Changed-file status is unavailable/);
  });

  it('does not run the database lane merely because its workflow definition changed', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['.github/workflows/pr-checks.yml'],
      metadataOnly: false,
    });
    assert.equal(plan.serverTestMode, 'targeted');
    assert.deepEqual(plan.targetedServerTests, ['server/tests/plaidSchedulerMigration.test.ts']);
    assert.equal(plan.databaseRequired, false);
  });

  it('executes and verifies every curated database integration suite', () => {
    // One typed list is both what the lane runs and what its report must show ran.
    const executed = new Set<string>(distributedDatabaseSuites);
    for (const path of curatedDatabaseIntegrationTests) {
      assert.ok(executed.has(path), `${path} must run in the distributed database lane`);
    }
  });

  it('declares a runtime contract for every suite in the distributed database lane', () => {
    const isolatedPaths = new Set(runtimeManifest.tests.map((contract) => contract.path));
    for (const path of distributedDatabaseSuites) {
      assert.ok(
        curatedDatabaseIntegrationTests.has(path) || isolatedPaths.has(path),
        `${path} must declare a database runtime contract`,
      );
    }
  });

  it('routes the mortgage-assignment disconnect suite through the curated database lane', () => {
    const path = 'server/tests/userProfileDisconnectMortgageAssignments.postgres.integration.test.ts';
    const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });

    assert.equal(plan.serverTestMode, 'none');
    assert.deepEqual(plan.targetedIntegrationTests, []);
    assert.equal(plan.databaseRequired, true);
  });

  it('routes the Apple authorization PostgreSQL suite through the curated database lane', () => {
    const path = 'server/tests/appleAuthorization.postgres.integration.test.ts';
    const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });

    assert.equal(plan.serverTestMode, 'none');
    assert.deepEqual(plan.targetedIntegrationTests, []);
    assert.equal(plan.databaseRequired, true);
  });

  it('routes production server code by verified test impact', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['server/services/plaid/plaidService.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.serverStaticRequired, true);
    assert.equal(plan.serverTestMode, 'targeted');
    assert.ok(plan.targetedServerTests.includes('server/tests/plaidService.aiHooks.test.ts'));
  });

  it('routes ambient server declarations to static validation only', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['server/types/express.d.ts'], metadataOnly: false,
    });
    assert.equal(plan.serverStaticRequired, true);
    assert.equal(plan.serverTestMode, 'none');
    assert.equal(plan.databaseRequired, false);
  });

  it('keeps server config and standalone scripts on conservative server validation', () => {
    for (const path of [
      'server/vitest.config.ts',
      'server/scripts/new-maintenance-command.ts',
    ]) {
      const plan = derivePrValidationPlan({ changedFiles: [path], metadataOnly: false });
      assert.equal(plan.serverStaticRequired, true, path);
      assert.equal(plan.serverTestMode, 'full', path);
    }
  });

  it('adds a shadow assurance plan for regulated financial calculation changes', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['server/services/chat/rules/socialSecurityEvidenceRules.ts'],
      metadataOnly: false,
    });

    assert.equal(plan.calculationAssurance.mode, 'shadow');
    assert.deepEqual(plan.calculationAssurance.selectedPackages, [
      'social-security-benefits',
    ]);
    assert.equal(plan.calculationAssurance.independentAuditRequired, true);
  });

  it('keeps the assurance plan when a regulated calculator is renamed out of the registry', () => {
    // A rename reports only its new path as changed, so a plan that selected on changed paths
    // alone let the move skip assurance entirely.
    const plan = derivePrValidationPlan({
      changedFiles: ['server/services/engines/retirementTimingEngineV2.ts'],
      deletedFiles: ['server/services/engines/retirementTimingEngine.ts'],
      metadataOnly: false,
      serverSourceImpact: {
        ownedSources: [
          'server/services/engines/retirementTimingEngine.ts',
          'server/services/engines/retirementTimingEngineV2.ts',
        ],
        affectedUnitTests: ['server/tests/retirementTimingEngine.test.ts'],
        affectedIntegrationTests: [],
        totalUnitTests: 871,
      },
    });

    assert.equal(plan.calculationAssurance.mode, 'shadow');
    assert.deepEqual(plan.calculationAssurance.selectedPackages, ['social-security-benefits']);
    assert.equal(plan.calculationAssurance.independentAuditRequired, true);
  });

  it('retains changed integration tests beside production server changes', () => {
    const plan = derivePrValidationPlan({
      changedFiles: [
        'server/services/core/dashboardService.ts',
        'server/tests/dashboardCashflowEndpoints.integration.test.ts',
      ],
      metadataOnly: false,
    });
    assert.ok(['targeted', 'full'].includes(plan.serverTestMode));
    assert.ok(plan.targetedIntegrationTests.includes(
      'server/tests/dashboardCashflowEndpoints.integration.test.ts'));
    assert.equal(plan.databaseRequired, true);
  });

  it('routes provider-boundary ownership to the isolated process-heavy lane', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['server/services/chat/core/providerBoundaryManifest.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.processHeavyRequired, true);
    assert.ok(!plan.targetedServerTests.includes('server/tests/chatProviderBoundaryManifest.test.ts'));
    assert.notEqual(plan.serverTestMode, 'full');
  });

  it('does not run a process-heavy test in the generic targeted lane', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['server/tests/dateWindowTimezone.test.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.processHeavyRequired, true);
    assert.equal(plan.serverTestMode, 'none');
    assert.deepEqual(plan.targetedServerTests, []);
  });

  it('fails closed into server validation for non-CI scripts', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['scripts/rebuild-user-ledger.mjs'],
      metadataOnly: false,
    });
    assert.equal(plan.workflowContractsRequired, true);
    assert.equal(plan.serverTestMode, 'full');
    assert.equal(plan.databaseRequired, true);
  });

  it('routes database integration only for database boundaries', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['server/persistence/repositories/actionItemsRepository.ts'],
      metadataOnly: false,
    });
    assert.equal(plan.databaseRequired, true);
  });

  it('keeps iOS changes out of the server suite while retaining contracts', () => {
    const plan = derivePrValidationPlan({
      changedFiles: ['ios/example-ios/Views/SettingsView.swift'],
      metadataOnly: false,
    });
    assert.equal(plan.iosContractsRequired, true);
    assert.equal(plan.serverTestMode, 'none');
  });

  it('fails closed for an empty ordinary changed-file inventory', () => {
    assert.throws(
      () => derivePrValidationPlan({ changedFiles: [], metadataOnly: false }),
      /Changed-file inventory is empty/,
    );
  });
});

describe('PR validation action adapter', () => {
  it('reads every input the workflow passes and the workflow passes every input it requires', () => {
    const workflow = readFileSync('.github/workflows/pr-checks.yml', 'utf8');
    const step = workflow.slice(
      workflow.indexOf(`      - name: ${prValidationPlanning.selection.name}`),
      workflow.indexOf('      - name: Explain financial calculation assurance'),
    );
    assert.match(step, /^ {8}run: node ci\/src\/actions\/planPrValidation\.ts$/m);
    const passed = [...step.matchAll(/^\s+INPUT_([A-Z_]+):/gm)].map((match) => match[1] ?? '').sort();
    const source = readFileSync('ci/src/actions/planPrValidation.ts', 'utf8');
    const read = [...source.matchAll(/input\('([a-z-]+)'/g)]
      .map((match) => (match[1] ?? '').toUpperCase().replaceAll('-', '_'));
    const trustedSource = step.match(/^\s+INPUT_TRUSTED_SCRIPT_SOURCE_SHA: (.+)$/m)?.[1];
    assert.ok(trustedSource);
    assert.deepEqual(passed, [...new Set(read)].sort());
  });

  function plannedOutputs(eventName: string, baseBranch: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'example-pr-validation-'));
    try {
      const changedFiles = join(directory, 'changed-files.txt');
      const deletedFiles = join(directory, 'deleted-files.txt');
      const output = join(directory, 'output.txt');
      writeFileSync(changedFiles, 'server/tests/example.test.ts\n', 'utf8');
      writeFileSync(deletedFiles, '', 'utf8');
      writeFileSync(output, '', 'utf8');
      const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      const result = spawnSync(
        process.execPath,
        ['ci/src/actions/planPrValidation.ts'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            INPUT_CHANGED_FILES_FILE: changedFiles,
            INPUT_DELETED_FILES_FILE: deletedFiles,
            INPUT_FILE_STATUS_AVAILABLE: 'true',
            INPUT_TEST_RUNTIME_CONTRACTS_FILE: 'ci/contracts/server-test-runtimes.json',
            INPUT_EVENT_NAME: eventName,
            INPUT_BASE_BRANCH: baseBranch,
            INPUT_HEAD_SHA: revision,
            INPUT_TRUSTED_SCRIPT_SOURCE_SHA: revision,
            GITHUB_OUTPUT: output,
            INPUT_METADATA_ONLY: 'false',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(output, 'utf8');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('publishes the complete typed output contract', () => {
    const outputs = plannedOutputs('pull_request', 'develop');
    assert.match(outputs, /^server_test_mode=targeted$/m);
    assert.match(outputs, /^targeted_server_tests=\["server\/tests\/example\.test\.ts"\]$/m);
    assert.match(outputs, /^targeted_integration_tests=\[\]$/m);
    assert.match(outputs, /^calculation_assurance_mode=skip$/m);
    assert.match(outputs, /^calculation_assurance_packages=\[\]$/m);
    assert.match(outputs, /^plan_json=\{"schema":"example\.pr-validation-plan\.v1"/m);
    assert.match(outputs, /"validationDepth":"pull-request"/);
  });

  it('plans the complete suites for a queue candidate and for missing event inputs', () => {
    for (const [eventName, baseBranch] of [['merge_group', 'develop'], ['', '']] as const) {
      const outputs = plannedOutputs(eventName, baseBranch);
      assert.match(outputs, /^server_test_mode=full$/m, eventName);
      assert.match(outputs, /^process_heavy_required=true$/m, eventName);
      assert.match(outputs, /"validationDepth":"complete"/, eventName);
    }
  });

  it('adds the pull request files to lint when a base delta changes lintable code', () => {
    const expected = {
      true: '["src/components/Example.tsx","src/components/Owned.tsx"]',
      // Without the route, the inventory is the pull request itself.
      false: '["src/components/Example.tsx"]',
    };
    for (const [route, paths] of Object.entries(expected)) {
      assert.equal(lintPlanWithPullRequestScope(route), `{"mode":"selected","paths":${paths}}`, route);
    }
  });

  function lintPlanWithPullRequestScope(baseDeltaRoute: string): string | undefined {
    const directory = mkdtempSync(join(tmpdir(), 'example-pr-validation-'));
    try {
      const changedFiles = join(directory, 'changed-files.txt');
      const deletedFiles = join(directory, 'deleted-files.txt');
      const output = join(directory, 'output.txt');
      writeFileSync(changedFiles, 'src/components/Example.tsx\n', 'utf8');
      writeFileSync(deletedFiles, '', 'utf8');
      writeFileSync(output, '', 'utf8');
      const result = spawnSync(
        process.execPath,
        ['ci/src/actions/planPrValidation.ts'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            INPUT_CHANGED_FILES_FILE: changedFiles,
            INPUT_DELETED_FILES_FILE: deletedFiles,
            INPUT_FILE_STATUS_AVAILABLE: 'true',
            INPUT_TEST_RUNTIME_CONTRACTS_FILE: 'ci/contracts/server-test-runtimes.json',
            INPUT_BASE_DELTA_ROUTE: baseDeltaRoute,
            INPUT_PULL_REQUEST_FILES: 'src/components/Owned.tsx\nsrc/components/Removed.tsx',
            INPUT_PULL_REQUEST_DELETED_FILES: 'src/components/Removed.tsx',
            GITHUB_OUTPUT: output,
            INPUT_METADATA_ONLY: 'false',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return /^lint_plan=(.*)$/m.exec(readFileSync(output, 'utf8'))?.[1];
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('performs zero evidence API calls for changes unrelated to every assurance package', () => {
    // Regression: no github-token/repository/head-sha/pr-number inputs are supplied below. If the
    // action fetched evidence before the plan determined that changed files select a package, it
    // would throw "Missing required action input: github-token" and exit non-zero.
    const directory = mkdtempSync(join(tmpdir(), 'example-pr-validation-'));
    try {
      const changedFiles = join(directory, 'changed-files.txt');
      const deletedFiles = join(directory, 'deleted-files.txt');
      const output = join(directory, 'output.txt');
      writeFileSync(changedFiles, 'src/components/Example.tsx\n', 'utf8');
      writeFileSync(deletedFiles, '', 'utf8');
      writeFileSync(output, '', 'utf8');
      const result = spawnSync(
        process.execPath,
        ['ci/src/actions/planPrValidation.ts'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            INPUT_CHANGED_FILES_FILE: changedFiles,
            INPUT_DELETED_FILES_FILE: deletedFiles,
            INPUT_FILE_STATUS_AVAILABLE: 'true',
            INPUT_TEST_RUNTIME_CONTRACTS_FILE: 'ci/contracts/server-test-runtimes.json',
            GITHUB_OUTPUT: output,
            INPUT_METADATA_ONLY: 'false',
            INPUT_GITHUB_TOKEN: '',
            INPUT_REPOSITORY: '',
            INPUT_HEAD_SHA: '',
            INPUT_PR_NUMBER: '',
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const outputs = readFileSync(output, 'utf8');
      assert.match(outputs, /^calculation_assurance_mode=skip$/m);
      assert.match(outputs, /^calculation_assurance_packages=\[\]$/m);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });


});

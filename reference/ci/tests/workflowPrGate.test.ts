import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';

import { prepareConversationRuntimeDatabases } from '../src/databaseLaneSuites.ts';
import { runtimeDatabaseSuites } from '../src/targetedServerTests.ts';
import { stepShell, workflowDocument, workflowJob } from '../src/workflowStepShell.ts';
import { ciEventCondition, ciEventFieldSource } from '../workflows/lib/ciEvent.ts';

const stepSchema = z.object({
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const jobSchema = z.object({
  name: z.string(),
  needs: z.array(z.string()).optional(),
  if: z.string().optional(),
  'runs-on': z.string(),
  outputs: z.record(z.string(), z.string()).optional(),
  steps: z.array(stepSchema),
}).passthrough();

function job(id: string): z.infer<typeof jobSchema> {
  return jobSchema.parse(workflowJob('pr-checks.yml', id));
}

function step(id: string, name: string): z.infer<typeof stepSchema> {
  const found = job(id).steps.find((candidate) => candidate.name === name);
  assert.ok(found, `${id} lacks ${name}`);
  return found;
}

test('trusted PR planner passes verified inventory and runtime provenance to typed actions', () => {
  const document = workflowDocument('pr-checks.yml');
  assert.equal(document.jobs['resolve-pr-linux-runner'], undefined);
  const selection = step('plan-pr-validation', 'Select free external capacity or hosted overflow');
  assert.equal(selection.run, 'node ci/src/actions/selectPrLinuxRunners.ts');
  assert.equal(selection.if,
    "steps.inventory.outputs.candidate_gone != 'true' && steps.plan.outputs.docs_only != 'true'");
  assert.ok(!selection.if.includes("server_test_mode != 'none'"));
  assert.equal(selection.env?.REPOSITORY_DEFAULT_BRANCH,
    '${{ github.event.repository.default_branch }}');
  const planner = step('plan-pr-validation', 'Select required validation lanes');
  assert.equal(planner.run, 'node ci/src/actions/planPrValidation.ts');
  assert.equal(planner.env?.INPUT_TRUSTED_SCRIPT_SOURCE_SHA,
    step('plan-pr-validation', 'Checkout trusted base workspace').with?.ref);
  assert.equal(planner.env?.INPUT_TEST_RUNTIME_CONTRACTS_FILE,
    '${{ runner.temp }}/server-test-runtimes.json');
  assert.ok(!planner.run?.includes('::notice::'));
  const deleted = step('plan-pr-validation', 'Detect removed changed files');
  const deletionSource = stepShell('pr-checks.yml', 'plan-pr-validation',
    'Detect removed changed files');
  assert.ok(deleted.env?.INCREMENTAL_DELETED_FILES);
  assert.ok(deleted.env?.FILE_STATUS_INVENTORY_VERIFIED);
  assert.ok(!deletionSource.includes('pulls/${pr_number}/files'));
  const runtime = step('plan-pr-validation', 'Load exact-head server test runtime contracts');
  assert.equal(runtime.env?.HEAD_SHA, `\${{ ${ciEventFieldSource('headSha')} }}`);
  assert.equal(runtime.env?.BASE_REPOSITORY, '${{ github.repository }}');
  assert.ok(!JSON.stringify(runtime).includes('head.repo.full_name'));
  const inventory = readFileSync(new URL('../src/prChangeInventory.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(inventory,
    /server_validation_required|database_required|ios_contract_validation_required/);
});

test('promotion planner and verdict pin one trusted typed policy revision', () => {
  const planner = job('plan-pr-validation');
  const trustedSource = step('plan-pr-validation', 'Check out the trusted base gate scripts');
  assert.equal(trustedSource.with?.ref, '${{ github.event.repository.default_branch }}');
  // On merge_group the fallback is the queue base, never the candidate.
  const policy = `\${{ ${ciEventCondition('pullRequestIntoMain')} `
    + `&& ${ciEventCondition('sameRepositoryPullRequest')} `
    + '&& steps.trusted-gate-source.outputs.commit '
    + `|| ${ciEventFieldSource('trustedBaseSha')} }}`;
  for (const name of ['Checkout base-update classifier', 'Checkout trusted base workspace']) {
    assert.equal(step('plan-pr-validation', name).with?.ref, policy, name);
  }
  assert.equal(step('plan-pr-validation', 'Select required validation lanes')
    .env?.INPUT_TRUSTED_SCRIPT_SOURCE_SHA, policy);
  assert.equal(planner.outputs?.trusted_policy_sha, policy);
  assert.equal(
    step('validate', 'Check out the typed validation verdict').with?.ref,
    `\${{ needs.plan-pr-validation.outputs.trusted_policy_sha || ${ciEventFieldSource('trustedBaseSha')} }}`,
  );
});

test('lint and selected lanes depend on the planner in parallel', () => {
  const lint = job('lint');
  assert.deepEqual(lint.needs, ['plan-pr-validation']);
  assert.ok(lint.if?.includes("needs.plan-pr-validation.outputs.docs_only != 'true'"));
  assert.ok(!lint.if?.includes(".mode != 'none'"));
  assert.ok(lint.if?.includes("needs.plan-pr-validation.result == 'success'"));
  assert.equal(lint['runs-on'],
    '${{ fromJson(needs.plan-pr-validation.outputs.pr_linux_overflow_labels) }}');
  assert.equal(lint.steps.filter((candidate) =>
    candidate.run === 'node ci/src/actions/installNodeDependencies.ts').length, 1);
  assert.equal(lint.steps.find((candidate) =>
    candidate.run === 'node ci/src/actions/installNodeDependencies.ts')?.if, undefined);
  assert.ok(!lint.steps.some((candidate) => candidate.run?.startsWith('npm ci')));
  assert.equal(step('lint', 'Lint selected PR code').run,
    'node ci/src/actions/runSelectedLint.ts');
  assert.ok(step('lint', 'Lint selected PR code').if?.includes(".mode != 'none'"));
  assert.equal(step('lint', 'Verify Linux lane documentation inputs').run,
    'node --test ci/tests/linuxLaneDocumentationInputs.test.ts');
  assert.equal(step('lint', 'Verify Linux lane documentation inputs').if, undefined);
  assert.ok(step('lint', 'Lint selected PR code').env?.PR_LINT_PLAN
    ?.includes('needs.plan-pr-validation.outputs.lint_plan'));
  for (const id of [
    'workflow-contracts', 'server-static', 'server-process-tests', 'server-tests',
    'targeted-server-tests', 'ios-contracts', 'database-integration', 'validation-policy',
  ]) {
    const lane = job(id);
    assert.deepEqual(lane.needs, ['plan-pr-validation'], id);
    assert.ok(!lane.if?.includes('needs.lint'), id);
    if (id !== 'validation-policy') assert.match(lane['runs-on'], /needs\.plan-pr-validation\.outputs\.pr_/);
  }
  const policy = job('validation-policy');
  assert.match(policy['runs-on'], /example-trusted-control/);
  assert.ok(!policy['runs-on'].includes('CI_CONTROL_RUNNER_LABELS'));
  assert.deepEqual(step('validation-policy', 'Validate debt dependency preflight').with,
    { entry: 'ci/src/actions/debt/runDebtDependencyPreflight.ts' });
  const debt = readFileSync(new URL('../src/actions/debt/runDebtDependencyPreflight.ts',
    import.meta.url), 'utf8');
  assert.match(debt, /ci\/src\/actions\/debt\/runDebtProjectionPreflight\.ts/);
});

test('server lanes retain their selected execution modes and runtime SQL database', () => {
  const staticCommands = job('server-static').steps.map((candidate) => candidate.run).join('\n');
  assert.match(staticCommands, /npm run security:error-envelopes/);
  assert.match(staticCommands, /npm run type-check/);
  assert.ok(job('server-process-tests').if?.includes("process_heavy_required == 'true'"));
  assert.ok(job('server-process-tests').if?.includes("server_test_mode == 'full'"));
  assert.ok(job('server-tests').if?.includes("server_test_mode == 'full'"));
  assert.match(job('server-process-tests').steps.map((candidate) => candidate.run).join('\n'),
    /npm run test:process-heavy/);
  const shards = z.object({ strategy: z.object({ matrix: z.object({ shard: z.array(z.number()) }) }) })
    .parse(workflowJob('pr-checks.yml', 'server-tests')).strategy.matrix.shard;
  assert.deepEqual(shards, [1, 2, 3, 4]);
  assert.match(job('server-tests').steps.map((candidate) => candidate.run).join('\n'),
    /runLinuxCoverageShard\.ts \$\{\{ matrix\.shard \}\}/);
  const targeted = job('targeted-server-tests');
  assert.ok(targeted.if?.includes("server_test_mode == 'targeted'"));
  assert.ok(targeted.steps.some((candidate) =>
    candidate.run === 'node ci/src/actions/runTargetedServerTests.ts'));
  assert.match(JSON.stringify(targeted.steps), /TARGETED_TEST_RESULTS_FILE/);
  assert.match(JSON.stringify(targeted.steps), /RUN_HTTP_TESTS/);
  const database = job('database-integration');
  const runtime = step('database-integration', 'Prepare conversation runtime SQL database');
  assert.equal(runtime.if, undefined);
  assert.equal(runtime.uses, './.github/actions/typed-step-runner');
  assert.deepEqual(runtime.with, { entry: 'ci/src/actions/prepareConversationRuntimeDatabases.ts' });
  const selected = step('database-integration', 'Run selected database acceptance tests');
  assert.equal(selected.run, 'node ci/src/actions/runDatabaseIntegrationValidation.ts');
  assert.ok(selected.if?.includes("targeted_integration_tests != '[]'"));
  assert.ok(selected.if?.includes("entitlement_acceptance_required == 'true'"));
  assert.equal(selected.env?.RUNTIME_POSTGRES_TEST_URL, '${{ env.RUNTIME_POSTGRES_TEST_URL }}');
  assert.equal(selected.env?.ENTITLEMENT_TEST_DATABASE_URL, '${{ env.DATABASE_URL }}');
  assert.equal(selected.env?.APPLE_AUTH_TEST_DATABASE_URL, '${{ env.DATABASE_URL }}');
  assert.equal(selected.env?.RUN_INTEGRATION_TESTS, '1');
  assert.ok(database.steps.findIndex((candidate) =>
    candidate.name === 'Prepare conversation runtime SQL database')
    < database.steps.findIndex((candidate) => candidate.name === selected.name));
  assert.match(JSON.stringify(database.steps), /TARGETED_TEST_RESULTS_FILE/);
});

test('runtime SQL preparation exports each private database before its strict suites run', async () => {
  const lane = {
    DB_CONTAINER_CMD: 'podman',
    DB_CONTAINER_NAME: 'gh-actions-pg-database-integration-7-1',
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:49153/example',
    RUNNER_TEMP: '/runner/temp',
  };
  const server = 'postgresql://postgres:postgres@127.0.0.1:49153';
  const events: string[] = [];
  const status = await prepareConversationRuntimeDatabases({
    env: lane,
    run: async (command, args) => {
      events.push(`${command} ${args.join(' ')}`);
      return { status: 0, stdout: '', stderr: '' };
    },
    exportEnv: (entries) => { events.push(`export ${JSON.stringify(entries)}`); },
    runTargeted: (selection, resultsFile, env) => {
      assert.deepEqual(z.array(z.string()).parse(JSON.parse(selection) as unknown), runtimeDatabaseSuites);
      assert.equal(resultsFile, '/runner/temp/runtime-persistence-results.json');
      assert.equal(env['RUNTIME_POSTGRES_TEST_URL'], `${server}/runtime_sql_qa`);
      assert.equal(env['RUNTIME_PREPARATION_TEST_URL'], `${server}/runtime_preparation_qa`);
      assert.equal(env['RUNTIME_PENDING_TEST_URL'], `${server}/runtime_pending_qa`);
      assert.equal(env['DATABASE_URL'], lane.DATABASE_URL);
      events.push('targeted');
      return 0;
    },
  });
  assert.equal(status, 0);
  const psql = `podman exec ${lane.DB_CONTAINER_NAME} psql -v ON_ERROR_STOP=1 -U postgres -d example -c`;
  assert.deepEqual(events, [
    `${psql} CREATE DATABASE runtime_sql_qa`,
    `export {"RUNTIME_POSTGRES_TEST_URL":"${server}/runtime_sql_qa"}`,
    `${psql} CREATE DATABASE runtime_preparation_qa`,
    `export {"RUNTIME_PREPARATION_TEST_URL":"${server}/runtime_preparation_qa"}`,
    `${psql} CREATE DATABASE runtime_pending_qa`,
    `export {"RUNTIME_PENDING_TEST_URL":"${server}/runtime_pending_qa"}`,
    'targeted',
  ]);
  await assert.rejects(prepareConversationRuntimeDatabases({
    env: lane,
    run: async () => ({ status: 2, stdout: '', stderr: '' }),
    exportEnv: () => { throw new Error('a failed create exports nothing'); },
    runTargeted: () => { throw new Error('a failed create runs nothing'); },
  }), /psql on example failed with exit 2: CREATE DATABASE runtime_sql_qa/);
});

test('one read-only required aggregate waits for every selected lane', () => {
  const aggregate = job('validate');
  assert.equal(aggregate.name, 'Validate pull request changes');
  assert.ok(aggregate.if?.includes('always() && !cancelled()'));
  assert.ok(!aggregate.steps.some((candidate) =>
    candidate.run?.includes('npm ci') || candidate.run?.includes('npm run validate:ci')));
  const checkouts = aggregate.steps.filter((candidate) =>
    candidate.uses?.startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0]?.with?.['repository'], undefined);
  assert.equal(checkouts[0]?.with?.['persist-credentials'], false);
  assert.equal(checkouts[0]?.with?.['sparse-checkout'], 'ci/src\n');
  const setup = aggregate.steps.find((candidate) => candidate.uses?.startsWith('actions/setup-node@'));
  assert.equal(setup?.with?.['node-version'], '26.5.0');
  const verdict = step('validate', 'Require every selected validation lane');
  assert.equal(verdict.run, 'node ci/src/actions/requireSelectedValidationLanes.ts');
  assert.equal(verdict.env?.LINT, '${{ needs.lint.result }}');
  assert.ok(verdict.env?.LINT_PLAN?.includes('needs.plan-pr-validation.outputs.lint_plan'));
  assert.equal(verdict.env?.SERVER_TESTS, '${{ needs.server-tests.result }}');
  assert.equal(verdict.env?.TARGETED_SERVER_TESTS, '${{ needs.targeted-server-tests.result }}');
  assert.equal(verdict.env?.SERVER_TEST_MODE,
    '${{ needs.plan-pr-validation.outputs.server_test_mode }}');
  for (const dependency of [
    'validation-policy', 'workflow-contracts', 'server-static',
    'server-process-tests', 'server-tests', 'targeted-server-tests',
    'ios-contracts', 'database-integration',
  ]) assert.ok(aggregate.needs?.includes(dependency), dependency);
  assert.ok(!aggregate.needs?.includes('resolve-pr-linux-runner'));
  const plannerOutputs = z.object({ outputs: z.record(z.string(), z.string()) })
    .parse(workflowJob('pr-checks.yml', 'plan-pr-validation')).outputs;
  for (const name of [
    'server_test_mode', 'targeted_server_tests',
    'workflow_contracts_required', 'ios_contracts_required',
  ]) assert.equal(plannerOutputs[name], `\${{ steps.plan.outputs.${name} }}`);
  for (const name of [
    'pr_linux_runner_labels', 'pr_linux_overflow_labels', 'pr_database_runner_labels',
  ]) assert.equal(plannerOutputs[name], `\${{ steps.pick.outputs.${name} }}`);
  const iosContracts = job('ios-contracts').steps.map((candidate) => candidate.run).join('\n');
  for (const name of [
    '*Contract.test.ts', '*TypesSync.test.ts', 'budgetRequestTypes.test.ts',
    'budgetCategoryEnums.test.ts', 'chatDataTypeRegistry.test.ts',
    'dashboardGeneratedTypes.test.ts',
  ]) assert.ok(iosContracts.includes(name), name);
  const contractRun = JSON.stringify(job('workflow-contracts'));
  assert.ok(!contractRun.includes('scripts/tests/refresh-pr-ci-after-base-edit.test.mjs'));
});

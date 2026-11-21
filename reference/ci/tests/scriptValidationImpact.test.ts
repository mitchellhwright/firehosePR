import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePrValidationPlan, type PrValidationInput } from '../src/prValidationPlan.ts';
import { retainDeletedScriptConsumers, scriptConsumersFromSources, scriptValidationImpact } from '../src/scriptConsumers.ts';
const emptyRuntime = { schema: 'example.server-test-runtimes.v1', tests: [] };
const ordinary = 'server/tests/contract.test.ts';
const isolated = 'server/tests/isolated-postgres/contract.integration.test.ts';
const input: PrValidationInput = {
  changedFiles: ['scripts/helper.mjs'],
  scriptImpact: { ciOnlyScripts: ['scripts/helper.mjs'], affectedServerTests: [ordinary] }, metadataOnly: false,
};
test('exact-head test helper ownership selects its readers instead of every server shard', () => {
  const helper = 'server/tests/utils/numericRules.ts';
  const reader = 'server/tests/numericRules.test.ts';
  const sources = new Map([
    [helper, 'export const rule = 1;'],
    [reader, "import { rule } from './utils/numericRules.js'; rule;"],
  ]);
  const graph = scriptConsumersFromSources(sources);
  const impact = scriptValidationImpact(graph, [helper]);
  assert.deepEqual(impact.testOnlyHelpers, [helper]);
  const plan = derivePrValidationPlan({ changedFiles: [helper], metadataOnly: false,
    scriptImpact: impact }, emptyRuntime);
  assert.equal(plan.serverTestMode, 'targeted');
  assert.deepEqual(plan.targetedServerTests, [reader]);
  assert.equal(plan.serverStaticRequired, true);
  assert.deepEqual(plan.testOnlyHelpersToTypecheck, [helper]);
  assert.equal(plan.workflowContractsRequired, false);
  assert.equal(plan.databaseRequired, false);

  const deleted = derivePrValidationPlan({
    changedFiles: [helper], deletedFiles: [helper], metadataOnly: false,
    scriptImpact: impact,
  }, emptyRuntime);
  assert.deepEqual(deleted.testOnlyHelpersToTypecheck, []);

  const shared = scriptConsumersFromSources(new Map([
    ...sources,
    ['server/services/rules.ts', "import { rule } from '../tests/utils/numericRules.js'; rule;"],
  ]));
  const sharedImpact = scriptValidationImpact(shared, [helper]);
  assert.deepEqual(sharedImpact.testOnlyHelpers, []);
  const sharedPlan = derivePrValidationPlan({ changedFiles: [helper], metadataOnly: false,
    scriptImpact: sharedImpact }, emptyRuntime);
  assert.equal(sharedPlan.serverTestMode, 'full');
  assert.equal(sharedPlan.databaseRequired, true);
});
test('a deleted helper retains its base integration owner without compiling the missing file', () => {
  const helper = 'server/tests/utils/integrationFixture.ts';
  const integration = 'server/tests/contract.integration.test.ts';
  const baseSources = new Map([
    [helper, 'export const fixture = 1;'],
    [integration, "import { fixture } from './utils/integrationFixture.js'; fixture;"],
  ]);
  const headSources = new Map([[integration, "test('contract', () => {});"]]);
  const deleted = [helper];
  const graph = retainDeletedScriptConsumers(
    scriptConsumersFromSources(baseSources),
    scriptConsumersFromSources(headSources, deleted),
    headSources,
    deleted,
  );
  const plan = derivePrValidationPlan({
    changedFiles: deleted,
    deletedFiles: deleted,
    metadataOnly: false,
    scriptImpact: scriptValidationImpact(graph, deleted),
  }, { ...emptyRuntime, tests: [{ path: integration, profile: 'isolated-postgres' }] });
  assert.deepEqual(plan.targetedIntegrationTests, [integration]);
  assert.equal(plan.databaseRequired, true);
  assert.deepEqual(plan.testOnlyHelpersToTypecheck, []);

  const withoutOwner = retainDeletedScriptConsumers(
    scriptConsumersFromSources(baseSources),
    scriptConsumersFromSources(new Map(), deleted),
    new Map(),
    deleted,
  );
  assert.deepEqual(scriptValidationImpact(withoutOwner, deleted).affectedServerTests, []);
});
test('test dependencies select targeted coverage without server static or database work', () => {
  const result = derivePrValidationPlan(input, emptyRuntime);
  assert.equal(result.serverTestMode, 'targeted');
  assert.deepEqual(result.targetedServerTests, [ordinary]);
  assert.equal(result.serverStaticRequired, false);
  assert.equal(result.databaseRequired, false);
  assert.equal(result.workflowContractsRequired, true);
});
test('inferred integration tests use their directory-owned database runtime', () => {
  const dependency = { ...input, scriptImpact: { ciOnlyScripts: ['scripts/helper.mjs'], affectedServerTests: [isolated] } };
  assert.throws(() => derivePrValidationPlan({ ...input, scriptImpact: { ciOnlyScripts: ['scripts/helper.mjs'], affectedServerTests: ['server/tests/modelBenchmark.test.ts'] } }, emptyRuntime), /runtime contract is not declared/);
  const result = derivePrValidationPlan(dependency, emptyRuntime);
  assert.equal(result.databaseRequired, true);
  assert.deepEqual(result.targetedIntegrationTests, [isolated]);
  assert.equal(result.serverTestMode, 'none');
  assert.equal(result.serverStaticRequired, false);
});
test('deleted dependent tests never execute, and product edits require test ownership', () => {
  const result = derivePrValidationPlan({ ...input, deletedFiles: [ordinary] }, emptyRuntime);
  assert.deepEqual(result.targetedServerTests, []);
  assert.equal(result.serverTestMode, 'none');
  const changedFiles = [...input.changedFiles, 'server/service.ts'];
  assert.throws(() => derivePrValidationPlan({ ...input, changedFiles }, emptyRuntime),
    /Exact-head server test ownership is missing or mismatched/);
  const product = derivePrValidationPlan({
    ...input,
    changedFiles,
    serverSourceImpact: {
      ownedSources: ['server/service.ts'],
      affectedUnitTests: [ordinary],
      affectedIntegrationTests: [],
      totalUnitTests: 100,
    },
  }, emptyRuntime);
  assert.equal(product.serverTestMode, 'targeted');
  assert.equal(product.serverStaticRequired, true);
});
test('deleting an unregistered tooling test keeps workflow validation without running the application suite', () => {
  const path = 'scripts/tests/retired-helper.test.mjs';
  const result = derivePrValidationPlan({ changedFiles: [path], deletedFiles: [path], metadataOnly: false }, emptyRuntime);
  assert.equal(result.workflowContractsRequired, true);
  assert.equal(result.serverTestMode, 'none');
  assert.equal(result.serverStaticRequired, false);
});

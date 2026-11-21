import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveServerSourceTestImpact,
  isServerDeclaration,
  isServerProductSource,
} from '../src/serverSourceTestOwnership.ts';
import { repositoryScriptSources } from '../src/scriptConsumers.ts';

describe('server source test ownership', () => {
  const base = new Map([
    ['server/services/budget/compute.ts', 'export const compute = () => 1;'],
    ['server/services/budget/index.ts', "export { compute } from './compute.js';"],
    ['server/tests/budget.test.ts', "import { compute } from '../services/budget/index.js';"],
    ['server/tests/unrelated.test.ts', 'export const unrelated = true;'],
  ]);

  it('selects only reachable test owners for a source change', () => {
    assert.deepEqual(deriveServerSourceTestImpact(base, base,
      ['server/services/budget/compute.ts'], []), {
      ownedSources: ['server/services/budget/compute.ts'],
      affectedUnitTests: ['server/tests/budget.test.ts'],
      affectedIntegrationTests: [],
      totalUnitTests: 2,
    });
  });

  it('classifies a new file from its known directory and exact-head imports', () => {
    const head = new Map(base);
    head.set('server/services/budget/round.ts', 'export const round = () => 2;');
    head.set('server/tests/budget.test.ts', "import { round } from '../services/budget/round.js';");
    assert.deepEqual(deriveServerSourceTestImpact(base, head,
      ['server/services/budget/round.ts'], []).affectedUnitTests,
    ['server/tests/budget.test.ts']);
  });

  it('keeps a deleted source bound to its trusted-base tests', () => {
    const head = new Map(base);
    head.delete('server/services/budget/compute.ts');
    assert.deepEqual(deriveServerSourceTestImpact(base, head,
      ['server/services/budget/compute.ts'], ['server/services/budget/compute.ts']).affectedUnitTests,
    ['server/tests/budget.test.ts']);
  });

  it('allows a source and its sole test to be deleted together', () => {
    const head = new Map(base);
    head.delete('server/services/budget/compute.ts');
    head.delete('server/tests/budget.test.ts');
    assert.deepEqual(deriveServerSourceTestImpact(base, head,
      ['server/services/budget/compute.ts', 'server/tests/budget.test.ts'],
      ['server/services/budget/compute.ts', 'server/tests/budget.test.ts']).affectedUnitTests, []);
  });

  it('re-runs exact-head readers of a source already absent from the trusted base', () => {
    const trusted = new Map(base);
    trusted.delete('server/services/budget/compute.ts');
    trusted.set('server/services/budget/index.ts', 'export const compute = () => 2;');
    const head = new Map(trusted);
    head.set('server/services/budget/report.ts',
      "import { compute } from './compute.js';\nexport const report = compute;");
    head.set('server/tests/report.test.ts',
      "import { report } from '../services/budget/report.js';");
    head.set('server/tests/direct.test.ts',
      "const load = () => import('server/services/budget/compute.ts');");
    assert.deepEqual(deriveServerSourceTestImpact(trusted, head,
      ['server/services/budget/compute.ts'], ['server/services/budget/compute.ts']).affectedUnitTests,
    ['server/tests/direct.test.ts', 'server/tests/report.test.ts']);
  });

  it('accepts removing a source that neither revision still has or reads', () => {
    const trusted = new Map(base);
    trusted.delete('server/services/budget/compute.ts');
    trusted.set('server/services/budget/index.ts', 'export const compute = () => 2;');
    const impact = deriveServerSourceTestImpact(trusted, trusted,
      ['server/services/budget/compute.ts'], ['server/services/budget/compute.ts']);
    assert.deepEqual(impact.ownedSources, ['server/services/budget/compute.ts']);
    assert.deepEqual(impact.affectedUnitTests, []);
    assert.equal(impact.totalUnitTests, 2);
  });

  it('still requires an owner for an unread source the trusted base has', () => {
    const trusted = new Map(base);
    trusted.set('server/services/budget/orphan.ts', 'export const orphan = () => 3;');
    assert.throws(() => deriveServerSourceTestImpact(trusted, base,
      ['server/services/budget/orphan.ts'], ['server/services/budget/orphan.ts']),
    /No declared server test owner for server\/services\/budget\/orphan.ts/);
  });

  it('keeps ambient declarations in static validation without runtime ownership', () => {
    assert.equal(isServerDeclaration('server/types/express.d.ts'), true);
    assert.equal(isServerProductSource('server/types/express.d.ts'), false);
  });

  it('leaves server configuration and standalone scripts to conservative validation', () => {
    for (const path of [
      'server/vitest.config.ts',
      'server/scripts/verifyDevE2eSchemaRevision.ts',
      'server/scripts/new-maintenance-command.ts',
    ]) {
      assert.equal(isServerProductSource(path), false);
      assert.deepEqual(deriveServerSourceTestImpact(base, base, [path], []).ownedSources, []);
    }
    assert.equal(isServerProductSource('server/config/cardVideos.ts'), true);
    assert.equal(isServerProductSource('server/services/budget/compute.ts'), true);
  });

  it('names an unowned file instead of expanding to the full suite', () => {
    const head = new Map(base);
    head.set('server/services/budget/unused.ts', 'export const unused = true;');
    assert.throws(() => deriveServerSourceTestImpact(base, head,
      ['server/services/budget/unused.ts'], []),
    /No declared server test owner for server\/services\/budget\/unused\.ts/);
  });

  it('does not treat a type-only import as a runtime test owner', () => {
    const head = new Map(base);
    head.set('server/tests/unrelated.test.ts',
      "import type { Budget } from '../services/budget/typeOnly.js';\nexport const unrelated = true;");
    head.set('server/services/budget/typeOnly.ts',
      'export interface Budget { total: number }\nexport const emptyBudget = { total: 0 };');
    assert.throws(() => deriveServerSourceTestImpact(base, head,
      ['server/services/budget/typeOnly.ts'], []), /No declared server test owner/);
  });

  it('leaves a module with no runtime emit to type-check instead of requiring an owner', () => {
    const head = new Map(base);
    head.set('server/services/budget/contracts.ts', [
      "import type { components } from '../../generated/api-types';",
      "import { type Compute } from './compute.js';",
      "export type Summary = components['schemas']['Summary'];",
      'export interface Budget { total: number; compute: Compute }',
      "export type { Budget as BudgetAlias };",
      "export type { Other } from './other.js';",
    ].join('\n'));
    assert.deepEqual(deriveServerSourceTestImpact(base, head,
      ['server/services/budget/contracts.ts'], []), {
      ownedSources: ['server/services/budget/contracts.ts'],
      affectedUnitTests: [],
      affectedIntegrationTests: [],
      totalUnitTests: 2,
    });
  });

  it('keeps requiring an owner for any statement that emits runtime code', () => {
    for (const runtimeStatement of [
      'export const limit = 1;',
      'export enum Kind { A }',
      "export { compute } from './compute.js';",
      "import './register.js';",
      "import { compute } from './compute.js';",
      'export function total() { return 1; }',
    ]) {
      const head = new Map(base);
      head.set('server/services/budget/contracts.ts',
        `export interface Budget { total: number }\n${runtimeStatement}`);
      assert.throws(() => deriveServerSourceTestImpact(base, head,
        ['server/services/budget/contracts.ts'], []), /No declared server test owner/,
      runtimeStatement);
    }
  });

  it('checks a deleted types-only module against its trusted-base source', () => {
    const baseWithTypes = new Map(base);
    baseWithTypes.set('server/services/budget/contracts.ts', 'export type Total = number;');
    assert.deepEqual(deriveServerSourceTestImpact(baseWithTypes, base,
      ['server/services/budget/contracts.ts'],
      ['server/services/budget/contracts.ts']).affectedUnitTests, []);
  });

  it('finds source-text readers rooted at the repository', () => {
    const head = new Map(base);
    head.set('server/db/migrate.ts', 'export const migrate = () => 1;');
    head.set('server/tests/plaidSchedulerMigration.test.ts',
      "readFileSync(resolve(repositoryRoot, 'server/db/migrate.ts'), 'utf8');");
    assert.deepEqual(deriveServerSourceTestImpact(base, head,
      ['server/db/migrate.ts'], []).affectedUnitTests,
    ['server/tests/plaidSchedulerMigration.test.ts']);
  });

  it('finds route tests that load the module with a literal dynamic import', () => {
    const head = new Map(base);
    head.set('server/routes/plaid.ts', 'export default { routes: true };');
    head.set('server/tests/plaidSyncHealthRoute.test.ts',
      "beforeEach(async () => { const route = await import('../routes/plaid.js'); return route.default; });");
    assert.deepEqual(deriveServerSourceTestImpact(base, head,
      ['server/routes/plaid.ts'], []).affectedUnitTests,
    ['server/tests/plaidSyncHealthRoute.test.ts']);
  });

  it('finds source-text contracts using URL or dirname-relative paths', () => {
    const head = new Map(base);
    head.set('server/services/core/dashboardService.ts', 'export const dashboard = true;');
    head.set('server/routes/plaid.ts', 'export const router = true;');
    head.set('server/tests/dashboardCanonicalProjectionWiring.test.ts',
      "readFileSync(new URL('../services/core/dashboardService.ts', import.meta.url), 'utf8');");
    head.set('server/tests/plaidAccountsProfileCleanup.test.ts',
      "fs.readFileSync(path.resolve(__dirname, '../routes/plaid.ts'), 'utf8');");
    const impact = deriveServerSourceTestImpact(base, head,
      ['server/services/core/dashboardService.ts', 'server/routes/plaid.ts'], []);
    assert.deepEqual(impact.affectedUnitTests, [
      'server/tests/dashboardCanonicalProjectionWiring.test.ts',
      'server/tests/plaidAccountsProfileCleanup.test.ts',
    ]);
  });

  it('selects source-text contracts using asynchronous file reads', () => {
    const head = new Map(base);
    head.set('server/routes/cardRewards.ts', 'export const cardRewards = true;');
    head.set('server/tests/cardRewardsEnrichmentFlag.test.ts',
      "await readFile(new URL('../routes/cardRewards.ts', import.meta.url), 'utf8');");
    assert.deepEqual(deriveServerSourceTestImpact(base, head,
      ['server/routes/cardRewards.ts'], []).affectedUnitTests,
    ['server/tests/cardRewardsEnrichmentFlag.test.ts']);
  });

  it('follows immutable local paths passed to source-text readers', () => {
    const head = new Map(base);
    head.set('server/services/chat/rag/agents/ragTools.ts', 'export const tools = true;');
    head.set('server/tests/ragTopicTerminology.test.ts',
      "describe('terms', () => { const ragToolsPath = path.resolve(__dirname, "
      + "'../services/chat/rag/agents/ragTools.ts'); "
      + "const content = fs.readFileSync(ragToolsPath, 'utf8'); return content; });");
    assert.ok(deriveServerSourceTestImpact(base, head,
      ['server/services/chat/rag/agents/ragTools.ts'], []).affectedUnitTests
      .includes('server/tests/ragTopicTerminology.test.ts'));
  });

  it('follows literal paths through a local source-read helper', () => {
    const head = new Map(base);
    head.set('server/services/chat/handlers/streamingWrapper.ts', 'export const wrapper = true;');
    head.set('server/tests/askExampleDiagnosticLogging.test.ts',
      "function readSource(path: string) { return fs.readFileSync(resolve(process.cwd(), path), 'utf8'); }\n"
      + "readSource('server/services/chat/handlers/streamingWrapper.ts');");
    assert.ok(deriveServerSourceTestImpact(base, head,
      ['server/services/chat/handlers/streamingWrapper.ts'], []).affectedUnitTests
      .includes('server/tests/askExampleDiagnosticLogging.test.ts'));
  });

  it('selects declared PostgreSQL integration readers without selecting opt-in suites', () => {
    const head = new Map(base);
    head.set('server/services/core/dashboardService.ts', 'export const dashboard = true;');
    head.set('server/tests/dashboardCashflowEndpoints.integration.test.ts',
      "import '../services/core/dashboardService.js';");
    head.set('server/tests/external.integration.test.ts',
      "import '../services/core/dashboardService.js';");
    const impact = deriveServerSourceTestImpact(base, head,
      ['server/services/core/dashboardService.ts'], [],
      new Set(['server/tests/dashboardCashflowEndpoints.integration.test.ts']));
    assert.deepEqual(impact.affectedIntegrationTests,
      ['server/tests/dashboardCashflowEndpoints.integration.test.ts']);
  });

  it('finds real Plaid dynamic-import and source-text route owners', () => {
    const sources = repositoryScriptSources(process.cwd());
    const impact = deriveServerSourceTestImpact(sources, sources,
      ['server/routes/plaid.ts'], []);
    assert.ok(impact.affectedUnitTests.includes('server/tests/plaidSyncHealthRoute.test.ts'));
    assert.ok(impact.affectedUnitTests.includes('server/tests/plaidAccountsProfileCleanup.test.ts'));
    assert.ok(impact.affectedUnitTests.includes('server/tests/debtClassifierSourceGuard.test.ts'));
    const cardRewards = deriveServerSourceTestImpact(sources, sources,
      ['server/routes/cardRewards.ts'], []);
    assert.ok(cardRewards.affectedUnitTests.includes('server/tests/cardRewardsEnrichmentFlag.test.ts'));
    const chatWrapper = deriveServerSourceTestImpact(sources, sources,
      ['server/services/chat/handlers/streamingWrapper.ts'], []);
    assert.ok(chatWrapper.affectedUnitTests.includes('server/tests/askExampleDiagnosticLogging.test.ts'));
    const ragTools = deriveServerSourceTestImpact(sources, sources,
      ['server/services/chat/rag/agents/ragTools.ts'], []);
    assert.ok(ragTools.affectedUnitTests.includes('server/tests/ragTopicTerminology.test.ts'));
  });

  it('selects executable parity coverage for generated chat payload enums', () => {
    const sources = repositoryScriptSources(process.cwd());
    const impact = deriveServerSourceTestImpact(sources, sources,
      ['server/services/shared/generated/chatPayloadTypes.generated.ts'], []);
    assert.ok(impact.affectedUnitTests.includes('server/tests/chatPayloadGeneratedParity.test.ts'));
  });

  it('selects the isolated provider-boundary scanner for chat sources and reachable dependencies', () => {
    const head = new Map(base);
    head.set('server/platform/providerClient.ts', 'export const provider = true;');
    head.set('server/services/chat/core/providerBoundaryManifest.ts',
      "import { provider } from '../../../platform/providerClient.js'; export { provider };");
    head.set('server/tests/chatProviderBoundaryManifest.test.ts',
      "import '../services/chat/core/providerBoundaryManifest.js';");
    head.set('server/tests/providerClient.test.ts',
      "import '../platform/providerClient.js';");
    for (const source of [
      'server/services/chat/core/providerBoundaryManifest.ts',
      'server/platform/providerClient.ts',
    ]) {
      const impact = deriveServerSourceTestImpact(head, head, [source], []);
      assert.ok(impact.affectedUnitTests.includes('server/tests/chatProviderBoundaryManifest.test.ts'));
    }
  });
});

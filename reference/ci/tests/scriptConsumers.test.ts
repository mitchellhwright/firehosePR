import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { derivePrValidationPlan, validationScriptRenames } from '../src/prValidationPlan.ts';
import { manifestChangeIsRuntimeNeutral } from '../src/packageManifest.ts';
import {
  affectedScriptServerTests,
  retainedDeletedWorkflowOnlyScripts,
  scriptConsumers,
  scriptConsumersFromSources,
  scriptValidationImpact,
  workflowOnlyScripts,
} from '../src/scriptConsumers.ts';

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'script-consumers-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test('a script is CI-only when only workflows, or CI-only scripts, name it', () => {
  const root = tree({
    '.github/workflows/ci.yml': 'run: bash scripts/gate.sh\nrun: node scripts/controller.mjs\n',
    'package.json': '{"scripts":{"gen":"node scripts/generate.js"}}',
    'cloudbuild.yaml': 'args: [bash, scripts/deploy.sh]\n',
    'server/services/x.ts': "import 'scripts/shared.mjs';\n",
    'scripts/gate.sh': 'bash scripts/helper.sh\nnode scripts/shared.mjs\n',
    'scripts/helper.sh': 'echo helper\n',
    'scripts/controller.mjs': 'export {};\n',
    'scripts/generate.js': 'export {};\n',
    'scripts/deploy.sh': 'echo deploy\n',
    'scripts/shared.mjs': 'export {};\n',
    'scripts/orphan.sh': 'echo nobody\n',
    'scripts/tests/gate.test.mjs': "import 'scripts/gate.sh';\n",
  });
  const consumers = scriptConsumers(root);
  assert.deepEqual([...(consumers.get('scripts/gate.sh') ?? [])].map((r) => `${r.consumer}:${r.file}`), ['workflow:.github/workflows/ci.yml']);
  assert.deepEqual([...(consumers.get('scripts/helper.sh') ?? [])].map((r) => `${r.consumer}:${r.file}`), ['script:scripts/gate.sh']);
  assert.deepEqual(workflowOnlyScripts(consumers), ['scripts/controller.mjs', 'scripts/gate.sh', 'scripts/helper.sh']);
  // generate.js: package.json; deploy.sh: Cloud Build; shared.mjs: application code (and a CI-only script);
  // orphan.sh: nothing names it; scripts/tests is never a consumer and never a candidate.
  assert.equal(consumers.has('scripts/tests/gate.test.mjs'), false);
});

test('deleting a workflow entry and its helper retains proven base ownership only when the head has no other owner', () => {
  const base = scriptConsumersFromSources(new Map([
    ['.github/workflows/ci.yml', 'run: node scripts/entry.mjs'],
    ['scripts/entry.mjs', "import './helper.mjs';"],
    ['scripts/helper.mjs', 'export {};'],
  ]));
  const headSources = new Map([['.github/workflows/ci.yml', 'run: node ci/src/actions/entry.ts']]);
  const deleted = ['scripts/entry.mjs', 'scripts/helper.mjs'];
  const head = scriptConsumersFromSources(headSources, deleted);
  const retained = retainedDeletedWorkflowOnlyScripts(base, head, headSources, deleted);
  assert.deepEqual(retained, deleted);
  const impact = scriptValidationImpact(head, deleted);
  const plan = derivePrValidationPlan({
    changedFiles: deleted,
    deletedFiles: deleted,
    metadataOnly: false,
    scriptImpact: {
      ...impact,
      ciOnlyScripts: [...new Set([...impact.ciOnlyScripts, ...retained])],
    },
  }, { schema: 'example.server-test-runtimes.v1', tests: [] });
  assert.equal(plan.serverTestMode, 'none');
  assert.equal(plan.databaseRequired, false);

  const referencedHeadSources = new Map([
    ...headSources,
    ['server/services/runtime.ts', "import '../../scripts/helper.mjs';"],
  ]);
  const referencedHead = scriptConsumersFromSources(referencedHeadSources, deleted);
  assert.deepEqual(
    retainedDeletedWorkflowOnlyScripts(base, referencedHead, referencedHeadSources, deleted),
    ['scripts/entry.mjs'],
  );
});

test('a helper below a script that package.json also names is not CI-only', () => {
  const root = tree({
    '.github/workflows/ci.yml': 'run: node scripts/entry.mjs\n',
    'package.json': '{"scripts":{"entry":"node scripts/entry.mjs"}}',
    'scripts/entry.mjs': "import './leaf.mjs'; // scripts/leaf.mjs\n",
    'scripts/leaf.mjs': 'export {};\n',
  });
  assert.deepEqual(workflowOnlyScripts(scriptConsumers(root)), []);
});

test('the repository classifies CI lane drivers separately from product generators', () => {
  const ciOnly = new Set(workflowOnlyScripts(scriptConsumers()));
  for (const path of ['scripts/run-ios-ci-main-tests.sh']) {
    assert.ok(ciOnly.has(path), `${path} should be CI-only`);
  }
  for (const path of ['scripts/generate-api-types.js']) {
    assert.ok(!ciOnly.has(path), `${path} is run outside CI`);
  }
});

test('relative imports preserve workflow ownership across helpers and cycles', () => {
  const root = tree({
    '.github/workflows/ci.yml': 'run: node scripts/entry.mjs\n',
    'scripts/entry.mjs': "import './lib/leaf.mjs'; export * from './export.mjs';\n",
    'scripts/lib/leaf.mjs': "import('../dynamic.mjs');\n",
    'scripts/dynamic.mjs': "import './lib/leaf.mjs';\n",
    'scripts/export.mjs': "const helper = require('./common.cjs');\n",
    'scripts/common.cjs': 'module.exports = {};\n',
    'scripts/orphan-a.mjs': "import './orphan-b.mjs';\n",
    'scripts/orphan-b.mjs': "import './orphan-a.mjs';\n",
  });
  assert.deepEqual(workflowOnlyScripts(scriptConsumers(root)), [
    'scripts/common.cjs', 'scripts/dynamic.mjs', 'scripts/entry.mjs',
    'scripts/export.mjs', 'scripts/lib/leaf.mjs',
  ]);
});

test('application and package consumers prevent relative helpers from being CI-only', () => {
  const root = tree({
    '.github/workflows/ci.yml': 'run: node scripts/entry.mjs\n',
    'package.json': '{"scripts":{"entry":"node scripts/package.mjs"}}',
    'scripts/entry.mjs': "import './shared.mjs'; import './package.mjs';\n",
    'scripts/package.mjs': "import './package-helper.mjs';\n",
    'scripts/package-helper.mjs': 'export {};\n',
    'scripts/shared.mjs': "import './nested.mjs';\n",
    'scripts/nested.mjs': 'export {};\n',
    'server/app.ts': "import '../scripts/shared.mjs';\n",
  });
  assert.deepEqual(workflowOnlyScripts(scriptConsumers(root)), ['scripts/entry.mjs']);
});

test('server test readers preserve workflow ownership and select transitive contract coverage', () => {
  const root = tree({
    '.github/workflows/ci.yml': 'run: node scripts/entry.mjs',
    'scripts/entry.mjs': "import './leaf.mjs';",
    'scripts/leaf.mjs': "import './entry.mjs';",
    'server/tests/reader.test.ts': "readFileSync('scripts/entry.mjs');",
    'scripts/orphan.mjs': 'export {};',
    'server/tests/orphan.test.ts': "import '../../scripts/orphan.mjs';",
  });
  const consumers = scriptConsumers(root);
  assert.deepEqual(workflowOnlyScripts(consumers), ['scripts/entry.mjs', 'scripts/leaf.mjs']);
  assert.deepEqual(affectedScriptServerTests(consumers, ['scripts/leaf.mjs', 'scripts/leaf.mjs']), ['server/tests/reader.test.ts']);
  assert.deepEqual(affectedScriptServerTests(consumers, ['scripts/orphan.mjs']), ['server/tests/orphan.test.ts']);
});

test('iOS full-run routing paths do not imply a server test consumes the runner', () => {
  const sources = new Map([
    ['scripts/run-ios-ci-main-tests.sh', 'echo tests'],
    ['scripts/select-ios-affected-tests.ts',
      "const fullRunFiles = ['scripts/run-ios-ci-main-tests.sh'];\n"
      + "const command = 'bash scripts/run-ios-ci-main-tests.sh';"],
    ['server/tests/gcpPlatformMigration.contract.test.ts',
      "readFileSync('scripts/select-ios-affected-tests.ts');"],
  ]);
  const withExecution = scriptConsumersFromSources(sources);
  assert.deepEqual(affectedScriptServerTests(withExecution, ['scripts/run-ios-ci-main-tests.sh']), [
    'server/tests/gcpPlatformMigration.contract.test.ts',
  ]);
  sources.set('scripts/select-ios-affected-tests.ts',
    "const fullRunFiles = ['scripts/run-ios-ci-main-tests.sh'];");
  const metadataOnly = scriptConsumersFromSources(sources);
  assert.deepEqual(affectedScriptServerTests(metadataOnly, ['scripts/run-ios-ci-main-tests.sh']), []);
  assert.deepEqual(affectedScriptServerTests(metadataOnly, ['scripts/select-ios-affected-tests.ts']), [
    'server/tests/gcpPlatformMigration.contract.test.ts',
  ]);
});

test('trusted workflow tests and transitively owned server helpers route new TypeScript scripts', () => {
  const sources = new Map([
    ['scripts/source-text.ts', 'export const normalized = true;'],
    ['ci/tests/retainedNativeWorkflow.test.ts', "import '../../scripts/source-text.ts';"],
    ['server/tests/helpers/sourceText.ts', "import '../../../scripts/source-text.ts';"],
    ['server/tests/healthRoute.test.ts', "import './helpers/sourceText.ts';"],
    ['server/tests/monitoringContract.test.ts', "import './helpers/sourceText.ts';"],
  ]);
  const consumers = scriptConsumersFromSources(sources);
  assert.deepEqual(workflowOnlyScripts(consumers), ['scripts/source-text.ts']);
  assert.deepEqual(affectedScriptServerTests(consumers, ['scripts/source-text.ts']), [
    'server/tests/healthRoute.test.ts',
    'server/tests/monitoringContract.test.ts',
  ]);

  // Even a helper under server/tests/ cannot hide an application consumer.
  sources.set('server/runtime.ts', "import './tests/helpers/sourceText.ts';");
  const productConsumers = scriptConsumersFromSources(sources);
  assert.deepEqual(workflowOnlyScripts(productConsumers), []);
  assert.deepEqual(affectedScriptServerTests(productConsumers, ['scripts/source-text.ts']), [
    'server/tests/healthRoute.test.ts',
    'server/tests/monitoringContract.test.ts',
  ]);
});

test('an unregistered scripts test does not declare workflow ownership', () => {
  const consumers = scriptConsumersFromSources(new Map([
    ['scripts/new-tool.ts', 'export {};'],
    ['scripts/tests/unregistered.test.mjs', "import '../new-tool.ts';"],
  ]));
  assert.deepEqual(workflowOnlyScripts(consumers), []);
});

test('a typed validation rename inherits its trusted base role only with unchanged npm ownership', () => {
  const from = 'scripts/check-error-envelope-boundary.mjs';
  const to = 'scripts/check-error-envelope-boundary.ts';
  const baseManifest = `{"scripts":{"security:error-envelopes":"node ${from}"}}`;
  const headManifest = `{"scripts":{"security:error-envelopes":"node ${to}"}}`;
  const base = scriptConsumersFromSources(new Map([
    ['package.json', baseManifest],
    [from, 'export {};'],
  ]));
  const sources = new Map([
    ['package.json', headManifest],
    [to, 'export {};'],
    ['server/tests/healthRoute.test.ts', `readFileSync('${to}');`],
  ]);
  const head = scriptConsumersFromSources(sources);
  const renames = validationScriptRenames(base, head, baseManifest, headManifest, [to], [from]);
  assert.deepEqual(renames, [{ from, to }]);
  const plan = derivePrValidationPlan({
    changedFiles: [to], deletedFiles: [from], metadataOnly: false,
    scriptImpact: { ...scriptValidationImpact(head, [to]), validationRenames: renames },
  }, { schema: 'example.server-test-runtimes.v1', tests: [] });
  assert.equal(plan.serverTestMode, 'targeted');
  assert.deepEqual(plan.targetedServerTests, ['server/tests/healthRoute.test.ts']);
  assert.equal(plan.serverStaticRequired, true);
  assert.equal(plan.databaseRequired, false);

  sources.set('server/runtime.ts', `import '../${to}';`);
  assert.deepEqual(validationScriptRenames(base, scriptConsumersFromSources(sources),
    baseManifest, headManifest, [to], [from]), []);
  assert.deepEqual(validationScriptRenames(base, head, baseManifest,
    `{"scripts":{"security:error-envelopes":"node ${to}","start":"node ${to}"}}`, [to], [from]), []);
  assert.deepEqual(validationScriptRenames(base, head, baseManifest, headManifest, [to], []), []);
});

test('test readers never erase package, deploy, or real application ownership', () => {
  for (const [file, content] of [
    ['package.json', '{"scripts":{"gen":"node scripts/entry.mjs"}}'],
    ['cloudbuild.yaml', 'run: node scripts/entry.mjs'],
    ['server/service.ts', "import '../scripts/entry.mjs';"],
    ['server/tests/support.ts', "import '../../scripts/entry.mjs';"],
  ] as const) {
    const consumers = scriptConsumers(tree({
      '.github/workflows/ci.yml': 'run: node scripts/entry.mjs',
      'scripts/entry.mjs': "import './leaf.mjs';",
      'scripts/leaf.mjs': 'export {};',
      'server/tests/reader.test.ts': "readFileSync('scripts/entry.mjs');",
      [file]: content,
    }));
    assert.deepEqual(workflowOnlyScripts(consumers), [], file);
    assert.deepEqual(affectedScriptServerTests(consumers, ['scripts/leaf.mjs']), ['server/tests/reader.test.ts'], file);
  }
});

test('exact-head package consumers revoke CI-only ownership transitively without widening metadata edits', () => {
  const base = '{"scripts":{}}';
  const root = tree({
    'package.json': base,
    '.github/workflows/ci.yml': 'run: node scripts/entry.mjs',
    'scripts/entry.mjs': "import './leaf.mjs';",
    'scripts/leaf.mjs': 'export {};',
    'server/tests/reader.test.ts': "readFileSync('scripts/entry.mjs');",
  });
  for (const changedFiles of [['package.json', 'scripts/leaf.mjs'], ['scripts/leaf.mjs']]) {
  for (const [head, expectedMode] of [
    ['{"scripts":{"start":"node scripts/entry.mjs"}}', 'full'],
    ['{"scripts":{"start":"node scripts/leaf.mjs"}}', 'full'],
    [String.raw`{"scripts":{"start":"node scripts\/leaf.mjs"}}`, 'full'],
    ['{"scripts":{},"description":"Updated metadata"}', 'targeted'],
  ] as const) {
    const graph = scriptConsumers(root, head);
    const plan = derivePrValidationPlan({ changedFiles, metadataOnly: false,
      packageManifestRuntimeNeutral: manifestChangeIsRuntimeNeutral(base, head),
      scriptImpact: scriptValidationImpact(graph, changedFiles),
    }, { schema: 'example.server-test-runtimes.v1', tests: [] });
    assert.equal(plan.serverTestMode, expectedMode, head);
    assert.equal(plan.serverStaticRequired, expectedMode === 'full', head);
  }
  }
  for (const malformed of ['null', '[]', '{invalid']) {
    assert.throws(() => scriptConsumers(root, malformed));
  }
  assert.deepEqual(workflowOnlyScripts(scriptConsumers(root)), ['scripts/entry.mjs', 'scripts/leaf.mjs']);
});

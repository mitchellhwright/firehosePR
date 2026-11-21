import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { nodeModulesCacheKey, restoredTreeRejection, stampFileName, installOrReuse } from '../ci/src/nodeModulesCache.ts';
import { partitionUiTests } from '../ci/src/ios/uiTestPartition.ts';
import { deriveTupleLifecyclePlan, type TupleLifecycleInput } from '../ci/src/tupleLifecycle.ts';

test('dependency cache invalidates manifests, npm config and install environment', t => {
  const root = mkdtempSync(join(tmpdir(), 'fpr-cache-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  const key = nodeModulesCacheKey(root, {});
  assert.equal(key, nodeModulesCacheKey(root, {}));
  assert.notEqual(key, nodeModulesCacheKey(root, {NODE_ENV: 'production'}));
  assert.notEqual(key, nodeModulesCacheKey(root, {npm_config_ignore_scripts: 'true'}));
  writeFileSync(join(root, '.npmrc'), 'ignore-scripts=true');
  assert.notEqual(key, nodeModulesCacheKey(root, {}));
  rmSync(join(root, '.npmrc'));
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  assert.notEqual(key, nodeModulesCacheKey(root, {}));
  assert.match(restoredTreeRejection({root, key, cacheHit: 'false'})!, /no exact/);
  assert.match(restoredTreeRejection({root, key, cacheHit: 'true'})!, /no key stamp/);
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', stampFileName), 'wrong');
  assert.match(restoredTreeRejection({root, key, cacheHit: 'true'})!, /stamped/);
  assert.equal(installOrReuse({root, environment: {}, install: () => 7}), 7);
  assert.equal(installOrReuse({root, environment: {}, install: () => {
    mkdirSync(join(root, 'node_modules')); return 0;
  }}), 0);
  const current = nodeModulesCacheKey(root, {});
  assert.equal(restoredTreeRejection({root, key: current, cacheHit: 'true'}), undefined);
});

const ui = {
  testPlan: JSON.stringify({testTargets: [{target: {name: 'UI'}, selectedTests: ['AccountTests']}]}),
  durationHints: JSON.stringify({tests: {'AccountTests/testSlow': 90, 'AccountTests/testFast': 10}}),
  sources: {methods: new Map([['AccountTests', new Set(['testSlow', 'testFast'])]]), weights: new Map([['AccountTests', 2]])},
  target: 'UI', exclusions: [], shardCount: 2,
};
test('UI shards preserve selected inventory and fail closed on missing or duplicate classes', () => {
  const p = partitionUiTests(ui);
  assert.equal(p.selectedCount, 2);
  assert.deepEqual(p.estimatedSeconds, [90, 10]);
  assert.deepEqual(p.shards.flat().sort(), ['UI/AccountTests/testFast', 'UI/AccountTests/testSlow']);
  assert.throws(() => partitionUiTests({...ui, sources: {methods: new Map(), weights: new Map()}}));
  assert.throws(() => partitionUiTests({...ui, testPlan: JSON.stringify({testTargets: [
    {target: {name: 'UI'}, selectedTests: ['AccountTests', 'AccountTests/testFast']},
  ]})}));
  assert.throws(() => partitionUiTests({...ui, shardCount: 0}));
});

test('tuple lifecycle refuses superseded events before proposing cancellation', () => {
  const head = 'a'.repeat(40), base = 'b'.repeat(40);
  const pr = {number: 1, state: 'open' as const, draft: false,
    head: {sha: head, ref: 'feature', repository: 'example/project'},
    base: {sha: base, ref: 'develop', repository: 'example/project'}};
  const input: TupleLifecycleInput = {repository: 'example/project',
    event: {action: 'synchronize', previousHeadSha: 'c'.repeat(40), baseChanged: false},
    pullRequest: pr, livePullRequest: {...pr, head: {...pr.head, sha: 'd'.repeat(40)}},
    iosExecutionScopeChangedByHead: {}, patchEquivalentPredecessor: false,
    verifiedLineage: [], runs: []};
  const plan = deriveTupleLifecyclePlan(input);
  assert.equal(plan.applicable, false);
  assert.equal(plan.reasonCode, 'tuple-superseded');
  assert.deepEqual(plan.cancelRunIds, []);
});

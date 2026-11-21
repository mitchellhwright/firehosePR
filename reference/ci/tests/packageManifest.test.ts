import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  manifestChangeIsRuntimeNeutral,
  manifestScriptChanged,
  packageManifestLaneImpact,
  runtimeNeutralManifestKeys,
} from '../src/packageManifest.ts';

const base = JSON.stringify({
  name: 'example',
  version: '1.0.0',
  type: 'module',
  scripts: { test: 'vitest', 'ci:check': 'npm run ci:test' },
  dependencies: { zod: '4.6.5' },
  devDependencies: { typescript: '5.9.3' },
  engines: { node: '26' },
});

function withChanges(changes: Record<string, unknown>): string {
  return JSON.stringify({ ...JSON.parse(base) as Record<string, unknown>, ...changes });
}

test('a change confined to npm scripts and package metadata is runtime neutral', () => {
  assert.equal(manifestChangeIsRuntimeNeutral(base, withChanges({
    scripts: { test: 'vitest', 'ci:check': 'npm run ci:typecheck && npm run ci:test', 'ci:lint': 'oxlint' },
    description: 'Financial planning',
    version: '1.0.1',
  })), true);
  assert.equal(manifestChangeIsRuntimeNeutral(base, base), true);
});

test('an edited entitlement acceptance npm alias retains its database obligation', () => {
  const changed = withChanges({
    scripts: { test: 'vitest', 'ci:check': 'npm run ci:test', 'test:entitlements:db': 'echo skipped' },
  });
  assert.equal(manifestChangeIsRuntimeNeutral(base, changed), true);
  assert.equal(manifestScriptChanged(base, changed, 'test:entitlements:db'), true);
  assert.equal(manifestScriptChanged(base, withChanges({ description: 'new' }), 'test:entitlements:db'), false);
  assert.equal(manifestScriptChanged(base, null, 'test:entitlements:db'), true);
});

test('key order and whitespace do not count as a change', () => {
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(base) as Record<string, unknown>).reverse()), null, 2);
  assert.equal(manifestChangeIsRuntimeNeutral(base, reordered), true);
});

test('a dependency, override, engine, module type or unknown key change selects the full suite', () => {
  assert.equal(manifestChangeIsRuntimeNeutral(base, withChanges({ dependencies: { zod: '4.7.0' } })), false);
  assert.equal(manifestChangeIsRuntimeNeutral(base, withChanges({ devDependencies: {} })), false);
  assert.equal(manifestChangeIsRuntimeNeutral(base, withChanges({ overrides: { minimist: '1.2.8' } })), false);
  assert.equal(manifestChangeIsRuntimeNeutral(base, withChanges({ engines: { node: '24' } })), false);
  assert.equal(manifestChangeIsRuntimeNeutral(base, withChanges({ type: 'commonjs' })), false);
  assert.equal(manifestChangeIsRuntimeNeutral(base, withChanges({ imports: { '#server/*': './server/*' } })), false);
  const withoutEngines = JSON.parse(base) as Record<string, unknown>;
  delete withoutEngines['engines'];
  assert.equal(manifestChangeIsRuntimeNeutral(base, JSON.stringify(withoutEngines)), false);
});

test('anything that cannot be compared is not neutral', () => {
  assert.equal(manifestChangeIsRuntimeNeutral(base, null), false);
  assert.equal(manifestChangeIsRuntimeNeutral(null, base), false);
  assert.equal(manifestChangeIsRuntimeNeutral(base, '{not json'), false);
  assert.equal(manifestChangeIsRuntimeNeutral(base, '[]'), false);
  assert.equal(manifestChangeIsRuntimeNeutral('null', base), false);
});

test('a base-delta package.json change reruns every script-driven lane', () => {
  // The base update brought the new alias in, so base and head agree while the
  // reused predecessor ran the old command.
  const updated = withChanges({
    scripts: { test: 'vitest', 'ci:check': 'npm run ci:test', 'test:entitlements:db': 'node next.ts' },
  });
  assert.deepEqual(
    packageManifestLaneImpact({ base: updated, head: updated, manifestChanged: true, baseDeltaRoute: true }),
    { runtimeNeutral: false, entitlementAcceptanceScriptChanged: true },
  );
});

test('outside a base-delta route package.json is classified by the base-to-head comparison', () => {
  const alias = withChanges({
    scripts: { test: 'vitest', 'ci:check': 'npm run ci:test', 'test:entitlements:db': 'node next.ts' },
  });
  assert.deepEqual(
    packageManifestLaneImpact({ base, head: alias, manifestChanged: true, baseDeltaRoute: false }),
    { runtimeNeutral: true, entitlementAcceptanceScriptChanged: true },
  );
  assert.deepEqual(
    packageManifestLaneImpact({ base, head: base, manifestChanged: true, baseDeltaRoute: false }),
    { runtimeNeutral: true, entitlementAcceptanceScriptChanged: false },
  );
  // Read only for script ownership: the manifest itself did not change.
  assert.deepEqual(
    packageManifestLaneImpact({ base, head: alias, manifestChanged: false, baseDeltaRoute: true }),
    { runtimeNeutral: true, entitlementAcceptanceScriptChanged: false },
  );
});

test('the neutral key list never names a key that configures npm or Node resolution', () => {
  const resolutionKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
    'overrides', 'engines', 'type', 'imports', 'exports', 'main', 'workspaces', 'browserslist', 'packageManager'];
  for (const key of resolutionKeys) assert.equal(runtimeNeutralManifestKeys.has(key), false, key);
  const repositoryManifest = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>;
  for (const key of Object.keys(repositoryManifest)) {
    assert.ok(runtimeNeutralManifestKeys.has(key) || resolutionKeys.includes(key),
      `package.json key "${key}" is neither runtime neutral nor a known resolution key; classify it`);
  }
});

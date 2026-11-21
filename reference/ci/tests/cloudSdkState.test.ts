import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { realServerE2eSteps } from '../workflows/ios-tests/real-server-e2e-steps.ts';
import { classifyIosChangedPaths } from '../src/ios/iosChangeClassification.ts';
import { isIosWorkflowOnlyPath } from '../src/ios/workflowOnlyPaths.ts';
import { createIsolatedCloudSdkState, removeIsolatedCloudSdkState } from '../src/ios/cloudSdkState.ts';
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'example-cloud-sdk-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { RUNNER_TEMP: root, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'real-server-e2e' };
  const owned = createIsolatedCloudSdkState(env);
  return { root, owned, env: { ...env, CLOUDSDK_CONFIG: owned, EXAMPLE_ISOLATED_CLOUDSDK_CONFIG: owned } };
}
test('creation and cleanup share exact job identity and remove only owned credentials', t => {
  const { root, owned, env } = fixture(t);
  const another = createIsolatedCloudSdkState({ ...env, GITHUB_JOB: 'other-lane' });
  writeFileSync(join(owned, 'credentials.db'), 'fake credentials');
  writeFileSync(join(another, 'credentials.db'), 'other credentials');
  assert.equal(removeIsolatedCloudSdkState(env), 'removed');
  assert.equal(existsSync(owned), false);
  assert.equal(readFileSync(join(another, 'credentials.db'), 'utf8'), 'other credentials');
  assert.equal(existsSync(root), true);
  assert.equal(removeIsolatedCloudSdkState(env), 'already-absent');
});
test('cleanup before creation is a no-op without requiring absent workflow variables', () => {
  assert.equal(removeIsolatedCloudSdkState({}), 'unowned');
});
for (const change of [
  { CLOUDSDK_CONFIG: '/unrelated' }, { CLOUDSDK_CONFIG: undefined },
  { GITHUB_RUN_ID: '../other' }, { GITHUB_RUN_ATTEMPT: 'a' }, { GITHUB_JOB: '../other' },
  { RUNNER_TEMP: '/' }, { RUNNER_TEMP: 'relative' },
]) test(`unsafe ownership ${JSON.stringify(change)} leaves credentials untouched`, t => {
  const { owned, env } = fixture(t);
  writeFileSync(join(owned, 'credentials.db'), 'keep');
  assert.throws(() => removeIsolatedCloudSdkState({ ...env, ...change }));
  assert.equal(readFileSync(join(owned, 'credentials.db'), 'utf8'), 'keep');
});
test('rejects symlinked temporary roots including a trailing slash', t => {
  const { root, env } = fixture(t);
  const link = join(root, 'link'); symlinkSync(root, link);
  for (const RUNNER_TEMP of [link, `${link}/`]) {
    assert.throws(() => createIsolatedCloudSdkState({ ...env, RUNNER_TEMP }), /unsafe RUNNER_TEMP/);
    assert.throws(() => removeIsolatedCloudSdkState({ ...env, RUNNER_TEMP }), /unsafe RUNNER_TEMP/);
  }
});
test('rejects foreign names, incorrect suffixes, trailing separators and nested paths', t => {
  const { root, env, owned } = fixture(t);
  const prefix = 'example-gcloud-123-2-real-server-e2e.';
  for (const path of [join(root, 'example-gcloud-124-2-real-server-e2e.ABC123'), join(root, `${prefix}A`),
    join(root, `${prefix}ABC123-extra`), `${owned}/`, join(owned, `${prefix}ABC123`)]) {
    assert.throws(() => removeIsolatedCloudSdkState({ ...env, CLOUDSDK_CONFIG: path, EXAMPLE_ISOLATED_CLOUDSDK_CONFIG: path }), /unexpected/);
  }
  assert.equal(existsSync(owned), true);
});
test('rejects a symlink in place of owned state and preserves its target', t => {
  const { root, owned, env } = fixture(t);
  rmSync(owned, { recursive: true });
  const target = join(root, 'unrelated'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'keep');
  symlinkSync(target, owned);
  assert.throws(() => removeIsolatedCloudSdkState(env), /symlinked/);
  assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'keep');
});
test('recursive removal unlinks nested symlinks without deleting their external target', t => {
  const { root, owned, env } = fixture(t);
  const target = join(root, 'other'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'keep');
  symlinkSync(target, join(owned, 'linked'));
  assert.equal(removeIsolatedCloudSdkState(env), 'removed');
  assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'keep');
});
test('rejects a file in place of owned configuration', t => {
  const { owned, env } = fixture(t); rmSync(owned, { recursive: true }); writeFileSync(owned, 'keep');
  assert.throws(() => removeIsolatedCloudSdkState(env), /non-directory/);
  assert.equal(readFileSync(owned, 'utf8'), 'keep');
});

test('credential filesystem lifecycle changes use contracts without selecting unrelated product tests', () => {
  for (const path of ['scripts/remove-isolated-gcloud-config.sh', 'ci/src/ios/cloudSdkState.ts',
    'ci/src/actions/ios/isolateCloudSdkState.ts', 'ci/src/actions/ios/removeIsolatedCloudSdkState.ts', 'ci/tests/cloudSdkState.test.ts']) {
    assert.equal(isIosWorkflowOnlyPath(path), true);
    assert.deepEqual(classifyIosChangedPaths([path]), { iosChangedFiles: [], storekitRequired: false,
      onboardingRequired: false, chatPlaidRequired: false, budgetRequired: false, incomeRequired: false });
  }
});

test('old product heads use lifecycle programs from the gate-proven control checkout', t => {
  const { root, env, owned } = fixture(t);
  const product = join(root, 'old-product'); mkdirSync(product);
  const verifier = join(product, '.ci/trusted-ios-revision-guard');
  for (const file of ['ci/src/ios/cloudSdkState.ts', 'ci/src/ios/shared/stepIo.ts',
    'ci/src/ios/shared/stepFailure.ts', 'ci/src/ios/shared/actionIo.ts',
    'ci/src/actions/ios/removeIsolatedCloudSdkState.ts', 'ci/src/actions/ios/isolateCloudSdkState.ts']) {
    const destination = join(verifier, file); mkdirSync(dirname(destination), { recursive: true });
    cpSync(file, destination);
  }
  assert.equal(existsSync(join(product, 'ci/src/actions/ios/removeIsolatedCloudSdkState.ts')), false);
  for (const [name, file] of [['Isolate Google Cloud SDK state', 'isolateCloudSdkState.ts'],
    ['Remove isolated Google Cloud SDK state', 'removeIsolatedCloudSdkState.ts']] as const) {
    const step = realServerE2eSteps.find(value => value.config.name === name);
    assert.equal(step?.config.command, `node .ci/trusted-ios-revision-guard/ci/src/actions/ios/${file}`);
  }
  writeFileSync(join(owned, 'credentials.db'), 'owned');
  const cleanup = spawnSync(process.execPath, ['.ci/trusted-ios-revision-guard/ci/src/actions/ios/removeIsolatedCloudSdkState.ts'], {
    cwd: product, env: { ...process.env, ...env }, encoding: 'utf8',
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(existsSync(owned), false);
  assert.match(cleanup.stdout, /"decision":"removed"/);
  const environmentFile = join(root, 'step-env');
  const creation = spawnSync(process.execPath, ['.ci/trusted-ios-revision-guard/ci/src/actions/ios/isolateCloudSdkState.ts'], {
    cwd: product, env: { ...process.env, ...env, GITHUB_ENV: environmentFile }, encoding: 'utf8',
  });
  assert.equal(creation.status, 0, creation.stderr);
  assert.match(readFileSync(environmentFile, 'utf8'), /CLOUDSDK_CONFIG=.*example-gcloud-123-2-real-server-e2e\.[A-Za-z0-9]{6}/);
});

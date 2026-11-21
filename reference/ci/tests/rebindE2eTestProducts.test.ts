import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, it } from 'node:test';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('falls back to an exact-head rebuild when a restored cache has the wrong receipt', () => {
  const root = mkdtempSync(join(tmpdir(), 'rebind-e2e-products-'));
  temporaryDirectories.push(root);
  const workspace = join(root, 'workspace');
  const runnerTemp = join(root, 'runner-temp');
  const binaryDirectory = join(root, 'bin');
  const output = join(root, 'github-output');
  mkdirSync(join(workspace, '.example-ci', 'handoff'), { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(binaryDirectory, { recursive: true });
  writeFileSync(
    join(workspace, '.example-ci', 'handoff', 'example-ios-e2e.xctestproducts.zip'),
    'opaque cache payload',
  );
  const fakeDitto = join(binaryDirectory, 'ditto');
  writeFileSync(fakeDitto, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const destination = process.argv.at(-1);
const stage = path.join(destination, 'example-ios-e2e-products');
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, 'exact-head-sha'), '${'c'.repeat(40)}\\n');
`, 'utf8');
  chmodSync(fakeDitto, 0o755);

  const result = spawnSync(
    process.execPath,
    [resolve('ci/src/actions/ios/rebindE2eTestProducts.ts')],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
        DEVELOPER_DIR: '',
        GITHUB_OUTPUT: output,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        IOS_E2E_REUSED_HEAD_SHA: 'a'.repeat(40),
        IOS_E2E_REUSED_RUN_ID: '123',
        IOS_E2E_REUSED_RUN_ATTEMPT: '2',
        ONBOARDING_E2E_COMMIT_SHA: 'b'.repeat(40),
        GITHUB_RUN_ID: '124',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'build-ios-e2e-test-products',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /not the proven predecessor/);
  assert.equal(readFileSync(output, 'utf8'), 'rebuild_required=true\n');
});

for (const scenario of ['verified', 'mismatched-build', 'malformed'] as const) {
it(`rebind ${scenario}: only verified predecessor products can be re-sealed`, () => {
  const root = mkdtempSync(join(tmpdir(), 'rebind-e2e-products-'));
  temporaryDirectories.push(root);
  const workspace = join(root, 'workspace');
  const runnerTemp = join(root, 'runner-temp');
  const binaryDirectory = join(root, 'bin');
  const output = join(root, 'github-output');
  const archive = join(workspace, '.example-ci', 'handoff', 'example-ios-e2e.xctestproducts.zip');
  mkdirSync(join(workspace, '.example-ci', 'handoff'), { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  mkdirSync(binaryDirectory, { recursive: true });
  writeFileSync(archive, 'predecessor cache payload');

  const predecessor = 'a'.repeat(40);
  const current = 'b'.repeat(40);
  const toolchain = scenario === 'malformed' ? {} : { schemaVersion: 1, headSha: predecessor, xcodeVersion: '27.0', xcodeBuild: scenario === 'mismatched-build' ? '27A300' : '27A266a' };
  const predecessorRunId = '123';
  const predecessorRunAttempt = '2';
  const fakeDitto = join(binaryDirectory, 'ditto');
  writeFileSync(fakeDitto, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '-x') {
  const destination = args.at(-1);
  const stage = path.join(destination, 'example-ios-e2e-products');
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'exact-head-sha'), '${predecessor}\\n');
  fs.writeFileSync(path.join(stage, 'toolchain.json'), JSON.stringify(${JSON.stringify(toolchain)}) + '\\n');
  fs.writeFileSync(path.join(stage, 'producer-provenance.json'), JSON.stringify({
    schema: 'example-ios-test-product-producer-v1',
    headSha: '${predecessor}',
    runId: '${predecessorRunId}',
    runAttempt: '${predecessorRunAttempt}',
    job: 'build-ios-e2e-test-products'
  }) + '\\n');
  fs.writeFileSync(path.join(stage, 'compiled-products'), 'unchanged binary');
} else {
  const stage = args.at(-2);
  const destination = args.at(-1);
  const head = fs.readFileSync(path.join(stage, 'exact-head-sha'), 'utf8').trim();
  const products = fs.readFileSync(path.join(stage, 'compiled-products'), 'utf8');
  fs.writeFileSync(destination, 'sealed:' + head + ':' + products);
}
`, 'utf8');
  chmodSync(fakeDitto, 0o755);

  const fakeXcode = join(binaryDirectory, 'xcodebuild');
  writeFileSync(fakeXcode, `#!/usr/bin/env node
console.log('Xcode 27.0');
console.log('Build version 27A266a');
`, 'utf8');
  chmodSync(fakeXcode, 0o755);

  const result = spawnSync(
    process.execPath,
    [resolve('ci/src/actions/ios/rebindE2eTestProducts.ts')],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ''}`,
        DEVELOPER_DIR: '',
        GITHUB_OUTPUT: output,
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        IOS_E2E_REUSED_HEAD_SHA: predecessor,
        IOS_E2E_REUSED_RUN_ID: predecessorRunId,
        IOS_E2E_REUSED_RUN_ATTEMPT: predecessorRunAttempt,
        ONBOARDING_E2E_COMMIT_SHA: current,
        GITHUB_RUN_ID: '124',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_JOB: 'build-ios-e2e-test-products',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  if (scenario === 'verified') {
    assert.equal(readFileSync(output, 'utf8'), 'rebuild_required=false\n');
    assert.equal(readFileSync(archive, 'utf8'), `sealed:${current}:unchanged binary`);
  } else {
    assert.equal(readFileSync(output, 'utf8'), 'rebuild_required=true\n');
    assert.equal(readFileSync(archive, 'utf8'), 'predecessor cache payload');
  }
});
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a missing cross-runner archive selects an exact-head consumer rebuild', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'example-native-products-'));
  const output = join(workspace, 'github-output');
  writeFileSync(output, '');
  try {
    const result = spawnSync(
      process.execPath,
      ['ci/src/actions/ios/prepareNativeTestProducts.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          RUNNER_TEMP: workspace,
          GITHUB_OUTPUT: output,
          EXACT_HEAD_SHA: 'a'.repeat(40),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /rebuilding on this exact-head consumer/);
    assert.equal(readFileSync(output, 'utf8'), 'rebuild_required=true\n');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a truncated cross-runner archive is removed before an exact-head consumer rebuild', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'example-native-products-'));
  const output = join(workspace, 'github-output');
  const archive = join(workspace, '.example-ci/handoff/example-ios-native-products.zip');
  const productsRoot = join(workspace, 'example-ios-native-products-restored');
  mkdirSync(join(workspace, '.example-ci/handoff'), { recursive: true });
  writeFileSync(archive, 'truncated zip');
  writeFileSync(output, '');
  try {
    const result = spawnSync(
      process.execPath,
      ['ci/src/actions/ios/prepareNativeTestProducts.ts'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          RUNNER_TEMP: workspace,
          GITHUB_OUTPUT: output,
          EXACT_HEAD_SHA: 'a'.repeat(40),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /could not be unpacked/);
    assert.equal(readFileSync(output, 'utf8'), 'rebuild_required=true\n');
    assert.equal(existsSync(archive), false);
    assert.equal(existsSync(productsRoot), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

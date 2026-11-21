import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runCommand } from '../src/ios/shared/processRunner.ts';
import { verifyTestProductToolchainReceipt } from '../src/ios/shared/testProductToolchain.ts';
import { StepFailure } from '../src/ios/shared/stepFailure.ts';
import {
  archiveStage,
  copyIntoStage,
  readArchiveProducerProvenance,
  requireNonEmptyFile,
  resetStage,
  sealArchive,
  validArchiveProducerProvenance,
} from '../src/ios/shared/testProductArchive.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'test-product-archive-'));
}

describe('archiveStage', () => {
  it('places the stage under the runner temp and the archive under the handoff directory', () => {
    const stage = archiveStage({
      runnerTemp: '/runner/temp',
      stageName: 'example-ios-native-products',
      workspace: '/work',
      archiveName: 'example-ios-native-products.zip',
      cwd: '/work/ios',
    });
    assert.equal(stage.stage, '/runner/temp/example-ios-native-products');
    assert.equal(stage.archive, '/work/.example-ci/handoff/example-ios-native-products.zip');
    assert.equal(stage.cwd, '/work/ios');
  });
});

describe('resetStage', () => {
  it('clears a stage left by an earlier attempt and creates the handoff directory', (t) => {
    const root = scratch();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stage = archiveStage({
      runnerTemp: root,
      stageName: 'stage',
      workspace: root,
      archiveName: 'products.zip',
      cwd: root,
    });
    mkdirSync(join(root, 'stage', 'stale'), { recursive: true });
    mkdirSync(join(root, '.example-ci', 'handoff'), { recursive: true });
    writeFileSync(join(root, 'stage', 'stale', 'left-over'), 'x');
    writeFileSync(stage.archive, 'previous attempt');

    resetStage(stage);

    assert.throws(() => requireNonEmptyFile(stage.archive, 'archive'), StepFailure);
    assert.throws(() => requireNonEmptyFile(join(stage.stage, 'stale', 'left-over'), 'stale'), StepFailure);
  });
});

describe('copyIntoStage', () => {
  it('copies the products directory into the stage under its own name', async (t) => {
    const root = scratch();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stage = archiveStage({
      runnerTemp: root, stageName: 'stage', workspace: root, archiveName: 'products.zip', cwd: root,
    });
    resetStage(stage);
    const products = join(root, 'example-ios-tests.xctestproducts');
    mkdirSync(join(products, 'nested'), { recursive: true });
    writeFileSync(join(products, 'nested', 'Info.plist'), 'plist');

    await copyIntoStage(stage, products);

    requireNonEmptyFile(
      join(stage.stage, 'example-ios-tests.xctestproducts', 'nested', 'Info.plist'),
      'copied plist',
    );
  });

  it('fails the step when the products it was told to stage are not there', async (t) => {
    const root = scratch();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stage = archiveStage({
      runnerTemp: root, stageName: 'stage', workspace: root, archiveName: 'products.zip', cwd: root,
    });
    resetStage(stage);
    await assert.rejects(
      () => copyIntoStage(stage, join(root, 'absent.xctestproducts')),
      (error: unknown) => error instanceof StepFailure && error.message.startsWith('::error::'),
    );
  });
});

describe('requireNonEmptyFile', () => {
  it('accepts a file with content and refuses an empty or absent one', (t) => {
    const root = scratch();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const populated = join(root, 'populated');
    const empty = join(root, 'empty');
    writeFileSync(populated, 'x');
    writeFileSync(empty, '');

    requireNonEmptyFile(populated, 'populated');
    assert.throws(
      () => requireNonEmptyFile(empty, 'the archive is empty'),
      (error: unknown) => error instanceof StepFailure
        && error.message === '::error::the archive is empty',
    );
    assert.throws(() => requireNonEmptyFile(join(root, 'absent'), 'absent'), StepFailure);
  });
});

describe('archive producer provenance', () => {
  const valid = {
    schema: 'example-ios-test-product-producer-v1' as const,
    headSha: 'a'.repeat(40),
    runId: '123',
    runAttempt: '2',
    job: 'build-ios-e2e-test-products',
  };

  it('accepts and reads one exact run-attempt producer receipt', (t) => {
    const root = scratch();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'producer-provenance.json'), `${JSON.stringify(valid)}\n`);
    assert.equal(validArchiveProducerProvenance(valid), true);
    assert.deepEqual(readArchiveProducerProvenance(root), valid);
  });

  it('rejects a missing, malformed, or ambiguous producer identity', (t) => {
    const root = scratch();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.equal(readArchiveProducerProvenance(root), null);
    for (const changed of [
      { ...valid, runId: '0' },
      { ...valid, runAttempt: 'attempt-2' },
      { ...valid, job: '../producer' },
      { ...valid, headSha: 'short' },
      { ...valid, schema: 'other' },
    ]) assert.equal(validArchiveProducerProvenance(changed), false);
  });
});

// Validate the real macOS producer/consumer boundary without claiming XCTest execution.
it('seals and restores products with exact-head, producer and real Xcode receipts', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = scratch();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = archiveStage({
    runnerTemp: root, stageName: 'stage', workspace: root, archiveName: 'products.zip', cwd: root,
  });
  resetStage(stage);
  writeFileSync(join(stage.stage, 'product.bin'), Buffer.from([0, 1, 255, 42]));
  const headSha = 'a'.repeat(40);
  const producer = { schema: 'example-ios-test-product-producer-v1' as const, headSha, runId: '123', runAttempt: '2', job: 'build-ios-e2e-test-products' };
  await sealArchive(stage, { headSha, producer });
  const restored = join(root, 'restored');
  const result = await runCommand('ditto', ['-x', '-k', stage.archive, restored], { capture: true });
  assert.equal(result.status, 0, result.stderr);
  const restoredStage = join(restored, 'stage');
  assert.deepEqual(readFileSync(join(restoredStage, 'product.bin')), Buffer.from([0, 1, 255, 42]));
  assert.equal(readFileSync(join(restoredStage, 'exact-head-sha'), 'utf8').trim(), headSha);
  assert.deepEqual(readArchiveProducerProvenance(restoredStage), producer);
  assert.equal(await verifyTestProductToolchainReceipt(join(restoredStage, 'toolchain.json'), headSha), 0);
});

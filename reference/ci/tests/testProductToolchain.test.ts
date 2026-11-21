import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';

import {
  currentTestProductToolchain,
  parseSelectedXcodeToolchain,
  parseTestProductToolchainReceipt,
  readTestProductToolchainReceipt,
  verifyTestProductToolchainReceipt,
  writeTestProductToolchainReceipt,
} from '../src/ios/shared/testProductToolchain.ts';

const head = 'a'.repeat(40);
const receipt = { schemaVersion: 1, headSha: head, xcodeVersion: '27.0', xcodeBuild: '27A266a' };

it('accepts the existing v1 receipt and refuses ambiguous, wrong-head or malformed receipts', () => {
  assert.deepEqual(parseTestProductToolchainReceipt(receipt, head), receipt);
  for (const invalid of [null, [], {}, { ...receipt, extra: true },
    { ...receipt, schemaVersion: true }, { ...receipt, schemaVersion: 2 },
    { ...receipt, headSha: 'b'.repeat(40) }, { ...receipt, xcodeBuild: '27 A266a' },
    { ...receipt, xcodeVersion: 27 }, { ...receipt, xcodeVersion: '27' },
  ]) assert.throws(() => parseTestProductToolchainReceipt(invalid, head));
  for (const invalid of ['short', 'A'.repeat(40), `${head}\n`]) {
    assert.throws(() => parseTestProductToolchainReceipt(receipt, invalid));
  }
});

it('requires the complete two-line Xcode receipt, including the exact build', () => {
  assert.deepEqual(parseSelectedXcodeToolchain('Xcode 27.0\nBuild version 27A266a\n'),
    { xcodeVersion: '27.0', xcodeBuild: '27A266a' });
  for (const invalid of ['Xcode 27.0', 'Xcode 27.0\nBuild version ',
    'Xcode 27.0\nBuild version 27A266a\nextra', 'Xcode 27.x\nBuild version 27A266a',
    'Other 27.0\nBuild version 27A266a',
  ]) assert.throws(() => parseSelectedXcodeToolchain(invalid));
});

it('checks the selected developer directory, preserves the wire receipt and distinguishes rebuilds from corrupt evidence', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'toolchain-receipt-'));
  const oldDirectory = process.env.DEVELOPER_DIR;
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.DEVELOPER_DIR;
    else process.env.DEVELOPER_DIR = oldDirectory;
    rmSync(root, { recursive: true, force: true });
  });
  const executable = join(root, 'usr/bin/xcodebuild');
  mkdirSync(join(root, 'usr/bin'), { recursive: true });
  writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("Xcode 27.0\\nBuild version 27A266a");\n');
  chmodSync(executable, 0o755);
  process.env.DEVELOPER_DIR = root;
  const manifest = join(root, 'stage/toolchain.json');
  await writeTestProductToolchainReceipt(manifest, head);
  assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')), receipt);
  assert.equal(await verifyTestProductToolchainReceipt(manifest, head), 0);
  for (const changed of [{ ...receipt, xcodeBuild: '27A300' }, { ...receipt, xcodeVersion: '27.1' }]) {
    writeFileSync(manifest, JSON.stringify(changed));
    assert.equal(await verifyTestProductToolchainReceipt(manifest, head), 3);
  }
  writeFileSync(manifest, JSON.stringify({ ...receipt, headSha: 'b'.repeat(40) }));
  await assert.rejects(verifyTestProductToolchainReceipt(manifest, head), /producer revision/);
  writeFileSync(manifest, '{truncated');
  assert.throws(() => readTestProductToolchainReceipt(manifest, head), /unreadable/);
  rmSync(manifest);
  await assert.rejects(verifyTestProductToolchainReceipt(manifest, head), /unreadable/);
  writeFileSync(executable, '#!/usr/bin/env node\nprocess.exit(7);\n');
  await assert.rejects(currentTestProductToolchain(), /status 7/);
});

it('writes and verifies a receipt with the locally selected real Xcode', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'toolchain-real-xcode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, 'toolchain.json');
  const selected = await currentTestProductToolchain();
  await writeTestProductToolchainReceipt(manifest, head);
  assert.deepEqual(readTestProductToolchainReceipt(manifest, head), { schemaVersion: 1, headSha: head, ...selected });
  assert.equal(await verifyTestProductToolchainReceipt(manifest, head), 0);
});

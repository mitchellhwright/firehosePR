import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommand } from '../src/ios/shared/processRunner.ts';
import { parseGitChangeInventory } from '../src/prChangeInventory.ts';

test('captured process streams preserve UTF-8 characters split across chunks', async () => {
  const source = `
    const bytes = Buffer.from('R100\\0old café.ts\\0new 📚.ts\\0');
    const diagnostic = Buffer.from('é📚');
    for (let index = 0; index < bytes.length; index += 1) {
      process.stdout.write(bytes.subarray(index, index + 1));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    for (let index = 0; index < diagnostic.length; index += 1) {
      process.stderr.write(diagnostic.subarray(index, index + 1));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  `;
  const result = await runCommand(process.execPath, ['--input-type=module', '-e', source], { capture: true });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, 'é📚');
  assert.deepEqual(parseGitChangeInventory(result.stdout), { changed: ['new 📚.ts'], deleted: ['old café.ts'] });
});

test('captured process streams flush incomplete terminal UTF-8 bytes on close', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xc3])); process.stderr.write(Buffer.from([0xf0, 0x9f]));'], { capture: true });
  assert.deepEqual(result, { status: 0, stdout: '�', stderr: '�' });
});

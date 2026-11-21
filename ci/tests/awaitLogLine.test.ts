import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { awaitLogLine, type LogMatch } from '../src/ios/shared/awaitLogLine.ts';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'firehosepr-typed-log-'));
  const signal = AbortSignal.timeout(3000);
  t.after(async () => { await rm(dir, { force: true, recursive: true }); });
  const log = join(dir, 'log');
  const wait = (match: LogMatch) => awaitLogLine(log, match, signal);
  return { dir, log, wait };
}

test('reads preexisting complete lines and returns the first match', async t => {
  const f = await fixture(t);
  await writeFile(f.log, 'starting\n ✓ Ready in 812ms\nReady again\n');
  assert.equal(await f.wait({ kind: 'regex', pattern: 'Ready in|exited' }), ' ✓ Ready in 812ms');
});

test('subscribes before file creation and consumes immediate writes without a startup gap', async t => {
  const f = await fixture(t);
  const pending = f.wait({ kind: 'literal', text: 'ready' });
  await writeFile(f.log, 'starting\nready\n');
  assert.equal(await pending, 'ready');
});

test('waits for a complete appended line and accepts an exit sentinel', async t => {
  const f = await fixture(t);
  await writeFile(f.log, 'starting\n');
  const pending = f.wait({ kind: 'regex', pattern: 'Ready in|dev backend exited' });
  let complete = false;
  void pending.then(() => { complete = true; });
  await appendFile(f.log, 'supervisor: dev backend exited with 1');
  await delay(30);
  assert.equal(complete, false, 'a partial record must not report readiness');
  await appendFile(f.log, '\n');
  assert.equal(await pending, 'supervisor: dev backend exited with 1');
});

test('matches recording markers literally including regex metacharacters', async t => {
  const f = await fixture(t);
  const marker = "Test Case '-[Suite.Klass testFlow]' passed (";
  await writeFile(f.log, `${marker}12.3 seconds).\n`);
  assert.equal(await f.wait({ kind: 'literal', text: marker }), `${marker}12.3 seconds).`);
});

test('decodes UTF-8 split across writes and reads past 64KB', async t => {
  const f = await fixture(t);
  await writeFile(f.log, 'unrelated\n'.repeat(10000));
  const pending = f.wait({ kind: 'literal', text: '✓ ready' });
  const bytes = Buffer.from('✓ ready\n');
  await appendFile(f.log, bytes.subarray(0, 1));
  await delay(30);
  await appendFile(f.log, bytes.subarray(1));
  assert.equal(await pending, '✓ ready');
});

test('follows replacement at the same filename without retaining the old partial line', async t => {
  const f = await fixture(t);
  await writeFile(f.log, 'stale prefix');
  const pending = f.wait({ kind: 'literal', text: 'ready' });
  await delay(30);
  await rename(f.log, join(f.dir, 'old'));
  await writeFile(f.log, 'ready\n');
  assert.equal(await pending, 'ready');
});

test('follows a replacement directory without relying on filesystem events', async t => {
  const f = await fixture(t);
  const watched = join(f.dir, 'watched');
  const moved = join(f.dir, 'detached-watched');
  const log = join(watched, 'log');
  await mkdir(watched);
  await writeFile(log, 'starting\n');
  const pending = awaitLogLine(log, { kind: 'literal', text: 'ready' }, AbortSignal.timeout(3000));
  await delay(30);

  // Replacing a watched directory detaches native filesystem watchers from the
  // path. The bounded scanner must still find the readiness record.
  await rename(watched, moved);
  await mkdir(watched);
  await writeFile(log, 'ready\n');

  assert.equal(await pending, 'ready');
});

test('resets the cursor when the log is truncated', async t => {
  const f = await fixture(t);
  await writeFile(f.log, 'starting\n'.repeat(100));
  const pending = f.wait({ kind: 'literal', text: 'ready' });
  await delay(30);
  await truncate(f.log, 0);
  await appendFile(f.log, 'ready\n');
  assert.equal(await pending, 'ready');
});

test('abort before or during a wait rejects without leaving a timer alive', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = awaitLogLine(f.log, { kind: 'literal', text: 'ready' }, controller.signal);
  const rejected = assert.rejects(pending, /stopped/);
  controller.abort(new Error('stopped'));
  await rejected;
  await assert.rejects(awaitLogLine(f.log, { kind: 'literal', text: 'ready' }, controller.signal), /stopped/);
});

test('invalid regex, missing parent directory and non-file paths fail promptly', async t => {
  const f = await fixture(t);
  assert.throws(() => f.wait({ kind: 'regex', pattern: '[' }));
  await assert.rejects(awaitLogLine(join(f.dir, 'missing', 'log'), { kind: 'literal', text: 'ready' }), /ENOENT/);
  await mkdir(f.log);
  await assert.rejects(f.wait({ kind: 'literal', text: 'ready' }), /not a regular file/);
});

test('the TypeScript CLI prints a literal match and exits without a live watcher', async t => {
  const f = await fixture(t);
  await writeFile(f.log, 'prefix [ready]\n');
  const entrypoint = fileURLToPath(new URL('../src/actions/awaitLogLine.ts', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [entrypoint, '-F', f.log, '[ready]'], {
    timeout: 3000,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(result.stdout, 'prefix [ready]\n');
  assert.equal(result.stderr, '');
});

for (const replacementSize of [200, 400]) {
  test(`same-inode rewrite of ${replacementSize} bytes cannot hide readiness before the old cursor`, async t => {
    const f = await fixture(t);
    await writeFile(f.log, 'x'.repeat(199) + '\n');
    const pending = f.wait({ kind: 'literal', text: 'READY' });
    await delay(60);
    // One synchronous rewrite coalesces truncate and growth before the next
    // watcher callback. The new size never appears smaller to the waiter.
    writeFileSync(f.log, 'READY\n' + 'x'.repeat(replacementSize - 7) + '\n');
    assert.equal(await pending, 'READY');
  });
}
test('a rewrite with unchanged prefix and suffix still detects a new middle line', async t => {
  const f = await fixture(t);
  const prefix = 'prefix\n'.repeat(10000), suffix = 'suffix\n'.repeat(10000);
  await writeFile(f.log, prefix + 'starting\n' + suffix);
  const pending = f.wait({ kind: 'literal', text: 'READY' });
  await delay(60);
  writeFileSync(f.log, prefix + 'READY!!!\n' + suffix);
  assert.equal(await pending, 'READY!!!');
});

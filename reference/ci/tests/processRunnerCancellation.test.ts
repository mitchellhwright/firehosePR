import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/cancelledProcessRunner.ts', import.meta.url));

for (const [signal, expectedStatus] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  test(`${signal} permits cleanup commands during asynchronous process teardown`, { timeout: 10_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ios-process-cancel-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const resultPath = join(root, 'result');
    const child = spawn(process.execPath, [fixture, signal, resultPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill('SIGKILL'));
    const [code, exitSignal] = await once(child, 'exit');
    assert.equal(exitSignal, null);
    assert.equal(code, expectedStatus);
    assert.equal(existsSync(resultPath), true, 'the fixture must attempt the post-signal command');
    assert.equal(readFileSync(resultPath, 'utf8'), '0');
  });
}

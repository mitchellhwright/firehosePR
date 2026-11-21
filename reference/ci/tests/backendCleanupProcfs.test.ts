import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cleanup = fileURLToPath(new URL('../../scripts/stop-onboarding-dev-backend.sh', import.meta.url));

test('Linux cleanup retains ownership of a live listener whose cwd was deleted', {
  skip: process.platform !== 'linux', timeout: 10_000,
}, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'example-deleted-cwd-'));
  const cwd = join(workspace, 'build');
  mkdirSync(cwd);
  const child = spawn(process.execPath, ['-e', `
    const server = require('node:net').createServer();
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(workspace, { recursive: true, force: true });
  });
  assert.ok(child.pid);
  let output = '';
  for await (const chunk of child.stdout) {
    output += String(chunk);
    if (output.includes('\n')) break;
  }
  const port = Number(output.trim());
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  rmSync(cwd, { recursive: true });
  assert.equal(readlinkSync(`/proc/${child.pid}/cwd`), `${cwd} (deleted)`);
  const pidFile = join(workspace, 'backend.pid');
  writeFileSync(pidFile, String(child.pid));
  const exited = once(child, 'exit');
  const result = spawnSync('bash', [cleanup], {
    encoding: 'utf8', timeout: 5000,
    env: {
      ...process.env,
      ONBOARDING_DEV_BACKEND_WORKSPACE: workspace,
      ONBOARDING_DEV_BACKEND_PORT: String(port),
      ONBOARDING_DEV_BACKEND_PID_FILE: pidFile,
      ONBOARDING_DEV_BACKEND_SUPERVISOR_PID: '',
      // The real backend runs in a recorded process group. That ownership
      // evidence also lets cleanup handle Linux hosts where ss hides socket PIDs.
      ONBOARDING_DEV_BACKEND_PROCESS_GROUP_ID: String(child.pid),
      ONBOARDING_DEV_BACKEND_CLEANUP_CHECKS: '5',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
});

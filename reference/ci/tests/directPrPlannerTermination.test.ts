import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { awaitLogLine } from '../src/ios/shared/awaitLogLine.ts';

const planner = fileURLToPath(new URL('../src/actions/planPrValidation.ts', import.meta.url));
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`direct typed PR planner reaps its Git child on ${signal}`, { timeout: 30_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'example-direct-pr-planner-'));
    const fetchMarker = join(root, 'fetch-pid');
    const changed = join(root, 'changed');
    const deleted = join(root, 'deleted');
    const output = join(root, 'output');
    writeFileSync(changed, 'scripts/affected.sh\n');
    writeFileSync(deleted, '');
    writeFileSync(output, '');
    const git = join(root, 'git');
    writeFileSync(git, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const command = process.argv[2];
if (command === 'rev-parse') { process.stdout.write('${baseSha}\\n'); process.exit(0); }
if (command === 'update-ref') process.exit(0);
if (command === 'fetch') {
  writeFileSync(process.env.GIT_STALL_MARKER, String(process.pid) + '\\n');
  setInterval(() => {}, 60_000);
} else process.exit(1);
`);
    chmodSync(git, 0o755);
    const child = spawn(process.execPath, [planner], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ''}`,
        GIT_STALL_MARKER: fetchMarker,
        GITHUB_OUTPUT: output,
        INPUT_CHANGED_FILES_FILE: changed,
        INPUT_DELETED_FILES_FILE: deleted,
        INPUT_TEST_RUNTIME_CONTRACTS_FILE: resolve('ci/contracts/server-test-runtimes.json'),
        INPUT_METADATA_ONLY: 'false',
        INPUT_BASE_DELTA_ROUTE: 'false',
        INPUT_REPOSITORY: 'example-org/example-app',
        INPUT_TRUSTED_SCRIPT_SOURCE_SHA: baseSha,
        INPUT_HEAD_SHA: headSha,
        INPUT_GITHUB_TOKEN: 'test-token',
        INPUT_PR_NUMBER: '123',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    t.after(() => {
      child.kill('SIGKILL');
      if (existsSync(fetchMarker)) {
        const gitPid = Number(readFileSync(fetchMarker, 'utf8'));
        if (Number.isSafeInteger(gitPid) && gitPid > 0) {
          try { process.kill(-gitPid, 'SIGKILL'); } catch { /* Already reaped. */ }
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      rmSync(root, { recursive: true, force: true });
    });
    const exited = once(child, 'exit');
    // Creation precedes write completion on Linux: wait for a complete positive PID record.
    const gitPid = Number(await awaitLogLine(fetchMarker,
      { kind: 'regex', pattern: '^[1-9][0-9]*$' }, AbortSignal.timeout(15_000)));
    assert.ok(Number.isSafeInteger(gitPid) && gitPid > 0);
    child.kill(signal);
    const [code] = await exited;
    assert.equal(code, signal === 'SIGINT' ? 130 : 143, stderr);
    assert.throws(() => process.kill(gitPid, 0), { code: 'ESRCH' });
  });
}

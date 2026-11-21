import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPlaidSchedulerDriftAction } from '../src/actions/provePlaidSchedulerSchemaDrift.ts';
import { provePlaidSchedulerSchemaDrift } from '../src/plaidSchedulerSchemaDrift.ts';

for (const { command, program: expectedProgram, prefix } of [
  { command: 'docker', program: 'docker', prefix: [] },
  { command: 'sudo -n docker', program: 'sudo', prefix: ['-n', 'docker'] },
  { command: 'podman', program: 'podman', prefix: [] },
  { command: 'sudo -n podman', program: 'sudo', prefix: ['-n', 'podman'] },
] as const) test(`drift adapter invokes ${command} with literal arguments`, async () => {
  const commands: { program: string; args: readonly string[] }[] = [];
  const logs: { path: string; contents: string }[] = [];
  const env = { DB_CONTAINER_CMD: command, DB_CONTAINER_NAME: 'fixture;literal', RUNNER_TEMP: '/fixture/temp' };
  const status = await runPlaidSchedulerDriftAction(env, async (program, args, options) => {
    commands.push({ program, args });
    assert.equal(options?.env, env);
    if (program === 'npm') {
      assert.deepEqual(args, ['run', 'db:verify-plaid-scheduler']);
      assert.equal(options?.capture, true);
      return { status: 0, stdout: 'unexpected acceptance', stderr: '' };
    }
    assert.equal(program, expectedProgram);
    assert.deepEqual(args.slice(0, -1), [...prefix, 'exec', env.DB_CONTAINER_NAME, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'example', '-c']);
    return { status: 0, stdout: '', stderr: '' };
  }, (path, contents) => logs.push({ path, contents }), () => {});
  assert.equal(status, 1);
  assert.equal(commands.length, 19);
  assert.deepEqual(logs, [{ path: '/fixture/temp/plaid-scheduler-drift-verifier.log', contents: 'unexpected acceptance' }]);
});

test('drift adapter rejects an unsupported container command before mutating the schema', async () => {
  const env = { DB_CONTAINER_CMD: 'docker; unexpected', DB_CONTAINER_NAME: 'fixture', RUNNER_TEMP: '/fixture/temp' };
  await assert.rejects(runPlaidSchedulerDriftAction(env), /Unsupported DB_CONTAINER_CMD/);
});

test('SIGTERM restores successful drift before the action exits', { timeout: 10_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'plaid-drift-signal-'));
  const events = join(directory, 'events');
  writeFileSync(events, '');
  writeFileSync(join(directory, 'docker'), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const sql = process.argv.at(-1);
appendFileSync(process.env.EVENTS, sql + '\\n');
if (sql.includes('RENAME TO heartbeat_plaid_scheduler_lease_expected')) {
  console.log('READY');
  setInterval(() => {}, 1000);
}
`, { mode: 0o755 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/actions/provePlaidSchedulerSchemaDrift.ts', import.meta.url))], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ''}`,
      DB_CONTAINER_CMD: 'docker',
      DB_CONTAINER_NAME: 'fixture',
      RUNNER_TEMP: directory,
      EVENTS: events,
    },
  });
  t.after(() => {
    child.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  });
  const exited = once(child, 'exit');
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Drift action exited before the second SQL command')));
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('READY')) resolve();
    });
  });
  child.kill('SIGTERM');
  const [status] = await exited;
  assert.equal(status, 143);
  assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n'), [
    'ALTER FUNCTION public.complete_plaid_scheduler_lease(uuid, integer, uuid) SET search_path TO pg_catalog',
    'ALTER FUNCTION public.heartbeat_plaid_scheduler_lease(uuid, integer, uuid, integer) RENAME TO heartbeat_plaid_scheduler_lease_expected',
    'ALTER FUNCTION public.complete_plaid_scheduler_lease(uuid, integer, uuid) RESET ALL',
  ]);
});

test('thrown setup errors restore earlier successful mutations before escaping', async () => {
  const sql: string[] = [];
  await assert.rejects(provePlaidSchedulerSchemaDrift({
    sql: async (statement) => {
      sql.push(statement);
      if (sql.length === 2) throw new Error('connection lost');
      return 0;
    },
    verify: async () => { throw new Error('verification must not run'); },
    writeVerifierLog: () => {}, log: () => {},
  }), /connection lost/);
  assert.equal(sql.length, 3);
  assert.equal(sql[2], 'ALTER FUNCTION public.complete_plaid_scheduler_lease(uuid, integer, uuid) RESET ALL');
});

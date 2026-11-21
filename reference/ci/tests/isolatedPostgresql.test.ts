import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ensureContainerEngine, type EngineSetupIo } from '../src/containerEngineCommand.ts';
import { runCommand, type CommandResult, type RunOptions } from '../src/ios/shared/processRunner.ts';
import {
  createSiblingDatabase, laneDatabase, POSTGRES_IMAGE, publishedPort, siblingDatabaseUrl,
  startIsolatedPostgresql,
} from '../src/isolatedPostgresql.ts';

interface Call { readonly command: string; readonly args: readonly string[]; readonly options: RunOptions }

function fakeRun(answer: (call: Call) => Partial<CommandResult> = () => ({})) {
  const calls: Call[] = [];
  const run = async (command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> => {
    const call = { command, args, options };
    calls.push(call);
    return { status: 0, stdout: '', stderr: '', ...answer(call) };
  };
  return { calls, run };
}

const line = (call: Call) => [call.command, ...call.args].join(' ');

function engineIo(
  answer: (call: Call) => Partial<CommandResult>,
  managers: readonly string[] = [],
): { io: EngineSetupIo; calls: Call[] } {
  const { calls, run } = fakeRun(answer);
  return { calls, io: { run, installed: (name) => managers.includes(name), env: {} } };
}

test('engine resolution tries unprivileged then non-interactive sudo forms, in order', async () => {
  const { io, calls } = engineIo((call) => ({ status: line(call) === 'podman info' ? 0 : 1 }));
  assert.equal(await ensureContainerEngine(io), 'podman');
  assert.deepEqual(calls.map(line), ['docker info', 'sudo -n docker info', 'podman info']);
  assert.ok(calls.every((call) => call.options.capture === true));
});

test('a runner without an engine installs Docker with apt and falls back to the SysV service', async () => {
  let installed = false;
  const { io, calls } = engineIo((call) => {
    const command = line(call);
    if (command.endsWith('apt-get install -y docker.io')) installed = true;
    if (command === 'sudo -n systemctl start docker') return { status: 1 };
    if (command.endsWith(' info')) return { status: installed && command === 'sudo -n docker info' ? 0 : 1 };
    return { status: 0 };
  }, ['apt-get', 'dnf']);
  assert.equal(await ensureContainerEngine(io), 'sudo -n docker');
  assert.deepEqual(calls.map(line).filter((command) => !command.endsWith(' info')), [
    'sudo -n true',
    'sudo -n apt-get update',
    'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io',
    'sudo -n systemctl start docker',
    'sudo -n service docker start',
  ]);
});

test('dnf and yum hosts install Podman', async () => {
  for (const manager of ['dnf', 'yum']) {
    let installed = false;
    const { io, calls } = engineIo((call) => {
      if (line(call) === `sudo -n ${manager} install -y podman`) installed = true;
      if (line(call).endsWith(' info')) return { status: installed && line(call) === 'podman info' ? 0 : 1 };
      return { status: 0 };
    }, [manager]);
    assert.equal(await ensureContainerEngine(io), 'podman', manager);
    assert.ok(calls.map(line).includes(`sudo -n ${manager} install -y podman`), manager);
  }
});

test('engine setup fails with the reason it could not provide an engine', async () => {
  const unavailable = (call: Call) => ({ status: line(call).endsWith(' info') ? 1 : 0 });
  await assert.rejects(ensureContainerEngine(engineIo((call) => ({
    status: line(call) === 'sudo -n true' || line(call).endsWith(' info') ? 1 : 0,
  }), ['apt-get']).io), /cannot install one without interaction/);
  await assert.rejects(ensureContainerEngine(engineIo(unavailable).io),
    /No supported package manager is available/);
  await assert.rejects(ensureContainerEngine(engineIo(unavailable, ['yum']).io),
    /installation completed but the engine is still unavailable/);
  const failedUpdate = engineIo((call) => ({
    status: line(call).endsWith(' info') || line(call) === 'sudo -n apt-get update' ? 100 : 0,
  }), ['apt-get']);
  await assert.rejects(ensureContainerEngine(failedUpdate.io), /sudo -n apt-get update failed with exit 100/);
  assert.equal(failedUpdate.calls.some((call) => line(call).includes('install')), false);
});

const startEnv = { DB_CONTAINER_CMD: 'sudo -n podman', GITHUB_JOB: 'database-integration', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' };
const container = 'gh-actions-pg-database-integration-42-2';

test('starting PostgreSQL replaces a stale container and exports how to reach the new one', async () => {
  const exported: Record<string, string>[] = [];
  const { calls, run } = fakeRun((call) => (call.args.includes('port') ? { stdout: '127.0.0.1:49153\n' } : {}));
  await startIsolatedPostgresql(startEnv, { run, now: () => 1_700_000_000_999, exportEnv: (entries) => { exported.push({ ...entries }); } });
  assert.deepEqual(calls.map(line), [
    `sudo -n podman rm -f ${container}`,
    `sudo -n podman run -d --name ${container} --health-cmd pg_isready -U postgres -d example --health-interval 1s `
      + '--health-retries 30 -e POSTGRES_DB=example -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres '
      + `-p 127.0.0.1::5432 ${POSTGRES_IMAGE}`,
    `sudo -n podman port ${container} 5432/tcp`,
  ]);
  assert.equal(calls[1]?.args.includes('pg_isready -U postgres -d example'), true, 'the health command is one argument');
  assert.deepEqual(exported, [
    { DB_CONTAINER_NAME: container, DB_STARTED_AT: '1700000000' },
    {
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:49153/example',
      DB_HOST: '127.0.0.1', DB_PORT: '49153', DB_USER: 'postgres', DB_PASSWORD: 'postgres', DB_NAME: 'example',
    },
  ]);
});

test('a container that fails to start exports nothing; an unresolved port still leaves it removable', async () => {
  const exported: Record<string, string>[] = [];
  const io = (answer: (call: Call) => Partial<CommandResult>) => ({
    run: fakeRun(answer).run, now: () => 0, exportEnv: (entries: Record<string, string>) => { exported.push(entries); },
  });
  await assert.rejects(startIsolatedPostgresql(startEnv, io((call) => ({ status: call.args.includes('run') ? 125 : 0 }))),
    /failed to start \(exit 125\)/);
  assert.deepEqual(exported, []);
  await assert.rejects(startIsolatedPostgresql(startEnv, io((call) => (call.args.includes('port')
    ? { status: 1, stderr: 'no public port\n' } : {}))), /Unable to resolve the PostgreSQL host port \(exit 1\): no public port/);
  assert.deepEqual(exported.map((entries) => entries['DB_CONTAINER_NAME']), [container]);
  await assert.rejects(startIsolatedPostgresql({ ...startEnv, DB_CONTAINER_CMD: 'docker; rm -rf /' }, io(() => ({}))),
    /Unsupported DB_CONTAINER_CMD/);
});

test('the published port is the last field of the first line', () => {
  assert.equal(publishedPort('127.0.0.1:49153\n'), '49153');
  assert.equal(publishedPort('[::]:5433\n0.0.0.0:5434\n'), '5433');
  for (const output of ['', '127.0.0.1:\n', '127.0.0.1:port\n']) {
    assert.throws(() => publishedPort(output), /Unable to resolve the PostgreSQL host port/, output);
  }
});

test('sibling databases share the primary server and reject names that are not identifiers', async () => {
  assert.equal(siblingDatabaseUrl('postgresql://u:p@h:1/example', 'x_qa'), 'postgresql://u:p@h:1/x_qa');
  assert.equal(siblingDatabaseUrl('postgresql://u:p@h:1/other', 'x_qa'), 'postgresql://u:p@h:1/other/x_qa');
  const { calls, run } = fakeRun();
  const lane = laneDatabase({
    DB_CONTAINER_CMD: 'docker', DB_CONTAINER_NAME: 'pg', DATABASE_URL: 'postgresql://u:p@h:1/example',
  }, run);
  assert.equal(await createSiblingDatabase(lane, 'runtime_sql_qa'), 'postgresql://u:p@h:1/runtime_sql_qa');
  await assert.rejects(createSiblingDatabase(lane, 'x; DROP DATABASE example'), /Invalid database name/);
  assert.deepEqual(calls.map(line), ['docker exec pg psql -v ON_ERROR_STOP=1 -U postgres -d example -c CREATE DATABASE runtime_sql_qa']);
});

test('a process can read its standard input from a file', async (t) => {
  const directory = workspace(t);
  const input = join(directory, 'input.sql');
  writeFileSync(input, 'CREATE TABLE users (id uuid);\n');
  const result = await runCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    capture: true, stdinFile: input,
  });
  assert.deepEqual(result, { status: 0, stdout: 'CREATE TABLE users (id uuid);\n', stderr: '' });
});

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'isolated-postgresql-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('the typed entries hand the engine, container and URL to later steps through GitHub files', (t) => {
  const directory = workspace(t);
  const events = join(directory, 'events');
  writeFileSync(join(directory, 'docker'), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.EVENTS, args.join(' ') + '\\n');
if (args[0] === 'port') console.log('127.0.0.1:49153');
if (args[0] === 'rm' && process.env.FAIL_REMOVE) { console.error('engine unavailable'); process.exit(1); }
`, { mode: 0o755 });
  const githubEnv = join(directory, 'env');
  writeFileSync(githubEnv, '');
  const entry = (name: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, [
    fileURLToPath(new URL(`../src/actions/${name}.ts`, import.meta.url)),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env['PATH'] ?? ''}`,
      EVENTS: events, GITHUB_ENV: githubEnv,
      GITHUB_JOB: 'database-integration', GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1',
      NODE_NO_WARNINGS: '1',
      ...extra,
    },
  });

  const exported = () => Object.fromEntries(readFileSync(githubEnv, 'utf8').trim().split('\n')
    .map((entryLine) => entryLine.split(/=(.*)/s).slice(0, 2)));
  const engine = entry('ensureContainerEngine');
  assert.equal(engine.status, 0, engine.stderr);
  assert.deepEqual(exported(), { DB_CONTAINER_CMD: 'docker' });

  // GitHub loads $GITHUB_ENV into every later step's environment.
  const started = entry('startIsolatedPostgresql', exported());
  assert.equal(started.status, 0, started.stderr);
  assert.equal(exported()['DB_CONTAINER_NAME'], 'gh-actions-pg-database-integration-7-1');
  assert.equal(exported()['DATABASE_URL'], 'postgresql://postgres:postgres@127.0.0.1:49153/example');

  const lane = { DB_CONTAINER_CMD: 'docker', DB_CONTAINER_NAME: 'gh-actions-pg-database-integration-7-1' };
  const removed = entry('removePostgresqlContainer', lane);
  assert.equal(removed.status, 0, removed.stderr);
  const failedRemoval = entry('removePostgresqlContainer', { ...lane, FAIL_REMOVE: '1' });
  assert.equal(failedRemoval.status, 0, 'cleanup never fails the finished lane');
  assert.match(failedRemoval.stdout, /::warning::Could not remove PostgreSQL container .* engine unavailable/);
  assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n').map((event) => event.split(' ')[0]),
    ['info', 'rm', 'run', 'port', 'rm', 'rm']);
});

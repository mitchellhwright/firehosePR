import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { runPostgresqlHealthAction } from '../src/actions/awaitPostgresqlHealth.ts';
import type { CommandResult } from '../src/ios/shared/processRunner.ts';
import { awaitPostgresqlHealth, parseContainerState } from '../src/postgresqlHealth.ts';
import { prChecks } from '../workflows/pr-checks.ts';

const inspectState = (state: Record<string, unknown>) => JSON.stringify([{ State: state }]);
const healthy: CommandResult = {
  status: 0,
  stdout: inspectState({ Running: true, Health: { Status: 'healthy' } }),
  stderr: '',
};
const environment = {
  DB_CONTAINER_NAME: 'literal;container',
  DB_STARTED_AT: '1000',
};

for (const { value, program, prefix } of [
  { value: 'docker', program: 'docker', prefix: [] },
  { value: 'sudo -n docker', program: 'sudo', prefix: ['-n', 'docker'] },
  { value: 'podman', program: 'podman', prefix: [] },
  { value: 'sudo -n podman', program: 'sudo', prefix: ['-n', 'podman'] },
] as const) test(`current health inspection invokes ${value} with literal arguments`, async () => {
  const calls: { program: string; args: readonly string[] }[] = [];
  const output: string[] = [];
  const status = await runPostgresqlHealthAction(
    { ...environment, DB_CONTAINER_CMD: value },
    async (command, args, options) => {
      calls.push({ program: command, args });
      assert.ok(options);
      assert.equal(options.capture, true);
      return value.includes('podman')
        ? { ...healthy, stdout: inspectState({ Running: true, Healthcheck: { Status: 'healthy' } }) }
        : healthy;
    },
    // A healthy container must pass even after a slow checkout or install
    // consumed the original 120-second startup budget.
    () => 1_200_000,
    async () => { throw new Error('A healthy container must not wait'); },
    (line) => output.push(line),
  );
  assert.equal(status, 0);
  assert.deepEqual(calls, [{
    program,
    args: [...prefix, 'inspect', environment.DB_CONTAINER_NAME],
  }]);
  assert.deepEqual(output, ['PostgreSQL container is healthy.']);
});

test('starting health is rechecked only within the original startup budget', async () => {
  let now = 119_500;
  let reads = 0;
  const waits: number[] = [];
  await assert.rejects(awaitPostgresqlHealth(0, {
    inspect: async () => { reads += 1; return { running: true, health: 'starting' }; },
    now: () => now,
    sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
  }), /remained starting after the 120-second health budget/);
  assert.equal(reads, 2);
  assert.deepEqual(waits, [500]);
});

test('a later healthy state succeeds without waiting for an event', async () => {
  let reads = 0;
  await awaitPostgresqlHealth(0, {
    inspect: async () => {
      reads += 1;
      return { running: true, health: reads === 1 ? 'starting' : 'healthy' };
    },
    now: () => 1_000,
    sleep: async (milliseconds) => { assert.equal(milliseconds, 1_000); },
  });
  assert.equal(reads, 2);
});

test('Docker and Podman inspect shapes yield the same current health', () => {
  for (const field of ['Health', 'Healthcheck']) {
    assert.deepEqual(parseContainerState(inspectState({ Running: true, [field]: { Status: 'healthy' } })), {
      running: true,
      health: 'healthy',
    });
  }
  assert.deepEqual(parseContainerState(inspectState({
    Running: true,
    Health: { Status: '' },
    Healthcheck: { Status: 'healthy' },
  })), { running: true, health: 'healthy' });
});

test('unhealthy, stopped, and malformed states fail closed', async () => {
  for (const input of [
    'not JSON',
    '[]',
    inspectState({ Running: 'true', Health: { Status: 'healthy' } }),
    inspectState({ Running: true, Health: { Status: 'missing' } }),
    inspectState({ Running: true, Health: 'healthy' }),
    inspectState({ Running: true }),
    inspectState({ Running: true, Health: { Status: 'healthy' }, Healthcheck: { Status: 'unhealthy' } }),
  ]) {
    assert.throws(() => parseContainerState(input));
  }
  for (const [state, expected] of [
    [{ running: true, health: 'unhealthy' }, /became unhealthy/],
    [{ running: false, health: 'healthy' }, /stopped with health healthy/],
  ] as const) {
    await assert.rejects(awaitPostgresqlHealth(0, {
      inspect: async () => state,
      now: () => 0,
      sleep: async () => { throw new Error('Terminal state must not wait'); },
    }), expected);
  }
});

test('engine failure reports inspect error and container logs without hiding failure', async () => {
  const calls: string[][] = [];
  const errors: string[] = [];
  const status = await runPostgresqlHealthAction(
    { ...environment, DB_CONTAINER_CMD: 'docker' },
    async (_command, args) => {
      calls.push([...args]);
      return args[0] === 'inspect'
        ? { status: 1, stdout: '', stderr: 'daemon unavailable\n' }
        : { status: 0, stdout: 'database log\n', stderr: '' };
    },
    () => 1_000_000,
    async () => {},
    () => {},
    (line) => errors.push(line),
  );
  assert.equal(status, 1);
  assert.deepEqual(calls.map((args) => args[0]), ['inspect', 'logs']);
  assert.match(errors.join('\n'), /Container inspect failed \(exit 1\): daemon unavailable/);
  assert.match(errors.join('\n'), /database log/);
});

test('the generated workflow executes the typed state check and retires the event script', () => {
  const job = prChecks.config.jobs.find((candidate) => candidate.id === 'database-integration');
  assert.ok(job);
  const health = job.config.steps.find((step) => step.config.name === 'Await PostgreSQL health');
  assert.ok(health);
  assert.equal(health.config.command, 'node ci/src/actions/awaitPostgresqlHealth.ts');
  assert.equal(existsSync('scripts/ci/pr-checks/database-integration/await-postgresql-health.sh'), false);
});

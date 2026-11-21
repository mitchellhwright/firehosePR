import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { awaitPostgresqlHealth, parseContainerState } from '../../src/postgresqlHealth.ts';
import {
  installSignalTraps, isProcessTerminating, runCommand, type RunProcess,
} from '../../src/ios/shared/processRunner.ts';

export const defaultPrimaryImage = 'example-primary-container:test';

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Validate the engine's external metadata before any security probe executes. */
export function primaryImageId(output: string): string {
  const image = record(JSON.parse(output) as unknown);
  assert.equal(typeof image.Id, 'string');
  assert.match(String(image.Id), /^sha256:[a-f0-9]{64}$/);
  const config = record(image.Config);
  assert.equal(config.User, '10001:10001');
  assert.ok(Object.hasOwn(record(config.ExposedPorts), '8080/tcp'));
  const health = record(config.Healthcheck).Test;
  assert.ok(Array.isArray(health) && health.every(item => typeof item === 'string')
    && health.some(item => item.includes('/health')));
  assert.equal(config.StopSignal, 'SIGTERM');
  return String(image.Id);
}

export interface PrimarySmokeIo {
  readonly run: RunProcess;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly docker: string;
  readonly probeSource: string;
  readonly env: NodeJS.ProcessEnv;
  readonly containerName: string;
  readonly terminating: () => boolean;
  readonly log: (message: string) => void;
}

/** One lifecycle owner; cleanup is idempotent across failure and cancellation. */
export function primaryContainerSmoke(io: PrimarySmokeIo): {
  readonly run: (image?: string) => Promise<void>;
  readonly cleanup: () => Promise<void>;
} {
  assert.match(io.containerName, /^example-primary-smoke-[a-f0-9-]+$/);
  const owned = new Set<string>();
  const removals = new Map<string, Promise<void>>();
  const remove = (name: string): Promise<void> => {
    const pending = removals.get(name);
    if (pending !== undefined) return pending;
    if (!owned.delete(name)) return Promise.resolve();
    const removal = (async () => {
      const removed = await io.run(io.docker, ['rm', '-f', name], { capture: true, timeoutMs: 10_000, env: io.env });
      if (removed.status !== 0) io.log(`Container cleanup failed: ${removed.stderr.trim()}`);
    })();
    removals.set(name, removal);
    return removal;
  };
  let cleaning: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    if (cleaning !== undefined) return cleaning;
    if (owned.size === 0 && removals.size === 0) return Promise.resolve();
    cleaning = (async () => {
      const options = { capture: true, timeoutMs: 10_000, env: io.env };
      if (owned.has(io.containerName)) {
        const logs = await io.run(io.docker, ['logs', '--tail', '40', io.containerName], options);
        if (logs.stdout || logs.stderr) io.log(logs.stdout + logs.stderr);
      }
      await Promise.all([...owned].map(remove));
      await Promise.all(removals.values());
    })();
    return cleaning;
  };
  const command = async (args: readonly string[], stdinFile?: string, timeoutMs = 30_000): Promise<string> => {
    if (io.terminating()) throw new Error('Primary container smoke was cancelled');
    const result = await io.run(io.docker, args, { capture: true, timeoutMs, env: io.env,
      ...(stdinFile === undefined ? {} : { stdinFile }) });
    if (result.status !== 0) throw new Error(`Docker ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  const probe = async (image: string, mode: 'image-permissions' | 'package-managers'): Promise<string> => {
    const name = `${io.containerName}-${mode}`;
    owned.add(name);
    try {
      return await command(['run', '--name', name, '--interactive', '--entrypoint', 'node', image,
        '--input-type=module-typescript', '-', mode], io.probeSource);
    } finally {
      await remove(name);
    }
  };
  return {
    cleanup,
    run: async (selectedImage?: string): Promise<void> => {
      const image = selectedImage ?? defaultPrimaryImage;
      assert.match(image, /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/);
      if (selectedImage === undefined) await command(['build', '--tag', image, '.'], undefined, 1_200_000);
      else {
        const present = await io.run(io.docker, ['image', 'inspect', image], { capture: true, env: io.env, timeoutMs: 30_000 });
        if (present.status !== 0) await command(['build', '--tag', image, '.'], undefined, 1_200_000);
      }
      const id = primaryImageId(await command(['image', 'inspect', '--format', '{{json .}}', image]));
      await probe(id, 'image-permissions');
      await probe(id, 'package-managers');
      const startedAt = io.now();
      // Record ownership before starting Docker, including when its response is lost.
      owned.add(io.containerName);
      try {
        await command(['run', '--detach', '--name', io.containerName,
          '--health-interval', '1s', '--health-retries', '60', '--read-only', '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--tmpfs', '/tmp/example:rw,noexec,nosuid,nodev,mode=0700,uid=10001,gid=10001',
          '--tmpfs', '/app/.next/cache:rw,noexec,nosuid,nodev,mode=0700,uid=10001,gid=10001', id]);
        await awaitPostgresqlHealth(startedAt, {
          inspect: async () => parseContainerState(await command(['inspect', io.containerName], undefined, 5_000)),
          now: io.now, sleep: io.sleep, label: 'Primary runtime',
        });
        for (const mode of ['health', 'runtime-permissions', 'head'] as const) {
          await command(['exec', '--interactive', io.containerName, 'node',
            '--input-type=module-typescript', '-', mode], io.probeSource);
        }
        const stoppingAt = io.now();
        await command(['stop', '--time', '10', io.containerName], undefined, 15_000);
        assert.ok(io.now() - stoppingAt <= 11_000, 'Container exceeded the shutdown deadline');
        const exitCode = await command(['inspect', '--format', '{{.State.ExitCode}}', io.containerName]);
        assert.ok(exitCode === '0' || exitCode === '143', `Unexpected shutdown exit code ${exitCode}`);
        await command(['rm', io.containerName]);
        owned.delete(io.containerName);
        io.log(`Primary container security smoke passed for ${image} (${id}).`);
      } finally {
        await cleanup();
      }
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const smoke = primaryContainerSmoke({
    run: runCommand, now: Date.now, sleep,
    docker: process.env['PRIMARY_CONTAINER_DOCKER'] ?? 'docker', env: process.env,
    probeSource: fileURLToPath(new URL('./primaryContainerProbe.ts', import.meta.url)),
    containerName: `example-primary-smoke-${randomUUID()}`, terminating: isProcessTerminating, log: console.log,
  });
  installSignalTraps(smoke.cleanup);
  try {
    assert.ok(process.argv.length <= 3, 'Expected at most one image argument');
    await smoke.run(process.argv[2]);
  } catch (cause) {
    console.error(`Primary container smoke failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}

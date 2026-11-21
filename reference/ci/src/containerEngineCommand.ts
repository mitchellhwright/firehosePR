import type { CommandResult, RunOptions, RunProcess } from './ios/shared/processRunner.ts';

/**
 * The container engine a database lane drives, and the one way it is invoked.
 *
 * The engine travels between steps as one of four literal strings in
 * `DB_CONTAINER_CMD`. Each is parsed back into an executable plus a fixed
 * argument prefix, so a container name or SQL statement is always a literal
 * argument and never shell syntax.
 */

const containerEngineNames = ['docker', 'sudo -n docker', 'podman', 'sudo -n podman'] as const;
export type ContainerEngineName = typeof containerEngineNames[number];

export interface ContainerEngineCommand {
  readonly program: 'docker' | 'podman' | 'sudo';
  readonly prefix: readonly string[];
}

/** Parse the exact four engine commands `ensureContainerEngine` emits. */
export function containerEngineCommand(value: string): ContainerEngineCommand {
  switch (value) {
    case 'docker': return { program: 'docker', prefix: [] };
    case 'sudo -n docker': return { program: 'sudo', prefix: ['-n', 'docker'] };
    case 'podman': return { program: 'podman', prefix: [] };
    case 'sudo -n podman': return { program: 'sudo', prefix: ['-n', 'podman'] };
    default: throw new Error(`Unsupported DB_CONTAINER_CMD: ${value}`);
  }
}

/** One engine subcommand with literal arguments. */
export function runEngine(
  engine: ContainerEngineCommand,
  args: readonly string[],
  run: RunProcess,
  options: RunOptions = {},
): Promise<CommandResult> {
  return run(engine.program, [...engine.prefix, ...args], options);
}

export interface EngineSetupIo {
  readonly run: RunProcess;
  /** `command -v <name>`: whether a package manager is installed. */
  readonly installed: (name: string) => boolean;
  readonly env: NodeJS.ProcessEnv;
}

/** The first engine whose daemon answers `info`, trying the unprivileged forms first. */
async function resolveContainerEngine(io: EngineSetupIo): Promise<ContainerEngineName | undefined> {
  for (const name of containerEngineNames) {
    const engine = containerEngineCommand(name);
    const info = await runEngine(engine, ['info'], io.run, { capture: true, env: io.env });
    if (info.status === 0) return name;
  }
  return undefined;
}

async function required(io: EngineSetupIo, command: string, args: readonly string[]): Promise<void> {
  const result = await io.run(command, args, { env: io.env });
  if (result.status !== 0) {
    throw new Error(`${[command, ...args].join(' ')} failed with exit ${result.status}`);
  }
}

async function installContainerEngine(io: EngineSetupIo): Promise<void> {
  if ((await io.run('sudo', ['-n', 'true'], { capture: true, env: io.env })).status !== 0) {
    throw new Error(
      'A container engine is required and this runner cannot install one without interaction.',
    );
  }
  if (io.installed('apt-get')) {
    await required(io, 'sudo', ['-n', 'apt-get', 'update']);
    await required(io, 'sudo', [
      '-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', 'docker.io',
    ]);
    // Hosts without systemd start the daemon through its SysV service instead.
    const systemd = await io.run('sudo', ['-n', 'systemctl', 'start', 'docker'], {
      capture: true, env: io.env,
    });
    if (systemd.status !== 0) await required(io, 'sudo', ['-n', 'service', 'docker', 'start']);
    return;
  }
  for (const manager of ['dnf', 'yum']) {
    if (!io.installed(manager)) continue;
    await required(io, 'sudo', ['-n', manager, 'install', '-y', 'podman']);
    return;
  }
  throw new Error('No supported package manager is available to install a container engine.');
}

/**
 * A usable engine on this runner, installing Docker (apt) or Podman (dnf/yum)
 * through non-interactive sudo when none answers.
 */
export async function ensureContainerEngine(io: EngineSetupIo): Promise<ContainerEngineName> {
  const existing = await resolveContainerEngine(io);
  if (existing !== undefined) return existing;
  await installContainerEngine(io);
  const installed = await resolveContainerEngine(io);
  if (installed === undefined) {
    throw new Error('Container engine installation completed but the engine is still unavailable.');
  }
  return installed;
}

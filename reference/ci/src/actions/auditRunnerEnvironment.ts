import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pinnedIosXcodeToolchain } from '../ios/toolchainPolicy.ts';
import {
  JOB_COMPLETED_HOOK_SOURCE, jobCompletedHookFiles, renderLauncher, resolveRunnerNode,
} from './installJobCompletedHook.ts';

const MACOS_RUNNER_PATH = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

type Command = (program: string, args: readonly string[]) => void;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function containsLine(path: string, expected: string): boolean {
  return readFileSync(path, 'utf8').split('\n').includes(expected);
}

function fail(message: string): never {
  throw new Error(`::error::${message}`);
}

function runCommand(program: string, args: readonly string[]): void {
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Audit the environment carried by the listener executing this job. */
export function auditRunnerEnvironment(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly run: Command;
}): void {
  const { env, platform, run } = options;
  const expectedPlatform = required(env, 'EXPECTED_PLATFORM');
  const actualPlatform = platform === 'darwin' ? 'Darwin' : platform === 'linux' ? 'Linux' : platform;
  if (!((expectedPlatform === 'macos' && platform === 'darwin')
    || (expectedPlatform === 'linux' && platform === 'linux'))) {
    fail(`Expected ${expectedPlatform} runner, got ${actualPlatform}.`);
  }

  const workspace = required(env, 'GITHUB_WORKSPACE');
  if (expectedPlatform === 'macos') {
    run('bash', [join(workspace, 'scripts/provision-github-macos-runner-tools.sh'), '--verify-only']);
    run('node', [join(workspace, 'ci/src/actions/ios/selectXcode.ts'), pinnedIosXcodeToolchain]);
  }

  const runnerTemp = realpathSync(required(env, 'RUNNER_TEMP'));
  const workRoot = dirname(runnerTemp);
  const runnerRoot = realpathSync(dirname(workRoot));
  const runnerName = required(env, 'RUNNER_NAME');
  const hooks = jobCompletedHookFiles(join(required(env, 'HOME'), '.local/libexec/example-actions-runner', runnerName));
  const hookPath = hooks.launcher;

  if (expectedPlatform === 'macos' && !containsLine(join(runnerRoot, '.path'), MACOS_RUNNER_PATH)) {
    fail('The active macOS listener has not loaded the persistent runner PATH.');
  }
  if (env['ACTIONS_RUNNER_HOOK_JOB_COMPLETED'] !== hookPath) {
    fail(`The active ${runnerName} listener has not loaded ${hookPath}.`);
  }
  if (env['EXAMPLE_ACTIONS_RUNNER_ROOT'] !== runnerRoot) {
    fail(`The active ${runnerName} listener has not loaded its runner root.`);
  }
  if (env['EXAMPLE_ACTIONS_RUNNER_WORKDIR'] !== basename(workRoot)) {
    fail(`The active ${runnerName} listener has not loaded its runner workdir.`);
  }
  try {
    accessSync(hookPath, constants.X_OK);
  } catch {
    fail(`Installed cleanup hook is missing or not executable: ${hookPath}`);
  }
  let expectedLauncher: string;
  try {
    expectedLauncher = renderLauncher(resolveRunnerNode(runnerRoot), hooks.script);
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (readFileSync(hookPath, 'utf8') !== expectedLauncher) {
    fail(`Installed cleanup hook launcher does not run ${hooks.script} on the runner's bundled Node.`);
  }
  if (!existsSync(hooks.script)
    || !readFileSync(join(workspace, JOB_COMPLETED_HOOK_SOURCE)).equals(readFileSync(hooks.script))) {
    fail('Installed cleanup hook does not match the trusted repository source.');
  }

  const persistentEnv = join(runnerRoot, '.env');
  for (const line of [
    `EXAMPLE_ACTIONS_RUNNER_ROOT=${runnerRoot}`,
    `EXAMPLE_ACTIONS_RUNNER_WORKDIR=${basename(workRoot)}`,
    `ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${hookPath}`,
  ]) {
    if (!containsLine(persistentEnv, line)) fail(`Runner environment file is missing ${line}.`);
  }

  console.log(`Active cleanup hook verified for ${runnerName}.`);
  run('df', ['-h', runnerTemp]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    auditRunnerEnvironment({ env: process.env, platform: process.platform, run: runCommand });
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { z } from 'zod';
import { runCommand } from './ios/shared/processRunner.ts';
import {
  createLinuxShardSnapshot, linuxShardReceiptInputPaths, sha256,
  type LinuxShardContext, type LinuxShardSnapshot,
} from './linuxShardReceipt.ts';

/** Capture actual checkout and installed tool inputs; no environment secrets are serialized. */
export async function captureLinuxShardSnapshot(context: LinuxShardContext): Promise<LinuxShardSnapshot> {
  const command = async (program: string, args: readonly string[]): Promise<string> => {
    const result = await runCommand(program, args, { capture: true });
    if (result.status !== 0) throw new Error(`Cannot capture shard input: ${program} ${args[0] ?? ''}`);
    return result.stdout.trim();
  };
  // HEAD alone is not the executed input if a lifecycle script changed tracked files.
  if (await command('git', ['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Tracked checkout is dirty; refusing shard input receipt.');
  }
  const mergeSha = await command('git', ['rev-parse', 'HEAD']);
  const treeSha = await command('git', ['rev-parse', 'HEAD^{tree}']);
  // Reading the commit object preserves both parents even in a shallow checkout.
  const commit = await command('git', ['cat-file', '-p', 'HEAD']);
  const parents = commit.split('\n\n', 1)[0]?.split('\n')
    .filter(line => line.startsWith('parent ')).map(line => line.slice('parent '.length)) ?? [];
  const files = new Map<string, string>();
  for (const path of linuxShardReceiptInputPaths) {
    const committed = await runCommand('git', ['show', `HEAD:${path}`], { capture: true });
    const actual = readFileSync(path);
    if (committed.status !== 0 || sha256(committed.stdout) !== sha256(actual)) {
      throw new Error(`Shard execution input differs from the merge tree: ${path}`);
    }
    files.set(path, committed.stdout);
  }
  const vitest: unknown = JSON.parse(readFileSync('node_modules/vitest/package.json', 'utf8'));
  return createLinuxShardSnapshot({
    context, mergeSha, treeSha, parents, files,
    runtime: {
      node: process.version,
      npm: await command('npm', ['--version']),
      vitest: z.object({ version: z.string().min(1) }).parse(vitest).version,
      platform: process.platform, arch: process.arch, kernel: release(),
      runnerOs: process.env.RUNNER_OS, runnerArch: process.env.RUNNER_ARCH,
      runnerEnvironment: process.env.RECEIPT_RUNNER_ENVIRONMENT || process.env.RUNNER_ENVIRONMENT || 'unknown',
      imageOs: process.env.ImageOS ?? '', imageVersion: process.env.ImageVersion ?? '',
      ci: process.env.CI, nodeEnv: process.env.NODE_ENV ?? '', timezone: process.env.TZ ?? '',
      nodeOptions: process.env.NODE_OPTIONS ?? '', envFile: process.env.ENV_FILE ?? '',
    },
  });
}

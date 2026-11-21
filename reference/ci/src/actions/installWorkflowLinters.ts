import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, renameSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type LinterName = 'actionlint' | 'shellcheck';
type LinuxArchitecture = 'x64' | 'arm64';

export interface PinnedLinter {
  readonly name: LinterName;
  readonly version: string;
  readonly sha256: string;
  readonly url: string;
  readonly archive: 'gz' | 'xz';
  readonly member: string;
  readonly stripComponents: number;
  readonly versionArgument: '-version' | '--version';
}

type PinnedLinterSet = readonly [
  PinnedLinter & { readonly name: 'actionlint' },
  PinnedLinter & { readonly name: 'shellcheck' },
];

// The maintained fork understands GitHub's concurrency.queue syntax.
const actionlintVersion = '1.16.1';
const shellcheckVersion = 'v0.11.0';

export const pinnedWorkflowLinters: Readonly<Record<LinuxArchitecture, PinnedLinterSet>> = {
  x64: [
    {
      name: 'actionlint', version: actionlintVersion,
      sha256: 'd566eee8af147ee1fa24ee204e1a171fcf8b5ce40e267c39a7383c7f20e6236d',
      url: `https://github.com/kjanat/actionlint/releases/download/v${actionlintVersion}/actionlint_${actionlintVersion}_linux_amd64.tar.gz`,
      archive: 'gz', member: 'actionlint', stripComponents: 0, versionArgument: '-version',
    },
    {
      name: 'shellcheck', version: shellcheckVersion,
      sha256: '8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198',
      url: `https://github.com/koalaman/shellcheck/releases/download/${shellcheckVersion}/shellcheck-${shellcheckVersion}.linux.x86_64.tar.xz`,
      archive: 'xz', member: `shellcheck-${shellcheckVersion}/shellcheck`, stripComponents: 1,
      versionArgument: '--version',
    },
  ],
  arm64: [
    {
      name: 'actionlint', version: actionlintVersion,
      sha256: '8727b6749053bd7a910ce816117328dd9a3b9ed8a212129ee2ea6b0acb2cd812',
      url: `https://github.com/kjanat/actionlint/releases/download/v${actionlintVersion}/actionlint_${actionlintVersion}_linux_arm64.tar.gz`,
      archive: 'gz', member: 'actionlint', stripComponents: 0, versionArgument: '-version',
    },
    {
      name: 'shellcheck', version: shellcheckVersion,
      sha256: '12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588',
      url: `https://github.com/koalaman/shellcheck/releases/download/${shellcheckVersion}/shellcheck-${shellcheckVersion}.linux.aarch64.tar.xz`,
      archive: 'xz', member: `shellcheck-${shellcheckVersion}/shellcheck`, stripComponents: 1,
      versionArgument: '--version',
    },
  ],
};

type CommandRunner = (command: string, arguments_: readonly string[], quiet: boolean) => number;

function runCommand(command: string, arguments_: readonly string[], quiet: boolean): number {
  const result = spawnSync(command, [...arguments_], { stdio: quiet ? 'ignore' : 'inherit' });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function usable(path: string, spec: PinnedLinter, run: CommandRunner): boolean {
  if (!existsSync(path)) return false;
  if ((statSync(path).mode & 0o111) === 0) return false;
  return run(path, [spec.versionArgument], true) === 0;
}

export interface WorkflowLinterInstallOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly tools?: readonly PinnedLinter[];
  readonly run?: CommandRunner;
}

/** Install checksum-pinned binaries atomically, reusing the existing runner cache. */
export function installWorkflowLinters(options: WorkflowLinterInstallOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (platform !== 'linux') throw new Error('Pinned workflow linters require a Linux runner.');
  if (architecture !== 'x64' && architecture !== 'arm64') {
    throw new Error(`Unsupported Linux architecture for workflow linters: ${architecture}`);
  }
  const environment = options.environment ?? process.env;
  const run = options.run ?? runCommand;
  const tools = options.tools ?? pinnedWorkflowLinters[architecture];
  const cacheRoot = environment['RUNNER_TOOL_CACHE'] || join(environment['TMPDIR'] || tmpdir(), 'example-tool-cache');
  const installDir = join(cacheRoot, 'example-workflow-linters',
    `actionlint-${actionlintVersion}-shellcheck-${shellcheckVersion}`);
  mkdirSync(installDir, { recursive: true });

  for (const tool of tools) {
    const destination = join(installDir, tool.name);
    if (usable(destination, tool, run)) continue;
    const staging = mkdtempSync(join(installDir, '.staging-'));
    try {
      const archive = join(staging, `archive.tar.${tool.archive}`);
      if (run('curl', ['--fail', '--silent', '--show-error', '--location',
        '--retry', '2', '--max-time', '90', tool.url, '--output', archive], false) !== 0) {
        throw new Error(`Could not download pinned ${tool.name} ${tool.version}`);
      }
      const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
      if (digest !== tool.sha256) throw new Error(`Checksum mismatch for pinned ${tool.name} ${tool.version}`);
      const extraction = tool.archive === 'gz' ? '-xzf' : '-xJf';
      const extractArgs = [extraction, archive, '-C', staging];
      if (tool.stripComponents > 0) extractArgs.push(`--strip-components=${tool.stripComponents}`);
      extractArgs.push(tool.member);
      if (run('tar', extractArgs, false) !== 0) throw new Error(`Could not extract pinned ${tool.name}`);
      const extracted = join(staging, tool.name);
      if (!existsSync(extracted)) throw new Error(`Pinned ${tool.name} archive lacks its executable`);
      chmodSync(extracted, statSync(extracted).mode | 0o111);
      if (!usable(extracted, tool, run)) throw new Error(`Pinned ${tool.name} is not executable`);
      // A concurrent job may publish the same verified revision. Atomic rename
      // keeps every reader away from a partially extracted binary.
      renameSync(extracted, destination);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return installDir;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const githubPath = process.env['GITHUB_PATH'];
  if (!githubPath) throw new Error('GITHUB_PATH is required');
  appendFileSync(githubPath, `${installWorkflowLinters()}\n`);
}

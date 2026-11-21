import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ToolchainSpec {
  readonly version: string;
  readonly build: string;
}

interface InstalledToolchain {
  readonly app: string;
  readonly developerDirectory: string;
  readonly version: string;
  readonly build: string;
}

const USAGE = 'Usage: selectXcode.ts <version@build>, e.g. 27.0@27A266a '
  + '(the pin lives in ci/src/ios/toolchainPolicy.ts)';

function parseSpec(args: readonly string[]): ToolchainSpec {
  const [text] = args;
  const match = args.length === 1 && text !== undefined
    ? /^([0-9]+\.[0-9]+(?:\.[0-9]+)?)@([A-Za-z0-9]+)$/.exec(text)
    : null;
  if (match?.[1] === undefined || match[2] === undefined) throw new Error(USAGE);
  return { version: match[1], build: match[2] };
}

function appFromDeveloperDirectory(directory: string): string {
  return directory.endsWith('/Contents/Developer')
    ? directory.slice(0, -'/Contents/Developer'.length)
    : directory;
}

function selectedDeveloperDirectory(env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync('xcode-select', ['-p'], { encoding: 'utf8', env });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function applicationCandidates(env: NodeJS.ProcessEnv, applicationsDirectory: string): readonly string[] {
  const candidates: string[] = [];
  if (env.DEVELOPER_DIR) candidates.push(appFromDeveloperDirectory(env.DEVELOPER_DIR));
  const selected = selectedDeveloperDirectory(env);
  if (selected) candidates.push(appFromDeveloperDirectory(selected));
  if (env.XCODE_APP_PATH) candidates.push(env.XCODE_APP_PATH);
  const installedApps = existsSync(applicationsDirectory)
    ? readdirSync(applicationsDirectory).filter((name) => /^Xcode.*\.app$/.test(name)).sort()
    : [];
  candidates.push(...installedApps.map((name) => join(applicationsDirectory, name)));
  return candidates;
}

function describeInstallation(developerDirectory: string): { version: string; build: string } {
  const executable = join(developerDirectory, 'usr/bin/xcodebuild');
  if (!existsSync(executable)) return { version: 'unknown', build: 'unknown' };
  const result = spawnSync(executable, ['-version'], { encoding: 'utf8' });
  if (result.status !== 0) return { version: 'unknown', build: 'unknown' };
  return {
    version: /^Xcode (\S+)/m.exec(result.stdout)?.[1] ?? 'unknown',
    build: /^Build version (\S+)/m.exec(result.stdout)?.[1] ?? 'unknown',
  };
}

function installedToolchains(env: NodeJS.ProcessEnv, applicationsDirectory: string): readonly InstalledToolchain[] {
  const seen = new Set<string>();
  const installed: InstalledToolchain[] = [];
  for (const app of applicationCandidates(env, applicationsDirectory)) {
    const developerDirectory = join(app, 'Contents/Developer');
    if (seen.has(developerDirectory) || !existsSync(developerDirectory)
      || !statSync(developerDirectory).isDirectory()) continue;
    seen.add(developerDirectory);
    installed.push({ app, developerDirectory, ...describeInstallation(developerDirectory) });
  }
  return installed;
}

function reportMissing(
  spec: ToolchainSpec,
  installed: readonly InstalledToolchain[],
  env: NodeJS.ProcessEnv,
  applicationsDirectory: string,
): void {
  const runner = env.RUNNER_NAME || 'this runner';
  console.error(`::error::${runner} does not have the pinned Xcode ${spec.version} (${spec.build}). `
    + 'CI builds only with this exact Xcode and never falls back to another one.');
  console.error(`Install Xcode ${spec.version} (${spec.build}) at `
    + `${join(applicationsDirectory, `Xcode-${spec.version}.app`)} on ${runner}, `
    + 'or change the pin in ci/src/ios/toolchainPolicy.ts.');
  console.error(`Checked DEVELOPER_DIR, xcode-select, XCODE_APP_PATH, and ${applicationsDirectory}/Xcode*.app.`);
  if (installed.length === 0) {
    console.error('No Xcode installation was found at any candidate path.');
    return;
  }
  console.error('Found these installations instead:');
  for (const candidate of installed) {
    console.error(`  ${candidate.version} (${candidate.build})\t${candidate.app}`);
  }
}

/** Select the pinned Xcode and export it for later GitHub Actions steps. */
export function selectXcode(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  applicationsDirectory = '/Applications',
): number {
  let spec: ToolchainSpec;
  try {
    spec = parseSpec(args);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const installed = installedToolchains(env, applicationsDirectory);
  const chosen = installed.find((candidate) =>
    candidate.version === spec.version && candidate.build === spec.build);
  if (chosen === undefined) {
    reportMissing(spec, installed, env, applicationsDirectory);
    return 1;
  }

  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `DEVELOPER_DIR=${chosen.developerDirectory}\n`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `xcode-version=${chosen.version}\nxcode-build=${chosen.build}\n`);
  }
  const result = spawnSync(join(chosen.developerDirectory, 'usr/bin/xcodebuild'), ['-version'], {
    stdio: 'inherit',
    env: { ...env, DEVELOPER_DIR: chosen.developerDirectory },
  });
  if (result.error !== undefined) console.error(result.error.message);
  return result.status ?? 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = selectXcode(process.argv.slice(2));
}

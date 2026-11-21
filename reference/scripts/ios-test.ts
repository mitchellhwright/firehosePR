/**
 * Build once and run the iOS unit tests on an installed iPhone simulator.
 *
 * Usage:
 *   node scripts/ios-test.ts                                    Build once, run all tests
 *   node scripts/ios-test.ts --no-build                         Reuse the last test build
 *   node scripts/ios-test.ts example-iosTests/FooTests             Run a single test class
 *   node scripts/ios-test.ts --no-build example-iosTests/FooTests/testBar
 *
 * Positional arguments become xcodebuild -only-testing filters
 * (TARGET[/CLASS[/METHOD]]). The simulator is discovered from what is
 * installed, newest iOS first, because dev Macs carry whichever runtime their
 * Xcode shipped with. Override when you need a specific destination, e.g. to
 * reproduce CI:
 *   EXAMPLE_SIMULATOR_OS=27.0 node scripts/ios-test.ts
 *   EXAMPLE_SIMULATOR_NAME="iPhone 18 Pro" node scripts/ios-test.ts
 *   EXAMPLE_SIMULATOR_UDID=<udid> node scripts/ios-test.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export interface TestArguments {
  readonly skipBuild: boolean;
  readonly onlyTesting: readonly string[];
}

export interface SimulatorRequest {
  readonly name: string;
  readonly os: string;
  readonly udid: string;
}

export interface SimulatorChoice {
  readonly udid: string;
  readonly name: string;
  readonly os: string;
}

export interface SimctlDevice {
  readonly udid?: string;
  readonly name?: string;
  readonly isAvailable?: boolean;
}

type Score = readonly number[];

export function parseTestArguments(argv: readonly string[]): TestArguments {
  let skipBuild = false;
  const onlyTesting: string[] = [];
  for (const argument of argv) {
    if (argument === '--no-build') {
      skipBuild = true;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      onlyTesting.push(argument);
    }
  }
  return { skipBuild, onlyTesting };
}

/** Mainstream iPhone over SE/mini, then the highest model, then the largest variant. */
function modelScore(name: string): Score {
  const model = /iPhone (\d+)/.exec(name);
  return [
    name.toLowerCase().includes('mini') || name.includes('SE') ? 0 : 1,
    model ? Number(model[1]) : 0,
    name.includes('Pro Max') ? 2 : name.includes('Pro') ? 1 : 0,
  ];
}

function compareScores(left: Score, right: Score): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** An exact "26.5" matches that runtime; a bare "26" matches any 26.x. */
function osMatches(requested: string, label: string, major: number): boolean {
  if (requested === '' || requested === label) return true;
  return !requested.includes('.') && String(major) === requested;
}

/**
 * Picks the newest iOS runtime's best iPhone that satisfies the request, or
 * undefined when nothing installed matches.
 */
export function selectSimulator(
  devicesByRuntime: Readonly<Record<string, readonly SimctlDevice[]>>,
  request: SimulatorRequest,
): SimulatorChoice | undefined {
  let best: { score: Score; choice: SimulatorChoice } | undefined;
  for (const [runtime, devices] of Object.entries(devicesByRuntime)) {
    const version = /SimRuntime\.iOS-(\d+)-(\d+)$/.exec(runtime);
    if (!version) continue;
    const major = Number(version[1]);
    const minor = Number(version[2]);
    const label = `${major}.${minor}`;
    if (!osMatches(request.os, label, major)) continue;
    for (const device of devices) {
      const name = device.name ?? '';
      const udid = device.udid ?? '';
      if (!name.startsWith('iPhone') || device.isAvailable === false || udid === '') continue;
      if (request.udid !== '' && udid !== request.udid) continue;
      if (request.name !== '' && name !== request.name) continue;
      const score = [major, minor, ...modelScore(name)];
      if (!best || compareScores(score, best.score) > 0) {
        best = { score, choice: { udid, name, os: label } };
      }
    }
  }
  return best?.choice;
}

/**
 * The number of tests a run executed, across XCTest and Swift Testing
 * summaries. A filter that matches nothing still exits 0, so zero means the
 * suite never ran.
 */
export function executedTestCount(log: string): number {
  const counts = [...log.matchAll(/(?:Executed|Test run with) (\d+) test/g)]
    .map((match) => Number(match[1]));
  return counts.length === 0 ? 0 : Math.max(...counts);
}

function run(command: string, args: readonly string[]): number {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Runs a command, streaming its merged output while keeping a copy. */
function runAndCapture(
  command: string,
  args: readonly string[],
): Promise<{ status: number; log: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let log = '';
    const forward = (chunk: Buffer): void => {
      log += chunk.toString('utf8');
      process.stdout.write(chunk);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? 1, log }));
  });
}

function installedDevices(): Record<string, SimctlDevice[]> {
  const listing = spawnSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], {
    encoding: 'utf8',
  });
  if (listing.error) throw listing.error;
  if (listing.status !== 0) {
    throw new Error(`xcrun simctl list devices failed: ${listing.stderr.trim()}`);
  }
  const parsed = JSON.parse(listing.stdout) as { devices?: Record<string, SimctlDevice[]> };
  return parsed.devices ?? {};
}

function reportNoSimulator(request: SimulatorRequest): void {
  console.error('No available iPhone simulator matched.');
  if (request.name + request.os + request.udid !== '') {
    console.error(
      `Requested: name='${request.name || 'any'}' os='${request.os || 'any'}' `
        + `udid='${request.udid || 'any'}'`,
    );
  }
  console.error('Installed runtimes:');
  run('xcrun', ['simctl', 'list', 'runtimes']);
}

async function main(): Promise<number> {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectPath = path.join(scriptDirectory, '..', 'ios', 'example-ios.xcodeproj');
  if (!existsSync(projectPath)) {
    console.error(`Xcode project not found at ${projectPath}`);
    return 1;
  }
  const { skipBuild, onlyTesting } = parseTestArguments(process.argv.slice(2));
  const request: SimulatorRequest = {
    name: process.env.EXAMPLE_SIMULATOR_NAME ?? '',
    os: process.env.EXAMPLE_SIMULATOR_OS ?? '',
    udid: process.env.EXAMPLE_SIMULATOR_UDID ?? '',
  };

  const simulator = selectSimulator(installedDevices(), request);
  if (!simulator) {
    reportNoSimulator(request);
    return 1;
  }
  console.log(`Simulator: ${simulator.name} (iOS ${simulator.os}) ${simulator.udid}`);

  // Pre-boot so the test run doesn't pay boot cost. Already booted is fine,
  // and xcodebuild boots the destination itself if needed.
  spawnSync('xcrun', ['simctl', 'boot', simulator.udid], { stdio: 'ignore' });

  const xcodebuildArgs = [
    '-project', projectPath,
    '-scheme', 'example-ios',
    '-destination', `platform=iOS Simulator,id=${simulator.udid}`,
    'COMPILER_INDEX_STORE_ENABLE=NO',
  ];
  if (!skipBuild) {
    const buildStatus = run('xcodebuild', [...xcodebuildArgs, '-quiet', 'build-for-testing']);
    if (buildStatus !== 0) return buildStatus;
  }

  const filters = onlyTesting.map((filter) => `-only-testing:${filter}`);
  const { status, log } = await runAndCapture(
    'xcodebuild',
    [...xcodebuildArgs, ...filters, 'test-without-building'],
  );
  if (status === 0 && executedTestCount(log) === 0) {
    console.error('xcodebuild reported success but executed no tests.');
    if (onlyTesting.length > 0) {
      console.error(`Check the -only-testing filter(s): ${onlyTesting.join(' ')}`);
    }
    return 1;
  }
  return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((status) => {
    process.exitCode = status;
  }, (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

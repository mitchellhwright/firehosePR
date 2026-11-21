import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  pinnedIosSimulatorRuntime,
  pinnedIosSimulatorRuntimeIdentifier,
  pinnedIosXcodeToolchain,
} from '../src/ios/toolchainPolicy.ts';

const script = fileURLToPath(new URL('../../scripts/ios-ci-image-prerequisites.py', import.meta.url));

/**
 * Runs the script's `main` with every host command answered from `host`, so
 * the test sees exactly which tools a purpose consults. A command the host
 * does not answer fails the run, which is how "never asks simctl" is proven.
 */
const harness = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('prerequisites', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
host = json.loads(sys.argv[2])
def command(*args, timeout=120):
    key = ' '.join(args)
    if key not in host:
        raise RuntimeError('unexpected host command: ' + key)
    return host[key]
module.command = command
sys.argv = ['ios-ci-image-prerequisites.py', *sys.argv[3:]]
try:
    module.main()
except RuntimeError as error:
    print(f'::error::{error}', file=sys.stderr)
    sys.exit(1)
`;

const [xcodeVersion, xcodeBuild] = pinnedIosXcodeToolchain.split('@');
const XCODE = `Xcode ${xcodeVersion}\nBuild version ${xcodeBuild}`;

function runtimeRow(buildversion: string): Record<string, unknown> {
  return {
    isAvailable: true,
    identifier: pinnedIosSimulatorRuntimeIdentifier,
    version: pinnedIosSimulatorRuntime,
    buildversion,
  };
}

function pinnedRuntimeBuild(): string {
  const source = readFileSync(script, 'utf8');
  const build = /'runtime_build': '([^']+)'/.exec(source)?.[1];
  assert.ok(build, 'the profile names a runtime build');
  return build;
}

function run(host: Record<string, string>, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('python3', ['-c', harness, script, JSON.stringify(host), ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const baseHost = {
  '/usr/bin/xcodebuild -version': XCODE,
  '/usr/bin/sw_vers -productVersion': '27.0',
};

describe('ios-ci-image-prerequisites.py', () => {
  it('keeps its simulator runtime aligned with the pinned iOS toolchain policy', () => {
    const versions = [...readFileSync(script, 'utf8').matchAll(/'runtime_version': '([^']+)'/g)]
      .map((match) => match[1]);
    assert.deepEqual(versions, [pinnedIosSimulatorRuntime]);
  });

  it('agrees with the provisioning script and the workflows on the runtime identifier and build', () => {
    const source = readFileSync(script, 'utf8');
    const identifier = /'runtime_identifier': '([^']+)'/.exec(source)?.[1];
    assert.equal(identifier, pinnedIosSimulatorRuntimeIdentifier);
    const provisioning = readFileSync(
      fileURLToPath(new URL('../../scripts/provision-ios-ci-simulator.py', import.meta.url)), 'utf8');
    const primary = /PRIMARY_RUNTIMES = \(\s*\(\((\d+), (\d+)\), "([^"]+)", "([^"]+)"\),\s*\)/.exec(provisioning);
    assert.ok(primary, 'provisioning declares exactly one primary runtime');
    assert.equal(`${primary[1]}.${primary[2]}`, pinnedIosSimulatorRuntime);
    assert.equal(primary[3], pinnedIosSimulatorRuntimeIdentifier);
    assert.equal(primary[4], pinnedRuntimeBuild());
  });

  it('checks the archive against the device SDK and never asks for a simulator runtime', () => {
    const result = run({
      ...baseHost,
      '/usr/bin/xcrun --sdk iphoneos --show-sdk-version': xcodeVersion ?? '',
    }, '--purpose', 'archive');
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { sdk: string; runtimes: unknown[] };
    assert.equal(report.sdk, `iphoneos ${xcodeVersion}`);
    assert.deepEqual(report.runtimes, []);
  });

  it('refuses an archive host whose device SDK is not the pinned Xcode\'s', () => {
    const result = run({
      ...baseHost,
      '/usr/bin/xcrun --sdk iphoneos --show-sdk-version': '26.5',
    }, '--purpose', 'archive');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires iphoneos SDK/);
  });

  it('still requires the pinned simulator runtime for a simulator lane', () => {
    const simulatorHost = {
      ...baseHost,
      '/usr/bin/xcrun --sdk iphonesimulator --show-sdk-version': xcodeVersion ?? '',
    };
    const listRuntimes = '/usr/bin/xcrun simctl list runtimes -j';
    const missing = run({ ...simulatorHost, [listRuntimes]: JSON.stringify({ runtimes: [] }) });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, new RegExp(`Image prerequisite missing: primary iOS ${pinnedIosSimulatorRuntime}`));
    const present = run({
      ...simulatorHost,
      [listRuntimes]: JSON.stringify({ runtimes: [runtimeRow(pinnedRuntimeBuild())] }),
    });
    assert.equal(present.status, 0, present.stderr);
  });
});

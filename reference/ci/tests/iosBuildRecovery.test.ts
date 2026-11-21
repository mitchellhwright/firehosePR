import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { classifyIosBuildRecovery } from '../src/actions/ios/classifyIosBuildRecovery.ts';
import { classifyIosRecovery } from '../src/ios/iosBuildRecovery.ts';

/** The link failure a stale PlaidAPIExtensions.o produced on t-runner-2 (run 36377826146). */
const staleAppObjectLink = [
  'Ld /cache/DerivedData/Build/Products/Debug-iphonesimulator/example-ios.app/example-ios.debug.dylib normal',
  "example-ios: ld: warning: Could not find or use auto-linked framework 'CoreAudioTypes'",
  'Undefined symbols for architecture arm64:',
  '  "example_ios.SyncResponse.init(success: Swift.Bool, message: Swift.String?, itemsTriggered: '
    + 'Swift.Int?, skipped: Swift.String?, retryAfter: Swift.String?) -> example_ios.SyncResponse", '
    + 'referenced from:',
  '      example_ios.PlaidStubTransport.stubResponse<A where A: Swift.Decodable>(endpoint: Swift.String, '
    + 'method: example_ios.HTTPMethod, body: [Swift.String : Any]?) -> A? in PlaidAPIExtensions.o',
  'ld: symbol(s) not found for architecture arm64',
  'clang: error: linker command failed with exit code 1 (use -v to see invocation)',
  '',
].join('\n');

test('an app-module symbol missing at link time is a stale cached object', () => {
  assert.equal(classifyIosRecovery(staleAppObjectLink), 'cache corruption');
  assert.equal(classifyIosRecovery(staleAppObjectLink.replaceAll('\n', '\r\n')), 'cache corruption');
});

test('the stale app symbol may follow other undefined symbols in the same block', () => {
  const log = [
    'Undefined symbols for architecture arm64:',
    '  "_OBJC_CLASS_$_PLKHandler", referenced from:',
    '      in LinkKitBridge.o',
    '  "_$s8example_ios12SyncResponseV7successACSb_tcfC", referenced from:',
    '      in PlaidAPIExtensions.o',
    '',
  ].join('\n');
  assert.equal(classifyIosRecovery(log), 'cache corruption');
});

test('an undefined symbol from another module is not a cache fault', () => {
  const log = [
    'Undefined symbols for architecture arm64:',
    '  "_OBJC_CLASS_$_PLKHandler", referenced from:',
    '      objc-class-ref in LinkKitBridge.o',
    'ld: symbol(s) not found for architecture arm64',
    '',
    'note: example_ios.SyncResponse is mentioned elsewhere in the log',
    '',
  ].join('\n');
  assert.equal(classifyIosRecovery(log), undefined);
  assert.equal(classifyIosRecovery('error: cannot find \'SyncResponse\' in scope\n'), undefined);
  assert.equal(classifyIosRecovery(''), undefined);
});

test('the pre-existing recovery signatures keep their kinds and priority', () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['error: workspace-state.json is CORRUPT', 'cache corruption'],
    ['checksum of downloaded artifact of binary target LinkKit does not match', 'cache corruption'],
    ['PIF transfer session failed', 'cache corruption'],
    ['the package graph is invalid', 'cache corruption'],
    ['unable to open dependencies file (/dd/Foo.d)', 'cache corruption'],
    ['Error Domain=NSMachErrorDomain Code=-308 "(ipc/mig) server died"', 'CoreSimulator infrastructure'],
    ['CoreSimulatorService connection became invalid', 'CoreSimulator infrastructure'],
    ['Failed to boot simulator because the service is unavailable', 'CoreSimulator infrastructure'],
    ['Plaid Sandbox item never reached a healthy state', 'Plaid sandbox infrastructure'],
    ['plaid sandbox sync timed out after 60s', 'Plaid sandbox infrastructure'],
    ['NSMachErrorDomain\n-308', undefined],
    ['Plaid\tSandbox timed out', undefined],
    ['Test Case failed: expected 3 accounts', undefined],
  ];
  for (const [log, kind] of cases) assert.equal(classifyIosRecovery(`${log}\n`), kind, log);
  assert.equal(
    classifyIosRecovery('CoreSimulatorService died\nPIF transfer session invalid\n'),
    'cache corruption',
  );
  assert.equal(
    classifyIosRecovery('Plaid sandbox sync timeout\nCoreSimulatorService unavailable\n'),
    'CoreSimulator infrastructure',
  );
});

test('the classifier program reads the log it is given and fails loudly without one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ios-recovery-classify-'));
  const log = join(directory, 'build.log');
  writeFileSync(log, staleAppObjectLink);
  assert.equal(classifyIosBuildRecovery([log]), 'cache corruption');
  writeFileSync(log, 'error: expected expression\n');
  assert.equal(classifyIosBuildRecovery([log]), '');
  assert.throws(() => classifyIosBuildRecovery([]), /usage/);
  assert.throws(() => classifyIosBuildRecovery([join(directory, 'missing.log')]), /ENOENT/);

  const missing = spawnSync(process.execPath, [
    resolve('ci/src/actions/ios/classifyIosBuildRecovery.ts'), join(directory, 'missing.log'),
  ], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /::error::Could not classify the failed iOS command/);
});

interface CacheSandbox {
  readonly env: NodeJS.ProcessEnv;
  readonly entry: string;
  readonly directory: string;
}

/** A prepared persistent cache entry, as the lane's prepare step leaves it. */
function preparedCache(): CacheSandbox {
  const directory = mkdtempSync(join(tmpdir(), 'ios-recovery-wrapper-'));
  const home = join(directory, 'home');
  mkdirSync(home);
  const packageResolved = join(directory, 'Package.resolved');
  writeFileSync(packageResolved, '{"pins":[]}\n');
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    RUNNER_NAME: 'test-runner',
    IOS_CI_XCODE_FINGERPRINT: 'a'.repeat(64),
    IOS_CI_PACKAGE_RESOLVED: packageResolved,
  };
  const prepared = spawnSync('bash', [resolve('scripts/manage-ios-build-cache.sh'), 'prepare', 'main'], {
    encoding: 'utf8', env: base,
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const entry = /IOS_CI_BUILD_CACHE_ENTRY=(.+)/.exec(prepared.stdout)?.[1];
  assert.ok(entry !== undefined, prepared.stdout);
  return {
    directory,
    entry,
    env: { ...base, IOS_CI_CACHE_LANE: 'main', IOS_CI_BUILD_CACHE_ENTRY: entry },
  };
}

/** A build that fails with `firstLog` once, then succeeds. */
function flakyBuild(directory: string, firstLog: string): string {
  const script = join(directory, 'build.sh');
  writeFileSync(join(directory, 'first.log'), firstLog);
  writeFileSync(script, [
    'set -euo pipefail',
    `if [[ ! -e "${directory}/attempted" ]]; then`,
    `  touch "${directory}/attempted"`,
    `  cat "${directory}/first.log"`,
    '  exit 65',
    'fi',
    'echo "** TEST BUILD SUCCEEDED **"',
    '',
  ].join('\n'));
  return script;
}

test('the recovery wrapper wipes the cache entry and retries once after a stale-object link', () => {
  const cache = preparedCache();
  const stale = join(cache.entry, 'DerivedData', 'PlaidAPIExtensions.o');
  writeFileSync(stale, 'stale');
  const build = flakyBuild(cache.directory, staleAppObjectLink);
  const result = spawnSync('bash', [
    resolve('scripts/run-with-ios-cache-recovery.sh'), join(cache.directory, 'wrapper.log'), '--', 'bash', build,
  ], { encoding: 'utf8', env: cache.env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /::warning::Retrying once after a recognized cache corruption signature\./);
  assert.match(result.stdout, /TEST BUILD SUCCEEDED/);
  assert.equal(existsSync(stale), false);
});

test('the recovery wrapper keeps an ordinary build failure as the job result', () => {
  const cache = preparedCache();
  const kept = join(cache.entry, 'DerivedData', 'Kept.o');
  writeFileSync(kept, 'kept');
  const build = flakyBuild(cache.directory, "error: cannot find 'SyncResponse' in scope\n");
  const result = spawnSync('bash', [
    resolve('scripts/run-with-ios-cache-recovery.sh'), join(cache.directory, 'wrapper.log'), '--', 'bash', build,
  ], { encoding: 'utf8', env: cache.env });
  assert.equal(result.status, 65);
  assert.doesNotMatch(result.stdout, /Retrying once/);
  assert.ok(existsSync(kept));
});

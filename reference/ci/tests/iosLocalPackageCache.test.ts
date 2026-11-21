import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const prepareScript = resolve('scripts/prepare-ios-plaid-link.sh');
const cacheScript = resolve('scripts/manage-ios-build-cache.sh');

function linkKitManifest(version: string, checksum: string): string {
  return [
    '// swift-tools-version: 5.10',
    'import PackageDescription',
    'let package = Package(name: "PlaidLink", targets: [',
    '    .binaryTarget(',
    '        name: "LinkKit",',
    `        url: "https://github.com/plaid/plaid-link-ios/releases/download/${version}/LinkKit.xcframework.zip",`,
    `        checksum: "${checksum}"`,
    '    ),',
    '])',
    '',
  ].join('\n');
}

interface Checkout {
  readonly root: string;
  readonly manifest: string;
  setPin(version: string, checksum: string): void;
}

/** A repository-shaped tree holding a copy of the script under test and the PlaidLink manifest. */
function checkout(script: string): Checkout {
  const root = mkdtempSync(join(tmpdir(), 'ios-local-package-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(script, join(root, 'scripts', 'script.sh'));
  const packageDirectory = join(root, 'ios', 'Packages', 'PlaidLink');
  mkdirSync(packageDirectory, { recursive: true });
  const manifest = join(packageDirectory, 'Package.swift');
  const setPin = (version: string, checksum: string) => writeFileSync(manifest, linkKitManifest(version, checksum));
  setPin('7.0.4', 'a'.repeat(64));
  return { root, manifest, setPin };
}

interface PlaidLinkSandbox extends Checkout {
  readonly sourcePackages: string;
  readonly deviceBinary: string;
  resolves(): number;
  run(): SpawnSyncReturns<string>;
}

/**
 * A fake `swift` resolves by writing a LinkKit xcframework whose binaries
 * carry the version in the manifest it was pointed at, the way SwiftPM
 * materialises the pinned archive; `plutil` accepts anything.
 */
function plaidLinkSandbox(options: { readonly materialize?: boolean } = {}): PlaidLinkSandbox {
  const repo = checkout(prepareScript);
  const bin = join(repo.root, 'bin');
  const calls = join(repo.root, 'swift-calls');
  const sourcePackages = join(repo.root, 'SourcePackages');
  const framework = join(sourcePackages, 'artifacts', 'plaidlink', 'LinkKit', 'LinkKit.xcframework');
  mkdirSync(bin);
  writeFileSync(calls, '');
  writeFileSync(join(bin, 'swift'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf '%s\\n' "$*" >> '${calls}'`,
    options.materialize === false ? 'exit 0' : '',
    'while [[ "$#" -gt 0 ]]; do',
    '  case "$1" in',
    '    --package-path) package="$2"; shift 2 ;;',
    '    --scratch-path) scratch="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'version="$(sed -n -E \'s#.*/download/([^/]+)/.*#\\1#p\' "$package/Package.swift")"',
    'framework="$scratch/artifacts/plaidlink/LinkKit/LinkKit.xcframework"',
    'for slice in ios-arm64 ios-arm64_x86_64-simulator; do',
    '  mkdir -p "$framework/$slice/LinkKit.framework"',
    '  printf \'LinkKit %s\\n\' "$version" > "$framework/$slice/LinkKit.framework/LinkKit"',
    'done',
    'printf \'<plist/>\\n\' > "$framework/Info.plist"',
  ].join('\n') + '\n');
  writeFileSync(join(bin, 'plutil'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(bin, 'swift'), 0o755);
  chmodSync(join(bin, 'plutil'), 0o755);
  return {
    ...repo,
    sourcePackages,
    deviceBinary: join(framework, 'ios-arm64', 'LinkKit.framework', 'LinkKit'),
    resolves: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).length,
    run: () => spawnSync('bash', [join(repo.root, 'scripts', 'script.sh'), sourcePackages], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
    }),
  };
}

test('a prepared LinkKit artifact is reused only for the manifest pin that resolved it', () => {
  const sandbox = plaidLinkSandbox();
  const first = sandbox.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(sandbox.resolves(), 1);
  assert.equal(readFileSync(sandbox.deviceBinary, 'utf8'), 'LinkKit 7.0.4\n');

  const warm = sandbox.run();
  assert.equal(warm.status, 0, warm.stderr);
  assert.match(warm.stdout, /already prepared for the manifest pin/);
  assert.equal(sandbox.resolves(), 1, 'an unchanged pin does not resolve again');

  sandbox.setPin('7.2.0', 'b'.repeat(64));
  const upgraded = sandbox.run();
  assert.equal(upgraded.status, 0, upgraded.stderr);
  assert.match(upgraded.stdout, /not stamped for the manifest pin; re-resolving/);
  assert.equal(sandbox.resolves(), 2, 'a new URL and checksum resolve again on a warm runner');
  assert.equal(readFileSync(sandbox.deviceBinary, 'utf8'), 'LinkKit 7.2.0\n');

  sandbox.setPin('7.2.0', 'c'.repeat(64));
  assert.equal(sandbox.run().status, 0);
  assert.equal(sandbox.resolves(), 3, 'a checksum-only change also resolves again');
});

test('an artifact replaced after it was stamped, or never stamped, is resolved again', () => {
  const sandbox = plaidLinkSandbox();
  assert.equal(sandbox.run().status, 0);
  writeFileSync(sandbox.deviceBinary, 'LinkKit 6.0.0\n');
  assert.equal(sandbox.run().status, 0);
  assert.equal(sandbox.resolves(), 2);
  assert.equal(readFileSync(sandbox.deviceBinary, 'utf8'), 'LinkKit 7.0.4\n');

  const legacy = plaidLinkSandbox();
  assert.equal(legacy.run().status, 0);
  const stamp = join(legacy.sourcePackages, 'artifacts', 'plaidlink', '.example-linkkit-pin');
  assert.ok(existsSync(stamp));
  writeFileSync(stamp, '');
  assert.equal(legacy.run().status, 0);
  assert.equal(legacy.resolves(), 2, 'a warm cache from before the stamp resolves once');
});

test('a manifest without exactly one url and checksum fails before resolving', () => {
  const sandbox = plaidLinkSandbox();
  writeFileSync(sandbox.manifest, linkKitManifest('7.0.4', 'a'.repeat(64)).replace(/checksum:.*\n/, ''));
  const result = sandbox.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected exactly one LinkKit url and checksum/);
  assert.equal(sandbox.resolves(), 0);
});

test('a resolve that does not materialize the artifact fails and leaves no stamp', () => {
  const sandbox = plaidLinkSandbox({ materialize: false });
  const result = sandbox.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /was not materialized/);
  assert.equal(existsSync(join(sandbox.sourcePackages, 'artifacts', 'plaidlink', '.example-linkkit-pin')), false);
});

interface CacheSandbox extends Checkout {
  prepare(): { readonly result: SpawnSyncReturns<string>; readonly entry: string };
}

function buildCacheSandbox(): CacheSandbox {
  const repo = checkout(cacheScript);
  const home = join(repo.root, 'home');
  mkdirSync(home);
  const resolved = join(repo.root, 'Package.resolved');
  writeFileSync(resolved, '{"pins":[]}\n');
  return {
    ...repo,
    prepare() {
      const result = spawnSync('bash', [join(repo.root, 'scripts', 'script.sh'), 'prepare', 'main'], {
        cwd: repo.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          GITHUB_ENV: '',
          IOS_CI_BUILD_CACHE_ROOT: '',
          IOS_CI_CACHE_NAMESPACE: '',
          RUNNER_NAME: 'mac-1',
          IOS_CI_PACKAGE_RESOLVED: resolved,
          IOS_CI_XCODE_FINGERPRINT: 'f'.repeat(64),
        },
      });
      const entry = /^IOS_CI_BUILD_CACHE_ENTRY=(.+)$/m.exec(result.stdout)?.[1] ?? '';
      return { result, entry };
    },
  };
}

test('a local package manifest change discards the reused entry\'s SourcePackages only', () => {
  const sandbox = buildCacheSandbox();
  const cold = sandbox.prepare();
  assert.equal(cold.result.status, 0, cold.result.stderr);
  assert.match(readFileSync(join(cold.entry, 'manifest'), 'utf8'), /^local_packages=[0-9a-f]{64}$/m);
  const packageMarker = join(cold.entry, 'SourcePackages', 'resolved-linkkit');
  const buildMarker = join(cold.entry, 'DerivedData', 'build-products');
  writeFileSync(packageMarker, '');
  writeFileSync(buildMarker, '');

  const unchanged = sandbox.prepare();
  assert.equal(unchanged.result.status, 0, unchanged.result.stderr);
  assert.equal(unchanged.entry, cold.entry);
  assert.ok(existsSync(packageMarker), 'unchanged manifests keep the resolved packages');

  sandbox.setPin('7.2.0', 'b'.repeat(64));
  const changed = sandbox.prepare();
  assert.equal(changed.result.status, 0, changed.result.stderr);
  assert.equal(changed.entry, cold.entry);
  assert.match(changed.result.stdout, /Local package manifests changed/);
  assert.equal(existsSync(packageMarker), false, 'a new pin cannot reuse the stale SourcePackages');
  assert.ok(existsSync(join(changed.entry, 'SourcePackages')), 'the directory is recreated empty');
  assert.ok(existsSync(buildMarker), 'DerivedData stays warm');

  writeFileSync(packageMarker, '');
  assert.equal(sandbox.prepare().result.status, 0);
  assert.ok(existsSync(packageMarker), 'the new fingerprint is recorded after the discard');
});

test('an entry recorded before local packages were fingerprinted discards SourcePackages once', () => {
  const sandbox = buildCacheSandbox();
  const cold = sandbox.prepare();
  assert.equal(cold.result.status, 0, cold.result.stderr);
  const manifest = join(cold.entry, 'manifest');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(/^local_packages=.*\n/m, ''));
  const packageMarker = join(cold.entry, 'SourcePackages', 'resolved-linkkit');
  writeFileSync(packageMarker, '');
  const upgraded = sandbox.prepare();
  assert.equal(upgraded.result.status, 0, upgraded.result.stderr);
  assert.equal(existsSync(packageMarker), false);
});

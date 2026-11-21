import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  chatPlaidCleanupToken,
  chatPlaidEmail,
  chatPlaidSeedArguments,
  cloudSdkPythonCandidates,
  dashboardProxyExitRecord,
  dashboardProxyHealthy,
  dashboardProxyPidRecord,
  dashboardProxyPort,
  debtCardBuildArguments,
  debtCardBuildFingerprint,
  debtCardCacheKey,
  debtCardManifest,
  debtCardManifestJson,
  debtCardManifestMismatch,
  devGcpRuntimeConfig,
  devGcpRuntimeSecrets,
  e2eLaunchPathExports,
  homebrewCandidates,
  isUsablePort,
  laneBackendPortExports,
  onboardingApiBaseUrl,
  onboardingIdentities,
  onboardingIdentityConfirmed,
  onboardingIdentityExports,
  onboardingRecoveryArguments,
  missingPrecompiledProductsVerdict,
  precompiledProductsVerdict,
  psqlResolution,
  realServerE2ePaths,
  shasumListing,
  simulatorProvisionPurpose,
  videoToolingPlan,
} from '../src/ios/realServerE2eLanes.ts';
import { findFirstEntry } from '../src/ios/shared/fileTree.ts';
import { invokedScripts, scriptNamesKey } from '../src/invokedSources.ts';

describe('precompiledProductsVerdict', () => {
  it('rebuilds from the exact checked-out head when both handoff transports are unavailable', () => {
    assert.deepEqual(missingPrecompiledProductsVerdict('/t'), {
      kind: 'rebuild',
      products: '/t/example-ios-e2e-consumer/example-ios-e2e.xctestproducts',
    });
  });
  it('rebuilds only on the verifier status that means "a different Xcode"', () => {
    assert.deepEqual(precompiledProductsVerdict(3, { runnerTemp: '/t', stage: '/s' }), {
      kind: 'rebuild',
      products: '/t/example-ios-e2e-consumer/example-ios-e2e.xctestproducts',
    });
  });

  it('reuses the staged tree on success', () => {
    assert.deepEqual(precompiledProductsVerdict(0, { runnerTemp: '/t', stage: '/s' }), {
      kind: 'reuse',
      products: '/s/example-ios-e2e.xctestproducts',
    });
  });

  it('propagates any other status rather than flattening it to 1', () => {
    for (const status of [1, 2, 4, 127]) {
      assert.deepEqual(precompiledProductsVerdict(status, { runnerTemp: '/t', stage: '/s' }), {
        kind: 'propagate',
        status,
      });
    }
  });
});

describe('psqlResolution', () => {
  it('prefers a client already on PATH over anything Homebrew knows', () => {
    assert.deepEqual(
      psqlResolution({
        onPath: true,
        candidates: [{ prefix: '/opt/libpq', executable: true }],
        homebrewAvailable: true,
      }),
      { kind: 'on-path' },
    );
  });

  it('skips a formula that is not installed and one whose bin holds no psql', () => {
    assert.deepEqual(
      psqlResolution({
        onPath: false,
        candidates: [
          { prefix: '', executable: false },
          { prefix: '/opt/postgresql@17', executable: false },
          { prefix: '/opt/postgresql@16', executable: true },
        ],
        homebrewAvailable: true,
      }),
      { kind: 'prefix', binDirectory: '/opt/postgresql@16/bin' },
    );
  });

  it('installs when nothing is resolvable but Homebrew is there', () => {
    assert.deepEqual(
      psqlResolution({ onPath: false, candidates: [], homebrewAvailable: true }),
      { kind: 'install' },
    );
  });

  it('fails closed on a host with neither a client nor Homebrew', () => {
    assert.deepEqual(
      psqlResolution({
        onPath: false,
        candidates: [{ prefix: '/opt/libpq', executable: false }],
        homebrewAvailable: false,
      }),
      { kind: 'unavailable' },
    );
  });
});

describe('e2eLaunchPathExports', () => {
  it('points every lane script alias at the same tree', () => {
    const exported = e2eLaunchPathExports('/products', '/products/a.xctestrun');
    for (const alias of [
      'TEST_PRODUCTS',
      'TEST_PRODUCTS_PATH',
      'IOS_TEST_PRODUCTS_PATH',
      'BUDGET_E2E_TEST_PRODUCTS',
    ]) {
      assert.equal(exported.get(alias), '/products');
    }
    assert.equal(exported.get('XCTESTRUN_PATH'), '/products/a.xctestrun');
    assert.equal(exported.get('SKIP_BUILD'), '1');
    assert.equal(exported.get('DEFER_VIDEO_PROCESSING'), '1');
  });
});

describe('realServerE2ePaths', () => {
  const paths = realServerE2ePaths({ runDirectory: '/run', workspace: '/workspace' });

  it('anchors the backend directory and its three markers under the run directory', () => {
    assert.equal(paths.backendDirectory, '/run/backend');
    assert.equal(paths.environment.get('ONBOARDING_DEV_BACKEND_LOG'), '/run/backend/devserver.log');
    assert.equal(paths.environment.get('ONBOARDING_DEV_BACKEND_PID_FILE'), '/run/backend/devserver.pid');
    assert.equal(
      paths.environment.get('ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG'),
      '/run/backend/devserver-supervisor.log',
    );
  });

  it('keeps every path but the debt-card cache inside the run directory', () => {
    for (const [name, value] of paths.environment) {
      if (name.startsWith('DEBT_CARD_')) continue;
      assert.ok(
        value === '/run' || value.startsWith('/run/'),
        `${name} escaped the run directory: ${value}`,
      );
    }
  });

  it('anchors the debt-card cache in the workspace so a restore lands where it was saved', () => {
    const cacheDirectory = '/workspace/.example-ci/debt-card-test-products-cache';
    assert.equal(
      paths.environment.get('DEBT_CARD_TEST_PRODUCTS'),
      `${cacheDirectory}/example-ios-tests.xctestproducts`,
    );
    assert.deepEqual(paths.outputs, [
      ['debt_card_cache_dir', cacheDirectory],
      ['debt_card_test_products', `${cacheDirectory}/example-ios-tests.xctestproducts`],
      ['debt_card_cache_manifest', `${cacheDirectory}/manifest.json`],
    ]);
  });

  it('never exports the same name twice, and never a blank one', () => {
    assert.equal(new Set(paths.environment.keys()).size, paths.environment.size);
    for (const [name, value] of paths.environment) {
      assert.ok(name.length > 0 && value.length > 0);
    }
  });

  it('carries a run directory whose name is not a path prefix of another lane', () => {
    const other = realServerE2ePaths({ runDirectory: '/run-2', workspace: '/workspace' });
    assert.notEqual(
      other.environment.get('ONBOARDING_E2E_RESULT_BUNDLE'),
      paths.environment.get('ONBOARDING_E2E_RESULT_BUNDLE'),
    );
  });
});

describe('debt-card fingerprints', () => {
  it('reproduces shasum listing text, separator and trailing newline included', () => {
    assert.equal(shasumListing([['abc', 'one.txt'], ['def', 'two.txt']]), 'abc  one.txt\ndef  two.txt\n');
    assert.equal(shasumListing([]), '');
  });

  it('joins the two digests the way the cache key reads them back', () => {
    assert.equal(debtCardBuildFingerprint('xc', 'in'), 'xc-in');
    assert.equal(
      debtCardCacheKey({
        runnerOs: 'macOS',
        runnerArch: 'ARM64',
        exactHeadSha: 'head',
        buildFingerprint: 'xc-in',
      }),
      'ios-debt-card-test-products-v1-macOS-ARM64-head-xc-in',
    );
  });

  it('writes the manifest with sorted keys and a trailing newline, as json.dump did', () => {
    assert.equal(
      debtCardManifestJson(debtCardManifest('head', 'fingerprint')),
      '{\n  "buildFingerprint": "fingerprint",\n  "exactHeadSha": "head",\n  "testPlan": "Debt-Card-Backend-Evidence"\n}\n',
    );
  });
});

describe('debtCardManifestMismatch', () => {
  const expected = debtCardManifest('head', 'fingerprint');

  it('accepts a manifest that agrees, even with unknown extra fields', () => {
    assert.equal(debtCardManifestMismatch({ ...expected, note: 'extra' }, expected), undefined);
  });

  it('names the first field that disagrees', () => {
    assert.equal(debtCardManifestMismatch({ ...expected, exactHeadSha: 'x' }, expected), 'exactHeadSha');
    assert.equal(debtCardManifestMismatch({ ...expected, testPlan: 'CI' }, expected), 'testPlan');
  });

  it('rejects a payload that is not an object at all', () => {
    for (const payload of [null, undefined, 42, 'manifest', [expected]]) {
      assert.equal(debtCardManifestMismatch(payload, expected), 'exactHeadSha');
    }
  });

  it('rejects a manifest missing a field rather than treating absence as agreement', () => {
    assert.equal(
      debtCardManifestMismatch({ exactHeadSha: 'head', testPlan: expected.testPlan }, expected),
      'buildFingerprint',
    );
  });
});

describe('debtCardBuildArguments', () => {
  it('passes every path as its own argument, so none can be read as shell', () => {
    const args = debtCardBuildArguments({
      testProductsPath: '/a b/products; rm -rf /',
      derivedData: '/derived',
      sourcePackages: '/packages',
      packageCache: '/cache',
    });
    assert.equal(args[args.indexOf('-testProductsPath') + 1], '/a b/products; rm -rf /');
    assert.equal(args[0], 'build-for-testing');
    assert.ok(args.includes('CODE_SIGNING_ALLOWED=NO'));
  });
});

describe('Cloud SDK interpreter search', () => {
  it('drops an unresolved PATH interpreter instead of probing an empty path', () => {
    assert.deepEqual(cloudSdkPythonCandidates(''), [
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
    ]);
  });

  it('keeps the PATH interpreter last, as the shell loop did', () => {
    assert.deepEqual(cloudSdkPythonCandidates('/usr/bin/python3').at(-1), '/usr/bin/python3');
  });

  it('names both Homebrew prefixes even when PATH resolves one already', () => {
    assert.deepEqual(homebrewCandidates(''), ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']);
    assert.equal(homebrewCandidates('/x/brew').length, 3);
  });
});

describe('dev GCP runtime config', () => {
  it('names no secret in the plain block, and every secret in the secret list', () => {
    for (const name of devGcpRuntimeConfig().keys()) {
      assert.ok(!name.includes('PEPPER') && !name.includes('API_KEY'));
    }
    assert.deepEqual(devGcpRuntimeSecrets.map(([, variable]) => variable), [
      'IDENTITY_PLATFORM_API_KEY',
      'AUTH_CODE_PEPPER',
    ]);
  });
});

describe('lane backend port', () => {
  it('points the runner at the port it just allocated', () => {
    assert.deepEqual([...laneBackendPortExports(51234)], [
      ['ONBOARDING_DEV_BACKEND_PORT', '51234'],
      ['TEST_RUNNER_UI_TEST_API_BASE_URL', 'http://127.0.0.1:51234/api'],
    ]);
  });

  it('accepts only a port the kernel could actually have handed out', () => {
    assert.equal(isUsablePort(1), true);
    assert.equal(isUsablePort(65535), true);
    assert.equal(isUsablePort(0), false);
    assert.equal(isUsablePort(65536), false);
    assert.equal(isUsablePort(-1), false);
    assert.equal(isUsablePort(1.5), false);
  });
});

describe('Chat Plaid identity', () => {
  it('scopes the address to the run attempt so a rerun cannot reuse a user', () => {
    assert.equal(chatPlaidEmail('10', '2'), 'chat-plaid-10-2@test.example.local');
    assert.notEqual(chatPlaidEmail('10', '1'), chatPlaidEmail('10', '2'));
  });

  it('takes the cleanup token only from a confirmed bootstrap', () => {
    assert.equal(chatPlaidCleanupToken({ confirmed: true, cleanupToken: 'tok' }), 'tok');
    assert.equal(chatPlaidCleanupToken({ confirmed: false, cleanupToken: 'tok' }), undefined);
    assert.equal(chatPlaidCleanupToken({ confirmed: true }), undefined);
    assert.equal(chatPlaidCleanupToken({ confirmed: true, cleanupToken: '' }), undefined);
    assert.equal(chatPlaidCleanupToken({ confirmed: true, cleanupToken: 7 }), undefined);
    assert.equal(chatPlaidCleanupToken('confirmed'), undefined);
    assert.equal(chatPlaidCleanupToken(null), undefined);
  });

  it('seeds the lane fixture against the identity it just created', () => {
    const args = chatPlaidSeedArguments({ email: 'a@b.c', password: 'p' });
    assert.equal(args[args.indexOf('--email') + 1], 'a@b.c');
    assert.ok(args.includes('--truncate-user'));
  });
});

describe('simulatorProvisionPurpose', () => {
  it('uses the backend runtime only for backend-only evidence', () => {
    assert.equal(simulatorProvisionPurpose('debt-card-evidence'), 'backend');
    for (const scope of ['', 'e2e', 'evidence', 'mortgage-assignment-evidence']) {
      assert.equal(simulatorProvisionPurpose(scope), 'onboarding');
    }
  });
});

describe('videoToolingPlan', () => {
  it('does nothing when both binaries are already there', () => {
    assert.equal(videoToolingPlan({ present: [true, true], homebrewAvailable: false }), 'present');
  });

  it('installs when either binary is missing and Homebrew can supply it', () => {
    assert.equal(videoToolingPlan({ present: [true, false], homebrewAvailable: true }), 'install');
    assert.equal(videoToolingPlan({ present: [false, false], homebrewAvailable: true }), 'install');
  });

  it('reports the runner as unusable for review when nothing can install them', () => {
    assert.equal(videoToolingPlan({ present: [false, true], homebrewAvailable: false }), 'unavailable');
  });
});

describe('development FullOnboarding identities', () => {
  it('gives the onboarding and privacy journeys separate addresses per attempt', () => {
    const identities = onboardingIdentities('99', '3');
    assert.equal(identities.onboardingEmail, 'onboard-ci-99-3@test.example.local');
    assert.equal(identities.privacyEmail, 'privacy-ci-99-3@test.example.local');
    assert.notEqual(identities.onboardingEmail, identities.privacyEmail);
  });

  it('exports the password beside both addresses', () => {
    const exported = onboardingIdentityExports(onboardingIdentities('1', '1'), 'secret');
    assert.equal(exported.get('UI_TEST_SYNTHETIC_PASSWORD'), 'secret');
    assert.equal(exported.size, 3);
  });

  it('confirms an identity only when the backend echoes the address asked for', () => {
    assert.equal(onboardingIdentityConfirmed({ confirmed: true, email: 'a@b' }, 'a@b'), true);
    assert.equal(onboardingIdentityConfirmed({ confirmed: true, email: 'other@b' }, 'a@b'), false);
    assert.equal(onboardingIdentityConfirmed({ confirmed: 'true', email: 'a@b' }, 'a@b'), false);
    assert.equal(onboardingIdentityConfirmed({ email: 'a@b' }, 'a@b'), false);
    assert.equal(onboardingIdentityConfirmed([], 'a@b'), false);
  });
});

describe('dashboard offline proxy', () => {
  const sha = 'abc123';

  it('spells the two records the lane blocks on', () => {
    assert.equal(dashboardProxyPidRecord(4242), '{"pid":4242}');
    assert.equal(dashboardProxyExitRecord(0), '{"exited":0}');
    assert.equal(dashboardProxyExitRecord(143), '{"exited":143}');
  });

  it('reads the port from the first readiness record for this commit', () => {
    const log = [
      '{"pid":10}',
      'not json at all',
      `{"ready":true,"commitSha":"other","port":1111}`,
      `{"ready":true,"commitSha":"${sha}","port":2222}`,
      `{"ready":true,"commitSha":"${sha}","port":3333}`,
      '',
    ].join('\n');
    assert.equal(dashboardProxyPort(log, sha), 2222);
  });

  it('accepts a port reported as a decimal string, as the jq filter did', () => {
    assert.equal(dashboardProxyPort(`{"ready":true,"commitSha":"${sha}","port":"2222"}`, sha), 2222);
  });

  it('refuses a first readiness record whose port is unusable, rather than scanning on', () => {
    const log = [
      `{"ready":true,"commitSha":"${sha}","port":0}`,
      `{"ready":true,"commitSha":"${sha}","port":2222}`,
    ].join('\n');
    assert.equal(dashboardProxyPort(log, sha), undefined);
    assert.equal(dashboardProxyPort(`{"ready":true,"commitSha":"${sha}","port":70000}`, sha), undefined);
    assert.equal(dashboardProxyPort(`{"ready":true,"commitSha":"${sha}"}`, sha), undefined);
  });

  it('reports nothing for a log that only records an exit', () => {
    assert.equal(dashboardProxyPort('{"pid":9}\n{"exited":1}\n', sha), undefined);
    assert.equal(dashboardProxyPort('', sha), undefined);
  });

  it('accepts the health answer only when it names this run\'s commit', () => {
    assert.equal(dashboardProxyHealthy({ ready: true, commitSha: sha }, sha), true);
    assert.equal(dashboardProxyHealthy({ ready: true, commitSha: 'other' }, sha), false);
    assert.equal(dashboardProxyHealthy({ ready: 'true', commitSha: sha }, sha), false);
    assert.equal(dashboardProxyHealthy(null, sha), false);
  });
});

describe('onboarding execution inputs', () => {
  it('sends the app to the proxy, never straight to the backend', () => {
    assert.equal(onboardingApiBaseUrl('4321'), 'http://127.0.0.1:4321/api');
  });

  it('wraps the lane script in the cache-recovery runner, argument by argument', () => {
    assert.deepEqual(
      onboardingRecoveryArguments({ recoveryLog: '/run/r.log', laneScript: 'scripts/l.sh' }),
      ['scripts/run-with-ios-cache-recovery.sh', '/run/r.log', '--', 'bash', 'scripts/l.sh'],
    );
  });
});

describe('findFirstEntry', () => {
  const root = mkdtempSync(join(tmpdir(), 'file-tree-'));
  mkdirSync(join(root, 'nested', 'deeper'), { recursive: true });
  writeFileSync(join(root, 'nested', 'deeper', 'run.xctestrun'), '');
  mkdirSync(join(root, 'nested', 'bundle.xctest'), { recursive: true });

  it('finds a file nested several levels down', () => {
    const found = findFirstEntry(root, (entry) => entry.kind === 'file' && entry.name.endsWith('.xctestrun'));
    assert.equal(found, join(root, 'nested', 'deeper', 'run.xctestrun'));
  });

  it('distinguishes a directory match from a file match', () => {
    assert.equal(
      findFirstEntry(root, (entry) => entry.kind === 'directory' && entry.name === 'bundle.xctest'),
      join(root, 'nested', 'bundle.xctest'),
    );
    assert.equal(
      findFirstEntry(root, (entry) => entry.kind === 'file' && entry.name === 'bundle.xctest'),
      undefined,
    );
  });

  it('returns undefined for a tree that does not exist rather than throwing', () => {
    assert.equal(findFirstEntry(join(root, 'absent'), () => true), undefined);
  });
});

describe('invokedScripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'invoked-sources-'));
  mkdirSync(join(root, 'ci/src/actions/ios'), { recursive: true });
  mkdirSync(join(root, 'ci/src/ios'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'ci/src/actions/ios/program.ts'),
    "import { decide } from '../../ios/decisions.ts';\nexport const x = decide;\n",
  );
  writeFileSync(
    join(root, 'ci/src/ios/decisions.ts'),
    "import { shared } from './shared.ts';\nexport const decide = ['EXPORTED_NAME', shared];\n",
  );
  writeFileSync(join(root, 'ci/src/ios/shared.ts'), "export const shared = 'deep_key';\n");
  writeFileSync(join(root, 'scripts/outer.sh'), 'bash scripts/inner.sh\n');
  writeFileSync(join(root, 'scripts/inner.sh'), 'echo "FROM_INNER=1"\n');

  it('follows a typed program into the decision modules it imports, transitively', () => {
    const reached = invokedScripts(root, 'run: node ci/src/actions/ios/program.ts');
    assert.ok(reached.includes('ci/src/ios/decisions.ts'));
    assert.ok(reached.includes('ci/src/ios/shared.ts'));
    assert.equal(scriptNamesKey(root, reached, 'EXPORTED_NAME'), true);
    assert.equal(scriptNamesKey(root, reached, 'deep_key'), true);
    assert.equal(scriptNamesKey(root, reached, 'ABSENT_NAME'), false);
  });

  it('still follows one level of shell delegation', () => {
    const reached = invokedScripts(root, 'bash scripts/outer.sh');
    assert.ok(reached.includes('scripts/inner.sh'));
    assert.equal(scriptNamesKey(root, reached, 'FROM_INNER'), true);
  });

  it('reports nothing for a step that invokes no script', () => {
    assert.deepEqual(invokedScripts(root, 'echo hello'), []);
  });
});

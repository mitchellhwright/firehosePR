/**
 * Decisions for the shared real-server E2E step list — the anchor every lane
 * (onboarding, chat-plaid, income, budget) runs before its own test command.
 *
 * Everything here is pure: given what the runner reports, which products the
 * lane launches, which paths the run writes to, which Python the Cloud SDK may
 * use, which identities the lane provisions, and whether the dashboard offline
 * proxy proved itself. The side effects — spawning `ditto`, `xcodebuild`,
 * `brew`, the proxy supervisor, and the `$GITHUB_ENV`/`$GITHUB_OUTPUT` writes
 * — live in the step programs under `ci/src/actions/ios/`.
 */

/** The only test plan the debt-card evidence lane builds and caches. */
export const debtCardTestPlan = 'Debt-Card-Backend-Evidence';

/** The bundle whose presence proves a debt-card product tree is complete. */
export const debtCardUiTestBundle = 'example-iosBudgetDebtUITests.xctest';

/** `verifyTestProductToolchainReceipt` reports this when Xcode moved. */
export const toolchainRebuildStatus = 3;

// ---------------------------------------------------------------------------
// Precompiled E2E products
// ---------------------------------------------------------------------------

export const precompiledProductsUnavailableMessage =
  'Exact-head E2E handoff was unavailable from cache and artifact; rebuilding this lane from its exact head.';

export const precompiledRebuildNotice =
  "Rebuilding E2E test products for the consumer's exact Xcode.";

export type PrecompiledProductsVerdict =
  /** The consumer's Xcode differs; the staged tree is discarded and rebuilt. */
  | { readonly kind: 'rebuild'; readonly products: string }
  /** The staged tree matches this toolchain and is launched as-is. */
  | { readonly kind: 'reuse'; readonly products: string }
  /** Any other verifier status is the step's status, as `exit "$s"` was. */
  | { readonly kind: 'propagate'; readonly status: number };

/** A missing transport is recoverable from the already-checked-out exact head. */
export function missingPrecompiledProductsVerdict(
  runnerTemp: string,
): Extract<PrecompiledProductsVerdict, { readonly kind: 'rebuild' }> {
  return {
    kind: 'rebuild',
    products: `${runnerTemp}/example-ios-e2e-consumer/example-ios-e2e.xctestproducts`,
  };
}

/**
 * What to do with the staged products given the toolchain verifier's status.
 * Only status 3 means "rebuild"; 0 means "reuse"; everything else fails the
 * step with the verifier's own status rather than a generic 1.
 */
export function precompiledProductsVerdict(
  verifyStatus: number,
  paths: { readonly runnerTemp: string; readonly stage: string },
): PrecompiledProductsVerdict {
  if (verifyStatus === toolchainRebuildStatus) {
    return missingPrecompiledProductsVerdict(paths.runnerTemp);
  }
  if (verifyStatus === 0) {
    return { kind: 'reuse', products: `${paths.stage}/example-ios-e2e.xctestproducts` };
  }
  return { kind: 'propagate', status: verifyStatus };
}

export function stagedProductsMismatchMessage(staged: string, expected: string): string {
  return `Staged E2E products carry ${staged}, expected exact head ${expected}.`;
}

// ---------------------------------------------------------------------------
// Income lane database clients
// ---------------------------------------------------------------------------

export const missingCloudSqlProxyMessage =
  'The baked macOS runner image is missing cloud-sql-proxy.';

export const missingHomebrewForPsqlMessage =
  'Income E2E needs a psql client and Homebrew is unavailable to install one.';

export function installedPsqlMissingMessage(prefix: string): string {
  return `Installed libpq but ${prefix}/bin/psql is missing.`;
}

/** The keg-only prefixes the lane consults, in the order the shell tried them. */
export const psqlBrewFormulae = ['libpq', 'postgresql@17', 'postgresql@16'] as const;

export type PsqlResolution =
  | { readonly kind: 'on-path' }
  | { readonly kind: 'prefix'; readonly binDirectory: string }
  | { readonly kind: 'install' }
  | { readonly kind: 'unavailable' };

export interface PsqlCandidate {
  readonly prefix: string;
  readonly executable: boolean;
}

/**
 * Where the lane's `psql` comes from. A client already on `PATH` wins; then
 * the first keg-only prefix that actually holds an executable; otherwise the
 * lane installs one, and fails closed when it cannot.
 */
export function psqlResolution(inputs: {
  readonly onPath: boolean;
  readonly candidates: readonly PsqlCandidate[];
  readonly homebrewAvailable: boolean;
}): PsqlResolution {
  if (inputs.onPath) return { kind: 'on-path' };
  for (const candidate of inputs.candidates) {
    if (candidate.prefix.length > 0 && candidate.executable) {
      return { kind: 'prefix', binDirectory: `${candidate.prefix}/bin` };
    }
  }
  return inputs.homebrewAvailable ? { kind: 'install' } : { kind: 'unavailable' };
}

// ---------------------------------------------------------------------------
// Launch paths
// ---------------------------------------------------------------------------

export const missingXctestrunMessage =
  'The exact-toolchain E2E products contain no .xctestrun file.';

/**
 * The launch environment every lane script reads. Four aliases name the same
 * tree because the four lane scripts each grew their own variable; they are
 * exported together so no lane can be launched against a different build.
 */
export function e2eLaunchPathExports(
  products: string,
  xctestrun: string,
): ReadonlyMap<string, string> {
  return new Map([
    ['TEST_PRODUCTS', products],
    ['TEST_PRODUCTS_PATH', products],
    ['IOS_TEST_PRODUCTS_PATH', products],
    ['BUDGET_E2E_TEST_PRODUCTS', products],
    ['XCTESTRUN_PATH', xctestrun],
    ['SKIP_BUILD', '1'],
    ['DEFER_VIDEO_PROCESSING', '1'],
  ]);
}

// ---------------------------------------------------------------------------
// Run-directory layout
// ---------------------------------------------------------------------------

export interface RealServerE2ePaths {
  /** Exported to `$GITHUB_ENV` for every later step in the lane. */
  readonly environment: ReadonlyMap<string, string>;
  /** Exported to `$GITHUB_OUTPUT` for the `with:` blocks that need a path. */
  readonly outputs: readonly (readonly [string, string])[];
  /** Created before anything writes into it. */
  readonly backendDirectory: string;
}

/**
 * Every path the shared step list writes, derived from the one run directory
 * the lane owns. The debt-card cache must restore to a stable workspace path
 * on every run, so it is the only entry anchored outside the run directory.
 */
export function realServerE2ePaths(inputs: {
  readonly runDirectory: string;
  readonly workspace: string;
}): RealServerE2ePaths {
  const run = inputs.runDirectory;
  const backendDirectory = `${run}/backend`;
  const debtCardCacheDirectory = `${inputs.workspace}/.example-ci/debt-card-test-products-cache`;
  const debtCardTestProducts = `${debtCardCacheDirectory}/example-ios-tests.xctestproducts`;
  const debtCardCacheManifest = `${debtCardCacheDirectory}/manifest.json`;
  const environment = new Map<string, string>([
    ['ONBOARDING_E2E_RUN_DIR', run],
    ['ONBOARDING_DEV_BACKEND_LOG', `${backendDirectory}/devserver.log`],
    ['ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG', `${backendDirectory}/devserver-supervisor.log`],
    ['ONBOARDING_DEV_BACKEND_PID_FILE', `${backendDirectory}/devserver.pid`],
    ['BACKEND_DIAGNOSTICS_DIR', `${run}/backend-diagnostics`],
    ['ONBOARDING_E2E_RESULT_BUNDLE', `${run}/onboarding-e2e.xcresult`],
    ['ONBOARDING_E2E_XCODEBUILD_LOG', `${run}/xcodebuild.log`],
    ['CHAT_PLAID_E2E_RESULT_BUNDLE', `${run}/chat-plaid-e2e.xcresult`],
    ['CHAT_PLAID_E2E_XCODEBUILD_LOG', `${run}/chat-plaid-xcodebuild.log`],
    ['CHAT_PLAID_E2E_EVIDENCE_DIR', `${run}/chat-plaid-evidence`],
    ['INCOME_E2E_RUN_DIR', `${run}/income-e2e`],
    ['INCOME_E2E_RESULT_BUNDLE', `${run}/income-e2e/income-e2e.xcresult`],
    ['INCOME_E2E_XCODEBUILD_LOG', `${run}/income-e2e/xcodebuild.log`],
    ['INCOME_E2E_RAW_VIDEO', `${run}/income-e2e/income-e2e.raw.mp4`],
    ['INCOME_E2E_COMPRESSED_VIDEO', `${run}/income-e2e/income-e2e-evidence.mp4`],
    ['INCOME_E2E_DB_PROXY_LOG', `${run}/income-e2e/cloud-sql-proxy.log`],
    ['INCOME_E2E_PROVIDER_AUDIT_LOG', `${run}/income-e2e/provider-boundaries.jsonl`],
    ['ONBOARDING_E2E_RAW_VIDEO', `${run}/onboarding-e2e.raw.mp4`],
    ['ONBOARDING_E2E_COMPRESSED_VIDEO', `${run}/onboarding-e2e.compressed.mp4`],
    ['ONBOARDING_E2E_REVIEW_JSON', `${run}/onboarding-video-review.json`],
    ['ONBOARDING_E2E_REVIEW_MD', `${run}/onboarding-video-review.md`],
    ['DASHBOARD_OFFLINE_PROXY_EVENTS', `${run}/dashboard-offline-proxy.jsonl`],
    ['DASHBOARD_OFFLINE_PROXY_LOG', `${run}/dashboard-offline-proxy.log`],
    ['DASHBOARD_OFFLINE_EVIDENCE_JSON', `${run}/dashboard-offline-evidence.json`],
    ['DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE', `${run}/development-user-cleanup.jsonl`],
    ['BUDGET_E2E_RESULT_BUNDLE', `${run}/budget-e2e.xcresult`],
    ['BUDGET_E2E_XCODEBUILD_LOG', `${run}/budget-xcodebuild.log`],
    ['BUDGET_E2E_RAW_VIDEO', `${run}/budget-e2e.raw.mp4`],
    ['BUDGET_E2E_COMPRESSED_VIDEO', `${run}/budget-e2e.compressed.mp4`],
    ['BUDGET_E2E_VIDEO_LOG', `${run}/budget-e2e-video.log`],
    ['IOS_3996_EVIDENCE_DIR', `${run}/issue-3996-evidence`],
    ['IOS_3996_CLEANUP_RECEIPT', `${run}/issue-3996-cleanup-receipt.json`],
    ['IOS_3996_EVIDENCE_JSON', `${run}/issue-3996-evidence/evidence.json`],
    ['IOS_3998_EVIDENCE_DIR', `${run}/issue-3998-evidence`],
    ['IOS_3998_FRESHNESS_RECEIPT', `${run}/issue-3998-evidence/freshness-receipt.json`],
    ['IOS_3998_CLEANUP_RECEIPT', `${run}/issue-3998-evidence/cleanup-receipt.json`],
    ['IOS_3999_ARCHIVE_EVIDENCE', `${run}/issue-3998-evidence/release-archive.json`],
    ['DEBT_CARD_TEST_PRODUCTS', debtCardTestProducts],
    ['DEBT_CARD_TEST_PRODUCTS_MANIFEST', debtCardCacheManifest],
  ]);
  return {
    environment,
    outputs: [
      ['debt_card_cache_dir', debtCardCacheDirectory],
      ['debt_card_test_products', debtCardTestProducts],
      ['debt_card_cache_manifest', debtCardCacheManifest],
    ],
    backendDirectory,
  };
}

// ---------------------------------------------------------------------------
// Debt-card test products
// ---------------------------------------------------------------------------

/** The build inputs whose digests decide whether a cached tree is still valid. */
export const debtCardFingerprintInputs: readonly string[] = [
  'ios/example-ios.xcodeproj/project.pbxproj',
  'ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
  `ios/example-ios.xcodeproj/xcshareddata/TestPlans/${debtCardTestPlan}.xctestplan`,
];

/**
 * `shasum -a 256 <files>` output, which the shell hashed a second time. The
 * two-space separator and the path text are part of what was hashed, so both
 * are reproduced exactly rather than hashing the file contents alone.
 */
export function shasumListing(
  entries: readonly (readonly [digest: string, path: string])[],
): string {
  return entries.map(([digest, path]) => `${digest}  ${path}\n`).join('');
}

export function debtCardBuildFingerprint(
  xcodeFingerprint: string,
  inputsFingerprint: string,
): string {
  return `${xcodeFingerprint}-${inputsFingerprint}`;
}

export function debtCardCacheKey(inputs: {
  readonly runnerOs: string;
  readonly runnerArch: string;
  readonly exactHeadSha: string;
  readonly buildFingerprint: string;
}): string {
  return [
    'ios-debt-card-test-products-v1',
    inputs.runnerOs,
    inputs.runnerArch,
    inputs.exactHeadSha,
    inputs.buildFingerprint,
  ].join('-');
}

export interface DebtCardManifest {
  readonly exactHeadSha: string;
  readonly buildFingerprint: string;
  readonly testPlan: string;
}

export function debtCardManifest(
  exactHeadSha: string,
  buildFingerprint: string,
): DebtCardManifest {
  return { exactHeadSha, buildFingerprint, testPlan: debtCardTestPlan };
}

/** `json.dump(..., indent=2, sort_keys=True)` plus the trailing newline. */
export function debtCardManifestJson(manifest: DebtCardManifest): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(manifest).sort()) {
    sorted[key] = manifest[key as keyof DebtCardManifest];
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * The first field of a cached manifest that disagrees with what this run would
 * build, or `undefined` when the cached tree may be reused.
 */
export function debtCardManifestMismatch(
  parsed: unknown,
  expected: DebtCardManifest,
): string | undefined {
  const manifest =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  for (const key of ['exactHeadSha', 'buildFingerprint', 'testPlan'] as const) {
    if (manifest[key] !== expected[key]) return key;
  }
  return undefined;
}

export function debtCardManifestMismatchMessage(key: string): string {
  return `cached debt-card test products mismatch for ${key}`;
}

/** `xcodebuild build-for-testing …`, as an argument array rather than a line. */
export function debtCardBuildArguments(inputs: {
  readonly testProductsPath: string;
  readonly derivedData: string;
  readonly sourcePackages: string;
  readonly packageCache: string;
}): readonly string[] {
  return [
    'build-for-testing',
    '-project', 'ios/example-ios.xcodeproj',
    '-scheme', 'example-ios-BudgetDebt',
    '-testPlan', debtCardTestPlan,
    '-destination', 'generic/platform=iOS Simulator',
    '-parallel-testing-enabled', 'NO',
    '-enableCodeCoverage', 'NO',
    '-testProductsPath', inputs.testProductsPath,
    '-derivedDataPath', inputs.derivedData,
    '-clonedSourcePackagesDirPath', inputs.sourcePackages,
    '-packageCachePath', inputs.packageCache,
    '-disableAutomaticPackageResolution',
    'COMPILER_INDEX_STORE_ENABLE=NO',
    'ARCHS=arm64',
    'ONLY_ACTIVE_ARCH=YES',
    'CODE_SIGNING_ALLOWED=NO',
  ];
}

// ---------------------------------------------------------------------------
// Google Cloud SDK
// ---------------------------------------------------------------------------

/** The gcloud CLI refuses anything outside this window. */
export const cloudSdkPythonProbe =
  'import sys; assert (3, 10) <= sys.version_info[:2] <= (3, 14)';

export const noCompatiblePythonMessage =
  'No compatible Python or Homebrew installation is available.';

export const cloudSdkHomebrewFormula = 'python@3.12';

/** The interpreters the lane prefers, before falling back to `PATH`. */
export function cloudSdkPythonCandidates(pathPython: string): readonly string[] {
  return ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', pathPython].filter(
    (candidate) => candidate.length > 0,
  );
}

/** The Homebrew installs the lane will accept, in the shell's own order. */
export function homebrewCandidates(pathHomebrew: string): readonly string[] {
  return [pathHomebrew, '/opt/homebrew/bin/brew', '/usr/local/bin/brew'].filter(
    (candidate) => candidate.length > 0,
  );
}

/** The non-secret half of the dev runtime config, written verbatim. */
export function devGcpRuntimeConfig(): ReadonlyMap<string, string> {
  return new Map([
    ['GCP_PROJECT_ID', 'example-app'],
    [
      'GCP_WORKLOAD_IDENTITY_PROVIDER',
      'projects/123456789012/locations/global/workloadIdentityPools/github-actions/providers/github',
    ],
    ['GCP_SERVICE_ACCOUNT', 'github-actions-ci@example-app.iam.gserviceaccount.com'],
    ['INSTANCE_CONNECTION_NAME', 'example-app:us-central1:example-dev-postgres'],
    ['DB_IAM_USER', 'github-actions-ci@example-app.iam'],
    ['DB_NAME', 'example'],
    ['GCS_ASSET_BUCKET', 'example-app-public-assets'],
  ]);
}

/** The secrets the lane reads from Secret Manager, and where each lands. */
export const devGcpRuntimeSecrets: readonly (readonly [
  secretName: string,
  variableName: string,
])[] = [
  ['IDENTITY_PLATFORM_SERVER_API_KEY', 'IDENTITY_PLATFORM_API_KEY'],
  ['AUTH_CODE_PEPPER', 'AUTH_CODE_PEPPER'],
];

// ---------------------------------------------------------------------------
// Lane-isolated backend port
// ---------------------------------------------------------------------------

export function laneBackendPortExports(port: number): ReadonlyMap<string, string> {
  return new Map([
    ['ONBOARDING_DEV_BACKEND_PORT', String(port)],
    ['TEST_RUNNER_UI_TEST_API_BASE_URL', `http://127.0.0.1:${port}/api`],
  ]);
}

export function allocatedPortMessage(port: number, lane: string): string {
  return `Allocated isolated backend port ${port} for ${lane}.`;
}

// ---------------------------------------------------------------------------
// Chat Plaid identity
// ---------------------------------------------------------------------------

/** The fixed password the Chat Plaid seed and the XCUITest runner both use. */
export const chatPlaidPassword = 'ChatPlaidE2E3767';

export function chatPlaidEmail(runId: string, runAttempt: string): string {
  return `chat-plaid-${runId}-${runAttempt}@test.example.local`;
}

export const missingCleanupTokenMessage = 'missing confirmed cleanupToken';

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * The cleanup token the bootstrap returns, or `undefined` when the response
 * does not prove a confirmed identity — which the shell treated as fatal.
 */
export function chatPlaidCleanupToken(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (record === undefined || record.confirmed !== true) return undefined;
  const token = record.cleanupToken;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

export function chatPlaidSeedArguments(inputs: {
  readonly email: string;
  readonly password: string;
}): readonly string[] {
  return [
    'run', 'dev:seed:db', '--',
    '--email', inputs.email,
    '--password', inputs.password,
    '--file', 'server/testdata/chat-plaid-e2e-seed.json',
    '--truncate-user',
  ];
}

// ---------------------------------------------------------------------------
// Simulator selection
// ---------------------------------------------------------------------------

/**
 * Backend-only evidence and every other scope provision on the pinned iOS
 * simulator runtime; they differ only in the simulator each one names.
 */
export function simulatorProvisionPurpose(testScope: string): 'backend' | 'onboarding' {
  return testScope === 'debt-card-evidence' ? 'backend' : 'onboarding';
}

// ---------------------------------------------------------------------------
// Video review tooling
// ---------------------------------------------------------------------------

export const videoToolingBinaries = ['ffmpeg', 'ffprobe'] as const;

export const missingVideoToolingMessage =
  'ffmpeg/ffprobe are required for onboarding video review, and Homebrew is not available to install them';

export function videoToolingStillMissingMessage(missing: readonly string[]): string {
  return `Installed ffmpeg but ${missing.join(' and ')} are still unavailable`;
}

export type VideoToolingPlan = 'present' | 'install' | 'unavailable';

export function videoToolingPlan(inputs: {
  readonly present: readonly boolean[];
  readonly homebrewAvailable: boolean;
}): VideoToolingPlan {
  if (inputs.present.every((found) => found)) return 'present';
  return inputs.homebrewAvailable ? 'install' : 'unavailable';
}

// ---------------------------------------------------------------------------
// Development FullOnboarding identities
// ---------------------------------------------------------------------------

export interface OnboardingIdentities {
  readonly onboardingEmail: string;
  readonly privacyEmail: string;
}

export function onboardingIdentities(runId: string, runAttempt: string): OnboardingIdentities {
  return {
    onboardingEmail: `onboard-ci-${runId}-${runAttempt}@test.example.local`,
    privacyEmail: `privacy-ci-${runId}-${runAttempt}@test.example.local`,
  };
}

export const identityNotConfirmedMessage =
  'development FullOnboarding identity was not confirmed';

/** The bootstrap must confirm the exact address asked for, not merely succeed. */
export function onboardingIdentityConfirmed(payload: unknown, expectedEmail: string): boolean {
  const record = asRecord(payload);
  return record?.confirmed === true && record.email === expectedEmail;
}

export function onboardingIdentityExports(
  identities: OnboardingIdentities,
  password: string,
): ReadonlyMap<string, string> {
  return new Map([
    ['UI_TEST_SYNTHETIC_PASSWORD', password],
    ['UI_TEST_SYNTHETIC_ONBOARDING_EMAIL', identities.onboardingEmail],
    ['UI_TEST_SYNTHETIC_PRIVACY_EMAIL', identities.privacyEmail],
  ]);
}

// ---------------------------------------------------------------------------
// Dashboard offline proxy
// ---------------------------------------------------------------------------

export const dashboardProxyEntryPoint = 'ci/src/actions/ios/onboardingDashboardOfflineProxy.ts';

/** The wrapper's first record: ownership is knowable before readiness is. */
export function dashboardProxyPidRecord(pid: number): string {
  return JSON.stringify({ pid });
}

/** The wrapper's last record; the stop step blocks on it rather than polling. */
export function dashboardProxyExitRecord(status: number): string {
  return JSON.stringify({ exited: status });
}

/** Shared TypeScript log watcher patterns, kept beside the records they match. */
export const dashboardProxyPidPattern = '"pid":';
export const dashboardProxyReadyOrExitPattern = '"ready":true|"exited":';

export const dashboardProxyNotReadyMessage = 'Dashboard offline proxy did not become ready';

/**
 * The port from the first log record that announces readiness for this exact
 * commit — the `jq … | head -n 1` filter, without a shell. A record for a
 * different commit belongs to another run's proxy and is ignored.
 */
export function dashboardProxyPort(logText: string, commitSha: string): number | undefined {
  for (const line of logText.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record?.ready !== true || record.commitSha !== commitSha) continue;
    const port = record.port;
    if (typeof port === 'number' && Number.isInteger(port) && isUsablePort(port)) return port;
    if (typeof port === 'string' && /^[1-9][0-9]*$/.test(port)) {
      const numeric = Number.parseInt(port, 10);
      if (isUsablePort(numeric)) return numeric;
    }
    return undefined;
  }
  return undefined;
}

/** The shell's `[[ $port =~ ^[1-9][0-9]*$ ]] && (( port <= 65535 ))`. */
export function isUsablePort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** The proxy's own health endpoint must name this run's commit, not just answer. */
export function dashboardProxyHealthy(payload: unknown, commitSha: string): boolean {
  const record = asRecord(payload);
  return record?.ready === true && record.commitSha === commitSha;
}

export function dashboardProxyEnvironment(inputs: {
  readonly backendPort: string;
  readonly controlToken: string;
  readonly commitSha: string;
  readonly eventsPath: string;
}): Readonly<Record<string, string>> {
  return {
    DASHBOARD_OFFLINE_PROXY_PORT: '0',
    DASHBOARD_OFFLINE_PROXY_UPSTREAM: `http://127.0.0.1:${inputs.backendPort}`,
    DASHBOARD_OFFLINE_PROXY_CONTROL_TOKEN: inputs.controlToken,
    DASHBOARD_OFFLINE_PROXY_COMMIT_SHA: inputs.commitSha,
    DASHBOARD_OFFLINE_PROXY_EVENTS: inputs.eventsPath,
  };
}

export function dashboardProxyOwnershipExports(inputs: {
  readonly pid: number;
  readonly controlToken: string;
}): ReadonlyMap<string, string> {
  return new Map([
    ['DASHBOARD_OFFLINE_PROXY_PID', String(inputs.pid)],
    ['DASHBOARD_OFFLINE_PROXY_CONTROL_TOKEN', inputs.controlToken],
  ]);
}

// ---------------------------------------------------------------------------
// Onboarding execution
// ---------------------------------------------------------------------------

/**
 * The onboarding lane talks to the offline proxy, never straight to the
 * backend: the offline scenarios are produced by the proxy cutting the link.
 */
export function onboardingApiBaseUrl(proxyPort: string): string {
  return `http://127.0.0.1:${proxyPort}/api`;
}

export function onboardingRecoveryArguments(inputs: {
  readonly recoveryLog: string;
  readonly laneScript: string;
}): readonly string[] {
  return [
    'scripts/run-with-ios-cache-recovery.sh',
    inputs.recoveryLog,
    '--',
    'bash',
    inputs.laneScript,
  ];
}

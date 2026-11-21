/**
 * The Chat Plaid real-server lane: what it runs, what it validates, and how it
 * deletes the identity it created.
 *
 * The lane reuses the products the E2E build job produced, so its run is a
 * `test-without-building` over one suite. Every value that varies — the
 * `.xctestrun`, the simulator destination, the result bundle — arrives as an
 * argument in the array below and never as a word in a shell command, which
 * is the point of moving the step off `run: |`.
 *
 * Pure: no filesystem, no spawning, no network.
 */

/** The single suite this lane owns. */
export const chatPlaidTestIdentifier = 'example-iosOnboardingUITests/ChatPlaidLinkE2ETests';

export const missingXctestrunMessage = 'Chat Plaid build did not produce an .xctestrun file.';

export interface ChatPlaidRunInputs {
  readonly xctestrunPath: string;
  readonly destination: string;
  readonly resultBundle: string;
}

/**
 * `xcodebuild test-without-building …`. The suite runs serially and retries
 * once on failure: a Plaid Sandbox link is a real network round trip, so a
 * single flake must not fail a lane while a reproducible failure still does.
 */
export function chatPlaidXcodebuildArguments(inputs: ChatPlaidRunInputs): readonly string[] {
  return [
    'xcodebuild', 'test-without-building',
    '-xctestrun', inputs.xctestrunPath,
    '-destination', inputs.destination,
    '-parallel-testing-enabled', 'NO',
    `-only-testing:${chatPlaidTestIdentifier}`,
    '-retry-tests-on-failure',
    '-test-iterations', '2',
    '-test-repetition-relaunch-enabled', 'YES',
    '-resultBundlePath', inputs.resultBundle,
  ];
}

/** The wrapper that reruns a run killed by a corrupt derived-data cache. */
export function cacheRecoveryArguments(
  recoveryLog: string,
  command: readonly string[],
): readonly string[] {
  return ['scripts/run-with-ios-cache-recovery.sh', recoveryLog, '--', ...command];
}

export function chatPlaidRecoveryLog(runDirectory: string): string {
  return `${runDirectory}/chat-plaid-infra-recovery.log`;
}

export function chatPlaidBackendEvidenceArguments(
  backendLog: string,
  evidenceDirectory: string,
): readonly string[] {
  return [
    'ci/src/actions/ios/validateChatPlaidE2eLog.ts',
    backendLog,
    '--output',
    `${evidenceDirectory}/backend-evidence.json`,
  ];
}

export const chatPlaidBundleUnavailableMessage =
  'Chat Plaid result bundle is unavailable; no screenshots to export';

export interface ChatPlaidScreenshotPaths {
  readonly resultBundle: string;
  readonly evidenceDirectory: string;
  readonly screenshotsDirectory: string;
}

/**
 * Both paths keep the runner-temp default the shell used, so a lane whose run
 * directory was never published still exports somewhere rather than being
 * handed an empty argument.
 */
export function chatPlaidScreenshotPaths(
  runnerTemp: string,
  values: Readonly<Record<string, string | undefined>>,
): ChatPlaidScreenshotPaths {
  const resultBundle = orDefault(
    values.CHAT_PLAID_E2E_RESULT_BUNDLE,
    `${runnerTemp}/chat-plaid-e2e.xcresult`,
  );
  const evidenceDirectory = orDefault(
    values.CHAT_PLAID_E2E_EVIDENCE_DIR,
    `${runnerTemp}/chat-plaid-evidence`,
  );
  return { resultBundle, evidenceDirectory, screenshotsDirectory: `${evidenceDirectory}/screenshots` };
}

function orDefault(value: string | undefined, fallback: string): string {
  return value === undefined || value.length === 0 ? fallback : value;
}

/** Immediate re-requests only cover a transient API blip, as for the other lanes. */
export const chatPlaidCleanupAttempts = 3;

export const chatPlaidCleanupSkippedMessage =
  'No Chat Plaid E2E identity was prepared; cleanup is not required.';

export const chatPlaidCleanupFailedMessage =
  'Chat Plaid E2E cleanup failed after 3 attempts; user retained for retry';

export function chatPlaidCleanupAttemptMessage(attempt: number): string {
  return `Chat Plaid E2E cleanup attempt ${attempt} failed`;
}

/**
 * The headers the delete request carries. Each is sent only when its secret
 * was exported, which is how the shell built its `curl` argument array: a
 * blank header value would otherwise read as an empty credential.
 */
export function chatPlaidCleanupHeaders(
  values: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  const otpSecret = values.TEST_OTP_SECRET ?? '';
  if (otpSecret.length > 0) headers['x-test-otp-secret'] = otpSecret;
  const cleanupToken = values.CHAT_PLAID_E2E_CLEANUP_TOKEN ?? '';
  if (cleanupToken.length > 0) headers['x-test-user-cleanup-token'] = cleanupToken;
  return headers;
}

export function chatPlaidCleanupEndpoint(backendPort: string): string {
  return `http://127.0.0.1:${backendPort}/api/auth/test/user`;
}

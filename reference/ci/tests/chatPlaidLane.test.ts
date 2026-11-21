import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cacheRecoveryArguments,
  chatPlaidBackendEvidenceArguments,
  chatPlaidCleanupAttemptMessage,
  chatPlaidCleanupEndpoint,
  chatPlaidCleanupHeaders,
  chatPlaidRecoveryLog,
  chatPlaidScreenshotPaths,
  chatPlaidTestIdentifier,
  chatPlaidXcodebuildArguments,
} from '../src/ios/chatPlaidLane.ts';

test('the suite runs serially, retries once, and writes the lane bundle', () => {
  assert.deepEqual(
    chatPlaidXcodebuildArguments({
      xctestrunPath: '/products/example.xctestrun',
      destination: 'platform=iOS Simulator,id=ABC',
      resultBundle: '/run/chat-plaid-e2e.xcresult',
    }),
    [
      'xcodebuild', 'test-without-building',
      '-xctestrun', '/products/example.xctestrun',
      '-destination', 'platform=iOS Simulator,id=ABC',
      '-parallel-testing-enabled', 'NO',
      `-only-testing:${chatPlaidTestIdentifier}`,
      '-retry-tests-on-failure',
      '-test-iterations', '2',
      '-test-repetition-relaunch-enabled', 'YES',
      '-resultBundlePath', '/run/chat-plaid-e2e.xcresult',
    ],
  );
});

test('a destination carrying shell syntax stays one argument', () => {
  const hostile = 'platform=iOS Simulator,id=$(rm -rf /); echo';
  const args = chatPlaidXcodebuildArguments({
    xctestrunPath: '/p; rm -rf /',
    destination: hostile,
    resultBundle: '/r',
  });
  assert.equal(args[args.indexOf('-destination') + 1], hostile);
  assert.equal(args[args.indexOf('-xctestrun') + 1], '/p; rm -rf /');
});

test('the recovery wrapper separates its own log from the command with --', () => {
  assert.deepEqual(
    cacheRecoveryArguments('/run/chat-plaid-infra-recovery.log', ['xcodebuild', 'test']),
    ['scripts/run-with-ios-cache-recovery.sh', '/run/chat-plaid-infra-recovery.log', '--', 'xcodebuild', 'test'],
  );
  assert.equal(chatPlaidRecoveryLog('/run'), '/run/chat-plaid-infra-recovery.log');
});

test('the backend evidence validator names its output file under the evidence directory', () => {
  assert.deepEqual(
    chatPlaidBackendEvidenceArguments('/run/backend/devserver.log', '/run/chat-plaid-evidence'),
    [
      'ci/src/actions/ios/validateChatPlaidE2eLog.ts',
      '/run/backend/devserver.log',
      '--output',
      '/run/chat-plaid-evidence/backend-evidence.json',
    ],
  );
});

test('screenshot paths fall back to the runner temp and hang the screenshots off the evidence tree', () => {
  assert.deepEqual(chatPlaidScreenshotPaths('/tmp/runner', {}), {
    resultBundle: '/tmp/runner/chat-plaid-e2e.xcresult',
    evidenceDirectory: '/tmp/runner/chat-plaid-evidence',
    screenshotsDirectory: '/tmp/runner/chat-plaid-evidence/screenshots',
  });
  assert.deepEqual(
    chatPlaidScreenshotPaths('/tmp/runner', {
      CHAT_PLAID_E2E_RESULT_BUNDLE: '/run/b.xcresult',
      CHAT_PLAID_E2E_EVIDENCE_DIR: '',
    }),
    {
      resultBundle: '/run/b.xcresult',
      evidenceDirectory: '/tmp/runner/chat-plaid-evidence',
      screenshotsDirectory: '/tmp/runner/chat-plaid-evidence/screenshots',
    },
  );
});

test('a cleanup header is sent only when its secret was exported', () => {
  assert.deepEqual(chatPlaidCleanupHeaders({}), {});
  assert.deepEqual(chatPlaidCleanupHeaders({ TEST_OTP_SECRET: '', CHAT_PLAID_E2E_CLEANUP_TOKEN: '' }), {});
  assert.deepEqual(chatPlaidCleanupHeaders({ TEST_OTP_SECRET: 's' }), { 'x-test-otp-secret': 's' });
  assert.deepEqual(
    chatPlaidCleanupHeaders({ TEST_OTP_SECRET: 's', CHAT_PLAID_E2E_CLEANUP_TOKEN: 't' }),
    { 'x-test-otp-secret': 's', 'x-test-user-cleanup-token': 't' },
  );
});

test('the cleanup endpoint stays on loopback and the attempt message counts from one', () => {
  assert.equal(chatPlaidCleanupEndpoint('3200'), 'http://127.0.0.1:3200/api/auth/test/user');
  assert.equal(chatPlaidCleanupAttemptMessage(1), 'Chat Plaid E2E cleanup attempt 1 failed');
  assert.equal(chatPlaidCleanupAttemptMessage(3), 'Chat Plaid E2E cleanup attempt 3 failed');
});

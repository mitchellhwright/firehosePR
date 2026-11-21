import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactSummaryArguments,
  compactSummaryLane,
  compactSummaryTarget,
  e2eLanes,
  failureSummaryArguments,
  failureSummaryTarget,
  isE2eLane,
} from '../src/ios/e2eResultArtifacts.ts';

const runnerTemp = '/tmp/runner';

test('each lane summarises its own bundle and log', () => {
  const values = {
    ONBOARDING_E2E_RESULT_BUNDLE: '/run/onboarding-e2e.xcresult',
    ONBOARDING_E2E_XCODEBUILD_LOG: '/run/xcodebuild.log',
    BUDGET_E2E_RESULT_BUNDLE: '/run/budget-e2e.xcresult',
    BUDGET_E2E_XCODEBUILD_LOG: '/run/budget-xcodebuild.log',
  };
  assert.deepEqual(failureSummaryTarget('onboarding', { runnerTemp, values }), {
    resultBundle: '/run/onboarding-e2e.xcresult',
    xcodebuildLog: '/run/xcodebuild.log',
  });
  assert.deepEqual(failureSummaryTarget('budget', { runnerTemp, values }), {
    resultBundle: '/run/budget-e2e.xcresult',
    xcodebuildLog: '/run/budget-xcodebuild.log',
  });
});

test('an absent or blank path falls back to the lane name under the runner temp', () => {
  for (const values of [{}, { CHAT_PLAID_E2E_RESULT_BUNDLE: '', CHAT_PLAID_E2E_XCODEBUILD_LOG: '' }]) {
    assert.deepEqual(failureSummaryTarget('chat-plaid', { runnerTemp, values }), {
      resultBundle: `${runnerTemp}/chat-plaid-e2e.xcresult`,
      xcodebuildLog: `${runnerTemp}/chat-plaid-e2e-xcodebuild.log`,
    });
  }
  assert.deepEqual(failureSummaryTarget('income', { runnerTemp, values: {} }), {
    resultBundle: `${runnerTemp}/income-e2e.xcresult`,
    xcodebuildLog: `${runnerTemp}/income-e2e-xcodebuild.log`,
  });
});

test('the summariser is invoked with the log behind its own flag', () => {
  assert.deepEqual(
    failureSummaryArguments({ resultBundle: '/a b.xcresult', xcodebuildLog: '/c d.log' }),
    ['scripts/summarize-ios-test-failures.py', '/a b.xcresult', '--xcodebuild-log', '/c d.log'],
  );
});

test('every lane has a distinct compact summary label and file', () => {
  const labels = new Set<string>();
  const files = new Set<string>();
  for (const lane of e2eLanes) {
    const target = compactSummaryTarget(lane, '/run', {});
    assert.ok(!labels.has(target.label), lane);
    assert.ok(!files.has(target.outputPath), lane);
    labels.add(target.label);
    files.add(target.outputPath);
  }
  assert.deepEqual(
    compactSummaryTarget('onboarding', '/run', { ONBOARDING_E2E_RESULT_BUNDLE: '/run/o.xcresult' }),
    { label: 'FullOnboarding E2E', resultBundle: '/run/o.xcresult', outputPath: '/run/onboarding-summary.json' },
  );
});

test('a lane with no bundle passes an empty argument, as "${VAR:-}" did', () => {
  // The exporter itself distinguishes "no bundle" from "bundle missing", so
  // the empty value has to survive rather than becoming a runner-temp guess.
  const target = compactSummaryTarget('budget', '/run', {});
  assert.equal(target.resultBundle, '');
  assert.deepEqual(compactSummaryArguments(target), [
    'scripts/export-ios-xcresult-summaries.sh', 'Budget E2E', '', '/run/budget-e2e-summary.json',
  ]);
});

test('an unrecognised lane still writes the Budget summary, as the shell else branch did', () => {
  for (const value of ['', 'budget', 'storekit', 'ONBOARDING', 'toString', 'Budget ']) {
    assert.equal(compactSummaryLane(value), 'budget', value);
  }
  assert.equal(compactSummaryLane('income'), 'income');
  assert.equal(compactSummaryLane('chat-plaid'), 'chat-plaid');
  assert.equal(compactSummaryLane('onboarding'), 'onboarding');
  assert.equal(isE2eLane('storekit'), false);
  assert.equal(isE2eLane('income'), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  debtCardCacheDirectory,
  debtCardCacheRelativePath,
  issue3996PersistLabel,
  planDebtCardCacheRemoval,
  planIssue3996Evidence,
} from '../src/ios/debtCardEvidence.ts';
import {
  checkLifecycleOutcomes,
  dashboardOfflineEvidenceArguments,
  lifecycleOutcomeVariables,
  renderDevelopmentCleanupAdvisory,
  requiredLifecycleOutcomeVariables,
  summarizeDevelopmentCleanupEvidence,
} from '../src/ios/onboardingLifecycleEvidence.ts';

test('incomplete cleanup summary identifies missing role without claiming artifact upload failed', () => {
  const advisory = renderDevelopmentCleanupAdvisory({
    commitSha: 'a'.repeat(40),
    verifiedRoles: ['onboarding'],
    manifest: { cleanup: { complete: false, verifiedRoles: ['onboarding'] } },
  });
  assert.match(advisory, /Roles requiring verification: privacy/);
  assert.match(advisory, /"complete": false/);
  assert.doesNotMatch(advisory, /artifact storage rejected|upload failed/i);
});

test('only the workspace-relative cache directory may be removed', () => {
  assert.equal(debtCardCacheRelativePath, '.example-ci/debt-card-test-products-cache');
  assert.equal(debtCardCacheDirectory('/w'), '/w/.example-ci/debt-card-test-products-cache');
  assert.deepEqual(planDebtCardCacheRemoval('/w', '/w/.example-ci/debt-card-test-products-cache'), {
    kind: 'remove',
    path: '/w/.example-ci/debt-card-test-products-cache',
  });
});

test('any other path is refused, including a parent, a sibling and a traversal', () => {
  for (const requested of [
    '', '/', '/w', '/w/', '/w/.example-ci',
    '/w/.example-ci/debt-card-test-products-cache/',
    '/w/.example-ci/debt-card-test-products-cache/..',
    '/w/../.example-ci/debt-card-test-products-cache',
    '/other/.example-ci/debt-card-test-products-cache',
  ]) {
    const plan = planDebtCardCacheRemoval('/w', requested);
    assert.equal(plan.kind, 'refuse', requested);
    if (plan.kind !== 'refuse') continue;
    assert.deepEqual(plan.messages, [
      { level: 'error', text: `Refusing to remove unexpected cache path: ${requested}` },
    ]);
  }
});

test('the issue 3996 plan exports, validates and persists from one evidence root', () => {
  const plan = planIssue3996Evidence({
    evidenceDirectory: '/run/issue-3996-evidence',
    resultBundle: '/run/budget-e2e.xcresult',
    xcodebuildLog: '/run/budget-xcodebuild.log',
    cleanupReceipt: '/run/issue-3996-cleanup-receipt.json',
    evidenceJson: '/run/issue-3996-evidence/evidence.json',
    exactHeadSha: 'a'.repeat(40),
  });
  assert.equal(plan.attachmentsDirectory, '/run/issue-3996-evidence/attachments');
  assert.deepEqual(plan.exportArguments, [
    'xcresulttool', 'export', 'attachments',
    '--path', '/run/budget-e2e.xcresult',
    '--output-path', '/run/issue-3996-evidence/attachments',
  ]);
  assert.deepEqual(plan.validateArguments, [
    'ci/src/actions/ios/validateDebtHistoryEvidence.ts',
    '/run/budget-e2e.xcresult',
    '/run/budget-xcodebuild.log',
    '/run/issue-3996-evidence/attachments',
    '/run/issue-3996-cleanup-receipt.json',
    '/run/issue-3996-evidence/evidence.json',
    'a'.repeat(40),
  ]);
  assert.equal(plan.persistLabel, issue3996PersistLabel);
  assert.deepEqual(plan.persistPaths, [
    '/run/issue-3996-evidence', '/run/issue-3996-cleanup-receipt.json',
  ]);
});

test('the FullOnboarding lifecycle gate requires the journey and proxy, while reporting cleanup', () => {
  const allSucceeded = Object.fromEntries(lifecycleOutcomeVariables.map((name) => [name, 'success']));
  assert.deepEqual(checkLifecycleOutcomes(allSucceeded), { messages: [], exitCode: 0 });
  assert.equal(lifecycleOutcomeVariables.length, 5);
  assert.equal(requiredLifecycleOutcomeVariables.length, 4);

  for (const variable of requiredLifecycleOutcomeVariables) {
    for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
      const verdict = checkLifecycleOutcomes({ ...allSucceeded, [variable]: outcome });
      assert.equal(verdict.exitCode, 1, `${variable}=${outcome}`);
      assert.deepEqual(verdict.messages, [{
        level: 'error',
        text: `Development FullOnboarding lifecycle outcome was ${outcome}`,
      }]);
    }
  }

  for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
    assert.deepEqual(checkLifecycleOutcomes({ ...allSucceeded, CLEANUP_OUTCOME: outcome }), {
      messages: [{
        level: 'warning',
        text: `Development FullOnboarding cleanup outcome was ${outcome}; `
          + 'synthetic development users may remain and require cleanup',
      }],
      exitCode: 0,
    });
  }
});

test('cleanup evidence reports exact-head verified deletions without determining journey success', () => {
  const sha = 'a'.repeat(40);
  const record = (role: string, commitSha = sha) => JSON.stringify({
    event: 'development_synthetic_user_deleted', role, deleted: true, verified: true, commitSha,
  });
  assert.deepEqual(summarizeDevelopmentCleanupEvidence(`${record('onboarding')}\n${record('privacy')}\n`, sha), {
    complete: true, verifiedRoles: ['onboarding', 'privacy'],
  });
  assert.deepEqual(summarizeDevelopmentCleanupEvidence(record('onboarding'), sha), {
    complete: false, verifiedRoles: ['onboarding'],
  });
  for (const source of [undefined, '', 'not-json', record('onboarding', 'b'.repeat(40)),
    `${record('onboarding')}\n${record('onboarding')}`]) {
    assert.equal(summarizeDevelopmentCleanupEvidence(source, sha).complete, false);
  }
});

test('the gate reports the first failing outcome, in the order the lane runs them', () => {
  const verdict = checkLifecycleOutcomes({
    PROVISION_OUTCOME: 'success',
    PROXY_START_OUTCOME: 'failure',
    ONBOARDING_OUTCOME: 'skipped',
    PROXY_STOP_OUTCOME: 'success',
    CLEANUP_OUTCOME: 'success',
  });
  assert.deepEqual(verdict.messages, [{
    level: 'error',
    text: 'Development FullOnboarding lifecycle outcome was failure',
  }]);
});

test('the dashboard evidence validator keeps each path behind its own flag', () => {
  assert.deepEqual(
    dashboardOfflineEvidenceArguments({
      events: '/run/events.jsonl',
      cleanup: '/run/cleanup.jsonl',
      xcodeLog: '/run/xcodebuild.log',
      xcresult: '/run/onboarding-e2e.xcresult',
      sha: 'b'.repeat(40),
      output: '/run/evidence.json',
    }),
    [
      'ci/src/actions/ios/validateOnboardingDashboardOfflineEvidence.ts',
      '--events', '/run/events.jsonl',
      '--cleanup', '/run/cleanup.jsonl',
      '--xcode-log', '/run/xcodebuild.log',
      '--xcresult', '/run/onboarding-e2e.xcresult',
      '--sha', 'b'.repeat(40),
      '--output', '/run/evidence.json',
    ],
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evidenceRetentionKinds,
  isRetentionKindName,
  planEvidenceRetention,
  retentionPath,
  type EvidenceRetentionKind,
  type RetentionKindName,
} from '../src/ios/e2eEvidenceRetention.ts';

const everything = (): boolean => true;
const nothing = (): boolean => false;

function plan(
  kind: EvidenceRetentionKind,
  environment: Readonly<Record<string, string | undefined>>,
  present: readonly string[] | 'all' = 'all',
) {
  const exists = present === 'all'
    ? everything
    : (path: string): boolean => present.includes(path);
  return planEvidenceRetention({ kind, environment, pathExists: exists, isNonEmptyFile: exists });
}

const fallbackKinds = Object.entries(evidenceRetentionKinds)
  .filter(([, kind]) => kind.mode === 'fallback');

test('every fallback keeps the paths that exist, in the order the lane listed them', () => {
  const environment = {
    ONBOARDING_E2E_RUN_DIR: '/run',
    INCOME_E2E_RUN_DIR: '/run/income-e2e',
    INCOME_E2E_XCODEBUILD_LOG: '/run/income-e2e/xcodebuild.log',
    INCOME_E2E_COMPRESSED_VIDEO: '/run/income-e2e/evidence.mp4',
    INCOME_E2E_DB_PROXY_LOG: '/run/income-e2e/cloud-sql-proxy.log',
    INCOME_E2E_PROVIDER_AUDIT_LOG: '/run/income-e2e/provider.jsonl',
  };
  const result = plan(evidenceRetentionKinds['income-evidence'], environment);
  assert.deepEqual(result.persist, {
    label: 'Income activation E2E',
    paths: [
      '/run/income-e2e-summary.json',
      '/run/income-e2e/evidence-summary.json',
      '/run/income-e2e/xcodebuild.log',
      '/run/income-e2e/evidence.mp4',
      '/run/income-e2e/cloud-sql-proxy.log',
      '/run/income-e2e/provider.jsonl',
    ],
  });
  assert.deepEqual(result.messages, []);
  assert.equal(result.exitCode, 0);
});

test('a path whose variable was never exported is dropped, not passed as an empty argument', () => {
  const result = plan(evidenceRetentionKinds['chat-plaid-evidence'], {
    ONBOARDING_E2E_RUN_DIR: '/run',
    CHAT_PLAID_E2E_EVIDENCE_DIR: '/run/chat-plaid-evidence',
  });
  assert.deepEqual(result.persist?.paths, ['/run/chat-plaid-summary.json', '/run/chat-plaid-evidence']);
});

test('a composed path survives an unset prefix, as the shell "${VAR:-}/name" did', () => {
  // `"${ONBOARDING_E2E_RUN_DIR:-}/shards"` was never empty, so it reached the
  // `-e` test; only the plain variables were dropped by `-n`.
  assert.equal(retentionPath({ variable: 'MISSING', suffix: '/shards' }, {}), '/shards');
  assert.equal(retentionPath({ variable: 'MISSING' }, {}), '');
  const result = plan(
    evidenceRetentionKinds['budget-diagnostics'],
    { BUDGET_E2E_RESULT_BUNDLE: '' },
    ['/shards'],
  );
  assert.deepEqual(result.persist?.paths, ['/shards']);
});

test('a fallback with nothing left warns and stays green, or fails, per lane', () => {
  const empty = (name: RetentionKindName) =>
    plan(evidenceRetentionKinds[name], {}, []);

  for (const name of ['income-evidence', 'chat-plaid-evidence', 'full-onboarding-evidence',
    'full-onboarding-diagnostics', 'budget-evidence'] as const) {
    const result = empty(name);
    assert.equal(result.exitCode, 0, name);
    assert.equal(result.messages[0]?.level, 'warning', name);
    assert.equal(result.persist, undefined, name);
  }

  // The two lanes whose reviewers have nothing else to read fail instead.
  for (const name of ['chat-plaid-diagnostics', 'budget-diagnostics'] as const) {
    const result = empty(name);
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.messages[0]?.level, 'error', name);
  }
  assert.deepEqual(empty('budget-diagnostics').messages, [{
    level: 'error',
    text: 'The Budget diagnostic upload failed and no local diagnostics exist.',
  }]);
  assert.deepEqual(empty('income-evidence').messages, [{
    level: 'warning',
    text: 'The Income evidence upload failed and no local evidence exists.',
  }]);
});

test('every fallback kind has a distinct label and a non-empty candidate list', () => {
  const labels = new Set<string>();
  for (const [name, kind] of fallbackKinds) {
    assert.equal(kind.mode, 'fallback');
    if (kind.mode !== 'fallback') continue;
    assert.ok(kind.candidates.length > 0, name);
    assert.ok(!labels.has(kind.label), `duplicate label ${kind.label}`);
    labels.add(kind.label);
  }
  assert.equal(labels.size, 7);
});

test('a required retention keeps every receipt whether or not it exists on disk', () => {
  const environment = {
    IOS_3998_FRESHNESS_RECEIPT: '/r/fresh.json',
    IOS_3998_CLEANUP_RECEIPT: '/r/cleanup.json',
    BUDGET_E2E_XCODEBUILD_LOG: '/r/build.log',
    BUDGET_E2E_RESULT_BUNDLE: '/r/b.xcresult',
  };
  // `pathExists` is false for everything: the required mode never filtered.
  const result = planEvidenceRetention({
    kind: evidenceRetentionKinds['issue-3998-freshness'],
    environment,
    pathExists: nothing,
    isNonEmptyFile: everything,
  });
  assert.deepEqual(result.persist?.paths, ['/r/fresh.json', '/r/cleanup.json', '/r/build.log', '/r/b.xcresult']);
});

test('a required receipt that is missing, empty or unset fails before anything persists', () => {
  const environment = {
    IOS_3998_FRESHNESS_RECEIPT: '/r/fresh.json',
    IOS_3998_CLEANUP_RECEIPT: '/r/cleanup.json',
    BUDGET_E2E_XCODEBUILD_LOG: '/r/build.log',
    BUDGET_E2E_RESULT_BUNDLE: '/r/b.xcresult',
  };
  const kind = evidenceRetentionKinds['issue-3998-freshness'];

  const emptyFile = planEvidenceRetention({
    kind, environment, pathExists: everything, isNonEmptyFile: nothing,
  });
  assert.equal(emptyFile.exitCode, 1);
  assert.equal(emptyFile.persist, undefined);
  assert.deepEqual(emptyFile.messages, [{
    level: 'error',
    text: 'Issue 3998 automated freshness acceptance evidence is missing or empty: /r/fresh.json',
  }]);

  const unsetReceipt = planEvidenceRetention({
    kind,
    environment: { ...environment, IOS_3998_CLEANUP_RECEIPT: '' },
    pathExists: everything,
    isNonEmptyFile: everything,
  });
  assert.equal(unsetReceipt.exitCode, 1);
  assert.match(unsetReceipt.messages[0]?.text ?? '', /IOS_3998_CLEANUP_RECEIPT is required/);

  // `set -u` also stopped the step when a path it merely passed through was
  // unset, so an absent log must not reach the persist script as ''.
  const unsetPassthrough = planEvidenceRetention({
    kind,
    environment: { ...environment, BUDGET_E2E_RESULT_BUNDLE: undefined },
    pathExists: everything,
    isNonEmptyFile: everything,
  });
  assert.equal(unsetPassthrough.exitCode, 1);
  assert.match(unsetPassthrough.messages[0]?.text ?? '', /BUDGET_E2E_RESULT_BUNDLE is required/);
});

test('only the nine declared kinds are accepted', () => {
  assert.equal(Object.keys(evidenceRetentionKinds).length, 9);
  for (const name of Object.keys(evidenceRetentionKinds)) assert.ok(isRetentionKindName(name));
  for (const name of ['', 'budget', 'issue-3997', 'toString', '__proto__']) {
    assert.equal(isRetentionKindName(name), false, name);
  }
});

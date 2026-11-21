#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const screenshotNames = [
  'issue-3996-history-absent',
  'issue-3996-category-saved',
  'issue-3996-category-persisted',
];
const zeroCountKeys = [
  'authIdentities',
  'publicUsers',
  'plaidItems',
  'plaidAccounts',
  'debtCategoryOverrides',
];

type RequiredPathType = 'directory' | 'file';

interface Attachment {
  readonly suggestedHumanReadableName: string;
  readonly isAssociatedWithFailure: boolean;
  readonly exportedFileName: string;
}

interface CleanupPayload {
  readonly deleted: true;
  readonly verified: true;
  readonly alreadyAbsent: boolean;
  readonly counts: Readonly<Record<string, unknown>>;
}

function fail(message: string): never {
  process.stderr.write(`Issue #3996 evidence invalid: ${message}\n`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is missing ${key}`);
  return value;
}

function requirePath(path: string, label: string, type: RequiredPathType): void {
  if (!existsSync(path)) fail(`${label} is missing at ${path}`);
  const stats = statSync(path);
  if (type === 'directory' && !stats.isDirectory()) fail(`${label} is not a directory`);
  if (type === 'file' && !stats.isFile()) fail(`${label} is not a file`);
  if (type === 'file' && stats.size === 0) fail(`${label} is empty`);
}

function readJSON(path: string, label: string): unknown {
  requirePath(path, label, 'file');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactMarker(log: string, name: string): string {
  const matches = [...log.matchAll(new RegExp(`^${escapeRegex(name)}=(.*)$`, 'gm'))];
  if (matches.length !== 1) fail(`expected exactly one ${name} marker; found ${matches.length}`);
  const value = matches[0]?.[1];
  if (value === undefined) fail(`${name} marker has no value`);
  return value.trim();
}

function attachmentEntries(attachmentRoot: string): unknown[] {
  const manifest = readJSON(join(attachmentRoot, 'manifest.json'), 'attachment manifest');
  if (!Array.isArray(manifest)) fail('attachment manifest must contain an array');
  return manifest.flatMap((group, index) => {
    if (!isRecord(group) || !Array.isArray(group.attachments)) {
      fail(`attachment manifest group ${index} has no attachment array`);
    }
    return group.attachments;
  });
}

function isAttachment(value: unknown): value is Attachment {
  return isRecord(value)
    && typeof value.suggestedHumanReadableName === 'string'
    && typeof value.isAssociatedWithFailure === 'boolean'
    && typeof value.exportedFileName === 'string';
}

function requireNamedAttachment(
  attachments: readonly unknown[],
  root: string,
  name: string,
  extension: string,
): { readonly path: string; readonly file: string; readonly sha256: string } {
  const pattern = new RegExp(
    `^${escapeRegex(name)}(?:_[0-9]+_[0-9a-f-]{36})?\\.${escapeRegex(extension)}$`,
    'i'
  );
  const matches = attachments.filter((attachment) =>
    isRecord(attachment)
      && typeof attachment.suggestedHumanReadableName === 'string'
      && pattern.test(attachment.suggestedHumanReadableName)
  );
  if (matches.length !== 1) {
    fail(`expected exactly one ${name}.${extension} attachment; found ${matches.length}`);
  }
  const [attachment] = matches;
  if (attachment === undefined) fail(`${name}.${extension} attachment is missing`);
  if (!isAttachment(attachment)) fail(`${name}.${extension} attachment has malformed fields`);
  if (attachment.isAssociatedWithFailure !== false) {
    fail(`${name}.${extension} is associated with a test failure`);
  }
  if (
    typeof attachment.exportedFileName !== 'string'
      || basename(attachment.exportedFileName) !== attachment.exportedFileName
  ) {
    fail(`${name}.${extension} has an invalid exported file name`);
  }
  const path = join(root, attachment.exportedFileName);
  requirePath(path, `${name}.${extension}`, 'file');
  return { path, file: attachment.exportedFileName, sha256: sha256File(path) };
}

function assertZeroCleanupPayload(
  payload: unknown,
  label: string,
  expectedAlreadyAbsent: boolean,
): asserts payload is CleanupPayload {
  if (!isRecord(payload) || payload.deleted !== true || payload.verified !== true) {
    fail(`${label} is not deleted and verified`);
  }
  if (payload.alreadyAbsent !== expectedAlreadyAbsent) {
    fail(`${label} alreadyAbsent must be ${expectedAlreadyAbsent}`);
  }
  if (!isRecord(payload.counts)) {
    fail(`${label} has no count receipt`);
  }
  for (const key of zeroCountKeys) {
    if (payload.counts[key] !== 0) fail(`${label} ${key} must be zero`);
  }
}

const args = process.argv.slice(2);
if (args.length !== 6) {
  fail(
    'usage: <budget.xcresult> <xcodebuild.log> <attachments> ' +
      '<cleanup-receipt.json> <evidence.json> <exact-head-sha>'
  );
}

const [resultBundleArg, logPathArg, attachmentRootArg, cleanupPathArg, outputPathArg, exactHeadSha] = args;
if (
  resultBundleArg === undefined
  || logPathArg === undefined
  || attachmentRootArg === undefined
  || cleanupPathArg === undefined
  || outputPathArg === undefined
  || exactHeadSha === undefined
) fail('all evidence arguments are required');
const resultBundle = resolve(resultBundleArg);
const logPath = resolve(logPathArg);
const attachmentRoot = resolve(attachmentRootArg);
const cleanupPath = resolve(cleanupPathArg);
const outputPath = resolve(outputPathArg);
if (!/^[0-9a-f]{40}$/i.test(exactHeadSha)) fail('exact head SHA is invalid');

requirePath(resultBundle, 'Budget xcresult', 'directory');
const infoPlistPath = join(resultBundle, 'Info.plist');
requirePath(infoPlistPath, 'Budget xcresult Info.plist', 'file');
requirePath(logPath, 'Budget xcodebuild log', 'file');
requirePath(attachmentRoot, 'Budget attachment export', 'directory');
const log = readFileSync(logPath, 'utf8');
if (/XCTSkip|Test Case .* skipped|\btest skipped\b/i.test(log)) {
  fail('Budget log contains a skipped test or scenario');
}

const markerExpectations = new Map([
  ['ISSUE_3996_EXACT_HEAD_SHA', exactHeadSha],
  ['ISSUE_3996_BACKEND_BUILD_SHA', exactHeadSha],
  ['ISSUE_3996_LAUNCH_ARGUMENTS', 'UI_TEST_RESET'],
  ['ISSUE_3996_HISTORY_ROUTE_ABSENT', 'true'],
  ['ISSUE_3996_INITIAL_CATEGORY', 'credit card'],
  ['ISSUE_3996_SAVE_ALERT', 'Category Updated'],
  ['ISSUE_3996_BACKEND_CATEGORY', 'student'],
  ['ISSUE_3996_HARD_RELAUNCH', 'true'],
  ['ISSUE_3996_RELAUNCH_CATEGORY', 'student'],
  ['ISSUE_3996_REAL_AUTH_BACKEND', 'true'],
  ['ISSUE_3996_PRODUCTION_DEBT_CARD', 'true'],
  ['ISSUE_3996_MATRIX_COMPLETE', '1'],
]);
for (const [marker, expected] of markerExpectations) {
  const actual = exactMarker(log, marker);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    fail(`${marker} is ${actual}, expected ${expected}`);
  }
}

const environmentKeys = exactMarker(log, 'ISSUE_3996_LAUNCH_ENVIRONMENT_KEYS')
  .split(',')
  .filter(Boolean);
for (const required of [
  'UI_TEST_API_BASE_URL',
  'UI_TEST_SIGNIN_PASSWORD',
  'UI_TEST_EXPECTED_SERVER_BUILD_SHA',
]) {
  if (!environmentKeys.includes(required)) fail(`launch environment is missing ${required}`);
}
for (const forbidden of [
  'UI_TESTING',
  'UI_TEST_BYPASS_SUBSCRIPTION',
  'UI_TEST_EMAIL',
  'UI_TEST_PASSWORD',
  'UI_TEST_NAV_CARD',
  'UI_TEST_DISABLE_POST_LOGIN_PRELOADS',
  'UI_TEST_SKIP_SCREENSHOTS',
]) {
  if (environmentKeys.includes(forbidden)) fail(`launch environment contains forbidden ${forbidden}`);
}

const attachments = attachmentEntries(attachmentRoot);
const screenshots = screenshotNames.map((name) => ({
  name,
  ...requireNamedAttachment(attachments, attachmentRoot, name, 'png'),
}));
if (new Set(screenshots.map((entry) => entry.file)).size !== screenshots.length) {
  fail('multiple screenshot requirements map to one exported file');
}

const backendAttachment = requireNamedAttachment(
  attachments,
  attachmentRoot,
  'issue-3996-backend-state',
  'json'
);
const backend = readJSON(backendAttachment.path, 'backend state attachment');
if (!isRecord(backend)) fail('backend state attachment must be an object');
const backendExactHeadSha = requiredString(backend, 'exactHeadSha', 'backend state attachment');
const backendServerBuildSha = requiredString(backend, 'serverBuildSha', 'backend state attachment');
if (backend.issue !== 3996 || backendExactHeadSha.toLowerCase() !== exactHeadSha.toLowerCase()) {
  fail('backend state attachment is not bound to issue #3996 exact head');
}
if (backendServerBuildSha.toLowerCase() !== exactHeadSha.toLowerCase()) {
  fail('backend state attachment is not from the exact-head server');
}
if (backend.debtCategory !== 'student' || backend.verifiedOverrideCount !== 1) {
  fail('backend state attachment does not prove exactly one student override');
}
requiredString(backend, 'authUserId', 'backend state attachment');
requiredString(backend, 'appUserId', 'backend state attachment');
const transactionId = requiredString(backend, 'transactionId', 'backend state attachment');
if (!transactionId.endsWith('-debt-payment-probe')) {
  fail('backend state attachment is for an unexpected transaction');
}

const cleanup = readJSON(cleanupPath, 'Budget cleanup receipt');
if (!isRecord(cleanup)) fail('cleanup receipt must be an object');
const cleanupExactHeadSha = requiredString(cleanup, 'exactHeadSha', 'cleanup receipt');
const syntheticEmailSha256 = requiredString(cleanup, 'syntheticEmailSha256', 'cleanup receipt');
if (cleanup.issue !== 3996 || cleanupExactHeadSha.toLowerCase() !== exactHeadSha.toLowerCase()) {
  fail('cleanup receipt is not bound to issue #3996 exact head');
}
if (!/^[0-9a-f]{64}$/i.test(syntheticEmailSha256)) {
  fail('cleanup receipt has no non-secret synthetic identity digest');
}
if (!isRecord(cleanup.first) || (cleanup.first.alreadyAbsent !== true && cleanup.first.alreadyAbsent !== false)) {
  fail('first cleanup receipt has invalid alreadyAbsent');
}
assertZeroCleanupPayload(cleanup.first, 'first cleanup receipt', cleanup.first.alreadyAbsent);
assertZeroCleanupPayload(cleanup.idempotent, 'idempotent cleanup receipt', true);

const artifactIndex = [
  { name: 'xcresult-info', path: infoPlistPath, sha256: sha256File(infoPlistPath) },
  { name: 'xcodebuild-log', path: logPath, sha256: sha256File(logPath) },
  {
    name: 'attachment-manifest',
    path: join(attachmentRoot, 'manifest.json'),
    sha256: sha256File(join(attachmentRoot, 'manifest.json')),
  },
  ...screenshots.map((entry) => ({ name: entry.name, path: entry.path, sha256: entry.sha256 })),
  { name: 'backend-state', path: backendAttachment.path, sha256: backendAttachment.sha256 },
  { name: 'cleanup-receipt', path: cleanupPath, sha256: sha256File(cleanupPath) },
];

const evidence = {
  issue: 3996,
  exactHeadSha,
  generatedAt: new Date().toISOString(),
  automatedAcceptance: {
    realProductSignIn: true,
    realDevelopmentBackend: true,
    removedRouteAbsent: true,
    rowTapOpenedPicker: true,
    backendOverride: 'student',
    hardRelaunchPersistence: true,
    cleanupVerified: true,
  },
  backend,
  cleanup,
  screenshots: screenshots.map(({ name, file, sha256 }) => ({ name, file, sha256 })),
  artifactIndex,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`Issue #3996 evidence verified for ${exactHeadSha}.\n`);

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planScreenshotExport,
  resolveScreenshotBundlePaths,
  xcresultExportArguments,
  type ScreenshotExportAction,
} from '../src/ios/xcresultScreenshotExport.ts';

const runnerTemp = '/tmp/runner';

function paths(overrides: Parameters<typeof resolveScreenshotBundlePaths>[0] | null = null) {
  return resolveScreenshotBundlePaths(overrides ?? { runnerTemp });
}

function plan(existing: readonly string[], resolved = paths()) {
  const present = new Set(existing);
  return planScreenshotExport({
    paths: resolved,
    directoryExists: (path) => present.has(path),
  });
}

function exports(actions: readonly ScreenshotExportAction[]): [string, string][] {
  return actions.flatMap((action) => (action.kind === 'export' ? [[action.bundlePath, action.outputPath]] : []));
}

test('every bundle path falls back to the runner-temp name its build step used', () => {
  const resolved = paths();
  assert.deepEqual(resolved, {
    resultBundle: `${runnerTemp}/example-ios-tests.xcresult`,
    accountUpdateResultBundle: `${runnerTemp}/example-ios-account-update-tests.xcresult`,
    accessibilityResultBundle: `${runnerTemp}/example-ios-accessibility-tests.xcresult`,
    narrowPaywallResultBundle: `${runnerTemp}/narrow-paywall-lane.xcresult`,
    screenshotsDir: `${runnerTemp}/screenshots`,
  });
});

test('an empty override is the same as an absent one', () => {
  // A lane that exported an unset variable through $GITHUB_ENV hands this step
  // an empty string, which must not become the path `/screenshots` at the root.
  const resolved = paths({ runnerTemp, resultBundle: '', narrowPaywallResultBundle: '' });
  assert.equal(resolved.resultBundle, `${runnerTemp}/example-ios-tests.xcresult`);
  assert.equal(resolved.narrowPaywallResultBundle, `${runnerTemp}/narrow-paywall-lane.xcresult`);
  assert.equal(resolved.screenshotsDir, `${runnerTemp}/screenshots`);
});

test('the screenshots directory follows the primary bundle, not the runner temp', () => {
  const resolved = paths({ runnerTemp, resultBundle: '/lane/results/tests.xcresult' });
  assert.equal(resolved.screenshotsDir, '/lane/results/screenshots');
  // The other bundles keep their own defaults; only the primary one moves it.
  assert.equal(resolved.accessibilityResultBundle, `${runnerTemp}/example-ios-accessibility-tests.xcresult`);
});

test('a lane that produced nothing creates no directory and only warns', () => {
  const { directoriesToCreate, actions } = plan([]);
  assert.deepEqual(directoriesToCreate, []);
  assert.deepEqual(actions, [
    { kind: 'warn', message: 'No iOS test result bundle was available for screenshot export.' },
  ]);
});

test('any single bundle is enough to create the screenshots directory itself', () => {
  const resolved = paths();
  for (const bundle of [
    resolved.resultBundle,
    resolved.accountUpdateResultBundle,
    resolved.accessibilityResultBundle,
    resolved.narrowPaywallResultBundle,
  ]) {
    assert.deepEqual(plan([bundle]).directoriesToCreate, [resolved.screenshotsDir], bundle);
  }
});

test('a missing primary bundle warns but never blocks the other exports', () => {
  const resolved = paths();
  const { actions } = plan([resolved.accessibilityResultBundle]);
  assert.deepEqual(actions[0], {
    kind: 'warn',
    message: 'No iOS test result bundle was available for screenshot export.',
  });
  assert.deepEqual(exports(actions), [[resolved.accessibilityResultBundle, `${resolved.screenshotsDir}/accessibility`]]);
});

test('each bundle exports into its own directory in a fixed order', () => {
  const resolved = paths();
  const expected: [string, string][] = [
    [resolved.resultBundle, resolved.screenshotsDir],
    [resolved.accountUpdateResultBundle, `${resolved.screenshotsDir}/account-update`],
    [resolved.accessibilityResultBundle, `${resolved.screenshotsDir}/accessibility`],
    [resolved.narrowPaywallResultBundle, `${resolved.screenshotsDir}/narrow-paywall`],
  ];
  const { actions } = plan(expected.map(([bundle]) => bundle).reverse());
  assert.deepEqual(exports(actions), expected);
  const messages = actions.flatMap((action) => (action.kind === 'export' ? [action.failureMessage] : []));
  assert.deepEqual(messages, [
    'Could not export iOS test screenshot attachments.',
    'Could not export account-update acceptance attachments.',
    'Could not export iOS accessibility screenshot attachments.',
    'Could not export narrow paywall accessibility attachments.',
  ]);
});

test('the export command never interpolates a path into a shell word', () => {
  assert.deepEqual(xcresultExportArguments('/a b/tests.xcresult', '/out dir'), [
    'xcresulttool', 'export', 'attachments', '--path', '/a b/tests.xcresult', '--output-path', '/out dir',
  ]);
});

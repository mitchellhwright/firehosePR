import { dirname } from 'node:path';

/**
 * Which `.xcresult` bundles an iOS execution lane exports screenshots from and
 * where each one's attachments land.
 *
 * A lane produces up to four result bundles depending on which suites it ran,
 * and every one of them is optional: exporting from a bundle that is not there
 * is not a failure, and a bundle whose attachments cannot be exported is a
 * warning rather than a failed lane.
 *
 * Pure: `directoryExists` is supplied by the caller, so the whole plan is
 * asserted in `ci/tests` with no filesystem.
 */

export interface ScreenshotBundleEnvironment {
  readonly runnerTemp: string;
  readonly resultBundle?: string | undefined;
  readonly accountUpdateResultBundle?: string | undefined;
  readonly accessibilityResultBundle?: string | undefined;
  readonly narrowPaywallResultBundle?: string | undefined;
}

export interface ScreenshotBundlePaths {
  readonly resultBundle: string;
  readonly accountUpdateResultBundle: string;
  readonly accessibilityResultBundle: string;
  readonly narrowPaywallResultBundle: string;
  readonly screenshotsDir: string;
}

function orDefault(value: string | undefined, fallback: string): string {
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Each bundle path is an environment override with the runner-temp default the
 * lane's own build step would have used. The screenshots directory is a
 * sibling of the primary bundle, which is what the upload step collects.
 */
export function resolveScreenshotBundlePaths(environment: ScreenshotBundleEnvironment): ScreenshotBundlePaths {
  const temp = environment.runnerTemp;
  const resultBundle = orDefault(environment.resultBundle, `${temp}/example-ios-tests.xcresult`);
  return {
    resultBundle,
    accountUpdateResultBundle: orDefault(
      environment.accountUpdateResultBundle,
      `${temp}/example-ios-account-update-tests.xcresult`,
    ),
    accessibilityResultBundle: orDefault(
      environment.accessibilityResultBundle,
      `${temp}/example-ios-accessibility-tests.xcresult`,
    ),
    narrowPaywallResultBundle: orDefault(
      environment.narrowPaywallResultBundle,
      `${temp}/narrow-paywall-lane.xcresult`,
    ),
    screenshotsDir: `${dirname(resultBundle)}/screenshots`,
  };
}

export type ScreenshotExportAction =
  | {
    readonly kind: 'export';
    readonly bundlePath: string;
    readonly outputPath: string;
    readonly failureMessage: string;
  }
  | { readonly kind: 'warn'; readonly message: string };

export interface ScreenshotExportPlan {
  readonly directoriesToCreate: readonly string[];
  readonly actions: readonly ScreenshotExportAction[];
}

export interface ScreenshotExportPlanInput {
  readonly paths: ScreenshotBundlePaths;
  readonly directoryExists: (path: string) => boolean;
}

/** Builds the ordered plan: the lane's own bundle first, then each group's. */
export function planScreenshotExport(input: ScreenshotExportPlanInput): ScreenshotExportPlan {
  const { paths, directoryExists } = input;
  const { screenshotsDir } = paths;
  const bundles = [
    paths.resultBundle,
    paths.accountUpdateResultBundle,
    paths.accessibilityResultBundle,
    paths.narrowPaywallResultBundle,
  ];
  const directoriesToCreate = bundles.some(directoryExists) ? [screenshotsDir] : [];

  const actions: ScreenshotExportAction[] = [];
  if (directoryExists(paths.resultBundle)) {
    actions.push({
      kind: 'export',
      bundlePath: paths.resultBundle,
      outputPath: screenshotsDir,
      failureMessage: 'Could not export iOS test screenshot attachments.',
    });
  } else {
    actions.push({ kind: 'warn', message: 'No iOS test result bundle was available for screenshot export.' });
  }

  const optionalExports: readonly (readonly [string, string, string])[] = [
    [paths.accountUpdateResultBundle, `${screenshotsDir}/account-update`, 'Could not export account-update acceptance attachments.'],
    [paths.accessibilityResultBundle, `${screenshotsDir}/accessibility`, 'Could not export iOS accessibility screenshot attachments.'],
    [paths.narrowPaywallResultBundle, `${screenshotsDir}/narrow-paywall`, 'Could not export narrow paywall accessibility attachments.'],
  ];
  for (const [bundlePath, outputPath, failureMessage] of optionalExports) {
    if (!directoryExists(bundlePath)) continue;
    actions.push({ kind: 'export', bundlePath, outputPath, failureMessage });
  }

  return { directoriesToCreate, actions };
}

/** The `xcresulttool` invocation for one export, as an argument array. */
export function xcresultExportArguments(bundlePath: string, outputPath: string): readonly string[] {
  return ['xcresulttool', 'export', 'attachments', '--path', bundlePath, '--output-path', outputPath];
}

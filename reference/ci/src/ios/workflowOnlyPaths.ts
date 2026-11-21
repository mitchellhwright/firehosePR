const workflowOnlyPaths: ReadonlySet<string> = new Set([
  // Filesystem lifecycle is proven by real-directory CI contracts; app/test inputs are unchanged.
  'scripts/remove-isolated-gcloud-config.sh', // Removed-path migration classification.
  'ci/src/ios/cloudSdkState.ts',
  'ci/src/actions/ios/isolateCloudSdkState.ts',
  'ci/src/actions/ios/removeIsolatedCloudSdkState.ts',
  'ci/tests/cloudSdkState.test.ts',
  '.github/workflows/ios-tests.yml',
  '.github/workflows/pr-checks.yml',
  'ios/fastlane/Fastfile',
  // These exact shard inputs are validated by CI contracts and have explicit
  // selection roles for base-lineage evidence re-planning.
  'ios/ci/ui-test-duration-weights.json',
  'ios/ci/ui-test-primary-exclusions.txt',
  'scripts/ios-test-onboarding-e2e.sh',
  'scripts/ios-test-wellness-lifecycle.py',
  'scripts/ios-workflow-native-selection.ts',
  'scripts/process-ios-e2e-video.sh',
  'ci/src/actions/reviewOnboardingVideo.ts',
  'scripts/select-ios-affected-tests.ts',
  'scripts/stop-onboarding-dev-backend.sh',
  'scripts/summarize-ios-test-failures.py',
  'ci/tests/iosAffectedEvidenceSelection.test.ts',
  'ci/src/actions/ios/validateChatPlaidE2eLog.ts',
]);

/**
 * CI and harness paths that describe iOS execution without changing the app
 * or its runtime contracts. Changes confined to these paths must not allocate
 * an Xcode runner.
 */
export function isIosWorkflowOnlyPath(changedPath: string): boolean {
  return workflowOnlyPaths.has(changedPath)
    || changedPath.startsWith('scripts/tests/ios-')
    || changedPath.startsWith('scripts/tests/onboarding-');
}

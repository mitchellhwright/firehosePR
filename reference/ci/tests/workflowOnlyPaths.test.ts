import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isIosWorkflowOnlyPath } from '../src/ios/workflowOnlyPaths.ts';

describe('isIosWorkflowOnlyPath', () => {
  it('keeps workflow and harness changes off Xcode runners', () => {
    for (const changedPath of [
      '.github/workflows/ios-tests.yml',
      '.github/workflows/pr-checks.yml',
      'scripts/ios-test-onboarding-e2e.sh',
      'scripts/stop-onboarding-dev-backend.sh',
      'scripts/select-ios-affected-tests.ts',
      'ios/ci/ui-test-duration-weights.json',
      'ios/ci/ui-test-primary-exclusions.txt',
      'scripts/tests/ios-ci-main-tests.test.mjs',
      'scripts/tests/onboarding-dev-backend-supervisor.test.mjs',
    ]) {
      assert.equal(isIosWorkflowOnlyPath(changedPath), true, changedPath);
    }
  });

  it('preserves affected iOS execution for product and XCTest changes', () => {
    for (const changedPath of [
      'ios/example-ios/UI/HomeView.swift',
      'ios/example-iosTests/DashboardTests.swift',
      'ios/example-iosUITests/OnboardingFullFlowUITests.swift',
      'server/services/plaid/plaidService.ts',
      'ios/ci/new-selector-input.json',
    ]) {
      assert.equal(isIosWorkflowOnlyPath(changedPath), false, changedPath);
    }
  });
});

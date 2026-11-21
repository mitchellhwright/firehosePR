import assert from 'node:assert/strict';
import test from 'node:test';
import { countAffectedUiTests as countAcrossUiTargets } from '../src/ios/affectedUiTestCount.ts';
import type { TestTarget } from '../src/ios/fullUiShards.ts';

function countAffectedUiTests(
  onlyTesting: readonly string[], skipped: readonly string[], target: TestTarget,
  methods: Readonly<Record<string, readonly string[]>>,
): number {
  return countAcrossUiTargets(onlyTesting, skipped, { 'example-iosUITests': target }, methods);
}

const discovered = {
  SignUp2ViewStateUITests: [
    'testPageRenders',
    'testCreateAccountRemainsHittableWithKeyboardVisible',
    'testCreateAccountDisabledWithMismatchedPasswords',
    'testPasswordsSurviveReturningToStepTwo',
    'testTermsAndPrivacyLinksExist',
    'testSignUp1ContinueRemainsHittableWithKeyboardVisible',
  ],
  OnboardingTourUITests: [
    'testTourOverlayAppearsWithAllElements',
    'testCaptureTourOverlayEveryStep',
  ],
} as const;

test('bare classes expand to XCTest methods while exact methods remain one test', () => {
  assert.equal(countAffectedUiTests(
    [
      'example-iosUITests/SignUp2ViewStateUITests',
      'example-iosUITests/OnboardingTourUITests/testTourOverlayAppearsWithAllElements',
    ],
    [],
    {
      selectedTests: [
        'SignUp2ViewStateUITests',
        'OnboardingTourUITests/testTourOverlayAppearsWithAllElements()',
      ],
      skippedTests: [],
    },
    discovered,
  ), 7);
});

test('test plan and command skips reduce the exact count without hiding missing tests', () => {
  assert.equal(countAffectedUiTests(
    ['example-iosUITests/SignUp2ViewStateUITests'],
    ['example-iosUITests/SignUp2ViewStateUITests/testTermsAndPrivacyLinksExist'],
    { selectedTests: ['SignUp2ViewStateUITests'],
      skippedTests: ['SignUp2ViewStateUITests/testPageRenders()'] },
    discovered,
  ), 4);
  assert.throws(() => countAffectedUiTests(
    ['example-iosUITests/SignUp2ViewStateUITests/testMissing'],
    [],
    { selectedTests: ['SignUp2ViewStateUITests'], skippedTests: [] },
    discovered,
  ), /absent from source/);
  assert.throws(() => countAffectedUiTests(
    ['example-iosUITests/SignUp2ViewStateUITests'],
    ['example-iosUITests/SignUp2ViewStateUITests'],
    { selectedTests: ['SignUp2ViewStateUITests'], skippedTests: [] },
    discovered,
  ), /no executable test methods/);
});

test('unplanned requested methods cannot disappear into the expected-count intersection', () => {
  const selected = [
    'example-iosUITests/OnboardingTourUITests/testTourOverlayAppearsWithAllElements',
    'example-iosUITests/SignUp2ViewStateUITests/testPageRenders',
  ];
  const plan = {
    selectedTests: ['OnboardingTourUITests/testTourOverlayAppearsWithAllElements'],
    skippedTests: [],
  };
  assert.throws(() => countAffectedUiTests(selected, [], plan, discovered),
    /absent from the test plan: example-iosUITests\/SignUp2ViewStateUITests\/testPageRenders/);
  assert.equal(countAffectedUiTests(selected,
    ['example-iosUITests/SignUp2ViewStateUITests/testPageRenders'], plan, discovered), 1);
  assert.equal(countAffectedUiTests(selected, [], {
    ...plan, skippedTests: ['SignUp2ViewStateUITests/testPageRenders'],
  }, discovered), 1);
});

test('overlapping and malformed selectors fail before XCTest starts', () => {
  const plan = { selectedTests: ['SignUp2ViewStateUITests'], skippedTests: [] };
  assert.throws(() => countAffectedUiTests([
    'example-iosUITests/SignUp2ViewStateUITests',
    'example-iosUITests/SignUp2ViewStateUITests/testPageRenders',
  ], [], plan, discovered), /selected twice/);
  assert.throws(() => countAffectedUiTests([
    'example-iosUITests/SignUp2ViewStateUITests()',
  ], [], plan, discovered), /Invalid affected UI class selector/);
  assert.throws(() => countAffectedUiTests([
    'example-iosUITests/SignUp2ViewStateUITests/testPageRenders',
  ], [], { selectedTests: ['SignUp2ViewStateUITests()'], skippedTests: [] },
  discovered), /Invalid UI test plan class selector/);
});

test('a split Budget UI target is counted and checked against its own plan', () => {
  const targets = {
    'example-iosUITests': { selectedTests: ['OnboardingTourUITests'], skippedTests: [] },
    'example-iosBudgetDebtUITests': { selectedTests: ['BudgetScopeGatingUITests'], skippedTests: [] },
  };
  const methods = { ...discovered,
    BudgetScopeGatingUITests: ['testBudgetDashboardDoesNotShowAddAccountBannerWhenServerHasData'],
  };
  assert.equal(countAcrossUiTargets([
    'example-iosBudgetDebtUITests/BudgetScopeGatingUITests',
  ], [], targets, methods), 1);
  assert.equal(countAcrossUiTargets([
    'example-iosBudgetDebtUITests/BudgetScopeGatingUITests',
    'example-iosUITests/OnboardingTourUITests/testTourOverlayAppearsWithAllElements',
  ], [], targets, methods), 2);
  assert.throws(() => countAcrossUiTargets([
    'example-iosBudgetDebtUITests/OnboardingTourUITests',
  ], [], targets, methods), /absent from the test plan/);
  assert.throws(() => countAcrossUiTargets([
    'example-iosUnplannedUITests/BudgetScopeGatingUITests',
  ], [], targets, methods), /Invalid affected UI selector/);
});

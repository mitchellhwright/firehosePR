import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareCompiledPlan,
  compiledTestIdentifiers,
  testPlanSelectors,
  unfilteredEnumerationArguments,
} from '../src/ios/compiledTestEnumeration.ts';

test('flat compiled inventory compares method and class selectors without test counts', () => {
  const compiled = compiledTestIdentifiers({
    testNodes: [
      { identifier: 'example-iosTests/ProfilePhotoTests/testShowsPhoto()' },
      { identifier: 'example-iosTests/ProfilePhotoTests/testUpdatesPhoto()' },
    ],
  });
  const plan = testPlanSelectors({
    testTargets: [{ target: { name: 'example-iosTests' }, selectedTests: [
      'ProfilePhotoTests', 'RemovedTests/testOldMethod()'], skippedTests: [],
    }],
  });
  assert.deepEqual(compareCompiledPlan(plan, compiled), {
    compiledMethods: 2,
    matchedSelectors: 1,
    missingSelectors: ['example-iosTests/RemovedTests/testOldMethod'],
  });
});

test('the plan parser excludes explicit skips and rejects malformed targets', () => {
  assert.deepEqual(testPlanSelectors({ testTargets: [{
    target: { name: 'example-iosUITests' },
    selectedTests: ['OnboardingFlowUITests/testCompletesJourney()', 'DraftUITests'],
    skippedTests: ['DraftUITests'],
  }] }), ['example-iosUITests/OnboardingFlowUITests/testCompletesJourney']);
  assert.throws(() => testPlanSelectors({ testTargets: [{ target: { name: 42 } }] }));
});

test('compiled inventory enumeration excludes changed-file test filters', () => {
  const arguments_ = unfilteredEnumerationArguments({
    planName: 'CI',
    productsPath: '/tmp/native.xctestproducts',
    destination: 'platform=iOS Simulator,id=ABC',
    outputPath: '/tmp/compiled.json',
  });
  assert.ok(arguments_.includes('-enumerate-tests'));
  assert.ok(arguments_.includes('/tmp/native.xctestproducts'));
  assert.ok(arguments_.includes('/tmp/compiled.json'));
  assert.ok(arguments_.every((argument) => !argument.startsWith('-only-testing:')));
  assert.ok(arguments_.every((argument) => !argument.startsWith('-skip-testing:')));
});

import { auxiliaryLanePaths, classifyIosChangedPaths } from '../src/ios/iosChangeClassification.ts';
import { REQUIRED_NATIVE_INPUTS, RETIRED_TEST_PRODUCT_INPUTS } from '../src/ios/testProductInputs.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  changedLinePatch,
  iosFileOwner,
  methodReadsResource,
  projectEditOwners,
  projectPatchResources,
  testPlanEnabledSelectors,
} from '../src/ios/changedFileOwnership.ts';

test('legacy full-run paths have declared narrow owners', () => {
  const workflow = [
    'ci/src/actions/ios/selectXcode.ts',
    'scripts/ios-test.sh',
    'scripts/ios-test.ts',
    'scripts/ios-test-budget-e2e.sh',
    'scripts/build-ios-ci-test-products.sh',
    'scripts/build-ios-e2e-test-products.sh',
    'scripts/manage-ios-build-cache.sh',
    'scripts/prepare-ios-ci-scheme.py',
    'scripts/provision-ios-ci-simulator.py',
    'scripts/prepare-ios-plaid-link.sh',
    'scripts/reclaim-ios-runner-disk.sh',
    'scripts/run-ios-budget-e2e-shards.sh',
    'scripts/run-ios-ci-main-tests.sh',
    'scripts/run-with-ios-cache-recovery.sh',
    'ci/src/actions/ios/classifyIosBuildRecovery.ts',
    'ci/src/actions/ios/guardIosIncrementalBuild.ts',
    'ci/src/ios/incrementalBuildGuard.ts',
    'ci/src/ios/iosBuildRecovery.ts',
    'scripts/verify-ios-release-archive.sh',
    'ios/ci_scripts/ci_post_clone.sh',
  ];
  for (const changedPath of workflow) assert.equal(iosFileOwner(changedPath), 'workflow');
  for (const changedPath of [
    'ios/example-ios/Assets.xcassets/NewIcon.imageset/Contents.json',
    'ios/example-ios/Config/NewEnvironment.plist',
    'ios/example-ios/Resources/PrivacyInfo.plist',
    'ios/example-ios/App.entitlements',
    'ios/example-ios/Resources/NewPayload.json',
  ]) assert.equal(iosFileOwner(changedPath), 'archive');
  for (const changedPath of [
    'ios/Package.swift', 'ios/Package.resolved',
    'ios/example-ios.xcodeproj/xcshareddata/TestPlans/CI.xctestplan',
    'ios/example-ios.xcodeproj/xcshareddata/xcschemes/NewScheme.xcscheme',
  ]) assert.equal(iosFileOwner(changedPath), 'build-semantics');
  assert.equal(iosFileOwner('ios/example-ios.xcodeproj/project.pbxproj'), 'project');
  for (const changedPath of [
    'ios/Packages/PlaidLink/Package.swift',
    'ios/Packages/NewVendoredKit/Package.swift',
  ]) assert.equal(iosFileOwner(changedPath), 'native-dependency');
  assert.equal(iosFileOwner('ios/example-ios/Info.plist'), 'runtime-config');
  assert.equal(iosFileOwner('ios/example-ios/Assets.xcassets/LaunchScreenBackground.colorset/Contents.json'),
    'runtime-config');
  assert.equal(iosFileOwner('ios/example-ios.xcodeproj/unknown-file'), 'unknown');
  assert.equal(iosFileOwner('ios/example-ios/Unowned/unknown.dat'), 'unknown');
});

test('project resource and version edits retain only their named XCTest owners', () => {
  const patch = [
    '@@ -1,2 +1,4 @@',
    '+\t\tA60901383000000000000001 /* mortgage-chat-refinance.json in Resources */ = {isa = PBXBuildFile; fileRef = A60901383000000000000003 /* mortgage-chat-refinance.json */; };',
    '+\t\tA60901383000000000000003 /* mortgage-chat-refinance.json */ = {isa = PBXFileReference; lastKnownFileType = text.json; path = ../server/testdata/mortgage-chat-refinance.json; sourceTree = SOURCE_ROOT; };',
    '+\t\t\t\tA60901383000000000000003 /* mortgage-chat-refinance.json */,',
    '+\t\t\t\tA60901383000000000000001 /* mortgage-chat-refinance.json in Resources */,',
    '-\t\t\t\tMARKETING_VERSION = 1.5.1;',
    '+\t\t\t\tMARKETING_VERSION = 1.5.2;',
  ].join('\n');
  assert.deepEqual(projectPatchResources(patch), ['mortgage-chat-refinance.json']);
  assert.equal(projectPatchResources(`${patch}\n+\t\t\t\tSWIFT_VERSION = 6.0;`), null);
  assert.equal(projectPatchResources(`${patch}\n+\t\t\t\tNEW_TARGET = YES;`), null);
  assert.deepEqual(projectPatchResources('@@ -1 +1 @@\n- MARKETING_VERSION = 1.5.1;\n+ MARKETING_VERSION = 1.5.2;'), []);
  assert.deepEqual(projectPatchResources('@@ -1 +1 @@\n- CURRENT_PROJECT_VERSION = 94;\n+ CURRENT_PROJECT_VERSION = 95;'), []);
  assert.deepEqual(projectPatchResources(
    '@@ -1,0 +2 @@\n+\t\t\t\tSWIFT_TREAT_WARNINGS_AS_ERRORS = "$(EXAMPLE_CI_SWIFT_WARNINGS_AS_ERRORS)";',
  ), []);
  assert.equal(projectPatchResources('@@ -1,0 +2 @@\n+\t\t\t\tSWIFT_TREAT_WARNINGS_AS_ERRORS = YES;'), null);
});

test('Bundle fixture helper assigns #6093 resources to only the methods that request them', () => {
  const source = [
    'private func fixture(_ name: String) throws -> Data {',
    '  Bundle(for: Self.self).url(forResource: name, withExtension: "json")',
    '}',
    'func testRefinance() throws { let data = try fixture("mortgage-chat-refinance") }',
    'func testInfeasible() throws { let data = try fixture("mortgage-chat-infeasible") }',
  ].join('\n');
  assert.equal(methodReadsResource('mortgage-chat-refinance.json', source,
    'func testRefinance() throws { let data = try fixture("mortgage-chat-refinance") }'), true);
  assert.equal(methodReadsResource('mortgage-chat-refinance.json', source,
    'func testInfeasible() throws { let data = try fixture("mortgage-chat-infeasible") }'), false);
  assert.equal(methodReadsResource('mortgage-chat-refinance.json', source,
    'func testLegacy() throws { XCTAssertTrue(true) }'), false);
  assert.equal(methodReadsResource('mortgage-chat-refinance.json', source.replace('"json"', '"txt"'),
    'func testRefinance() throws { let data = try fixture("mortgage-chat-refinance") }'), false);
  const apnsSource = source.replaceAll('fixture', 'loadFixture').replaceAll('"json"', '"apns"');
  assert.equal(methodReadsResource('insight-route.apns', apnsSource,
    'func testRoute() throws { let data = try loadFixture("insight-route") }'), true);
});

interface ProjectShape {
  readonly app?: readonly string[];
  readonly onboarding?: readonly string[];
  readonly budget?: readonly string[];
  readonly onboardingTarget?: string;
  readonly extraSet?: boolean;
  readonly swiftVersion?: string;
}

function exceptionSet(id: string, folder: string, target: string, files: readonly string[]): string {
  return [
    `\t\t${id} /* Exceptions for "${folder}" folder in "${target}" target */ = {`,
    '\t\t\tisa = PBXFileSystemSynchronizedBuildFileExceptionSet;',
    '\t\t\tmembershipExceptions = (',
    ...files.map((file) => `\t\t\t\t${file},`),
    '\t\t\t);',
    `\t\t\ttarget = ${id.slice(0, -1)}1 /* ${target} */;`,
    '\t\t};',
  ].join('\n');
}

function project({
  app = ['Info.plist'], onboarding = ['ABS001UITests.swift'], budget = ['ABS001UITests.swift'],
  onboardingTarget = 'example-iosOnboardingUITests', extraSet = false, swiftVersion = '5.0',
}: ProjectShape = {}): string {
  return [
    '/* Begin PBXFileSystemSynchronizedBuildFileExceptionSet section */',
    exceptionSet('C8D25EAB2E3AF2AB000A485F', 'example-ios', 'example-ios', app),
    exceptionSet('A10000000000000000000003', 'example-iosUITests', onboardingTarget, onboarding),
    exceptionSet('B10000000000000000000003', 'example-iosUITests', 'example-iosBudgetDebtUITests', budget),
    ...(extraSet ? [exceptionSet('D10000000000000000000003', 'example-iosUITests', 'example-iosNewUITests', ['X.swift'])] : []),
    '/* End PBXFileSystemSynchronizedBuildFileExceptionSet section */',
    `\t\t\t\tSWIFT_VERSION = ${swiftVersion};`,
  ].join('\n');
}

const testFolders = ['example-iosTests', 'example-iosUITests'];
const registered = ['WorkplacePlanTypeUITests.swift', 'ABS001UITests.swift'];

const workplaceExclusions = [
  { folder: 'example-iosUITests', target: 'example-iosOnboardingUITests', file: 'WorkplacePlanTypeUITests.swift' },
  { folder: 'example-iosUITests', target: 'example-iosBudgetDebtUITests', file: 'WorkplacePlanTypeUITests.swift' },
];

test('test-folder exclusions a project edit adds or removes are reported apart from other lines', () => {
  assert.deepEqual(projectEditOwners(project(), project({ onboarding: registered, budget: registered }),
    testFolders), {
    resources: [], projectLinesChanged: false, addedExclusions: workplaceExclusions, removedExclusions: [],
  });
  const before = project({ onboarding: registered, budget: registered });
  assert.deepEqual(projectEditOwners(before, project(), testFolders), {
    resources: [], projectLinesChanged: false, addedExclusions: [], removedExclusions: workplaceExclusions,
  });
  assert.deepEqual(projectEditOwners(before, project({ onboarding: ['New.swift'], budget: registered }),
    testFolders), {
    resources: [],
    projectLinesChanged: false,
    addedExclusions: [{ folder: 'example-iosUITests', target: 'example-iosOnboardingUITests', file: 'New.swift' }],
    removedExclusions: [
      { folder: 'example-iosUITests', target: 'example-iosOnboardingUITests', file: 'WorkplacePlanTypeUITests.swift' },
      { folder: 'example-iosUITests', target: 'example-iosOnboardingUITests', file: 'ABS001UITests.swift' },
    ],
  });
});

test('an exclusion and an owned project line compose; any unowned part fails closed', () => {
  const warnings = '\t\t\t\tSWIFT_TREAT_WARNINGS_AS_ERRORS = "$(EXAMPLE_CI_SWIFT_WARNINGS_AS_ERRORS)";';
  assert.deepEqual(projectEditOwners(project(),
    `${project({ onboarding: registered, budget: registered })}\n${warnings}`, testFolders), {
    resources: [], projectLinesChanged: true, addedExclusions: workplaceExclusions, removedExclusions: [],
  });
  const unowned: readonly (readonly [string, string])[] = [
    ['an app folder exception changes the app target', project({ app: ['Info.plist', 'Extra.plist'] })],
    ['an exclusion hides a build setting', project({ onboarding: registered, swiftVersion: '6.0' })],
    ['a removal hides a build setting', project({ onboarding: [], swiftVersion: '6.0' })],
    ['a new exception set describes a new target', project({ onboarding: registered, extraSet: true })],
    ['a retargeted exception set moves membership', project({ onboarding: registered, onboardingTarget: 'example-iosUITests' })],
    ['a non-CI warnings value changes compiler behaviour',
      `${project({ onboarding: registered })}\n\t\t\t\tSWIFT_TREAT_WARNINGS_AS_ERRORS = YES;`],
    ['an unchanged project has nothing to own', project()],
  ];
  for (const [reason, after] of unowned) {
    assert.equal(projectEditOwners(project(), after, testFolders), null, reason);
  }
});

test('a build setting moved between configurations is a change, not a no-op', () => {
  const debug = '\t\t\tname = Debug;';
  const release = '\t\t\tname = Release;';
  const setting = '\t\t\t\tSWIFT_VERSION = 6.0;';
  const moved = changedLinePatch([debug, setting, release].join('\n'), [debug, release, setting].join('\n'))
    .split('\n');
  assert.deepEqual(moved.map((line) => line[0]).sort(), ['+', '-']);
  assert.equal(projectPatchResources(moved.join('\n')), null);
  assert.equal(changedLinePatch('a\nb\nc', 'a\nb\nc'), '');
  assert.equal(changedLinePatch('a\nc', 'a\nb\nc'), '+b');
  assert.equal(changedLinePatch('a\nb\nc', 'a\nc'), '-b');
  assert.equal(changedLinePatch('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE'), '-b\n+B\n-e\n+E');
  // A minimal diff keeps unchanged neighbours out of the patch the owners must accept.
  assert.equal(changedLinePatch('0\na\nb\nc\nX\n9', '0\nX\na\nb\nc\n9'), '+X\n-X');
});

test('the #6395 promotion project edit is owned by its exclusions and the warnings mapping', () => {
  const fixtures = new URL('./fixtures/promotion-project-edit/', import.meta.url);
  const main = readFileSync(new URL('main-58f245a.pbxproj', fixtures), 'utf8');
  const develop = readFileSync(new URL('develop-2ba00f0.pbxproj', fixtures), 'utf8');
  assert.deepEqual(projectEditOwners(main, develop, testFolders), {
    resources: [], projectLinesChanged: true, addedExclusions: workplaceExclusions, removedExclusions: [],
  });
  const warningsOnly = develop.replaceAll('\t\t\t\tWorkplacePlanTypeUITests.swift,\n', '');
  assert.deepEqual(projectEditOwners(main, warningsOnly, testFolders), {
    resources: [], projectLinesChanged: true, addedExclusions: [], removedExclusions: [],
  });
  const unownedSetting = develop.replace('SWIFT_COMPILATION_MODE = wholemodule;', 'SWIFT_COMPILATION_MODE = singlefile;');
  assert.equal(projectEditOwners(main, unownedSetting, testFolders), null);
});

interface PlanShape {
  readonly selected?: readonly string[] | null;
  readonly skipped?: readonly string[] | null;
  readonly parallelizable?: boolean;
  readonly timeouts?: boolean;
  readonly extraTarget?: boolean;
}

const skippedMethod = 'SubscriptionCTACopyEvidenceUITests/testAccessibilityTextKeepsEveryBenefitReadableAboveStickyCTA()';

function plan({
  selected = ['AccountDeletionGuidanceUITests'], skipped = [skippedMethod],
  parallelizable = true, timeouts = false, extraTarget = false,
}: PlanShape = {}): string {
  return JSON.stringify({
    configurations: [{ id: '3d9e3066-55f7-593b-a918-156b35bbd6e6', name: 'CI Configuration', options: {} }],
    defaultOptions: { testTimeoutsEnabled: timeouts },
    testTargets: [
      {
        parallelizable,
        ...(skipped === null ? {} : { skippedTests: skipped }),
        target: { containerPath: 'container:example-ios.xcodeproj', identifier: '04D8EDD02E203F0000C5C6B1', name: 'example-iosUITests' },
        ...(selected === null ? {} : { selectedTests: selected }),
      },
      ...(extraTarget ? [{ target: { containerPath: 'container:example-ios.xcodeproj', name: 'example-iosTests' } }] : []),
    ],
    version: 1,
  }, null, 2);
}

test('a test-plan edit is owned by the selectors it enables and nothing else', () => {
  const workplace = { target: 'example-iosUITests', selector: 'WorkplacePlanTypeUITests' };
  const unskipped = { target: 'example-iosUITests', selector: skippedMethod };
  const reordered = JSON.stringify(Object.fromEntries(
    Object.entries(JSON.parse(plan({ selected: ['WorkplacePlanTypeUITests', 'AccountDeletionGuidanceUITests'] })) as
      Record<string, unknown>).reverse()));
  const enabled: readonly (readonly [string, string, readonly { target: string; selector: string }[]])[] = [
    ['a new UI test class is selected', plan({ selected: ['AccountDeletionGuidanceUITests', 'WorkplacePlanTypeUITests'] }), [workplace]],
    ['a skipped method is restored', plan({ skipped: [] }), [unskipped]],
    ['the last skip is removed with its list', plan({ skipped: null }), [unskipped]],
    ['key order alone is not a settings change', reordered, [workplace]],
  ];
  for (const [reason, after, expected] of enabled) {
    assert.deepEqual(testPlanEnabledSelectors(plan(), after), expected, reason);
  }
  const unowned: readonly (readonly [string, string])[] = [
    ['a removed selection stops running a test', plan({ selected: [] })],
    ['an added skip stops running a test', plan({ skipped: [skippedMethod, 'AccountDeletionGuidanceUITests'] })],
    ['a target option changes execution', plan({ selected: ['AccountDeletionGuidanceUITests', 'WorkplacePlanTypeUITests'], parallelizable: false })],
    ['a plan option changes execution', plan({ timeouts: true })],
    ['a new target runs a whole bundle', plan({ extraTarget: true })],
    ['an absent selection runs the whole target', plan({ selected: null })],
    ['a deleted plan has no selectors', ''],
    ['formatting alone has nothing to own', JSON.stringify(JSON.parse(plan()), null, 4)],
  ];
  for (const [reason, after] of unowned) {
    assert.equal(testPlanEnabledSelectors(plan(), after), null, reason);
  }
  assert.equal(testPlanEnabledSelectors('', plan()), null, 'an added plan has no prior selectors');
});

test('every required test-product contract input has an executable workflow owner', () => {
  for (const input of [...REQUIRED_NATIVE_INPUTS, ...RETIRED_TEST_PRODUCT_INPUTS]) assert.equal(iosFileOwner(input), 'workflow', input);
});


test('canonical auxiliary harnesses have infrastructure owners without hiding product inputs', () => {
  for (const input of Object.values(auxiliaryLanePaths).flat().filter((file) => file.startsWith('scripts/'))) {
    assert.equal(iosFileOwner(input), 'workflow', input);
  }
  assert.equal(classifyIosChangedPaths(['scripts/ios-test-budget-regression.sh']).budgetRequired, true);
  assert.equal(iosFileOwner('scripts/ios-test-unregistered.sh'), 'unknown');
  assert.equal(iosFileOwner('ios/example-ios/Views/Budget/Unknown.swift'), 'unknown');
  assert.equal(iosFileOwner('ios/example-ios.xcodeproj/xcshareddata/TestPlans/Budget-Regression.xctestplan'),
    'build-semantics');
});

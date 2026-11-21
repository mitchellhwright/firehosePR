import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  classifyIosChangedPaths,
  isIncomeE2EHarnessPath,
  iosChangeGateDeclares,
  iosChangeGatePathPatterns,
  isIosIrrelevantPath,
} from '../src/ios/iosChangeClassification.ts';
import { matchesCaseGlob } from '../src/ios/shared/caseGlob.ts';

describe('matchesCaseGlob', () => {
  it('lets * cross directory separators, the way a case pattern does', () => {
    // `ios/*` in a `case` selects the whole subtree; in pathname expansion it
    // would stop at the first slash, which would exempt every nested source.
    assert.equal(matchesCaseGlob('ios/example-ios/UI/Cards/Budget/BudgetView.swift', 'ios/*'), true);
    assert.equal(matchesCaseGlob('iosx/File.swift', 'ios/*'), false);
  });

  it('anchors both ends', () => {
    assert.equal(matchesCaseGlob('server/routes/index.ts', 'server/routes/index.ts'), true);
    assert.equal(matchesCaseGlob('a/server/routes/index.ts', 'server/routes/index.ts'), false);
    assert.equal(matchesCaseGlob('server/routes/index.ts.bak', 'server/routes/index.ts'), false);
  });

  it('treats regular-expression metacharacters in a pattern as literals', () => {
    // `ios/example-ios/UI/Components/CardAccountConnectionsView+ViewModel.swift`
    // is a real owner; a `+` compiled as a quantifier would match nothing.
    const owner = 'ios/example-ios/UI/Components/CardAccountConnectionsView+ViewModel.swift';
    assert.equal(matchesCaseGlob(owner, owner), true);
    assert.equal(matchesCaseGlob('server/routes/indexXts', 'server/routes/index.ts'), false);
  });
});

describe('classifyIosChangedPaths', () => {
  it('keeps app resources in the iOS inventory while CI shard inputs use workflow contracts', () => {
    const paths = [
      'ios/ci/ui-test-primary-exclusions.txt',
      'ios/example-ios/Resources/model.txt',
    ];
    const classification = classifyIosChangedPaths(paths);
    assert.deepEqual(classification.iosChangedFiles, ['ios/example-ios/Resources/model.txt']);
    assert.deepEqual(classifyIosChangedPaths(['ios/docs/evidence/guardrails.txt']).iosChangedFiles, []);
  });

  it('routes the income harness only to its real-server E2E lane', () => {
    const path = 'scripts/ios-test-income-e2e.sh';
    const classification = classifyIosChangedPaths([path]);
    assert.equal(isIncomeE2EHarnessPath(path), true);
    assert.deepEqual(classification.iosChangedFiles, [path]);
    assert.equal(classification.incomeRequired, true);
    assert.equal(classification.onboardingRequired, false);
    assert.equal(classification.chatPlaidRequired, false);
    assert.equal(classification.budgetRequired, false);
    assert.equal(isIncomeE2EHarnessPath('scripts/ios-test-unknown-e2e.sh'), false);
  });

  it('drops documentation and delivery tooling before any lane sees it', () => {
    // ios/Gemfile.lock also matches the broad `ios/*` inventory pattern; the
    // exclusion has to be evaluated first or a Fastlane bump books a Mac.
    const classification = classifyIosChangedPaths([
      'ios/Gemfile',
      'ios/Gemfile.lock',
      'ios/README.md',
      'ios/AGENTS.md',
      'ios/docs/testing.md',
      'ios/.swiftlint.yml',
      '.devin/rules/ios-ui-uniformity.md',
      'README.md',
      'notes.txt',
    ]);
    assert.deepEqual(classification.iosChangedFiles, []);
    assert.equal(classification.storekitRequired, false);
    assert.equal(classification.onboardingRequired, false);
  });

  it('drops CI control files that describe iOS work without being iOS work', () => {
    const classification = classifyIosChangedPaths([
      '.github/workflows/ios-tests.yml',
      '.github/workflows/trusted-production-onboarding-e2e.yml',
      'ios/fastlane/Fastfile',
      'scripts/select-ios-affected-tests.ts',
      'scripts/tests/ios-affected-evidence-selection.test.mjs',
      'ci/tests/iosAffectedEvidenceSelection.test.ts',
      'ci/src/workflowContractTests.ts',
      'scripts/tests/workflow-runner-configuration.test.mjs',
      'scripts/tests/onboarding-production-boundary.test.mjs',
    ]);
    assert.deepEqual(classification.iosChangedFiles, []);
  });

  it('ignores the empty entries a trailing newline produces', () => {
    assert.deepEqual(classifyIosChangedPaths(''.split('\n')).iosChangedFiles, []);
    assert.deepEqual(
      classifyIosChangedPaths('ios/example-ios/App.swift\n\n'.split('\n')).iosChangedFiles,
      ['ios/example-ios/App.swift'],
    );
  });

  it('keeps the inventory in the order the pull request listed it', () => {
    const changed = ['server/routes/index.ts', 'ios/example-ios/App.swift', 'server/routes/auth.ts'];
    assert.deepEqual(classifyIosChangedPaths(changed).iosChangedFiles, changed);
  });

  it('runs the iOS gate when the shared evidence attachment parser changes', () => {
    const path = 'ci/src/ios/evidenceAttachments.ts';
    assert.deepEqual(classifyIosChangedPaths([path]).iosChangedFiles, [path]);
  });

  it('routes a budget migration to the inventory without requiring the budget E2E', () => {
    // The E2E schema-revision gate demands the migration already be applied to
    // the shared development database, which a migration-only prerequisite
    // pull request can never satisfy for its own migration.
    const classification = classifyIosChangedPaths([
      'server/db/migrations/0099_widen_budget_period.sql',
    ]);
    assert.deepEqual(classification.iosChangedFiles, [
      'server/db/migrations/0099_widen_budget_period.sql',
    ]);
    assert.equal(classification.budgetRequired, false);
  });

  it('does not book Chat-Plaid E2E for pending confirmation state changes', () => {
    // Confirmation storage is outside the checked /chat/execute-tools path.
    const confirmationPaths = [
      'server/services/chat/services/confirmationStore.ts',
      'server/services/chat/services/mutationConfirmationService.ts',
      'server/services/chat/services/transactionSelectionActionService.ts',
      'server/services/chat/services/transactionSelectionStore.ts',
    ];
    const classification = classifyIosChangedPaths(confirmationPaths);
    assert.deepEqual(classification.iosChangedFiles, confirmationPaths);
    assert.equal(classification.chatPlaidRequired, false);
    assert.equal(classification.budgetRequired, true);
  });

  it('does not allocate unrelated E2E Macs for the WLC-02 manual plan registration', () => {
    const registration = [
      'ios/example-ios.xcodeproj/xcshareddata/TestPlans/WLC02-Live.xctestplan',
      'ios/example-ios.xcodeproj/xcshareddata/xcschemes/example-ios.xcscheme',
      'ios/example-iosUITests/ChatLiveServerE2ETests.swift',
    ];
    const classification = classifyIosChangedPaths([
      ...registration,
      'scripts/ios-test-wellness-lifecycle.py',
      'scripts/tests/test_ios_wellness_lifecycle_runner.py',
      'ios/docs/testing/WLC02_LIVE_LIFECYCLE.md',
    ]);
    assert.deepEqual(classification.iosChangedFiles, registration);
    assert.equal(classification.chatPlaidRequired, false);
    assert.equal(classification.budgetRequired, false);
    assert.equal(classification.onboardingRequired, false);
    assert.equal(classification.incomeRequired, false);

    assert.equal(classifyIosChangedPaths([
      ...registration,
      'ios/example-iosUITests/ChatPlaidLinkE2ETests.swift',
    ]).chatPlaidRequired, true);
    assert.equal(classifyIosChangedPaths(registration.slice(1)).chatPlaidRequired, true);
    assert.equal(classifyIosChangedPaths([registration[1]!]).budgetRequired, true);
  });

  it('selects Chat-Plaid E2E for its handler, shared execution path, and Plaid dependencies', () => {
    for (const path of [
      'server/services/chat/tools/institutionSuggestionTool.ts',
      'server/services/chat/tools/registry.ts',
      'server/services/chat/core/types/dataTypes.ts',
      'server/services/chat/core/types/generated/chatTypes.generated.ts',
      'server/services/chat/handlers/chatToolSideEffectPolicy.ts',
      'server/services/chat/handlers/evidenceEnvelope.ts',
      'server/services/chat/handlers/preparedToolExecutor.ts',
      'server/services/chat/tools/chatToolExecutionPolicy.ts',
      'server/services/chat/tools/toolCapabilityManifest.ts',
      'server/services/chat/utils/toolResultSafetyPolicy.ts',
      'server/services/chat/utils/toolSummaryFormatter.ts',
      'server/services/plaid/plaidInstitutionService.ts',
      'server/services/plaid/plaidService.ts',
      'server/routes/chatTypes.yaml',
      'ios/example-iosUITests/ChatPlaidLinkE2ETests.swift',
    ]) {
      const classification = classifyIosChangedPaths([path]);
      assert.deepEqual(classification.iosChangedFiles, [path]);
      assert.equal(classification.chatPlaidRequired, true, path);
    }
  });

  it('gives one shared file every lane that compiles it', () => {
    const shared = classifyIosChangedPaths(['ios/example-iosUITests/PageObjects/PlaidLinkPage.swift']);
    assert.equal(shared.onboardingRequired, true);
    assert.equal(shared.chatPlaidRequired, true);
    assert.equal(shared.budgetRequired, false);

    const auth = classifyIosChangedPaths(['server/routes/auth.ts']);
    assert.equal(auth.onboardingRequired, true);
    assert.equal(auth.chatPlaidRequired, true);
    assert.equal(auth.budgetRequired, true);
    assert.equal(auth.incomeRequired, true);
    assert.equal(auth.storekitRequired, false);
  });

  it('runs every account-linking journey when the vendored LinkKit package changes', () => {
    const linkKit = classifyIosChangedPaths(['ios/Packages/PlaidLink/Package.swift']);
    assert.deepEqual(linkKit.iosChangedFiles, ['ios/Packages/PlaidLink/Package.swift']);
    assert.equal(linkKit.onboardingRequired, true);
    assert.equal(linkKit.chatPlaidRequired, true);
    assert.equal(linkKit.budgetRequired, false);
    assert.equal(linkKit.incomeRequired, false);
    assert.equal(linkKit.storekitRequired, false);
  });

  it('selects a lane without selecting the inventory when only that lane owns the path', () => {
    // server/routes/plaid.yaml owns the onboarding lane but is not an
    // inventory path, so the gate reports the lane while should_run stays off.
    const yaml = classifyIosChangedPaths(['server/routes/plaid.yaml']);
    assert.deepEqual(yaml.iosChangedFiles, []);
    assert.equal(yaml.onboardingRequired, true);

    const users = classifyIosChangedPaths(['server/routes/users.ts']);
    assert.deepEqual(users.iosChangedFiles, []);
    assert.equal(users.incomeRequired, true);
  });

  it('keeps financial recurring subscriptions on Budget without StoreKit purchase tests', () => {
    assert.equal(classifyIosChangedPaths(['ios/Subscriptions.storekit']).storekitRequired, true);
    assert.equal(
      classifyIosChangedPaths(['ios/example-ios/UI/PaywallView.swift']).storekitRequired,
      true,
    );
    assert.equal(classifyIosChangedPaths([
      'ios/example-ios/ViewModels/Subscriptions/SubscriptionViewModel.swift',
    ]).storekitRequired, true);
    for (const financialSubscriptionPath of [
      'ios/example-ios/Models/Subscriptions.swift',
      'ios/example-ios/Models/Generated/SubscriptionTypes.generated.swift',
      'ios/example-ios/Services/Subscriptions/SubscriptionsService.swift',
      'ios/example-ios/UI/Subscriptions/UpcomingBillsListView.swift',
    ]) {
      const selection = classifyIosChangedPaths([financialSubscriptionPath]);
      assert.equal(selection.storekitRequired, false, financialSubscriptionPath);
      assert.equal(selection.budgetRequired, true, financialSubscriptionPath);
      assert.deepEqual(selection.iosChangedFiles, [financialSubscriptionPath]);
    }
    assert.equal(
      classifyIosChangedPaths(['ios/example-ios/Core/Design/ExampleColors.swift']).storekitRequired,
      false,
    );
  });

  it('requires the StoreKit lane for every file in the StoreKit test target', () => {
    // The main iOS lane leaves this target to the StoreKit Purchase lane, so a
    // member file that does not require that lane would execute nowhere.
    const project = readFileSync(
      new URL('../../ios/example-ios.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
    const group = /\/\* example-iosStoreKitTests \*\/ = \{\s*isa = PBXGroup;\s*children = \(([\s\S]*?)\);[\s\S]*?path = "example-iosTests";/
      .exec(project);
    assert.ok(group?.[1], 'the example-iosStoreKitTests group must list its files');
    const members = [...group[1].matchAll(/\/\* ([^*]+?) \*\//g)]
      .map((match) => `ios/example-iosTests/${match[1]}`);
    assert.ok(members.includes('ios/example-iosTests/SubscriptionTrialDisclosureTests.swift'));
    for (const member of members) {
      assert.equal(classifyIosChangedPaths([member]).storekitRequired, true, member);
    }
  });

  it('answers "declared" separately from "selects", for a path an earlier rule shadows', () => {
    // ci/src/actions/ios/validateChatPlaidE2eLog.ts is on the inventory list and on
    // the shared workflow-only list; the workflow-only rule wins, so the gate
    // names it and still selects nothing for it.
    const shadowed = 'ci/src/actions/ios/validateChatPlaidE2eLog.ts';
    assert.equal(iosChangeGateDeclares(shadowed), true);
    assert.equal(isIosIrrelevantPath(shadowed), true);
    assert.deepEqual(classifyIosChangedPaths([shadowed]).iosChangedFiles, []);
  });

  it('declares nothing about a path no list names', () => {
    assert.equal(iosChangeGateDeclares('server/services/notifications/pushService.ts'), false);
    assert.deepEqual(
      classifyIosChangedPaths(['server/services/notifications/pushService.ts']).iosChangedFiles,
      [],
    );
  });
});

describe('the base-update classifier agrees with the gate about iOS script inputs', () => {
  it('names every gate script the workflow no longer spells out', () => {
    // `classifyIosBaseLineageChanges` decides whether an incoming base update
    // can invalidate running iOS work. Paths the gate names in TypeScript may
    // not appear in the generated workflow, so its typed input inventory has
    // to name them explicitly.
    const workflow = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
    const classifier = [
      readFileSync('ci/src/ios/iosExecutionInputs.ts', 'utf8'),
      readFileSync('ci/src/ios/controllers/baseUpdateDelta.ts', 'utf8'),
    ].join('\n');
    const missing = iosChangeGatePathPatterns.filter((pattern) => (
      pattern.startsWith('scripts/')
      && !isIosIrrelevantPath(pattern)
      && !pattern.startsWith('scripts/tests/')
      && !pattern.includes('*')
      && !workflow.includes(pattern)
      && !classifier.includes(`'${pattern}'`)
      && !/ios|xcode|simulator|xcresult|e2e|onboarding/i.test(pattern.slice('scripts/'.length))
    ));
    assert.deepEqual(missing, []);
  });
});

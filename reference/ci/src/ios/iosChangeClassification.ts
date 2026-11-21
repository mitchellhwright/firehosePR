import { matchesAnyCaseGlob } from './shared/caseGlob.ts';
import { isIosWorkflowOnlyPath } from './workflowOnlyPaths.ts';

/**
 * Which iOS lanes a pull request's changed files select.
 *
 * Every list below is one `case "$changed_path" in …` branch of the former
 * `Detect iOS Changes` shell, in the order the shell evaluated them. Order is
 * load-bearing twice over: a path the skip lists claim never reaches the lane
 * lists at all, and a path the first inventory branch claims is never tested
 * against the second.
 *
 * Membership in `iosChangedFiles` decides whether iOS runs at all; the five
 * booleans decide which lanes run. They are independent: a file can require the
 * onboarding E2E and the budget E2E, and `server/db/migrations/*budget*`
 * deliberately reaches the inventory without requiring the budget E2E.
 */

/** Documentation, Ruby delivery tooling and editor lint configuration: never iOS
 * work, whatever else matches. SwiftLint runs in no build phase or CI step, so its
 * configuration cannot change what compiles or passes.
 * A nested .txt may control test selection or ship as a resource, so directory
 * ownership, rather than its suffix, decides whether it is iOS work.
 */
const documentationPaths = [
  'ios/docs/*',
  'ios/README.md',
  'ios/AGENTS.md',
  'ios/Gemfile',
  'ios/Gemfile.lock',
  'ios/.swiftlint.yml',
  '*.md',
] as const;

/**
 * CI control files that describe iOS work without being iOS work. Evaluated
 * before every lane list, so a change confined to them schedules nothing.
 */
const workflowControlPaths = [
  '.github/workflows/trusted-production-onboarding-e2e.yml',
  'ios/fastlane/Fastfile',
  'scripts/select-ios-affected-tests.ts',
  'ci/tests/iosAffectedEvidenceSelection.test.ts',
] as const;

/** Every entry point into the one shared XCTest result verdict has the same lane owner. */
export const XCRESULT_SUMMARY_INPUTS = [
  'scripts/validate-xcresult-summary.sh',
  'ci/src/actions/ios/validateXcresultSummary.ts',
  'ci/src/ios/xcresultSummary.ts',
] as const;

/** iOS app, iOS test and iOS test-infrastructure files: the primary inventory. */
const iosInventoryPaths = [
  'ios/*',
  'scripts/ios-test*',
  'scripts/build-ios-ci-test-products.sh',
  'scripts/build-ios-e2e-test-products.sh',
  'scripts/manage-ios-build-cache.sh',
  'scripts/prepare-ios-plaid-link.sh',
  'scripts/prepare-ios-ci-scheme.py',
  'scripts/process-ios-e2e-video.sh',
  'scripts/provision-ios-ci-simulator.py',
  'scripts/reclaim-ios-runner-disk.sh',
  'scripts/run-ios-budget-e2e-shards.sh',
  'scripts/run-ios-ci-main-tests.sh',
  'scripts/verify-ios-release-archive.sh',
  'scripts/remove-isolated-gcloud-config.sh',
  'ci/src/actions/ios/selectXcode.ts',
  'scripts/summarize-ios-test-failures.py',
  'ci/src/actions/reviewOnboardingVideo.ts',
  'scripts/prepare-local-gcp-adc.sh',
  'scripts/stop-onboarding-dev-backend.sh',
  'ci/src/actions/ios/validateChatPlaidE2eLog.ts',
  'ci/src/actions/ios/validateDebtHistoryEvidence.ts',
  'ci/src/ios/evidenceAttachments.ts',
  'scripts/run-with-ios-cache-recovery.sh',
  'ci/src/actions/ios/classifyIosBuildRecovery.ts',
  'ci/src/actions/ios/guardIosIncrementalBuild.ts',
  'ci/src/ios/incrementalBuildGuard.ts',
  'ci/src/ios/iosBuildRecovery.ts',
  'ci/src/actions/ios/onboardingDashboardOfflineProxy.ts',
  'ci/src/actions/ios/validateOnboardingDashboardOfflineEvidence.ts',
  'ci/tests/prepareLocalGcpAdc.test.ts',
  'server/generated/api-types.ts',
  'server/generated/openapi.json',
  'server/routes/auth.ts',
  'server/routes/chat.ts',
  'server/routes/chatTypes.yaml',
  'server/routes/plaid.ts',
  'server/scripts/plaid/dev-seed-db.ts',
  'server/scripts/plaid/devSeedFixture.ts',
  'server/scripts/production-e2e-users.ts',
  'server/services/chat/*',
  'server/services/shared/generated/chatTypes.generated.ts',
  'server/services/plaid/*',
  'server/services/users/accountClosureService.ts',
  'server/services/users/userProfileService.ts',
  'server/testdata/chat-plaid-e2e-seed.json',
  ...XCRESULT_SUMMARY_INPUTS,
] as const;

/**
 * Backend surfaces the iOS lanes exercise. A *budget* migration is here and
 * only here: it reaches the inventory so should_run, lint and build still cover
 * it, but it must not require the budget E2E, whose schema-revision gate
 * demands the migration already be applied to the shared development database
 * — which a migration-only prerequisite pull request can never satisfy for its
 * own migration.
 */
const backendInventoryPaths = [
  'server/controllers/budget*',
  'server/controllers/dashboard*',
  'server/routes/budget*',
  'server/routes/dashboard*',
  'server/routes/index.ts',
  'server/routes/testBudgetE2E.ts',
  'server/services/budget*',
  'server/services/dashboard/*',
  'server/services/liabilities/*',
  'server/services/subscriptions/*',
  'server/services/testing/*',
  'server/db/migrations/*budget*',
] as const;

// App Store purchases live in the subscription view model and paywall. The
// similarly named models, service and screens for recurring bank bills belong
// to Budget and do not exercise StoreKit purchases.
const storekitPaths = [
  'scripts/provision-ios-ci-simulator.py',
  'scripts/reclaim-ios-runner-disk.sh',
  'ios/Subscriptions.storekit',
  'ios/TestSubscriptions.storekit',
  'ios/example-ios.xcodeproj/xcshareddata/xcschemes/example-ios-storekit.xcscheme',
  'ios/example-iosTests/TestSubscriptions.storekit',
  'ios/example-ios/ViewModels/Subscriptions/*',
  'ios/example-ios/ViewModels/SubscriptionsViewModel.swift',
  'ios/example-ios/UI/HomeView.swift',
  'ios/example-ios/UI/ContentView.swift',
  'ios/example-ios/Utils/AppRouter.swift',
  'ios/example-ios/UI/Cards/Profile/ProfileCompleteView.swift',
  'ios/example-ios/UI/PaywallView.swift',
  'ios/example-ios/ViewModels/Auth/*',
  'ios/example-iosTests/StoreKit*',
  'ios/example-iosTests/SubscriptionTrialDisclosureTests.swift',
  'ios/example-iosTests/Paywall*',
  'ios/example-iosUITests/PremiumPaywallAccessUITests.swift',
  'ios/example-iosUITests/SignupPaywallPurchaseHandoffUITests.swift',
  'ios/example-iosUITests/OnboardingFullFlowUITests.swift',
] as const;

const onboardingPaths = [
  'scripts/build-ios-e2e-test-products.sh',
  'scripts/ios-test-onboarding-e2e.sh',
  'scripts/stop-onboarding-dev-backend.sh',
  'scripts/provision-ios-ci-simulator.py',
  'scripts/reclaim-ios-runner-disk.sh',
  'scripts/remove-isolated-gcloud-config.sh',
  'ci/src/actions/reviewOnboardingVideo.ts',
  'server/scripts/production-e2e-users.ts',
  'server/routes/auth.ts',
  'server/routes/plaid.ts',
  'server/routes/plaid.yaml',
  'server/services/plaid/*',
  'server/services/users/accountClosureService.ts',
  'server/services/users/userProfileService.ts',
  'ios/example-ios/Services/UITestAuthTokenStore.swift',
  'ios/example-ios/UI/Onboarding/*',
  'ios/example-ios/UI/Authentication/*',
  'ios/example-ios/UI/HomeView.swift',
  'ios/example-ios/UI/ContentView.swift',
  'ios/example-ios/Utils/AppRouter.swift',
  'ios/example-ios/ViewModels/User/UserDataViewModel.swift',
  'ios/example-ios/ViewModels/User/UserDataViewModel+EmployerRemoval.swift',
  'ios/example-ios/UI/Cards/Income/Income1View.swift',
  'ios/example-ios/UI/Cards/Profile/ProfileCompleteView.swift',
  'ios/example-ios/UI/PaywallView.swift',
  'ios/example-ios/ViewModels/Auth/*',
  'ios/example-ios/ViewModels/Plaid/PlaidAccountsViewModel.swift',
  'ios/example-ios/ViewModels/Plaid/PlaidLinkViewModel.swift',
  'ios/example-ios/ViewModels/Subscriptions/*',
  'ios/example-ios/UI/Components/AccountLinkAssignmentSummaryView.swift',
  'ios/example-ios/UI/Components/AccountLinkPostSuccessLifecycle.swift',
  'ios/example-ios/UI/Components/CardAccountConnectionsView+ViewModel.swift',
  'ios/example-iosUITests/Onboarding*',
  'ios/example-iosUITests/NewUserOnboardingFlowUITests.swift',
  'ios/example-iosUITests/PremiumPaywallAccessUITests.swift',
  'ios/example-iosUITests/SignupPaywallPurchaseHandoffUITests.swift',
  'ios/example-iosTests/Onboarding*',
  'ios/example-iosTests/Auth*',
  'ios/example-iosUITests/PageObjects/PlaidLinkPage.swift',
  'ios/example-iosTests/ProfileOnboardingValidationTests.swift',
  'ios/example-iosTests/SignInAuthBugTests*.swift',
  // The onboarding journey links a sandbox institution through LinkKit.
  'ios/Packages/PlaidLink/*',
] as const;

const chatPlaidPaths = [
  'scripts/build-ios-e2e-test-products.sh',
  'scripts/stop-onboarding-dev-backend.sh',
  'scripts/provision-ios-ci-simulator.py',
  'scripts/reclaim-ios-runner-disk.sh',
  'scripts/remove-isolated-gcloud-config.sh',
  'ci/src/actions/ios/validateChatPlaidE2eLog.ts',
  'server/routes/auth.ts',
  'server/routes/chat.ts',
  'server/routes/chatTypes.yaml',
  'server/routes/plaid.ts',
  // /chat/execute-tools reaches these shared modules before and after the
  // institution handler. A change to them invalidates Chat-Plaid evidence.
  'server/services/chat/core/types/dataTypes.ts',
  'server/services/chat/core/types/generated/*',
  'server/services/chat/handlers/chatToolSideEffectPolicy.ts',
  'server/services/chat/handlers/evidenceEnvelope.ts',
  'server/services/chat/handlers/preparedToolExecutor.ts',
  'server/services/chat/tools/chatToolExecutionPolicy.ts',
  'server/services/chat/tools/institutionSuggestionTool.ts',
  'server/services/chat/tools/registry.ts',
  'server/services/chat/tools/toolCapabilityManifest.ts',
  'server/services/chat/utils/toolResultSafetyPolicy.ts',
  'server/services/chat/utils/toolSummaryFormatter.ts',
  'server/services/plaid/*',
  'server/services/shared/generated/chatTypes.generated.ts',
  'server/services/users/accountClosureService.ts',
  'server/services/users/userProfileService.ts',
  'server/testdata/chat-plaid-e2e-seed.json',
  'ios/example-ios/Models/Chat*',
  'ios/example-ios/Services/Chat*',
  'ios/example-ios/UI/Chat*',
  'ios/example-ios/ViewModels/Chat*',
  'ios/example-iosUITests/PageObjects/PlaidLinkPage.swift',
  'ios/example-iosUITests/Chat*',
  // The Chat-Plaid journey opens Plaid Link through LinkKit.
  'ios/Packages/PlaidLink/*',
] as const;

const incomeE2EHarnessPath = 'scripts/ios-test-income-e2e.sh';

/** The income runner owns real-server E2E execution, not a native XCTest lane. */
export function isIncomeE2EHarnessPath(path: string): boolean {
  return path === incomeE2EHarnessPath;
}

const incomePaths = [
  incomeE2EHarnessPath,
  'ci/src/actions/ios/incomeE2eApi.ts',
  'ci/src/actions/ios/externalProviderAuditHook.ts',
  'ios/example-ios.xcodeproj/xcshareddata/TestPlans/Income-E2E.xctestplan',
  'ios/example-iosUITests/IncomeActivationRealServerE2ETests.swift',
  'ios/example-ios/UI/Cards/Income/*',
  'ios/example-ios/UI/CardsView.swift',
  'ios/example-ios/UI/Authentication/*',
  'ios/example-ios/Models/Generated/UserProfileTypes.generated.swift',
  'ios/example-iosUITests/BaseUITestCase.swift',
  'ios/example-iosUITests/PageObjects/WelcomePage.swift',
  'ios/example-ios/ViewModels/User/UserDataViewModel.swift',
  'ios/example-ios/ViewModels/User/UserDataViewModel+EmployerRemoval.swift',
  'server/routes/auth.ts',
  'server/routes/users.ts',
  'server/services/users/userProfileService.ts',
] as const;

const budgetPaths = [
  'scripts/build-ios-e2e-test-products.sh',
  'scripts/ios-test-budget-e2e.sh',
  'scripts/ios-test-budget-regression.sh',
  'scripts/run-ios-budget-e2e-shards.sh',
  'ci/src/actions/ios/validateDebtHistoryEvidence.ts',
  ...XCRESULT_SUMMARY_INPUTS,
  'ios/example-ios.xcodeproj/xcshareddata/TestPlans/Budget-E2E.xctestplan',
  'ios/example-ios.xcodeproj/xcshareddata/TestPlans/Budget-Regression.xctestplan',
  'ios/example-ios.xcodeproj/xcshareddata/xcschemes/example-ios.xcscheme',
  'ios/example-ios/Core/Integrations/PlaidManager.swift',
  'ios/example-ios/Models/Budget*',
  'ios/example-ios/Models/Subscriptions*',
  'ios/example-ios/Models/TransactionRule*',
  'ios/example-ios/Models/Generated/Budget*',
  'ios/example-ios/Models/Generated/PlaidAccountTypes.generated.swift',
  'ios/example-ios/Models/Generated/Subscription*',
  'ios/example-ios/Models/Generated/TransactionRule*',
  'ios/example-ios/UI/Authentication/PlaidLinkView.swift',
  'ios/example-ios/UI/Cards/Budget/*',
  'ios/example-ios/UI/Cards/Debt/*',
  'ios/example-ios/UI/Budget/*',
  'ios/example-ios/UI/Components/Budget/*',
  'ios/example-ios/UI/Components/ConnectedAccountsHubView*',
  'ios/example-ios/UI/Components/TransactionRowView.swift',
  'ios/example-ios/UI/Subscriptions/*',
  'ios/example-ios/UI/Transactions/*',
  'ios/example-ios/Services/Budget/*',
  'ios/example-ios/Services/Subscriptions/*',
  'ios/example-ios/ViewModels/Budget/*',
  'ios/example-ios/ViewModels/Debt/*',
  'ios/example-ios/ViewModels/Plaid/AllTransactionsViewModel.swift',
  'ios/example-ios/ViewModels/Plaid/PlaidAccountsViewModel.swift',
  'ios/example-ios/ViewModels/Plaid/PlaidLinkViewModel.swift',
  'ios/example-ios/ViewModels/Subscriptions*',
  'ios/example-ios/UI/Components/AccountLinkAssignmentSummaryView.swift',
  'ios/example-ios/UI/Components/AccountLinkPostSuccessLifecycle.swift',
  'ios/example-ios/UI/Components/CardAccountConnectionsView+ViewModel.swift',
  'ios/example-iosUITests/Budget*',
  'ios/example-iosUITests/ChatProfileUpdateRealServerE2ETests.swift',
  'ios/example-iosUITests/DebtHistoryRemovalRealServerE2ETests.swift',
  'server/controllers/budget*',
  'server/controllers/dashboard*',
  'server/routes/auth.ts',
  'server/routes/budget*',
  'server/routes/chat.ts',
  'server/routes/dashboard*',
  'server/routes/index.ts',
  'server/routes/testBudgetE2E.ts',
  'server/services/budget*',
  'server/services/chat/*',
  'server/services/dashboard/*',
  'server/services/liabilities/*',
  'server/services/subscriptions/*',
  'server/services/testing/*',
  'server/services/users/accountClosureService.ts',
  'server/services/users/userProfileService.ts',
] as const;

/** The real-server E2E lanes, in the order the gate reports them. */
export const IOS_E2E_AUXILIARY_LANES = [
  'onboarding',
  'chat-plaid',
  'income',
  'budget',
] as const;

export type IosE2eAuxiliaryLane = typeof IOS_E2E_AUXILIARY_LANES[number];

/** The path patterns that own each real-server lane. */
export const auxiliaryLanePaths: Readonly<Record<IosE2eAuxiliaryLane, readonly string[]>> = {
  onboarding: onboardingPaths,
  'chat-plaid': chatPlaidPaths,
  income: incomePaths,
  budget: budgetPaths,
};

export interface IosChangeClassification {
  /** The changed files that make iOS run at all, in the order they were listed. */
  readonly iosChangedFiles: readonly string[];
  readonly storekitRequired: boolean;
  readonly onboardingRequired: boolean;
  readonly chatPlaidRequired: boolean;
  readonly budgetRequired: boolean;
  readonly incomeRequired: boolean;
}

/**
 * Every path pattern the gate names, in the order it evaluates them. A pattern
 * can appear on more than one list: membership here says the gate has an
 * opinion about the path, not which lane it selects.
 */
export const iosChangeGatePathPatterns: readonly string[] = [
  ...documentationPaths,
  ...workflowControlPaths,
  ...iosInventoryPaths,
  ...backendInventoryPaths,
  ...storekitPaths,
  ...onboardingPaths,
  ...chatPlaidPaths,
  ...incomePaths,
  ...budgetPaths,
];

/**
 * True when the gate names this exact path, either in its own tables or in the
 * shared workflow-only list. Some named paths are shadowed by an earlier rule
 * and select nothing, which is why this answers "declared", not "selects".
 */
export function iosChangeGateDeclares(path: string): boolean {
  return iosChangeGatePathPatterns.includes(path) || isIosWorkflowOnlyPath(path);
}

/** True when the path decides nothing about iOS: CI control, docs or delivery tooling. */
export function isIosIrrelevantPath(path: string): boolean {
  return isIosWorkflowOnlyPath(path)
    || matchesAnyCaseGlob(path, documentationPaths)
    || matchesAnyCaseGlob(path, workflowControlPaths);
}

export function classifyIosChangedPaths(paths: readonly string[]): IosChangeClassification {
  // The new WLC-02 plan/scheme/test class belongs to a separate manual
  // real-server runner. The native selector validates their exact contents;
  // this narrow inventory exemption prevents the broad Chat* and scheme
  // patterns from allocating unrelated Chat-Plaid and Budget E2E Macs.
  const wellnessRegistrationPaths = new Set([
    'ios/example-ios.xcodeproj/xcshareddata/TestPlans/WLC02-Live.xctestplan',
    'ios/example-ios.xcodeproj/xcshareddata/xcschemes/example-ios.xcscheme',
    'ios/example-iosUITests/ChatLiveServerE2ETests.swift',
  ]);
  const wellnessRunnerTest = 'scripts/tests/test_ios_wellness_lifecycle_runner.py';
  const executablePaths = paths.filter((path) => path.length > 0
    && path !== wellnessRunnerTest && !isIosIrrelevantPath(path));
  const onlyWellnessRegistration = new Set(executablePaths).size === wellnessRegistrationPaths.size
    && executablePaths.every((path) => wellnessRegistrationPaths.has(path));
  const iosChangedFiles: string[] = [];
  let storekitRequired = false;
  let onboardingRequired = false;
  let chatPlaidRequired = false;
  let budgetRequired = false;
  let incomeRequired = false;

  for (const path of paths) {
    if (path.length === 0 || isIosIrrelevantPath(path)) continue;
    if (matchesAnyCaseGlob(path, iosInventoryPaths)
      || matchesAnyCaseGlob(path, backendInventoryPaths)) {
      iosChangedFiles.push(path);
    }
    if (onlyWellnessRegistration && wellnessRegistrationPaths.has(path)) continue;
    if (matchesAnyCaseGlob(path, storekitPaths)) storekitRequired = true;
    if (matchesAnyCaseGlob(path, onboardingPaths)) onboardingRequired = true;
    if (matchesAnyCaseGlob(path, chatPlaidPaths)) chatPlaidRequired = true;
    if (matchesAnyCaseGlob(path, incomePaths)) incomeRequired = true;
    if (matchesAnyCaseGlob(path, budgetPaths)) budgetRequired = true;
  }

  return {
    iosChangedFiles,
    storekitRequired,
    onboardingRequired,
    chatPlaidRequired,
    budgetRequired,
    incomeRequired,
  };
}

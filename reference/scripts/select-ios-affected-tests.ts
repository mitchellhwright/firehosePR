#!/usr/bin/env node

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { isIosWorkflowOnlyPath } from '../ci/src/ios/workflowOnlyPaths.ts';
import {
  iosFileOwner,
  methodReadsResource,
  projectEditOwners,
  testPlanEnabledSelectors,
  type TestFolderExclusion,
} from '../ci/src/ios/changedFileOwnership.ts';
import { decideChangedFileCoverage, type ChangedFileCoverage } from '../ci/src/ios/changedFileCoverage.ts';
import {
  affectedSwiftTestMethods,
  classifyGeneratedSwiftChange,
  parseSwiftTestMethods,
  parseSwiftTypeMethods,
  resourceReadingMethodKeys,
  type AdditiveGeneratedSwiftChange,
  type GeneratedSwiftChange,
} from './swift-test-impact.ts';

type Lane = 'main' | 'evidence';
type SelectionMode = 'full' | 'affected' | 'skip';
type IdentifiersByLane = Record<Lane, string[]>;

interface TestPlanTarget {
  readonly target: { readonly name: string };
  readonly selectedTests?: readonly string[];
  readonly skippedTests?: readonly string[];
}

interface TestPlan {
  readonly testTargets: readonly TestPlanTarget[];
}

interface TestRecord {
  readonly className: string;
  readonly contentLower: string;
  readonly fileLower: string;
  readonly identifiersByLane: IdentifiersByLane;
  readonly relativeFile: string;
  readonly targetName: string;
}

interface SelectionResult {
  readonly identifiersByLane: IdentifiersByLane;
  readonly reason: string;
}

interface FinishInput {
  readonly mode: SelectionMode;
  readonly reason: string;
  readonly changedFiles: readonly string[];
  readonly identifiersByLane?: IdentifiersByLane;
}

const lanes: readonly Lane[] = ['main', 'evidence'];
const emptyIdentifiers = (): IdentifiersByLane => ({ main: [], evidence: [] });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const productWorkspace = process.env.IOS_AFFECTED_TESTS_WORKSPACE;
if (productWorkspace && !path.isAbsolute(productWorkspace)) {
  throw new Error('IOS_AFFECTED_TESTS_WORKSPACE must be an absolute path.');
}
const repoRoot = productWorkspace ?? path.resolve(__dirname, '..');

const projectRelativePath = 'ios/example-ios.xcodeproj/project.pbxproj';
const testPlanDirectory = 'ios/example-ios.xcodeproj/xcshareddata/TestPlans';

const testPlanPaths = Object.freeze({
  main: path.join(
    repoRoot,
    'ios',
    'example-ios.xcodeproj',
    'xcshareddata',
    'TestPlans',
    'CI.xctestplan'
  ),
  evidence: path.join(
    repoRoot,
    'ios',
    'example-ios.xcodeproj',
    'xcshareddata',
    'TestPlans',
    'CI-Evidence.xctestplan'
  ),
});

const evidenceGroupRules = Object.freeze([
  {
    name: 'accessibility',
    prefixes: [
      'example-iosTests/ExampleInsightFoundationIncompleteTests',
      'example-iosUITests/TourCopyReviewEvidenceUITests',
      'example-iosUITests/SubscriptionCTACopyEvidenceUITests',
      'example-iosUITests/SharedCTAAccessibilityEvidenceUITests',
      'example-iosUITests/CardDashboardEditTipEvidenceUITests',
    ],
  },
  {
    name: 'onboarding-copy',
    prefixes: [
      'example-iosUITests/OnboardingCopyAccessibilityEvidenceUITests',
    ],
  },
  {
    name: 'account-update',
    prefixes: [
      'example-iosUITests/ActivationIntroManageAccounts',
      'example-iosUITests/CardAccountUpdateReturn',
    ],
  },
]);

const allEvidenceGroups = evidenceGroupRules.map((rule) => rule.name);

/**
 * Evidence XCTests captured by hand for review artifacts rather than by a CI
 * evidence group. Every other evidence-plan selection must reach a runnable
 * group or an equivalent main route.
 */
const manualEvidenceSelectors: readonly string[] = Object.freeze([
  'example-iosUITests/ActivationAggregateVisualMatrixUITests/testReceiptAndActivationIntroAutomatedMatrix',
  'example-iosUITests/DebtCardLayoutUITests/testAccessibilityExtraLargeObservation',
  'example-iosUITests/DebtCardLayoutUITests/testDefaultAndEdgeCaseMatrix',
  'example-iosUITests/ToggleMigrationEvidenceUITests',
]);

function evidencePrefixes(name: string): readonly string[] {
  const rule = evidenceGroupRules.find((candidate) => candidate.name === name);
  if (rule === undefined) throw new Error(`Missing iOS evidence group: ${name}`);
  return rule.prefixes;
}

const NARROW_PAYWALL_TEST_CLASS = 'example-iosUITests/SubscriptionCTACopyEvidenceUITests';

const supportedTestRoots = [
  'ios/example-iosTests',
  'ios/example-iosUITests',
];

/**
 * The XCTest classes that decode each generated model file's wire fixtures.
 * They run on every additive change to that file, alongside the tests that
 * name a touched type. A listed class that the CI plan no longer runs makes
 * the change unprovable rather than silently shrinking the selection.
 */
const generatedContractTestClasses: Readonly<Record<string, readonly string[]>> = {
  'ActionItemTypes.generated.swift': ['example-iosTests/NotificationContractDecodingTests'],
  'AuthTypes.generated.swift': ['example-iosTests/NativeLogoutSecurityContractTests'],
  'BudgetTypes.generated.swift': ['example-iosTests/BudgetModelsTests'],
  'ChatPayloads.generated.swift': ['example-iosTests/ChatPayloadTypeTests'],
  'ChatTypes.generated.swift': [
    'example-iosTests/ChatHistoryMessageContractTests',
    'example-iosTests/ChatPayloadTypeTests',
  ],
  'DashboardTypes.generated.swift': [
    'example-iosTests/DashboardGeneratedTypeCompatibilityTests',
    'example-iosTests/DashboardResponseDecodingTests',
  ],
  'IncomeTypes.generated.swift': [
    'example-iosTests/IRAFilingStatusActivationContractTests',
    'example-iosTests/IncomeNoCurrentIncomeActivationContractTests',
  ],
  'NotificationTypes.generated.swift': ['example-iosTests/NotificationContractDecodingTests'],
  'PlaidCategoryTypes.generated.swift': [
    'example-iosTests/PlaidAccountsErrorContractTests',
    'example-iosTests/PlaidSyncComponentHealthContractTests',
  ],
  'ExampleInsightTypes.generated.swift': ['example-iosTests/NotificationContractDecodingTests'],
  'UserProfileTypes.generated.swift': ['example-iosTests/TaxFilingStatusContractTests'],
};

const onboardingUiTestFiles = new Set([
  'ios/example-iosUITests/ChatPlaidLinkE2ETests.swift',
  'ios/example-iosUITests/OnboardingFullFlowUITests.swift',
]);

const separatelyExecutedTestTargets = new Set([
  'example-iosOnboardingUITests',
]);

// Real-server E2E lanes run these plans outside CI.xctestplan; their classes
// share example-iosBudgetDebtUITests with natively selected UI tests.
const separatelyExecutedTestPlanNames = [
  'Budget-E2E.xctestplan',
  'Debt-Card-Backend-Evidence.xctestplan',
  'Income-E2E.xctestplan',
  'WLC02-Live.xctestplan',
];

const wellnessManualPlanPath = path.posix.join(testPlanDirectory, 'WLC02-Live.xctestplan');
const wellnessSchemePath = 'ios/example-ios.xcodeproj/xcshareddata/xcschemes/example-ios.xcscheme';
const wellnessManualMethods = ['Coast', 'MWO'].flatMap((milestone) =>
  ['Pending', 'Confirmed', 'Grace', 'Expired', 'Recovered'].map((state) =>
    `ChatLiveServerE2ETests/test${milestone}${state}Lifecycle()`));

const budgetDebtUiTestFiles = new Set([
  'ios/example-iosUITests/BudgetCashflowChartFixtureSizeUITests.swift',
  'ios/example-iosUITests/BudgetCashflowChartUITests.swift',
  'ios/example-iosUITests/BudgetCategoryManagerUITests.swift',
  'ios/example-iosUITests/BudgetClassificationUITests.swift',
  'ios/example-iosUITests/BudgetDashboardLoadUITests.swift',
  'ios/example-iosUITests/BudgetEditingUITests.swift',
  'ios/example-iosUITests/BudgetFixtureClientDateResolverTests.swift',
  'ios/example-iosUITests/BudgetFlowUITests.swift',
  'ios/example-iosUITests/BudgetLinkSteerUITests.swift',
  'ios/example-iosUITests/BudgetNavigationUITests.swift',
  'ios/example-iosUITests/BudgetRealServerE2ETests.swift',
  'ios/example-iosUITests/BudgetRealServerEmptyStateE2ETests.swift',
  'ios/example-iosUITests/BudgetRecommendationsUITests.swift',
  'ios/example-iosUITests/BudgetScopeGatingUITests.swift',
  'ios/example-iosUITests/BudgetSubscriptionsBillsUITests.swift',
  'ios/example-iosUITests/BudgetTimePeriodUITests.swift',
  'ios/example-iosUITests/BudgetTransactionCategoryEditAffordanceUITests.swift',
  'ios/example-iosUITests/BudgetTransactionsUITests.swift',
  'ios/example-iosUITests/BudgetWhereMoneyGoesUITests.swift',
  'ios/example-iosUITests/ChatProfileUpdateRealServerE2ETests.swift',
  'ios/example-iosUITests/DataFreshnessBannerUITests.swift',
  'ios/example-iosUITests/DebtCardFreshnessRealServerE2ETests.swift',
  'ios/example-iosUITests/DebtHistoryRemovalRealServerE2ETests.swift',
]);

// Native Wellness tests run Swift only, with no backend, so the server's
// Wellness sources cannot change their result: the server side is covered by
// its own tests and the real-server lanes. The server/iOS contract reaches
// these tests only through the generated Swift types.
const wellnessSourcePrefixes = [
  'ios/example-ios/Models/Generated/DashboardTypes.generated.swift',
];
const wellnessRequiredIdentifiers = [
  'example-iosTests/WellnessScoreSnapshotLevel1Tests/testLevel1NextMissingFoundationCardPrefersServerCriteria',
  'example-iosTests/WellnessCriterionMapperTests/testMapsEveryCanonicalStateOneToOne',
  'example-iosTests/WellnessCriterionMapperTests/testExactBlockingNotMetStepKeyAddsFailedOverlay',
  'example-iosTests/WellnessPromotionContextTests/testSingleLevelPromotionContentNamesCompletedLevel',
  'example-iosUITests/WellnessLinkedCardEvidenceUITests/testLinkedCardAndUnavailablePaymentCycleRenderIndependently',
];
const isWellnessSource = (changedPath: string): boolean =>
  wellnessSourcePrefixes.some(prefix => changedPath.startsWith(prefix));

const workflowContractFiles = [
  'scripts/prepare-local-gcp-adc.sh',
  'scripts/remove-isolated-gcloud-config.sh',
  'scripts/stop-onboarding-dev-backend.sh',
  'ci/tests/prepareLocalGcpAdc.test.ts',
  'ci/src/actions/ios/validateOnboardingCopyEvidence.ts',
];

const onboardingCopyAccessibilityEvidenceIdentifier =
  'example-iosUITests/OnboardingCopyAccessibilityEvidenceUITests/testCaptureOnboardingCopyAccessibilityMatrix()';
const onboardingCopyAccessibilitySourcePrefixes = [
  'ios/example-ios/Core/Content/SmartCardCapabilityCopy.swift',
  'ios/example-ios/UI/Authentication/Components/AuthPrimitives.swift',
  'ios/example-ios/UI/Components/ManualAccountEditorView.swift',
  'ios/example-ios/UI/Components/UserCardSmall.swift',
  'ios/example-ios/UI/ContentView.swift',
  'ios/example-ios/UI/Onboarding/FlippableSmartCardPreview.swift',
  'ios/example-ios/UI/Onboarding/MeetYourSmartCardsView.swift',
  'ios/example-ios/UI/Onboarding/OnboardingCopyAccessibilityEvidenceFixtureView.swift',
  'ios/example-ios/UI/Onboarding/WelcomeView.swift',
  'ios/example-ios/Services/Cards/CardService.swift',
  'ios/example-ios/ViewModels/User/UserDataViewModel.swift',
];

const pinnedSourceTestRules = [
  ...[
    'example-iosTests/LinkedAccountRouterRetryPersistenceTests',
    'example-iosTests/PlaidSelectedSessionHostReconciliationTests',
    'example-iosTests/ConnectedAccountsHubLinkFinalizerTests',
  ].map((identifier) => ({
    prefix: 'ios/example-ios/UI/Cards/Budget/BudgetAboutView',
    identifier,
  })),
  ...[
    'ios/example-ios/UI/Components/CardAccountConnectionsView.swift',
    'ios/example-ios/UI/DashboardWidgets/InvestmentRateContributionPickerSheet.swift',
  ].map((prefix) => ({
    prefix,
    identifier:
      'example-iosUITests/SharedCTAAccessibilityEvidenceUITests/testCaptureSharedCTAAccessibilityEvidence',
  })),
  ...[
    'ios/example-ios/UI/Components/CardDashboardEditTip.swift',
    'ios/example-ios/UI/Components/Dashboard/CardDashboardContainer.swift',
    'ios/example-ios/UI/Components/Dashboard/CardDashboardEditTipEvidenceFixtureView.swift',
  ].flatMap((prefix) => [
    'example-iosTests/CardDashboardEditTipTests',
    'example-iosUITests/CardDashboardEditTipEvidenceUITests',
  ].map((identifier) => ({ prefix, identifier }))),
  ...[
    'ios/example-ios/UI/Cards/PersonalProperty/',
    'ios/example-ios/ViewModels/PersonalProperty/',
    'ios/example-ios/UI/Components/CardAccountEmptyStateView.swift',
  ].flatMap((prefix) => [
    'example-iosTests/PersonalPropertyFunctionalBugTests',
    'example-iosTests/PersonalPropertyVehicleRemovalTests',
    'example-iosUITests/PersonalPropertyManualEntryUITests',
  ].map((identifier) => ({ prefix, identifier }))),
  ...onboardingCopyAccessibilitySourcePrefixes.map((prefix) => ({
    prefix,
    identifier: onboardingCopyAccessibilityEvidenceIdentifier,
  })),
  {
    prefix: 'ios/example-ios/UI/Components/CardAccountConnectionsView+ViewModel.swift',
    identifier:
      'example-iosUITests/MixedAssignmentReceiptUITests/testMixedAssignmentsRenderEverySelectedAccountExactlyOnce',
  },
  {
    prefix: 'ios/example-ios/UI/Components/CardAccountConnectionsView+ViewModel.swift',
    identifier:
      'example-iosUITests/UnresolvedAssignmentReceiptUITests/testDelayedInventoryShowsUnresolvedStateAndDisablesCompletion',
  },
  {
    prefix: 'ios/example-ios/UI/Components/AccountLinkAssignmentSummaryView.swift',
    identifier:
      'example-iosUITests/MixedAssignmentReceiptUITests/testMixedAssignmentsRenderEverySelectedAccountExactlyOnce',
  },
  {
    prefix: 'ios/example-ios/UI/Components/AccountLinkAssignmentSummaryView.swift',
    identifier:
      'example-iosUITests/UnresolvedAssignmentReceiptUITests/testDelayedInventoryShowsUnresolvedStateAndDisablesCompletion',
  },
  {
    prefix: 'ios/example-ios/UI/Components/AccountLinkPostSuccessLifecycle.swift',
    identifier:
      'example-iosUITests/MixedAssignmentReceiptUITests/testMixedAssignmentsRenderEverySelectedAccountExactlyOnce',
  },
  {
    prefix: 'ios/example-ios/UI/Components/AccountLinkPostSuccessLifecycle.swift',
    identifier:
      'example-iosUITests/UnresolvedAssignmentReceiptUITests/testDelayedInventoryShowsUnresolvedStateAndDisablesCompletion',
  },
  {
    prefix: 'ios/example-ios/UI/Tour/',
    identifier:
      'example-iosUITests/OnboardingTourUITests/testCaptureTourOverlayEveryStep',
  },
  {
    prefix: 'ios/example-ios/UI/Tour/',
    identifier:
      'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureReadySpendingAnswer',
  },
  {
    prefix: 'ios/example-ios/UI/Components/ChatOverlayView.swift',
    identifier:
      'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureReadySpendingAnswer',
  },
  {
    prefix: 'ios/example-ios/UI/Components/ChatOverlayView.swift',
    identifier:
      'example-iosUITests/OnboardingTourUITests/testCaptureTourOverlayEveryStep',
  },
];

const pinnedTestSourceRules = [
  {
    path: 'ios/example-iosTests/FinancialIndependenceEvidenceTests.swift',
    identifier:
      'example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureFinancialIndependenceAccessibilityHierarchy',
  },
];

const chatPlaidE2EPrefixes = [
  'server/services/plaid/',
];

const sourceSuffixes = [
  'ViewModel',
  'View',
  'Service',
  'Manager',
  'Resolver',
  'Builder',
  'Controller',
  'Coordinator',
  'Provider',
  'Repository',
  'Store',
  'Client',
  'Helper',
  'Section',
  'Card',
  'Widget',
  'Cell',
  'Row',
  'Model',
];

const genericTokens = new Set([
  'app',
  'base',
  'card',
  'cell',
  'component',
  'components',
  'content',
  'controller',
  'core',
  'data',
  'detail',
  'helper',
  'helpers',
  'manager',
  'model',
  'models',
  'provider',
  'row',
  'section',
  'service',
  'shared',
  'state',
  'store',
  'tests',
  'ui',
  'utils',
  'view',
  'views',
  'widget',
]);

function git(args: readonly string[]): string {
  // Partial clones may lazily fetch a missing base blob. Selection must never
  // prompt for credentials after checkout removed its temporary token. A failed
  // optional history read must fail clearly; it cannot authorize broad tests.
  return execFileSync('git', ['-c', 'credential.helper=', '-c', 'credential.interactive=never', ...args], {
    cwd: repoRoot,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    timeout: 10_000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(args: readonly string[]): string {
  try {
    return git(args);
  } catch {
    return '';
  }
}

function refExists(ref: string): boolean {
  if (!ref) {
    return false;
  }
  return tryGit(['rev-parse', '--verify', `${ref}^{commit}`]) !== '';
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizeChangedPath(changedPath: string): string {
  return changedPath.replaceAll('\\', '/').replace(/^\.\//, '');
}

const requestedMode = process.env.IOS_AFFECTED_TESTS_MODE || 'affected';
/**
 * Only a manual dispatch may ask for the full suite outright. An automatic run
 * that carries `full` forward (a lane re-running the gate's escalated
 * selection) must re-derive that escalation from its own changed files.
 */
const dispatchedFull = requestedMode === 'full'
  && (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME === 'workflow_dispatch');

function getChangedFiles(): { files: string[]; forceFullReason: string } {
  if (dispatchedFull) {
    return { files: [], forceFullReason: 'workflow_dispatch requested full iOS tests' };
  }

  const explicitEmpty = process.env.IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY || 'false';
  if (!['true', 'false'].includes(explicitEmpty)) {
    throw new Error('IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY must be true or false.');
  }
  if (explicitEmpty === 'true') {
    if ((process.env.IOS_AFFECTED_TESTS_CHANGED_FILES || '').trim() !== '') {
      throw new Error('An explicitly empty iOS changed-file inventory cannot contain paths.');
    }
    return { files: [], forceFullReason: '' };
  }

  if (process.env.IOS_AFFECTED_TESTS_CHANGED_FILES) {
    return {
      files: uniqueSorted(
        process.env.IOS_AFFECTED_TESTS_CHANGED_FILES
          .split(/[\n,]/)
          .map((changedPath) => normalizeChangedPath(changedPath.trim()))
      ),
      forceFullReason: '',
    };
  }

  const headRef = process.env.IOS_AFFECTED_TESTS_HEAD || 'HEAD';
  const resolvedHead = refExists(headRef) ? headRef : 'HEAD';
  const baseCandidates = [
    process.env.IOS_AFFECTED_TESTS_BASE,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const baseRef of baseCandidates) {
    if (refExists(baseRef)) {
      try {
        const diff = git([
          'diff',
          '--name-only',
          '--diff-filter=ACMRTD',
          `${baseRef}...${resolvedHead}`,
        ]);
        return {
          files: uniqueSorted(diff.split('\n').map(normalizeChangedPath)),
          forceFullReason: '',
        };
      } catch {
        return { files: [], forceFullReason: 'comparable base history could not be read without interaction' };
      }
    }
  }

  if (process.env.GITHUB_ACTIONS === 'true') {
    return {
      files: [],
      forceFullReason: 'no comparable base ref was available in GitHub Actions',
    };
  }

  const localChanges = [
    tryGit(['diff', '--name-only', '--diff-filter=ACMRTD']),
    tryGit(['diff', '--cached', '--name-only', '--diff-filter=ACMRTD']),
    tryGit(['ls-files', '--others', '--exclude-standard']),
  ].flatMap((output) => output.split('\n'));

  const files = uniqueSorted(localChanges.map(normalizeChangedPath));
  if (files.length > 0) {
    return { files, forceFullReason: '' };
  }

  if (refExists('HEAD~1')) {
    const diff = tryGit(['diff', '--name-only', '--diff-filter=ACMRTD', 'HEAD~1...HEAD']);
    return {
      files: uniqueSorted(diff.split('\n').map(normalizeChangedPath)),
      forceFullReason: '',
    };
  }

  return { files: [], forceFullReason: 'no changed files could be determined' };
}

function appendGithubOutput(name: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  if (value.includes('\n')) {
    const delimiter = `EOF_${name}_${Date.now()}`;
    fs.appendFileSync(outputPath, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    fs.appendFileSync(outputPath, `${name}=${value}\n`);
  }
}

function setOutputs(outputs: Readonly<Record<string, string | number>>): void {
  for (const [name, value] of Object.entries(outputs)) {
    appendGithubOutput(name, String(value));
  }
}

function isIosRelevant(changedPath: string): boolean {
  return (
    pinnedSourceTestRules.some((rule) => changedPath.startsWith(rule.prefix)) ||
    changedPath.startsWith('ios/') ||
    isWellnessSource(changedPath) ||
    iosFileOwner(changedPath) !== 'unknown' ||
    workflowContractFiles.includes(changedPath) ||
    isIosWorkflowOnlyPath(changedPath) ||
    chatPlaidE2EPrefixes.some((prefix) => changedPath.startsWith(prefix)) ||
    changedPath === '.github/workflows/ios-tests.yml' ||
    changedPath.startsWith('scripts/ios-test') ||
    changedPath === 'ci/src/actions/ios/selectXcode.ts' ||
    changedPath === 'scripts/select-ios-affected-tests.ts' ||
    changedPath === 'scripts/summarize-ios-test-failures.py'
  );
}

function isDocumentationOnly(changedPath: string): boolean {
  return changedPath.startsWith('ios/docs/')
    || (changedPath.startsWith('ios/') && changedPath.endsWith('.md'))
    // SwiftLint runs in no build phase or CI step.
    || changedPath === 'ios/.swiftlint.yml';
}

function walkSwiftFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSwiftFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.swift')) {
      files.push(fullPath);
    }
  }
  return files;
}

function parseTestPlan(value: unknown, path: string): TestPlan {
  if (typeof value !== 'object' || value === null || !('testTargets' in value)
    || !Array.isArray(value.testTargets)) {
    throw new Error(`Invalid XCTest plan: ${path}`);
  }
  const testTargets: TestPlanTarget[] = [];
  for (const candidate of value.testTargets as unknown[]) {
    if (typeof candidate !== 'object' || candidate === null || !('target' in candidate)
      || typeof candidate.target !== 'object' || candidate.target === null
      || !('name' in candidate.target) || typeof candidate.target.name !== 'string') {
      throw new Error(`Invalid XCTest target in ${path}`);
    }
    const selectedTests = 'selectedTests' in candidate ? candidate.selectedTests : undefined;
    const skippedTests = 'skippedTests' in candidate ? candidate.skippedTests : undefined;
    if ((selectedTests !== undefined && (!Array.isArray(selectedTests)
      || selectedTests.some((item: unknown) => typeof item !== 'string')))
      || (skippedTests !== undefined && (!Array.isArray(skippedTests)
      || skippedTests.some((item: unknown) => typeof item !== 'string')))) {
      throw new Error(`Invalid XCTest selectors in ${path}`);
    }
    testTargets.push({
      target: { name: candidate.target.name },
      selectedTests: selectedTests as string[] | undefined,
      skippedTests: skippedTests as string[] | undefined,
    });
  }
  return { testTargets };
}

function readTestPlans(): Record<Lane, TestPlan> {
  return {
    main: parseTestPlan(JSON.parse(fs.readFileSync(testPlanPaths.main, 'utf8')) as unknown, testPlanPaths.main),
    evidence: parseTestPlan(JSON.parse(fs.readFileSync(testPlanPaths.evidence, 'utf8')) as unknown, testPlanPaths.evidence),
  };
}

function readSeparatelyExecutedTestPlans(includeNewWellnessPlan = false): TestPlan[] {
  return separatelyExecutedTestPlanNames.flatMap((planName) => {
    if (planName === 'WLC02-Live.xctestplan' && !includeNewWellnessPlan) return [];
    const planPath = path.join(path.dirname(testPlanPaths.main), planName);
    // The WLC-02 plan exists only on the PR that introduces the manual lane.
    // Existing required E2E plans still fail closed if a checkout loses them.
    if (planName === 'WLC02-Live.xctestplan' && !fs.existsSync(planPath)) return [];
    return [parseTestPlan(JSON.parse(fs.readFileSync(planPath, 'utf8')) as unknown, planPath)];
  });
}

/**
 * A test file belongs to a real-server E2E lane when none of its classes run in
 * the CI plans and every one of them is selected by a separately executed plan.
 */
function isSeparatelyExecutedPlanTestFile(
  changedPath: string,
  testRecords: readonly TestRecord[],
): boolean {
  const fileRecords = testRecords.filter((record) => record.relativeFile === changedPath);
  if (fileRecords.length === 0) return false;
  // The method-scoped WLC-02 plan only owns its initial registration. Once it
  // exists on the base, later edits to this class must get a fresh method owner.
  const includeNewWellnessPlan = changedPath === 'ios/example-iosUITests/ChatLiveServerE2ETests.swift'
    && newlyRegisteredWellnessManualPlan(wellnessManualPlanPath);
  const externalPlans = readSeparatelyExecutedTestPlans(includeNewWellnessPlan);
  return fileRecords.every((record) =>
    lanes.every((lane) => record.identifiersByLane[lane].length === 0)
    && externalPlans.some((plan) =>
      identifiersForClassInPlan(plan, record.targetName, record.className).length > 0));
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function synchronizedTestTargetNames(
  changedPath: string,
  project = fs.readFileSync(path.join(repoRoot, projectRelativePath), 'utf8'),
): string[] {
  const synchronizedRoot = supportedTestRoots
    .map((root) => `${root}/`)
    .find((root) => changedPath.startsWith(root));
  if (!synchronizedRoot) {
    return [];
  }

  const relativePath = changedPath.slice(synchronizedRoot.length);
  const groupName = path.basename(synchronizedRoot.slice(0, -1));
  const exceptionSetPattern = new RegExp(
    `\\/\\* Exceptions for "${regexEscape(groupName)}" folder in "[^"]+" target \\*\\/ = \\{([\\s\\S]*?)\\n\\s*\\};`,
    'g'
  );
  const targetNames: string[] = [];

  let exceptionSet = exceptionSetPattern.exec(project);
  while (exceptionSet) {
    const body = exceptionSet[1];
    if (body === undefined) {
      exceptionSet = exceptionSetPattern.exec(project);
      continue;
    }
    const targetMatch = body.match(/target = [A-F0-9]+ \/\* ([^*]+) \*\//);
    const membershipMatch = body.match(/membershipExceptions = \(([\s\S]*?)\);/);
    if (targetMatch?.[1] !== undefined && membershipMatch?.[1] !== undefined) {
      const excludedPaths = new Set(
        membershipMatch[1]
          .split('\n')
          .map((line) => line.trim().replace(/,$/, '').replace(/^"|"$/g, ''))
          .filter(Boolean)
      );
      if (!excludedPaths.has(relativePath)) {
        targetNames.push(targetMatch[1].trim());
      }
    }
    exceptionSet = exceptionSetPattern.exec(project);
  }

  return uniqueSorted(targetNames);
}

function identifiersForTargetInPlan(plan: TestPlan, targetName: string): string[] {
  const target = plan.testTargets.find((candidate) => candidate.target.name === targetName);
  if (!target) {
    return [];
  }

  const skippedTests = new Set(target.skippedTests || []);
  if (!Array.isArray(target.selectedTests)) {
    return [targetName];
  }

  return target.selectedTests
    .filter((identifier) => {
      const className = identifier.split('/', 1)[0];
      return !skippedTests.has(identifier) && !skippedTests.has(className);
    })
    .map((identifier) => `${targetName}/${identifier}`);
}

function identifiersForClassInPlan(plan: TestPlan, targetName: string, className: string): string[] {
  const target = plan.testTargets.find((candidate) => candidate.target.name === targetName);
  if (!target) {
    return [];
  }

  const skippedTests = target.skippedTests || [];
  if (skippedTests.includes(className)) {
    return [];
  }

  if (!Array.isArray(target.selectedTests)) {
    return [`${targetName}/${className}`];
  }

  return target.selectedTests
    .filter(
      (selectedTest) =>
        selectedTest === className || selectedTest.startsWith(`${className}/`)
    )
    .filter(
      (selectedTest) =>
        !skippedTests.includes(selectedTest) &&
        !skippedTests.some(
          (skippedTest) =>
            !skippedTest.includes('/') && selectedTest.startsWith(`${skippedTest}/`)
        )
    )
    .map((selectedTest) => `${targetName}/${selectedTest}`);
}

function identifierSelectedByPlan(plan: TestPlan, identifier: string): boolean {
  const [targetName, className, ...methodParts] = identifier.split('/');
  if (!targetName || !className) {
    return false;
  }

  const classIdentifiers = identifiersForClassInPlan(plan, targetName, className);
  if (methodParts.length === 0) {
    return classIdentifiers.length > 0;
  }

  // Native .xctestplan method identifiers end in (), while source rules use
  // xcodebuild's bare method form. Compare their identity without changing output.
  const exactIdentifier = `${targetName}/${className}/${methodParts.join('/')}`;
  return classIdentifiers.some(
    (selectedIdentifier) =>
      selectedIdentifier === `${targetName}/${className}` ||
      selectedIdentifier.replace(/\(\)$/, '') === exactIdentifier.replace(/\(\)$/, '')
  );
}

function accountUpdateTestIdentifiers(): string[] {
  const evidencePlan = readTestPlans().evidence;
  const accountUpdatePrefixes = evidencePrefixes('account-update');
  const identifiers = [];

  for (const testRoot of supportedTestRoots) {
    const absoluteRoot = path.join(repoRoot, testRoot);
    for (const absoluteFile of walkSwiftFiles(absoluteRoot)) {
      const relativeFile = normalizeChangedPath(path.relative(repoRoot, absoluteFile));
      const targetName = targetNameForTestPath(relativeFile);
      if (!targetName) continue;
      const source = fs.readFileSync(absoluteFile, 'utf8');
      for (const method of parseSwiftTestMethods(source)) {
        if (!method.name.startsWith('test')) continue;
        const identifier = `${targetName}/${method.className}/${method.name}`;
        if (
          accountUpdatePrefixes.some((prefix) => identifier.startsWith(prefix)) &&
          identifierSelectedByPlan(evidencePlan, identifier)
        ) {
          identifiers.push(identifier);
        }
      }
    }
  }

  return uniqueSorted(identifiers);
}

function selectedAccountUpdateTestCount(mode: SelectionMode, selectors: readonly string[]): number {
  const candidates = accountUpdateTestIdentifiers();
  if (mode === 'full') return candidates.length;

  const normalizedSelectors = selectors.map((identifier) => identifier.replace(/\(\)$/, ''));
  return candidates.filter((candidate) =>
    normalizedSelectors.some((selector) =>
      candidate === selector || candidate.startsWith(`${selector}/`)
    )
  ).length;
}

function identifierExplicitlySelectedByPlan(plan: TestPlan, identifier: string): boolean {
  const [targetName, className, ...methodParts] = identifier.split('/');
  if (!targetName || !className || methodParts.length === 0) return false;
  const target = plan.testTargets.find(candidate => candidate.target.name === targetName);
  if (!target || !Array.isArray(target.selectedTests)) return false;
  const planIdentifier = `${className}/${methodParts.join('/')}`.replace(/\(\)$/, '');
  return target.selectedTests.some(selected =>
    selected.replace(/\(\)$/, '') === planIdentifier);
}

function classNamesFromSwift(content: string, fallbackClassName: string): string[] {
  const names = [];
  const classPattern = /(?:^|\s)(?:@\w+(?:\([^)]*\))?\s+)*(?:final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*Tests)\s*:\s*[A-Za-z_][A-Za-z0-9_]*/g;
  let match = classPattern.exec(content);
  while (match) {
    if (match[1] !== undefined) names.push(match[1]);
    match = classPattern.exec(content);
  }
  return names.length > 0 ? names : [fallbackClassName];
}

function loadTestRecords() {
  const plans = readTestPlans();
  const records: TestRecord[] = [];

  for (const targetDir of supportedTestRoots) {
    const absoluteDir = path.join(repoRoot, targetDir);
    for (const absoluteFile of walkSwiftFiles(absoluteDir)) {
      const relativeFile = normalizeChangedPath(path.relative(repoRoot, absoluteFile));
      const targetName = targetNameForTestPath(relativeFile);
      const content = fs.readFileSync(absoluteFile, 'utf8');
      const fallbackClassName = path.basename(absoluteFile, '.swift');
      const classNames = classNamesFromSwift(content, fallbackClassName);

      for (const className of classNames) {
        const identifiersByLane: IdentifiersByLane = {
          main: identifiersForClassInPlan(plans.main, targetName, className),
          evidence: identifiersForClassInPlan(plans.evidence, targetName, className),
        };

        records.push({
          className,
          contentLower: content.toLowerCase(),
          fileLower: relativeFile.toLowerCase(),
          identifiersByLane,
          relativeFile,
          targetName,
        });
      }
    }
  }

  return { plans, records };
}

function targetNameForTestPath(changedPath: string): string {
  if (['ios/example-iosTests/StoreKitPurchaseIntegrationTests.swift',
    'ios/example-iosTests/SubscriptionTrialDisclosureTests.swift'].includes(changedPath)) {
    return 'example-iosStoreKitTests';
  }
  if (changedPath.startsWith('ios/example-iosTests/')) {
    return 'example-iosTests';
  }
  if (onboardingUiTestFiles.has(changedPath)) {
    return 'example-iosOnboardingUITests';
  }
  if (budgetDebtUiTestFiles.has(changedPath)) {
    return 'example-iosBudgetDebtUITests';
  }
  if (changedPath.startsWith('ios/example-iosUITests/')) {
    return 'example-iosUITests';
  }
  return '';
}

function camelWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

function addToken(tokens: Set<string>, value: string): void {
  const normalized = value.replace(/[^A-Za-z0-9]/g, '');
  const lower = normalized.toLowerCase();
  if (normalized.length < 5 || genericTokens.has(lower)) {
    return;
  }
  tokens.add(lower);
}

function sourceTokens(changedPath: string): { primary: string[]; fallback: string[] } {
  const stem = path.basename(changedPath, '.swift');
  const primary = new Set<string>();
  const fallback = new Set<string>();

  addToken(primary, stem);
  for (const suffix of sourceSuffixes) {
    if (stem.endsWith(suffix) && stem.length > suffix.length + 4) {
      addToken(primary, stem.slice(0, -suffix.length));
    }
  }

  const words = camelWords(stem).filter((word) => !genericTokens.has(word.toLowerCase()));
  for (let length = words.length; length >= 3; length -= 1) {
    addToken(primary, words.slice(0, length).join(''));
  }

  const pathParts = changedPath.split('/');
  const sourceRootIndex = pathParts.findIndex((part) => part === 'example-ios');
  for (const part of pathParts.slice(sourceRootIndex + 1, -1)) {
    if (!genericTokens.has(part.toLowerCase())) {
      addToken(fallback, part);
    }
  }

  return {
    primary: [...primary],
    fallback: [...fallback],
  };
}

function recordMatchesTokens(record: TestRecord, tokens: readonly string[]): boolean {
  return tokens.some((token) => record.fileLower.includes(token) || record.contentLower.includes(token));
}

function testsForSourceFile(changedPath: string, testRecords: readonly TestRecord[]): SelectionResult {
  const removed = !fs.existsSync(path.join(repoRoot, changedPath));
  const { primary, fallback } = sourceTokens(changedPath);
  let matches = testRecords.filter((record) => recordMatchesTokens(record, primary));

  // A removed source is owned only by tests that still name it, such as a
  // guard proving its callers are gone; its directory proves nothing.
  if (matches.length === 0 && !removed) {
    matches = testRecords.filter((record) => recordMatchesTokens(record, fallback));
  }

  const identifiersByLane = {
    main: uniqueSorted(matches.flatMap((record) => record.identifiersByLane.main)),
    evidence: uniqueSorted(matches.flatMap((record) => record.identifiersByLane.evidence)),
  };
  const identifiers = uniqueSorted(Object.values(identifiersByLane).flat());

  return {
    identifiersByLane,
    reason: identifiers.length > 0 ? ''
      : removed ? `${changedPath} was removed and no CI test names it`
        : `no CI test matched ${changedPath}`,
  };
}

/** The test records whose source names any of the types, by lane. */
function testsReferencingTypes(
  typeNames: readonly string[],
  testRecords: readonly TestRecord[],
): IdentifiersByLane {
  const patterns = typeNames.map((name) => new RegExp(`\\b${name.toLowerCase()}\\b`));
  const matches = testRecords.filter((record) =>
    patterns.some((pattern) => pattern.test(record.contentLower)));
  return {
    main: uniqueSorted(matches.flatMap((record) => record.identifiersByLane.main)),
    evidence: uniqueSorted(matches.flatMap((record) => record.identifiersByLane.evidence)),
  };
}

function describeAdditiveChange(change: AdditiveGeneratedSwiftChange): string {
  const parts: string[] = [];
  const fields = Object.entries(change.addedOptionalFields)
    .flatMap(([identity, names]) => names.map((name) => `${identity.split(':')[1]}.${name}`));
  if (fields.length > 0) parts.push(`optional fields ${fields.join(', ')}`);
  const cases = Object.entries(change.addedEnumCases)
    .flatMap(([identity, names]) => names.map((name) => `${identity.split(':')[1]}.${name}`));
  if (cases.length > 0) parts.push(`enum cases ${cases.join(', ')}`);
  if (change.addedDeclarations.length > 0) {
    parts.push(`new types ${change.addedDeclarations.map((identity) => identity.split(':')[1]).join(', ')}`);
  }
  return parts.join('; ');
}

/**
 * Narrow a generated model change to the tests that can observe it. Only an
 * additive change qualifies: it cannot alter how any existing field decodes
 * or encodes, so a fixture-driven test that never names the changed types
 * cannot change its result, and a compile-time break (a `switch` that a new
 * case makes non-exhaustive) fails the lane build regardless of selection.
 * The selection is every CI test that names a touched type plus the file's
 * wire-contract classes. Everything else, including a field that became
 * optional or a removed case, keeps the full native suite.
 */
function generatedSwiftTypeSelection(
  changedPath: string,
  testRecords: readonly TestRecord[],
  plan: TestPlan,
): SelectionResult & { readonly narrowing?: string } {
  const fallback = (reason: string): SelectionResult => ({
    identifiersByLane: emptyIdentifiers(),
    reason: `${changedPath}: ${reason}`,
  });
  const baseRef = process.env.IOS_AFFECTED_TESTS_BASE;
  const headRef = process.env.IOS_AFFECTED_TESTS_HEAD;
  if (!baseRef || !headRef) return fallback('exact base and head are required for generated type ownership');

  let change: GeneratedSwiftChange;
  try {
    const mergeBase = git(['merge-base', baseRef, headRef]);
    change = classifyGeneratedSwiftChange(
      git(['show', `${mergeBase}:${changedPath}`]),
      git(['show', `${headRef}:${changedPath}`]),
    );
  } catch (error) {
    return fallback(`exact declaration comparison failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (change.kind === 'documentation') return { identifiersByLane: emptyIdentifiers(), reason: '' };
  if (change.kind === 'not-additive') return fallback(`not additive: ${change.reason}`);

  const referencing = testsReferencingTypes(change.typeNames, testRecords);
  const contractClasses = generatedContractTestClasses[path.basename(changedPath)] ?? [];
  for (const identifier of contractClasses) {
    if (!identifierSelectedByPlan(plan, identifier)) {
      return fallback(`wire-contract owner ${identifier} is absent from the current CI plan`);
    }
  }
  const identifiersByLane = {
    main: uniqueSorted([...referencing.main, ...contractClasses]),
    evidence: referencing.evidence,
  };
  if (identifiersByLane.main.length === 0 && identifiersByLane.evidence.length === 0) {
    return fallback(`additive change but no CI test names ${change.typeNames.join(', ')}`);
  }
  return {
    identifiersByLane,
    reason: '',
    narrowing: `${path.basename(changedPath)}: additive (${describeAdditiveChange(change)})`,
  };
}

function addPinnedTestSourceIdentifiers(changedPath: string, identifiersByLane: IdentifiersByLane): void {
  for (const rule of pinnedTestSourceRules.filter((candidate) => candidate.path === changedPath)) {
    for (const lane of lanes) {
      const plan = plans[lane];
      if (identifierSelectedByPlan(plan, rule.identifier)) {
        identifiersByLane[lane].push(rule.identifier);
        identifiersByLane[lane] = uniqueSorted(identifiersByLane[lane]);
      }
    }
  }
}

function changedTestIdentifiers(changedPath: string, testRecords: readonly TestRecord[]): SelectionResult {
  const targetName = targetNameForTestPath(changedPath);
  if (!targetName || !changedPath.endsWith('.swift')) {
    return {
      identifiersByLane: emptyIdentifiers(),
      reason: `${changedPath} is not a supported CI test source file`,
    };
  }

  const records = testRecords.filter((record) => record.relativeFile === changedPath);
  const baseRef = process.env.IOS_AFFECTED_TESTS_BASE;
  const headRef = process.env.IOS_AFFECTED_TESTS_HEAD;
  if (baseRef && headRef && fs.existsSync(path.join(repoRoot, changedPath))) {
    try {
      const diff = git([
        'diff', '--unified=0', '--no-ext-diff', `${baseRef}...${headRef}`, '--', changedPath,
      ]);
      const affectedMethods = affectedSwiftTestMethods({
        source: fs.readFileSync(path.join(repoRoot, changedPath), 'utf8'),
        diff,
      });
      if (affectedMethods) {
        const identifiersByLane = emptyIdentifiers();
        for (const method of affectedMethods) {
          const identifier = `${targetName}/${method.className}/${method.methodName}`;
          // Explicit evidence-plan methods retain their dedicated fixture lane.
          // Other methods use the main plan as their single owner even when an
          // evidence plan happens to select the containing class broadly.
          if (identifierExplicitlySelectedByPlan(plans.evidence, identifier)) {
            identifiersByLane.evidence.push(identifier);
          } else if (identifierSelectedByPlan(plans.main, identifier)) {
            identifiersByLane.main.push(identifier);
          } else if (identifierSelectedByPlan(plans.evidence, identifier)) {
            identifiersByLane.evidence.push(identifier);
          } else {
            throw new Error(`Changed XCTest method is absent from CI plans: ${identifier}`);
          }
        }
        addPinnedTestSourceIdentifiers(changedPath, identifiersByLane);
        return {
          identifiersByLane: {
            main: uniqueSorted(identifiersByLane.main),
            evidence: uniqueSorted(identifiersByLane.evidence),
          },
          reason: '',
        };
      }
    } catch (error) {
      console.warn(
        `Could not prove method-level XCTest impact for ${changedPath}: ${error instanceof Error ? error.message : String(error)}. `
          + 'Retaining class-level coverage.'
      );
    }
  }
  const identifiersByLane = {
    main: uniqueSorted(records.flatMap((record) => record.identifiersByLane.main)),
    evidence: uniqueSorted(records.flatMap((record) => record.identifiersByLane.evidence)),
  };
  addPinnedTestSourceIdentifiers(changedPath, identifiersByLane);
  const identifiers = uniqueSorted(Object.values(identifiersByLane).flat());

  if (identifiers.length > 0) {
    return {
      identifiersByLane,
      reason: '',
    };
  }

  const sourceName = path.basename(changedPath, '.swift');
  if (!sourceName.endsWith('Tests')) {
    const normalizedSourceName = sourceName.toLowerCase();
    const directlyDependentIdentifiersByLane = emptyIdentifiers();

    for (const record of testRecords) {
      if (
        record.relativeFile === changedPath
        || !record.contentLower.includes(normalizedSourceName)
      ) {
        continue;
      }

      for (const lane of lanes) {
        const recordIdentifiers = record.identifiersByLane[lane];
        directlyDependentIdentifiersByLane[lane].push(
          ...recordIdentifiers.filter((identifier) => {
            const [identifierTarget] = identifier.split('/');
            return identifierTarget !== undefined && !separatelyExecutedTestTargets.has(identifierTarget);
          })
        );
      }
    }

    const normalizedDirectIdentifiersByLane: IdentifiersByLane = {
      main: uniqueSorted(directlyDependentIdentifiersByLane.main),
      evidence: uniqueSorted(directlyDependentIdentifiersByLane.evidence),
    };
    if (Object.values(normalizedDirectIdentifiersByLane).some((laneIdentifiers) => laneIdentifiers.length > 0)) {
      return {
        identifiersByLane: normalizedDirectIdentifiersByLane,
        reason: '',
      };
    }

    const targetNames = synchronizedTestTargetNames(changedPath)
      .filter((candidate) => !separatelyExecutedTestTargets.has(candidate));
    const targetIdentifiersByLane: IdentifiersByLane = {
      main: uniqueSorted(targetNames.flatMap((candidate) =>
        identifiersForTargetInPlan(plans.main, candidate))),
      evidence: uniqueSorted(targetNames.flatMap((candidate) =>
        identifiersForTargetInPlan(plans.evidence, candidate))),
    };
    if (uniqueSorted(Object.values(targetIdentifiersByLane).flat()).length > 0) {
      return {
        identifiersByLane: targetIdentifiersByLane,
        reason: '',
      };
    }
  }

  return {
    identifiersByLane: { main: [], evidence: [] },
    reason: `${changedPath} is not selected by CI.xctestplan`,
  };
}

function writeOnlyTestingFile(identifiers: readonly string[], lane: string): string {
  const outputDir = process.env.RUNNER_TEMP || os.tmpdir();
  const outputPath = path.join(outputDir, `ios-only-testing-${lane}-${process.pid}.txt`);
  fs.writeFileSync(outputPath, `${identifiers.join('\n')}\n`);
  return outputPath;
}

function evidenceGroupsForIdentifiers(identifiers: readonly string[]): string[] {
  return evidenceGroupRules
    .filter((rule) =>
      identifiers.some((identifier) =>
        rule.prefixes.some((prefix) => identifier.startsWith(prefix))
      )
    )
    .map((rule) => rule.name);
}

function selectionRequiresReleaseArchive(mode: SelectionMode, changedFiles: readonly string[]): boolean {
  return mode === 'full' || changedFiles.some((changedPath) =>
    (changedPath.startsWith('ios/example-ios/') && changedPath.endsWith('.swift'))
    || iosFileOwner(changedPath) === 'archive'
    || iosFileOwner(changedPath) === 'runtime-config'
    || iosFileOwner(changedPath) === 'project'
  );
}

function testsUsingResource(
  resourceName: string,
  testRecords: readonly TestRecord[],
  plans: Record<Lane, TestPlan>,
): IdentifiersByLane {
  const selected = emptyIdentifiers();
  const sources = [...new Set(testRecords.map((record) => record.relativeFile))]
    .map((relativeFile) => fs.readFileSync(path.join(repoRoot, relativeFile), 'utf8'));
  const readers = resourceReadingMethodKeys(sources,
    (source, body) => methodReadsResource(resourceName, source, body));
  for (const record of testRecords) {
    if (![...readers].some((key) => key.startsWith(`${record.className}.`))) continue;
    const source = fs.readFileSync(path.join(repoRoot, record.relativeFile), 'utf8');
    for (const method of parseSwiftTypeMethods(source)) {
      if (method.className !== record.className || !/^test[A-Z0-9_]/.test(method.name)) continue;
      if (!readers.has(`${method.className}.${method.name}`)) continue;
      const identifier = `${record.targetName}/${record.className}/${method.name}`;
      for (const lane of lanes) {
        if (identifierSelectedByPlan(plans[lane], identifier)) selected[lane].push(identifier);
      }
    }
  }
  return { main: uniqueSorted(selected.main), evidence: uniqueSorted(selected.evidence) };
}

/**
 * Excluding a Swift file that this change adds cannot alter what the excluded
 * target compiled before, so the exclusion shares that new file's test owners.
 */
function newTestFileExclusions(
  exclusions: readonly TestFolderExclusion[],
  mergeBase: string,
  head: string,
): string[] | null {
  const testPaths: string[] = [];
  for (const { folder, target, file } of exclusions) {
    const root = supportedTestRoots.find((candidate) => path.basename(candidate) === folder);
    if (!root || !file.endsWith('.swift')) return null;
    const testPath = `${root}/${file}`;
    // Excluding the new file from its executing target leaves CI with a
    // selected XCTest identifier that Xcode cannot compile or run.
    if (target === targetNameForTestPath(testPath)) return null;
    if (tryGit(['cat-file', '-t', `${mergeBase}:${testPath}`]) !== ''
      || tryGit(['cat-file', '-t', `${head}:${testPath}`]) !== 'blob') return null;
    testPaths.push(testPath);
  }
  return uniqueSorted(testPaths);
}

/**
 * Removing a test folder exclusion only follows a deletion when the excluded
 * file existed at the merge base, is gone at the head and is itself a changed
 * file, so the deleted-test rules still decide whether that deletion is owned.
 */
function deletedTestFileExclusions(
  removals: readonly TestFolderExclusion[],
  mergeBase: string,
  head: string,
  changedFiles: ReadonlySet<string>,
): string[] | null {
  const testPaths: string[] = [];
  for (const { folder, file } of removals) {
    const root = supportedTestRoots.find((candidate) => path.basename(candidate) === folder);
    if (!root) return null;
    const testPath = `${root}/${file}`;
    if (!changedFiles.has(testPath)
      || tryGit(['cat-file', '-t', `${mergeBase}:${testPath}`]) !== 'blob'
      || tryGit(['cat-file', '-t', `${head}:${testPath}`]) !== '') return null;
    testPaths.push(testPath);
  }
  return uniqueSorted(testPaths);
}

/**
 * Deleting a test file that no test plan executed at the merge base changes
 * nothing CI runs. Any target that compiled the file and any plan that selected
 * one of its classes makes the deletion a coverage removal, which keeps its
 * ordinary fail-closed selection.
 */
function deletedTestFileWasUnplanned(changedPath: string): boolean {
  const base = process.env.IOS_AFFECTED_TESTS_BASE
    || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '');
  const head = process.env.IOS_AFFECTED_TESTS_HEAD || 'HEAD';
  if (!refExists(base) || !refExists(head)) return false;
  const mergeBase = tryGit(['merge-base', base, head]);
  if (!mergeBase || tryGit(['cat-file', '-t', `${head}:${changedPath}`]) !== '') return false;
  const source = tryGit(['show', `${mergeBase}:${changedPath}`]);
  const project = tryGit(['show', `${mergeBase}:${projectRelativePath}`]);
  const planPaths = tryGit(['ls-tree', '--name-only', mergeBase, `${testPlanDirectory}/`])
    .split('\n')
    .filter((planPath) => planPath.endsWith('.xctestplan'));
  if (!source || !project || planPaths.length === 0) return false;
  const targetNames = uniqueSorted([
    targetNameForTestPath(changedPath), ...synchronizedTestTargetNames(changedPath, project),
  ]);
  const classNames = classNamesFromSwift(source, path.basename(changedPath, '.swift'));
  return planPaths.every((planPath) => {
    const planSource = git(['show', `${mergeBase}:${planPath}`]);
    const plan = parseTestPlan(JSON.parse(planSource) as unknown, planPath);
    return targetNames.every((targetName) => classNames.every((className) =>
      identifiersForClassInPlan(plan, targetName, className).length === 0));
  });
}

/** The selectors a plan edit enables since the merge base, or null for any other edit. */
function testPlanEnabledSelectorsSinceMergeBase(changedPath: string): ReturnType<typeof testPlanEnabledSelectors> {
  const base = process.env.IOS_AFFECTED_TESTS_BASE
    || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '');
  const head = process.env.IOS_AFFECTED_TESTS_HEAD || 'HEAD';
  if (!refExists(base) || !refExists(head)) return null;
  const mergeBase = tryGit(['merge-base', base, head]);
  if (!mergeBase) return null;
  return testPlanEnabledSelectors(
    tryGit(['show', `${mergeBase}:${changedPath}`]),
    tryGit(['show', `${head}:${changedPath}`]),
  );
}

// The Budget lane runs pull requests from its own shard selector list, not
// from Budget-E2E.xctestplan; the typed manifest replaces the shell list.
const budgetLaneSelectorSources = [
  'ci/src/ios/budgetE2eShards.ts',
  'scripts/run-ios-budget-e2e-shards.sh',
];

/**
 * The Budget harness passes each shard selector as an exact -only-testing
 * argument: a class selector runs the whole class, a method selector only
 * that method.
 */
function budgetLaneRunsSelector(selector: string): boolean {
  const selectors = budgetLaneShardSelectors();
  const normalized = selector.replace(/\(\)$/, '');
  const [className = ''] = normalized.split('/');
  return selectors.has(className) || selectors.has(normalized);
}

/** Only the selector data the Budget runner passes, never comments or other strings. */
function budgetLaneShardSelectors(): ReadonlySet<string> {
  const [manifestPath = '', scriptPath = ''] = budgetLaneSelectorSources
    .map((relativePath) => path.join(repoRoot, relativePath));
  if (fs.existsSync(manifestPath)) {
    const manifest = /export const budgetE2eShards = \{([\s\S]*?)\} as const/
      .exec(fs.readFileSync(manifestPath, 'utf8'))?.[1] ?? '';
    const code = manifest.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return new Set([...code.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? ''));
  }
  if (!fs.existsSync(scriptPath)) return new Set();
  const prefix = 'example-iosBudgetDebtUITests/';
  const heredocs = fs.readFileSync(scriptPath, 'utf8')
    .matchAll(/selected_tests="\$\(cat <<'EOF'\n([\s\S]*?)\nEOF\n/g);
  return new Set([...heredocs].flatMap((match) => (match[1] ?? '').split('\n'))
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length)));
}

/**
 * A Budget-E2E.xctestplan edit that only enables selectors the Budget lane's
 * shard selectors already run is owned by that lane. Other real-server plans
 * run only on focused dispatches or a fixed class, so their edits stay
 * fail-closed.
 */
function budgetE2EPlanOnlyEnablesLaneTests(changedPath: string): boolean {
  if (changedPath !== path.posix.join(testPlanDirectory, 'Budget-E2E.xctestplan')) return false;
  const enabled = testPlanEnabledSelectorsSinceMergeBase(changedPath);
  return enabled !== null && enabled.every(({ target, selector }) =>
    target === 'example-iosBudgetDebtUITests' && budgetLaneRunsSelector(selector));
}

/** A plan edit that only enables tests is owned by the CI lanes that now run them. */
function testPlanEnabledIdentifiers(changedPath: string): IdentifiersByLane | null {
  const enabled = testPlanEnabledSelectorsSinceMergeBase(changedPath);
  if (enabled === null) return null;
  const selected = emptyIdentifiers();
  for (const { target, selector } of enabled) {
    const identifier = `${target}/${selector}`;
    const [className = '', ...methodParts] = selector.split('/');
    let owned = false;
    for (const lane of lanes) {
      const laneIdentifiers = methodParts.length === 0
        ? identifiersForClassInPlan(plans[lane], target, className)
        : identifierSelectedByPlan(plans[lane], identifier) ? [identifier] : [];
      selected[lane].push(...laneIdentifiers);
      owned ||= laneIdentifiers.length > 0;
    }
    if (!owned) throw new Error(`${changedPath} enables ${identifier}, which no CI lane plan executes`);
  }
  return { main: uniqueSorted(selected.main), evidence: uniqueSorted(selected.evidence) };
}

/**
 * WLC-02 is an explicitly manual real-server matrix. Its new plan and the
 * scheme reference only make that separate runner available; neither changes
 * the CI plans. Accept only the new ten-method plan and the exact scheme
 * reference addition. Any later plan or scheme edit stays fail-closed.
 */
function newlyRegisteredWellnessManualPlan(changedPath: string): boolean {
  if (changedPath !== wellnessManualPlanPath && changedPath !== wellnessSchemePath) return false;
  const base = process.env.IOS_AFFECTED_TESTS_BASE
    || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '');
  const head = process.env.IOS_AFFECTED_TESTS_HEAD || 'HEAD';
  if (!refExists(base) || !refExists(head)) return false;
  const before = tryGit(['show', `${base}:${changedPath}`]);
  const after = tryGit(['show', `${head}:${changedPath}`]);
  if (!after) return false;
  const runner = tryGit(['show', `${head}:scripts/ios-test-wellness-lifecycle.py`]);
  if (!runner.includes('"WLC02-Live"')) {
    return false;
  }
  if (changedPath === wellnessManualPlanPath) {
    if (before) return false;
    const plan = parseTestPlan(JSON.parse(after) as unknown, changedPath);
    const target = plan.testTargets[0];
    return plan.testTargets.length === 1
      && target?.target.name === 'example-iosUITests'
      && (target.skippedTests?.length ?? 0) === 0
      && JSON.stringify([...(target.selectedTests ?? [])].sort())
        === JSON.stringify([...wellnessManualMethods].sort());
  }
  const reference = `         <TestPlanReference\n`
    + `            reference = "container:example-ios.xcodeproj/xcshareddata/TestPlans/WLC02-Live.xctestplan">\n`
    + `         </TestPlanReference>\n`;
  return after.split(reference).length === 2 && after.replace(reference, '') === before;
}

function changedFilesRequireTarget(changedFiles: readonly string[], requiredTarget: string): boolean {
  return changedFiles.some((changedPath) => {
    if (!changedPath.endsWith('.swift')) {
      return false;
    }
    return (
      targetNameForTestPath(changedPath) === requiredTarget
      || synchronizedTestTargetNames(changedPath).includes(requiredTarget)
    );
  });
}

/** A class selector covers its methods; a method selector covers only itself. */
function selectorCoversIdentifier(selector: string, identifier: string): boolean {
  const normalizedSelector = selector.replace(/\(\)$/, '');
  const normalizedIdentifier = identifier.replace(/\(\)$/, '');
  return normalizedIdentifier === normalizedSelector
    || normalizedIdentifier.startsWith(`${normalizedSelector}/`);
}

function requiredEvidenceSelection(evidenceIdentifiers: readonly string[]): string[] {
  return evidenceIdentifiers.filter((identifier) =>
    evidenceGroupRules.some((rule) =>
      rule.prefixes.some((prefix) => identifier.startsWith(prefix))
    )
  );
}

/** A selected evidence test must run somewhere, whatever mode the lane ends up in. */
function assertEvidenceRouted(identifiersByLane: IdentifiersByLane): void {
  const requiredEvidenceIdentifiers = requiredEvidenceSelection(identifiersByLane.evidence);
  const unroutedEvidenceIdentifiers = identifiersByLane.evidence.filter((identifier) =>
    !requiredEvidenceIdentifiers.includes(identifier)
    && ![...identifiersByLane.main, ...manualEvidenceSelectors].some((selector) =>
      selectorCoversIdentifier(selector, identifier))
  );
  if (unroutedEvidenceIdentifiers.length > 0) {
    throw new Error(
      `Selected evidence XCTest has no runnable evidence group, equivalent main route or manual-evidence registration: ${unroutedEvidenceIdentifiers.join(', ')}`
    );
  }
}

function finish({ mode, reason, changedFiles, identifiersByLane = emptyIdentifiers() }: FinishInput): void {
  const lane = process.env.IOS_AFFECTED_TESTS_LANE || 'main';
  if (lane !== 'main' && lane !== 'evidence') {
    throw new Error(`Unsupported IOS_AFFECTED_TESTS_LANE: ${lane}`);
  }

  const storeKitRequiresMainExecution =
    lane === 'main' && process.env.IOS_AFFECTED_TESTS_STOREKIT_REQUIRED === 'true';
  const effectiveMode = storeKitRequiresMainExecution && mode === 'skip' ? 'affected' : mode;
  const effectiveReason = storeKitRequiresMainExecution && mode === 'skip'
    ? `${reason}; consolidated main execution is required for StoreKit coverage`
    : reason;

  if (requestedMode === 'full' && !dispatchedFull && effectiveMode !== 'full') {
    throw new Error(
      'Full iOS selection requires an explicit workflow_dispatch event or a changed-file inventory that escalates to full'
    );
  }
  const requiredEvidenceIdentifiers = requiredEvidenceSelection(identifiersByLane.evidence);
  if (effectiveMode === 'affected') assertEvidenceRouted(identifiersByLane);
  const runnableIdentifiersByLane = {
    main: identifiersByLane.main,
    evidence: requiredEvidenceIdentifiers,
  };
  const evidenceGroups =
    effectiveMode === 'full'
      ? allEvidenceGroups
      : evidenceGroupsForIdentifiers(requiredEvidenceIdentifiers);
  // StoreKit tests execute only in the StoreKit Purchase lane, which the change
  // gate requires on its own; the main pass skips their target.
  let laneIdentifiers = lane === 'main'
    ? runnableIdentifiersByLane.main.filter((identifier) =>
      identifier.split('/', 1)[0] !== 'example-iosStoreKitTests')
    : runnableIdentifiersByLane[lane];
  const accountUpdatePrefixes = evidencePrefixes('account-update');
  let accountUpdateIdentifiers = requiredEvidenceIdentifiers.filter((identifier) =>
    accountUpdatePrefixes.some((prefix) => identifier.startsWith(prefix))
  );
  if (lane === 'main' && effectiveMode === 'affected' && evidenceGroups.includes('account-update')) {
    const transferredAccountUpdateIdentifiers = laneIdentifiers.filter((identifier) =>
      accountUpdatePrefixes.some((prefix) => identifier.startsWith(prefix))
    );
    laneIdentifiers = laneIdentifiers.filter((identifier) =>
      !accountUpdatePrefixes.some((prefix) => identifier.startsWith(prefix))
    );
    accountUpdateIdentifiers = uniqueSorted([
      ...accountUpdateIdentifiers,
      ...transferredAccountUpdateIdentifiers,
    ]);
  }
  const accountUpdateTestCount = evidenceGroups.includes('account-update')
    ? selectedAccountUpdateTestCount(effectiveMode, accountUpdateIdentifiers)
    : 0;
  if (evidenceGroups.includes('account-update') && accountUpdateTestCount < 1) {
    throw new Error('Account-update evidence selected with zero executable test methods');
  }
  // The paywall accessibility regression executes on a narrow (SE 375x667)
  // destination in the main lane whenever its class is selected or the whole
  // suite runs; the workflow provisions that simulator only on this signal.
  const narrowPaywallRequired =
    lane === 'main' &&
    (effectiveMode === 'full' ||
      laneIdentifiers.some((identifier) =>
        identifier === NARROW_PAYWALL_TEST_CLASS ||
        identifier.startsWith(`${NARROW_PAYWALL_TEST_CLASS}/`)
      ));
  const releaseArchiveRequired = selectionRequiresReleaseArchive(effectiveMode, changedFiles);
  const shouldRun =
    storeKitRequiresMainExecution ||
    effectiveMode === 'full' ||
    (effectiveMode === 'affected' &&
      (laneIdentifiers.length > 0 ||
        (lane === 'main' && (evidenceGroups.length > 0 || releaseArchiveRequired))));
  const onlyTestingIdentifiers = uniqueSorted([
    ...laneIdentifiers,
    ...accountUpdateIdentifiers,
  ]);
  const onlyTestingFile =
    effectiveMode === 'affected' && shouldRun
      ? writeOnlyTestingFile(onlyTestingIdentifiers, lane)
      : '';
  const identifiers = uniqueSorted(Object.values(identifiersByLane).flat());
  const onboardingRequired = changedFilesRequireTarget(
    changedFiles,
    'example-iosOnboardingUITests'
  );
  const summaryLines = [
    `iOS test selection: ${effectiveMode}`,
    `Lane: ${lane}`,
    effectiveReason ? `Reason: ${effectiveReason}` : '',
    changedFiles.length > 0 ? `Changed files: ${changedFiles.join(', ')}` : '',
    identifiers.length > 0 ? `Selected tests: ${identifiers.join(', ')}` : '',
    evidenceGroups.length > 0 ? `Evidence groups: ${evidenceGroups.join(', ')}` : '',
  ].filter(Boolean);
  const summary = summaryLines.join('\n');

  console.log(summary);
  setOutputs({
    mode: effectiveMode,
    should_run: shouldRun ? 'true' : 'false',
    release_archive_required: releaseArchiveRequired ? 'true' : 'false',
    narrow_paywall_required: narrowPaywallRequired ? 'true' : 'false',
    wellness_required: changedFiles.some(isWellnessSource) ? 'true' : 'false',
    wellness_only_testing_file: changedFiles.some(isWellnessSource) ? writeOnlyTestingFile(wellnessRequiredIdentifiers, 'wellness') : '',
    wellness_test_count: wellnessRequiredIdentifiers.length,
    only_testing_file: onlyTestingFile,
    test_count: laneIdentifiers.length,
    account_update_test_count: accountUpdateTestCount,
    evidence_groups: evidenceGroups.join(','),
    onboarding_required: onboardingRequired ? 'true' : 'false',
    summary,
  });
}

const { files: changedFiles, forceFullReason } = getChangedFiles();

if (forceFullReason) {
  if (!dispatchedFull) {
    throw new Error(`Cannot determine changed iOS files: ${forceFullReason}`);
  }
  finish({
    mode: 'full',
    reason: forceFullReason,
    changedFiles,
  });
  process.exit(0);
}

const relevantFiles = changedFiles.filter(isIosRelevant);
const executableRelevantFiles = relevantFiles.filter((changedPath) => !isDocumentationOnly(changedPath));

if (relevantFiles.length === 0 || executableRelevantFiles.length === 0) {
  finish({
    mode: 'skip',
    reason: relevantFiles.length === 0 ? 'no iOS-related files changed' : 'only iOS documentation changed',
    changedFiles,
  });
  process.exit(0);
}

const isNonXCTestOwner = (changedPath: string): boolean => (
  !pinnedSourceTestRules.some((rule) => changedPath.startsWith(rule.prefix))
  && (isIosWorkflowOnlyPath(changedPath)
    || iosFileOwner(changedPath) === 'workflow'
    || workflowContractFiles.includes(changedPath)
    || chatPlaidE2EPrefixes.some((prefix) => changedPath.startsWith(prefix)))
);
const isWorkflowOnlyChange = executableRelevantFiles.every(isNonXCTestOwner);
if (isWorkflowOnlyChange) {
  finish({
    mode: 'skip',
    reason: 'Only workflow, test-infra, or backend E2E owner files changed; skipping Xcode execution.',
    changedFiles: executableRelevantFiles,
  });
  process.exit(0);
}

const selectionRelevantFiles = executableRelevantFiles.filter(
  (changedPath) => !isNonXCTestOwner(changedPath)
);
const { plans, records: testRecords } = loadTestRecords();
const selectedIdentifiersByLane: IdentifiersByLane = emptyIdentifiers();
const fallbackReasons: string[] = [];
/** Generated models narrowed to referencing and wire-contract tests, and why. */
const generatedNarrowings: string[] = [];
const changedFileCoverage: ChangedFileCoverage[] = [];
let currentFileIdentifiers: string[] = [];

function addIdentifiers(identifiersByLane: IdentifiersByLane): void {
  for (const lane of lanes) {
    selectedIdentifiersByLane[lane].push(...identifiersByLane[lane]);
    currentFileIdentifiers.push(...identifiersByLane[lane]);
  }
}

/**
 * Owns each part of a project edit on its own terms: resource references select
 * the tests that read them, a new test file's exclusions share that file's
 * tests, a removed exclusion must follow an owned test deletion, and version or
 * warnings-mapping lines need only the native build and release archive. Any
 * other project line fails closed.
 */
function projectEditCoverage(changedPath: string): ChangedFileCoverage {
  const base = process.env.IOS_AFFECTED_TESTS_BASE
    || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '');
  const head = process.env.IOS_AFFECTED_TESTS_HEAD || 'HEAD';
  const mergeBase = refExists(base) && refExists(head) ? tryGit(['merge-base', base, head]) : '';
  if (!mergeBase) {
    throw new Error(`Cannot classify ${changedPath} without comparable base and head commits`);
  }
  const owners = projectEditOwners(
    git(['show', `${mergeBase}:${changedPath}`]),
    git(['show', `${head}:${changedPath}`]),
    supportedTestRoots.map((root) => path.basename(root)),
  );
  const addedTestPaths = owners && newTestFileExclusions(owners.addedExclusions, mergeBase, head);
  const deletedTestPaths = owners && deletedTestFileExclusions(
    owners.removedExclusions, mergeBase, head, new Set(selectionRelevantFiles),
  );
  if (!owners || !addedTestPaths || !deletedTestPaths) {
    throw new Error(`Unowned Xcode project edit in ${changedPath}; declare its target/build-setting owner`);
  }
  for (const resourceName of owners.resources) {
    const selected = testsUsingResource(resourceName, testRecords, plans);
    if (selected.main.length + selected.evidence.length === 0) {
      throw new Error(`Xcode project resource ${resourceName} has no executable XCTest owner`);
    }
    addIdentifiers(selected);
  }
  for (const testPath of addedTestPaths) {
    const { identifiersByLane, reason } = changedTestIdentifiers(testPath, testRecords);
    if (reason || identifiersByLane.main.length + identifiersByLane.evidence.length === 0) {
      throw new Error(`Xcode project exclusion of ${testPath} has no executable XCTest owner`);
    }
    addIdentifiers(identifiersByLane);
  }
  if (currentFileIdentifiers.length > 0) {
    return { path: changedPath, owner: 'native', selectedIdentifiers: currentFileIdentifiers };
  }
  return {
    path: changedPath,
    owner: owners.projectLinesChanged ? 'archive' : 'test-infrastructure',
    selectedIdentifiers: [],
  };
}

for (const changedPath of selectionRelevantFiles) {
  currentFileIdentifiers = [];
  const owner = iosFileOwner(changedPath);
  if (owner === 'project') {
    changedFileCoverage.push(projectEditCoverage(changedPath));
    continue;
  }
  if (owner === 'archive') {
    changedFileCoverage.push({ path: changedPath, owner: 'archive', selectedIdentifiers: [] });
    continue;
  }
  if (owner === 'native-dependency') {
    changedFileCoverage.push({
      path: changedPath, owner: 'native', selectedIdentifiers: [],
      reason: `${changedPath}: the vendored package links into the app binary every native test launches`,
      escalation: 'linked-native-dependency',
    });
    continue;
  }
  if (owner === 'runtime-config') {
    const classes = changedPath === 'ios/example-ios/Info.plist'
      ? ['PortraitOrientationContractTests', 'LaunchScreenConfigurationTests']
      : ['LaunchScreenConfigurationTests'];
    const identifiers = classes.flatMap((className) =>
      identifiersForClassInPlan(plans.main, 'example-iosTests', className));
    addIdentifiers({ main: identifiers, evidence: [] });
    changedFileCoverage.push({
      path: changedPath, owner: 'native', selectedIdentifiers: currentFileIdentifiers,
      reason: `native configuration contract tests are absent from CI.xctestplan for ${changedPath}`,
    });
    continue;
  }
  if (owner === 'build-semantics' && budgetE2EPlanOnlyEnablesLaneTests(changedPath)) {
    changedFileCoverage.push({ path: changedPath, owner: 'external-e2e', selectedIdentifiers: [] });
    continue;
  }
  if (owner === 'build-semantics' && newlyRegisteredWellnessManualPlan(changedPath)) {
    changedFileCoverage.push({ path: changedPath, owner: 'external-e2e', selectedIdentifiers: [] });
    continue;
  }
  if (owner === 'build-semantics') {
    const enabledIdentifiers = changedPath.endsWith('.xctestplan')
      ? testPlanEnabledIdentifiers(changedPath)
      : null;
    if (enabledIdentifiers === null) {
      throw new Error(`Cannot narrow ${changedPath}: Xcode build/test-plan semantics need an explicit changed-target owner`);
    }
    addIdentifiers(enabledIdentifiers);
    changedFileCoverage.push({
      path: changedPath, owner: 'native', selectedIdentifiers: currentFileIdentifiers,
    });
    continue;
  }
  if (supportedTestRoots.some((root) => changedPath.startsWith(`${root}/`))
    && !changedPath.endsWith('.swift')) {
    const resourceName = path.basename(changedPath);
    const selected = testsUsingResource(resourceName, testRecords, plans);
    addIdentifiers(selected);
    changedFileCoverage.push({
      path: changedPath, owner: 'native', selectedIdentifiers: currentFileIdentifiers,
      reason: `no XCTest method in the current plans reads ${resourceName}`,
    });
    continue;
  }
  const selectedPinnedSourceIdentifiers = pinnedSourceTestRules
    .filter((rule) => changedPath.startsWith(rule.prefix))
    .map((rule) => rule.identifier);
  addIdentifiers({
    main: selectedPinnedSourceIdentifiers.filter((identifier) => identifierSelectedByPlan(plans.main, identifier)),
    evidence: selectedPinnedSourceIdentifiers.filter((identifier) => identifierSelectedByPlan(plans.evidence, identifier)),
  });
  if (isWellnessSource(changedPath)) {
    for (const identifier of wellnessRequiredIdentifiers) {
      if (!identifierSelectedByPlan(plans.main, identifier)) {
        throw new Error(`Required Wellness test is absent or skipped in CI: ${identifier}`);
      }
    }
    addIdentifiers({ main: wellnessRequiredIdentifiers, evidence: [] });
    if (!changedPath.startsWith('ios/')) {
      changedFileCoverage.push({
        path: changedPath, owner: 'native', selectedIdentifiers: currentFileIdentifiers,
      });
      continue;
    }
  }
  const targetName = targetNameForTestPath(changedPath);
  if (separatelyExecutedTestTargets.has(targetName)
    || (targetName && isSeparatelyExecutedPlanTestFile(changedPath, testRecords))) {
    changedFileCoverage.push({
      path: changedPath, owner: 'external-e2e', selectedIdentifiers: [],
    });
    continue;
  }

  if (targetName && deletedTestFileWasUnplanned(changedPath)) {
    changedFileCoverage.push({
      path: changedPath, owner: 'test-infrastructure', selectedIdentifiers: [],
    });
    continue;
  }

  if (targetName) {
    const { identifiersByLane, reason } = changedTestIdentifiers(changedPath, testRecords);
    addIdentifiers(identifiersByLane);
    changedFileCoverage.push({
      path: changedPath, owner: 'native', selectedIdentifiers: currentFileIdentifiers, reason,
    });
    if (reason) {
      fallbackReasons.push(reason);
    }
    continue;
  }

  if (changedPath.startsWith('ios/example-ios/Models/Generated/')
    && changedPath.endsWith('.generated.swift')) {
    const { identifiersByLane, reason, narrowing } = generatedSwiftTypeSelection(
      changedPath, testRecords, plans.main);
    addIdentifiers(identifiersByLane);
    changedFileCoverage.push({
      path: changedPath,
      owner: currentFileIdentifiers.length === 0 && !reason ? 'documentation' : 'native',
      selectedIdentifiers: currentFileIdentifiers,
      reason,
      ...(reason ? { escalation: 'unprovable-generated-model' as const } : {}),
    });
    if (reason) fallbackReasons.push(reason);
    if (narrowing) generatedNarrowings.push(narrowing);
    continue;
  }

  if (changedPath.startsWith('ios/example-ios/') && changedPath.endsWith('.swift')) {
    const { identifiersByLane, reason } = testsForSourceFile(changedPath, testRecords);
    addIdentifiers(identifiersByLane);
    changedFileCoverage.push({
      path: changedPath, owner: 'native', selectedIdentifiers: currentFileIdentifiers, reason,
    });
    if (reason && selectedPinnedSourceIdentifiers.length === 0) {
      fallbackReasons.push(reason);
    }
    continue;
  }

  const reason = currentFileIdentifiers.length === 0
    ? `no affected-test rule exists for ${changedPath}`
    : undefined;
  if (reason) fallbackReasons.push(reason);
  changedFileCoverage.push({
    path: changedPath, owner: 'native', selectedIdentifiers: currentFileIdentifiers, reason,
  });
}

const coverageDecision = decideChangedFileCoverage(changedFileCoverage);
if (coverageDecision.mode === 'full') {
  assertEvidenceRouted(selectedIdentifiersByLane);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    fs.appendFileSync(stepSummary,
      `iOS ${process.env.IOS_AFFECTED_TESTS_LANE || 'main'} selection escalated to the full native suite. `
      + `Reason: ${coverageDecision.reason}\n`);
  }
  finish({ mode: 'full', reason: coverageDecision.reason, changedFiles: executableRelevantFiles });
  process.exit(0);
}

for (const lane of lanes) {
  const identifiers = uniqueSorted(selectedIdentifiersByLane[lane]);
  const selected = new Set(identifiers);
  // Xcode executes a method twice when both its class and the method are
  // passed to -only-testing. Keep the broader selection and its full coverage.
  selectedIdentifiersByLane[lane] = identifiers.filter((identifier) => {
    // A pinned bare method and a native plan method name represent one test.
    if (!identifier.endsWith('()') && selected.has(`${identifier}()`)) return false;
    const segments = identifier.split('/');
    return !segments.slice(1).some((_, index) =>
      selected.has(segments.slice(0, index + 1).join('/'))
    );
  });
}
const identifiers = uniqueSorted(Object.values(selectedIdentifiersByLane).flat());
if (identifiers.length === 0) {
  if (changedFileCoverage.every((file) => file.owner === 'documentation')) {
    finish({ mode: 'skip', reason: 'generated Swift documentation only', changedFiles: executableRelevantFiles });
    process.exit(0);
  }
  const onlyExternalE2ETestsChanged = changedFileCoverage.every(
    (file) => file.owner === 'external-e2e'
  );
  if (onlyExternalE2ETestsChanged) {
    finish({
      mode: 'skip',
      reason: 'only separately executed real-server E2E tests changed',
      changedFiles: executableRelevantFiles,
    });
    process.exit(0);
  }
  if (changedFileCoverage.every((file) => file.owner === 'test-infrastructure')) {
    finish({
      mode: 'skip',
      reason: 'only test files that no CI test plan executed were deleted',
      changedFiles: executableRelevantFiles,
    });
    process.exit(0);
  }
  if (changedFileCoverage.every((file) =>
    file.owner === 'archive' || file.owner === 'external-e2e' || file.owner === 'test-infrastructure')) {
    finish({
      mode: 'affected',
      reason: 'archive-only iOS inputs have no XCTest owner',
      changedFiles: executableRelevantFiles,
    });
    process.exit(0);
  }
  throw new Error(`Cannot select iOS tests: ${fallbackReasons[0] || 'no affected tests could be selected'}`);
}

const evidenceGroups = evidenceGroupsForIdentifiers(selectedIdentifiersByLane.evidence);

const matchedReason =
  fallbackReasons.length > 0
    ? `matched changed tests; ${fallbackReasons.length} changed files have no direct test mapping`
    : evidenceGroups.length > 0
    ? 'matched changed iOS files to lane-owned CI test classes'
    : 'matched changed iOS files to main-lane CI test classes';

finish({
  mode: 'affected',
  reason: generatedNarrowings.length > 0
    ? `${matchedReason}; generated models narrowed to referencing and wire-contract tests: ${generatedNarrowings.join(' | ')}`
    : matchedReason,
  changedFiles: executableRelevantFiles,
  identifiersByLane: selectedIdentifiersByLane,
});

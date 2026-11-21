import {
  ciEventConcurrencyKey, ciEventField, expr, MERGE_GROUP_TRIGGER, typedRequiredPrWorkflow,
  VALIDATION_PULL_REQUEST_EVENTS,
} from '../lib/index.ts';
import { manualMacRunnerChoices } from '../../src/ios/iosRunnerCapabilities.ts';
import { syncObservabilityGithubToken } from './sync-observability-github-token.ts';
import { iosInitialControlRoute } from './initial-control-route.ts';
import { iosChangeGate } from './ios-change-gate.ts';
import { releaseFullRoutingPredecessor } from './release-full-routing-predecessor.ts';
import { awaitRetainedIosPredecessor } from './await-retained-ios-predecessor.ts';
import { cancelDeletedQueueCandidate } from './cancel-deleted-queue-candidate.ts';
import { confirmCurrentIosPr } from './confirm-current-ios-pr.ts';
import { verifyIosReleaseArchive } from './verify-ios-release-archive.ts';
import { buildIosNativeTestProducts } from './build-ios-native-test-products.ts';
import { testIosExecution } from './test-ios-execution.ts';
import { testIos } from './test-ios.ts';
import { storekitPurchaseStatus } from './storekit-purchase-status.ts';
import { buildIosE2eTestProducts } from './build-ios-e2e-test-products.ts';
import { prepareDevE2eSchema } from './prepare-dev-e2e-schema.ts';
import { onboardingE2e } from './onboarding-e2e.ts';
import { chatPlaidE2e } from './chat-plaid-e2e.ts';
import { incomeE2e } from './income-e2e.ts';
import { budgetE2e } from './budget-e2e.ts';
import { budgetE2eVideoProcessing } from './budget-e2e-video-processing.ts';
import { onboardingE2eStatus } from './onboarding-e2e-status.ts';
import { removeRunArtifactsAfterSuccess } from './remove-run-artifacts-after-success.ts';
import { iosValidationGroup } from '../lib/validationConcurrency.ts';

/**
 * Everything the iOS application must satisfy before it can merge.
 *
 * One gate plans the run and every Mac lane is selected from that plan, so a
 * change that touches no Swift pays for the plan alone while an iOS change
 * pays for the lanes it actually reaches. Mac capacity is the scarce
 * resource: it is physical, shared, and slower to replace than anything else
 * in CI, which is why the plan, the tuple confirmation and the retained
 * predecessor all run on Linux before a single Mac is allocated.
 *
 * The workflow is being migrated one job at a time; `jobs` below grows a job
 * per commit until it holds all nineteen the YAML declares.
 */

/**
 * The job ids whose rendered names the develop and main branch rulesets list
 * as required checks. `typedWorkflow` refuses an id no job declares, so
 * during the migration only the migrated ones can be named — the filter is
 * what carries the full list through, and it comes off with the last job
 * file.
 */
const REQUIRED_CONTEXTS = ['ios-change-gate', 'test-ios', 'storekit-purchase-status', 'onboarding-e2e-status'];

// Declaration order is the order the jobs appear in the generated YAML, which
// is the order the workflow declares them in today.
const jobs = [
  syncObservabilityGithubToken,
  iosInitialControlRoute,
  iosChangeGate,
  releaseFullRoutingPredecessor,
  awaitRetainedIosPredecessor,
  cancelDeletedQueueCandidate,
  confirmCurrentIosPr,
  verifyIosReleaseArchive,
  buildIosNativeTestProducts,
  testIosExecution,
  testIos,
  storekitPurchaseStatus,
  buildIosE2eTestProducts,
  prepareDevE2eSchema,
  onboardingE2e,
  chatPlaidE2e,
  incomeE2e,
  budgetE2e,
  budgetE2eVideoProcessing,
  onboardingE2eStatus,
  removeRunArtifactsAfterSuccess,
];

export const iosTests = typedRequiredPrWorkflow({
  path: '.github/workflows/ios-tests.yml',
  source: 'ci/workflows/ios-tests/index.ts',
  // The workflow name is an operational input: the trusted controller, the
  // cancellation controller and the base-update classifier all subscribe to
  // "Test - iOS" by string, so the readable name lives beside it rather than
  // replacing it.
  name: 'Test - iOS',
  runName: expr("github.event_name == 'workflow_dispatch' && inputs.test_scope == 'promotion-evidence' "
    + "&& format('promotion-evidence:{0}:{1}', github.sha, inputs.promotion_base_sha) || github.workflow"),
  displayName: 'Validate iOS changes',
  doc: { purpose: 'Decides whether an iOS change is fit to merge, one selected lane at a time.' },
  on: {
    pull_request: {
      branches: ['main', 'develop'],
      types: [...VALIDATION_PULL_REQUEST_EVENTS],
    },
    merge_group: MERGE_GROUP_TRIGGER,
    workflow_dispatch: {
      inputs: {
        test_scope: {
          description: 'iOS test scope',
          required: false,
          default: 'affected',
          type: 'choice',
          options: [
            'full',
            'promotion-evidence',
            'affected',
            'e2e',
            'evidence',
            'onboarding-copy-evidence',
            'mortgage-assignment-evidence',
            'financial-independence-evidence',
            'shared-cta-evidence',
            'debt-card-evidence',
            'development-e2e-schema',
            'observability-credential-sync',
          ],
        },
        mac_runner: {
          description: 'Mac pool for this manual run (reserved Mitchell Mac is opt-in)',
          required: false,
          default: 'shared',
          type: 'choice',
          options: [...manualMacRunnerChoices],
        },
        pull_request_number: {
          description: 'Open same-repository PR number for exact-head evidence scopes',
          required: false,
          type: 'string',
        },
        promotion_base_sha: {
          description: 'Exact main SHA for an integrated-develop promotion evidence run',
          required: false,
          type: 'string',
        },
      },
    },
  },
  permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read' },
  // One PR run at a time keeps a patch-equivalent new head pending until its
  // retained predecessor finishes. Keep every pending event: GitHub does not
  // guarantee arrival order, so a delayed stale event must not replace the
  // current head's run in the single pending slot.
  // The trusted synchronize controller cancels an obsolete running predecessor
  // when its evidence cannot be reused. Dispatches use their own run ids so
  // they cannot replace a PR's pending required checks, and each merge queue
  // candidate has a key of its own.
  concurrency: {
    group: iosValidationGroup(ciEventConcurrencyKey),
    cancelInProgress: false,
    queue: 'max',
  },
  env: {
    EXAMPLE_CI_EXACT_HEAD_SHA: ciEventField('headSha'),
    // On merge_group this is the queue base; it never falls back to the candidate.
    EXAMPLE_CI_TRUSTED_BASE_SHA: ciEventField('trustedBaseSha'),
    EXAMPLE_CI_TRUSTED_BASE_REF: ciEventField('baseBranch'),
    EXAMPLE_CI_PR_NUMBER: ciEventField('prNumber'),
  },
  requiredContexts: REQUIRED_CONTEXTS.filter((id) => jobs.some((job) => job.id === id)),
  jobs,
});

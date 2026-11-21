import { IOS_PLANNING_CONDITION, iosInitialControlRoute } from './initial-control-route.ts';
import {
  byEvent, ciEventCondition, ciEventField, ciEventFieldSource, ciEventFieldWith, expr, github,
  mergeGroupProgramRoot, pullRequestOnly, typedJob, typedStep,
} from '../lib/index.ts';
import {
  CHECKOUT, DOWNLOAD_ARTIFACT, UPLOAD_ARTIFACT, controlLane, installTypedCiDependencies,
  iosGateRunner, prMetadataToken, selectedMacLabels, setupNode, typedLayerCheckout,
} from './shared.ts';
import {
  COVERED_REPLAN_OUTPUTS, NATIVE_SELECTION_RECORD_ARTIFACT_PREFIX, type CoveredReplanOutput,
} from '../../src/ios/nativeSelectionRecord.ts';
import { REAL_SERVER_EVIDENCE_REUSED_OUTPUT } from '../../src/ios/queueEvidenceReuse.ts';
import { QUEUE_EVIDENCE_REUSE_ARTIFACT_PREFIX } from '../../src/ios/runArtifactCleanup.ts';

const coveredReplanOutputs = Object.keys(COVERED_REPLAN_OUTPUTS) as CoveredReplanOutput[];

/**
 * Plan the whole iOS run, before a single Mac is allocated.
 *
 * Every other job in this workflow is selected from this one's outputs, which
 * is why so much lives here: the precheck decides whether iOS coverage applies
 * to this event at all, the classifier decides whether the new head is a
 * verified increment on a run that already has evidence, the selector decides
 * which lanes the changed files reach, and the planner decides what the native
 * producer builds. All of it is Linux work, and all of it is cheap next to the
 * Mac lanes it is deciding whether to start.
 *
 * The precheck, base-update classifier, and native test selector run from the
 * gate-pinned verifier. The changed-file inventory, resolver, and planner read
 * the exact head under review. Every native Mac job uses the same verifier
 * selector against that head's test plans and sources.
 */

/** The head inventory checkout is skipped for a metadata-only event or deferred head. */
const SELECTOR_CHECKOUT = "steps.precheck.outputs.needs_checkout == 'true' "
  + "&& steps.base-update.outputs.deferred != 'true'";

/**
 * A queue candidate is planned by the queue base's detector and selector, read
 * from the verifier revision the precheck proved; the candidate is only data.
 * A pull request keeps running the detector from the head checkout.
 */
const QUEUE_DETECTOR = `${SELECTOR_CHECKOUT} && ${ciEventCondition('mergeGroup')}`;
const QUEUE_DETECTOR_ROOT = '.ci/trusted-ios-detector';
/** `.ci/trusted-ios-detector` on a queue candidate, the workspace otherwise. */
const PLANNING_PROGRAM_ROOT = mergeGroupProgramRoot(QUEUE_DETECTOR_ROOT);

/** Either program can answer; a manual dispatch never reaches the selector. */
const SHOULD_RUN = "steps.base-update.outputs.deferred != 'true' "
  + "&& (steps.precheck.outputs.production_promotion == 'true' "
  + "|| (steps.precheck.outputs.production_promotion != 'true' "
  + "&& (steps.detect.outputs.should_run || steps.precheck.outputs.should_run) == 'true'))";

/** The resolver's own checkout exists for exactly the case the selector's does not. */
const RESOLVER = `${SHOULD_RUN} && steps.precheck.outputs.needs_checkout != 'true'`;

/**
 * The native planner reads the exact head, so a fork's head is excluded, and
 * the two dispatch scopes that carry no native work skip it entirely. A pull
 * request and a queue candidate are both planned from their detected changes;
 * only a dispatch plans without them.
 */
const NATIVE = `(${SHOULD_RUN}) `
  + "&& (github.event_name == 'workflow_dispatch' || steps.detect.outputs.should_run == 'true' "
  + "|| steps.precheck.outputs.production_promotion == 'true') "
  + `&& ${ciEventCondition('sameRepositoryCode')} `
  + "&& !(github.event_name == 'workflow_dispatch' "
  + "&& (inputs.test_scope == 'e2e' || inputs.test_scope == 'debt-card-evidence'))";

const EXACT_HEAD = ciEventField('headSha');
const SELECTION_HEAD = expr("(steps.precheck.outputs.production_promotion == 'true' "
  + '&& steps.precheck.outputs.checkpoint_sha) '
  + "|| (steps.precheck.outputs.production_promotion != 'true' "
  + `&& ${ciEventFieldSource('headSha')})`);

const prMetadataTokenStep = prMetadataToken('Create fallback PR metadata token');

/**
 * The precheck decides whether this event's iOS coverage runs at all and
 * whether a main pull request is a genuine promotion checkpoint, so it runs
 * the trusted base's copy of the program. On the first promotion, main has no
 * typed CI layer, so this precheck runs from protected develop; after it
 * verifies the checkpoint ancestry and update chain, downstream jobs pin the
 * exact checkpoint SHA it emits. This checkout never executes PR-head code.
 */
const checkoutPrecheck = typedLayerCheckout({
  name: 'Checkout trusted iOS gate precheck',
  path: '.ci/trusted-ios-gate',
  sparseCheckout: 'ci\nscripts/ci/generated\n',
  // Main promotions run the develop precheck; every other event runs its
  // trusted base: the PR base, the queue base (never the candidate), or the
  // dispatched commit.
  ref: expr(
    `${ciEventCondition('pullRequestIntoMain')} && 'develop' `
    + `|| ${ciEventFieldSource('trustedBaseSha')}`,
  ),
});

const precheck = typedStep({
  id: 'precheck',
  name: 'Precheck iOS Gate',
  doc: {
    purpose: 'Decides whether this event needs iOS coverage and which pull request tuple it is for.',
    recovery: 'read the reason the step prints; it names the event field that excluded the run',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  outputs: [
    'should_run', 'needs_checkout', 'storekit_required', 'onboarding_required', 'chat_plaid_required',
    'budget_required', 'income_required', 'evidence_required', 'production_promotion', 'pr_number',
    'expected_head_sha', 'expected_base_sha', 'expected_base_ref', 'verifier_sha', 'checkpoint_sha',
  ] as const,
  env: {
    EVENT_NAME: github('event_name'),
    BASE_BRANCH: ciEventField('baseBranch'),
    BASE_SHA: ciEventFieldWith('trustedBaseSha', { workflow_dispatch: "''" }),
    HEAD_BRANCH: ciEventField('headBranch'),
    HEAD_SHA: ciEventFieldWith('headSha', { workflow_dispatch: "''" }),
    HEAD_REPOSITORY: ciEventField('headRepository'),
    REPOSITORY: github('repository'),
    GITHUB_API_URL: github('api_url'),
    GITHUB_TOKEN: github('token'),
    GITHUB_FALLBACK_TOKEN: prMetadataTokenStep.outputs.token,
    PR_NUMBER: ciEventFieldWith('prNumber', { workflow_dispatch: "inputs.pull_request_number || ''" }),
    TEST_SCOPE: expr("inputs.test_scope || ''"),
    PROMOTION_BASE_SHA: expr("inputs.promotion_base_sha || ''"),
    GITHUB_REF: github('ref'),
  },
  command: 'node .ci/trusted-ios-gate/ci/src/actions/ios/precheckIosGate.ts',
});

const CONTROL_ROUTE_SCRIPT = '.ci/trusted-ios-gate/ci/src/actions/selectControlRunners.ts';

/**
 * Routes this run's later control and verdict jobs: the external Linux fleet
 * unless it already has queued work, then admitted hosted overflow. It runs
 * for every event, including the server-only changes whose required iOS
 * verdicts would otherwise queue behind that backlog. A base without the
 * script, or a failed read, leaves the outputs empty and every job on its
 * static external route.
 */
const controlRoute = typedStep({
  id: 'control-route',
  name: 'Route iOS control jobs to free external Linux or hosted overflow',
  doc: {
    purpose: 'Chooses external Linux for later control and verdict jobs, or hosted Linux while external has a backlog.',
    recovery: 'read the route and reason it prints; an empty output keeps the external route',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(`hashFiles('${CONTROL_ROUTE_SCRIPT}') != ''`),
  continueOnError: true,
  outputs: ['control_runner_labels'] as const,
  env: {
    GITHUB_TOKEN: github('token'),
    GITHUB_API_URL: github('api_url'),
    SAME_REPOSITORY_CODE: expr(ciEventCondition('sameRepositoryCode')),
    REPOSITORY_DEFAULT_BRANCH: github('event.repository.default_branch'),
    CI_HOSTED_LINUX_AVAILABLE: expr("vars.CI_HOSTED_LINUX_AVAILABLE || '0'"),
  },
  command: `node ${CONTROL_ROUTE_SCRIPT}`,
});

/** The trusted precheck admits the checkpoint; the verifier runs from that pinned revision. */
const promotionProof = typedStep({
  id: 'promotion-proof',
  name: 'Verify exact-develop promotion evidence',
  doc: {
    purpose: 'Requires one completed exact-develop run with all selected native/StoreKit/Release work and real-server onboarding.',
    recovery: 'run the required coverage at the exact integrated develop checkpoint, then retry the promotion check',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr("steps.precheck.outputs.production_promotion == 'true'"),
  outputs: ['proven', 'run_id', 'run_attempt'] as const,
  env: {
    PROMOTION_CHECKPOINT_SHA: expr('steps.precheck.outputs.checkpoint_sha'),
    PROMOTION_BASE_SHA: expr('steps.precheck.outputs.expected_base_sha'),
    PROMOTION_NATIVE_LANES: expr("steps.classify.outputs.execution_lanes || '[]'"),
    PROMOTION_DETECT_OUTCOME: expr('steps.detect.outcome'),
    PROMOTION_NATIVE_CHANGED_FILES: expr("steps.detect.outputs.native_changed_files || ''"),
    PROMOTION_PLANNER_OUTCOME: expr('steps.classify.outcome'),
    PROMOTION_PRODUCER_REQUIRED: expr("steps.classify.outputs.producer_mode != 'skip' && steps.classify.outcome == 'success' && 'true' || 'false'"),
    PROMOTION_STOREKIT_REQUIRED: expr("steps.detect.outputs.storekit_required || 'false'"),
    PROMOTION_ARCHIVE_REQUIRED: expr("steps.classify.outputs.release_archive_required || 'false'"),
    REPOSITORY: github('repository'),
    GITHUB_API_URL: github('api_url'),
    GITHUB_TOKEN: github('token'),
    GITHUB_FALLBACK_TOKEN: prMetadataTokenStep.outputs.token,
  },
  command: 'node .ci/trusted-native-controls/ci/src/actions/ios/verifyPromotionEvidence.ts',
});

/**
 * The classifier is the only script executed from this checkout; it reads this
 * workflow at import time. A fresh checkout of the whole 350 MB tree cost a
 * minute per event, so only these two trees are materialised.
 */
const checkoutBaseUpdateClassifier = typedStep({
  name: 'Checkout trusted base-update classifier',
  doc: {
    purpose: 'Materialises the trusted base copy of the classifier that compares this head with the last.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(`${ciEventCondition('pullRequest')} && steps.precheck.outputs.production_promotion != 'true'`),
  uses: CHECKOUT,
  with: {
    ref: pullRequestOnly.baseSha,
    path: '.ci/trusted-base-update',
    'persist-credentials': false,
    'sparse-checkout': 'scripts\n.github/workflows\nci\n',
  },
});

const baseUpdate = typedStep({
  id: 'base-update',
  name: 'Detect verified incremental head delta',
  doc: {
    purpose: 'Asks the trusted classifier whether this head is a verified increment on one already tested.',
    recovery: 'read the classifier log the step prints; it names the base it compared against',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(`${ciEventCondition('pullRequest')} && steps.precheck.outputs.production_promotion != 'true'`),
  outputs: [
    'valid', 'superseded', 'deferred', 'deferred_base_sha', 'predecessor_run_id', 'predecessor_run_ids',
    'changed_files', 'reuse_native_evidence', 'rerun_ios_lanes', 'rerun_ios_auxiliary',
    'reuse_e2e_products', 'reused_e2e_run_id', 'reused_e2e_run_attempt',
    'reused_e2e_head_sha', 'reused_e2e_product_digest', 'reused_e2e_producer_job_id',
    'replan_selection', 'replan_evidence_run_id', 'replan_evidence_run_attempt',
    'replan_evidence_head_sha', 'replan_record_attempt', 'replan_record_detail',
    'replan_successful_jobs',
  ] as const,
  env: {
    CONTROLLER_BASE_UPDATE_WORKFLOWS: 'Test - iOS',
    BASE_SHA: pullRequestOnly.baseSha,
    GITHUB_TOKEN: github('token'),
    GITHUB_FALLBACK_TOKEN: prMetadataTokenStep.outputs.token,
    TRUSTED_CHECKOUT_PATH: '.ci/trusted-base-update',
  },
  // Never execute a classifier supplied by the PR. A missing trusted base copy
  // simply leaves the new head on full affected-file routing.
  command: 'node .ci/trusted-ios-gate/ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts',
});

/**
 * No blob filter: this job shares the control runner's persistent workspace
 * with every other trusted controller, and a filtered fetch registers origin
 * as a blob:none promisor remote there, which makes every later plain fetch in
 * that workspace blobless too (the PR secret scan then dies on lazy fetches it
 * has no credentials for).
 */
const checkoutSelector = typedStep({
  name: 'Checkout iOS change selector',
  doc: {
    purpose: 'Materialises the revision under review so the selector describes the code being tested.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(SELECTOR_CHECKOUT),
  uses: CHECKOUT,
  with: { 'fetch-depth': 1, 'persist-credentials': false, ref: SELECTION_HEAD },
});

const lintEnabledStateReads = typedStep({
  name: 'Lint throwable iOS enabled-state reads',
  doc: {
    purpose: 'Rejects a UI test that reads an element enabled state in a way that throws on a stale handle.',
    recovery: 'read the file and line the linter names and use the non-throwing accessor it suggests',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(SELECTOR_CHECKOUT),
  // The linter reads the workspace (cwd) as data; on a queue candidate the
  // program itself comes from the queue base.
  env: { IOS_PLANNING_PROGRAM_ROOT: PLANNING_PROGRAM_ROOT },
  command: 'node "$IOS_PLANNING_PROGRAM_ROOT/ci/src/actions/ios/lintIosUiTestElementState.ts"',
});

const detect = typedStep({
  id: 'detect',
  // A deferred head owns no checks until its patch-equivalent predecessor
  // completes, and skips the selector checkout this program runs from.
  name: 'Detect iOS Changes',
  doc: {
    purpose: 'Turns the changed files into the lane flags every Mac job in this workflow is selected from.',
    recovery: 'read the notices it prints; they name the file that forced each lane on',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(SELECTOR_CHECKOUT),
  shell: 'bash',
  outputs: [
    'should_run', 'main_required', 'storekit_required', 'onboarding_required', 'chat_plaid_required',
    'budget_required', 'income_required', 'evidence_required',
    'native_changed_files', 'native_changed_files_explicit_empty', 'candidate_gone',
  ] as const,
  env: {
    EVENT_NAME: github('event_name'),
    GITHUB_TOKEN: github('token'),
    GITHUB_FALLBACK_TOKEN: prMetadataTokenStep.outputs.token,
    PR_NUMBER: ciEventFieldWith('prNumber', { workflow_dispatch: "inputs.pull_request_number || ''" }),
    MERGE_GROUP_REF: ciEventField('mergeGroupRef'),
    // A queue candidate is planned by the queue base's detector and selector;
    // a pull request keeps running the head's, as it always has.
    IOS_CHANGE_DETECTOR_ROOT: PLANNING_PROGRAM_ROOT,
    REPOSITORY: github('repository'),
    IOS_AFFECTED_TESTS_BASE: expr("steps.precheck.outputs.expected_base_sha || ''"),
    IOS_AFFECTED_TESTS_HEAD: SELECTION_HEAD,
    TEST_SCOPE: expr("steps.precheck.outputs.production_promotion == 'true' && 'promotion-evidence' || inputs.test_scope || ''"),
    GITHUB_API_URL: github('api_url'),
    CONTROLLER_BASE_UPDATE_VALID: expr("steps.base-update.outputs.valid || 'false'"),
    CONTROLLER_BASE_UPDATE_SUPERSEDED: expr("steps.base-update.outputs.superseded || 'false'"),
    CONTROLLER_BASE_UPDATE_DEFERRED: expr("steps.base-update.outputs.deferred || 'false'"),
    CONTROLLER_BASE_UPDATE_REUSE_NATIVE_EVIDENCE:
      expr("steps.base-update.outputs.reuse_native_evidence || 'false'"),
    CONTROLLER_BASE_UPDATE_FILES: expr("steps.base-update.outputs.changed_files || ''"),
    FORCED_IOS_AUXILIARY: expr("steps.base-update.outputs.rerun_ios_auxiliary || '[]'"),
    FORCED_IOS_LANES: expr("steps.base-update.outputs.rerun_ios_lanes || '[]'"),
  },
  command: 'node "$IOS_CHANGE_DETECTOR_ROOT/ci/src/actions/ios/detectIosChanges.ts"',
});

// The root checkout above replaced the workspace, so the trusted detector
// lands beside it afterwards rather than before.
const checkoutQueueDetector = typedLayerCheckout({
  name: 'Checkout trusted queue candidate detector',
  path: QUEUE_DETECTOR_ROOT,
  ref: expr('steps.precheck.outputs.verifier_sha'),
  if: expr(QUEUE_DETECTOR),
  sparseCheckout: '.github/workflows\nci\nscripts\n',
});

/**
 * A manual dispatch resolves runner labels without ever reaching the selector
 * checkout above, so the resolver's own checkout, runtime and dependencies are
 * materialised here for exactly that case.
 */
const checkoutRunnerResolver = typedStep({
  name: 'Checkout typed iOS runner resolver',
  doc: {
    purpose: 'Materialises the revision the runner resolver runs from when the selector checkout is skipped.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(RESOLVER),
  uses: CHECKOUT,
  with: { 'fetch-depth': 1, 'persist-credentials': false, ref: EXACT_HEAD },
});

const pick = typedStep({
  id: 'pick',
  name: 'Resolve iOS macOS runner labels',
  doc: {
    purpose: 'Publishes the free-space thresholds every Mac lane admits a worker against.',
    recovery: 'read the label set the step prints; a pool with no capability line is the failure',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  if: expr(`${SHOULD_RUN} && steps.precheck.outputs.production_promotion != 'true'`),
  shell: 'bash',
  outputs: [
    'ios_macos_minimum_free_kb', 'ios_macos_minimum_execution_free_kb',
    'ios_evidence_macos_minimum_free_kb', 'ios_evidence_macos_minimum_execution_free_kb',
  ] as const,
  env: {
    IOS_MACOS_RUNNER_LABELS: selectedMacLabels,
    IOS_EVIDENCE_MACOS_RUNNER_LABELS: selectedMacLabels,
    IOS_ONBOARDING_MACOS_RUNNER_LABELS: selectedMacLabels,
    IOS_CHAT_PLAID_MACOS_RUNNER_LABELS: selectedMacLabels,
    IOS_BUDGET_MACOS_RUNNER_LABELS: selectedMacLabels,
    EVENT_NAME: github('event_name'),
    HEAD_REPOSITORY: ciEventField('headRepository'),
    TEST_SCOPE: expr("inputs.test_scope || ''"),
    MAC_RUNNER: expr("inputs.mac_runner || 'shared'"),
  },
  command: 'node ci/src/actions/ios/resolveIosRunnerLabels.ts',
});

const checkoutExactNativeRevision = typedStep({
  name: 'Checkout exact native test revision',
  doc: {
    purpose: 'Materialises the head the native planner selects tests from, with history for the base diff.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  // The promotion source is already the selector checkout. Re-checking out at
  // the root would clean the trusted precheck tree needed by the proof step.
  if: expr(`${NATIVE} && github.event_name == 'workflow_dispatch' && steps.precheck.outputs.needs_checkout != 'true'`),
  uses: CHECKOUT,
  // PR selection reuses the exact checkout and proven merge base above.
  // Dispatch has no PR base and needs its own checkout.
  with: { 'fetch-depth': 64, 'persist-credentials': false, ref: SELECTION_HEAD },
});

/**
 * The trusted classifier found a base update that changed only selection or
 * controller code, and this gate has just re-planned the unchanged patch.
 */
const REPLAN = "steps.base-update.outputs.replan_selection == 'true' "
  + "&& steps.detect.outcome == 'success'";

const checkoutTrustedNativeControls = typedLayerCheckout({
  name: 'Checkout trusted native selection controls',
  path: '.ci/trusted-native-controls',
  ref: expr("steps.precheck.outputs.verifier_sha || env.EXAMPLE_CI_TRUSTED_BASE_SHA"),
  if: expr(`(${NATIVE}) || (${REPLAN})`),
  sparseCheckout: 'ci\nscripts\n',
});

const SELECTION_RECORD_ROOT = '.ci/trusted-native-controls/ci/src/actions/ios';
/** An older verifier revision has no record programs; its gate records nothing. */
const RECORD_PROGRAMS = `hashFiles('${SELECTION_RECORD_ROOT}/writeNativeSelectionRecord.ts') != '' `
  + `&& hashFiles('${SELECTION_RECORD_ROOT}/checkReplannedSelection.ts') != ''`;
/** Only a pull request's later base update can compare against a record. */
const RECORD = `${ciEventCondition('pullRequest')} && steps.classify.outcome == 'success' `
  + `&& ${RECORD_PROGRAMS}`;
const CHECK_REPLAN = `${REPLAN} && ${RECORD_PROGRAMS}`;
const SELECTION_RECORD_DIRECTORY = '${{ runner.temp }}/ios-native-selection-record';
const REPLAN_RECORD_DIRECTORY = '${{ runner.temp }}/ios-replan-prior-record';

/**
 * An evidence dispatch names the one file its scope is about; every other
 * event uses the selector's native inventory, and an explicitly empty
 * inventory stays empty rather than falling back to everything.
 */
const EVIDENCE_CHANGED_FILES = "github.event_name == 'workflow_dispatch' "
  + "&& inputs.test_scope == 'evidence' "
  + "&& 'ios/example-iosUITests/CardAccountUpdateReturnCashSavingsUITests.swift' "
  + "|| github.event_name == 'workflow_dispatch' "
  + "&& inputs.test_scope == 'onboarding-copy-evidence' "
  + "&& 'ios/example-iosUITests/OnboardingCopyAccessibilityEvidenceUITests.swift' "
  + "|| github.event_name == 'workflow_dispatch' "
  + "&& inputs.test_scope == 'shared-cta-evidence' "
  + "&& 'ios/example-iosUITests/CardEditFirstTapEvidenceUITests.swift' "
  + "|| github.event_name == 'workflow_dispatch' "
  + "&& inputs.test_scope == 'mortgage-assignment-evidence' "
  + "&& 'ios/example-iosTests/MortgageAssignmentDraftModelTests.swift' "
  + "|| github.event_name == 'workflow_dispatch' "
  + "&& inputs.test_scope == 'financial-independence-evidence' "
  + "&& 'ios/example-iosTests/FinancialIndependenceEvidenceTests.swift' "
  + "|| (steps.detect.outputs.native_changed_files || '') || ''";

/** An evidence scope is an affected-file selection over the one file it names. */
const EVIDENCE_MODE = "github.event_name == 'workflow_dispatch' "
  + "&& (inputs.test_scope == 'promotion-evidence' || inputs.test_scope == 'evidence' "
  + "|| inputs.test_scope == 'onboarding-copy-evidence' "
  + "|| inputs.test_scope == 'shared-cta-evidence' "
  + "|| inputs.test_scope == 'mortgage-assignment-evidence' "
  + "|| inputs.test_scope == 'financial-independence-evidence') "
  + "&& 'affected' "
  + "|| (steps.precheck.outputs.production_promotion == 'true' && 'affected') "
  + "|| (github.event_name == 'workflow_dispatch' && inputs.test_scope || 'affected')";

/** The selector inputs every native lane shares; only the lane differs. */
const selectorEnvironment = (lane: 'main' | 'evidence') => ({
  IOS_AFFECTED_TESTS_BASE: expr("steps.precheck.outputs.expected_base_sha || ''"),
  IOS_AFFECTED_TESTS_CHANGED_FILES: expr(EVIDENCE_CHANGED_FILES),
  IOS_AFFECTED_TESTS_CHANGED_FILES_EXPLICIT_EMPTY:
    expr("(github.event_name == 'workflow_dispatch' && inputs.test_scope == 'promotion-evidence' "
      + "|| steps.precheck.outputs.production_promotion == 'true') "
      + "&& steps.detect.outputs.native_changed_files == '' && 'true' "
      + "|| (steps.detect.outputs.native_changed_files_explicit_empty || 'false')"),
  IOS_AFFECTED_TESTS_HEAD: SELECTION_HEAD,
  IOS_AFFECTED_TESTS_LANE: lane,
  IOS_AFFECTED_TESTS_MODE: expr(EVIDENCE_MODE),
  IOS_AFFECTED_TESTS_STOREKIT_REQUIRED: expr(
    "(steps.detect.outputs.storekit_required || steps.precheck.outputs.storekit_required || 'false')",
  ),
  IOS_AFFECTED_TESTS_WORKSPACE: github('workspace'),
});

const selection = typedStep({
  id: 'selection',
  name: 'Select native iOS tests',
  doc: {
    purpose: 'Chooses the native test identifiers the changed Swift reaches, or the whole suite.',
    recovery: 'read the selection the step prints; an unexpected mode is a changed-file inventory problem',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(NATIVE),
  outputs: [
    'mode', 'should_run', 'release_archive_required', 'only_testing_file', 'evidence_groups',
    'narrow_paywall_required', 'wellness_required', 'wellness_only_testing_file',
  ] as const,
  env: selectorEnvironment('main'),
  command: 'node .ci/trusted-native-controls/scripts/select-ios-affected-tests.ts',
});

const classify = typedStep({
  id: 'classify',
  name: 'Classify selected UI work',
  doc: {
    purpose: 'Turns the selection into the producer mode and execution lanes the native jobs are keyed on.',
    recovery: 'read the classification the step prints; it names the selection input that produced it',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(NATIVE),
  outputs: [
    'producer_mode', 'ui_required', 'execution_required', 'execution_lanes', 'full_execution_lanes',
    'release_archive_required', 'handoff_required', 'ui_method_owners',
  ] as const,
  // The planner reads GitHub action-style INPUT_* names. On a queue candidate
  // it is the queue base's copy, so these names stay the contract until no
  // base without `ui_method_owners` can plan a candidate; such a base leaves
  // the output empty, which the Mac lanes refuse when they need it.
  env: {
    'INPUT_SELECTION-MODE': expr('steps.selection.outputs.mode'),
    'INPUT_SELECTION-REQUIRED': expr(
      "steps.selection.outputs.should_run || (steps.selection.outputs.mode != 'skip' && 'true' || 'false')",
    ),
    'INPUT_RELEASE-ARCHIVE-REQUIRED': expr('steps.selection.outputs.release_archive_required'),
    'INPUT_ONLY-TESTING-FILE': expr('steps.selection.outputs.only_testing_file'),
    'INPUT_EVIDENCE-GROUPS': expr('steps.selection.outputs.evidence_groups'),
    'INPUT_NARROW-PAYWALL-REQUIRED': expr('steps.selection.outputs.narrow_paywall_required'),
    'INPUT_FORCED-LANES': expr("(steps.base-update.outputs.rerun_ios_lanes || '[]')"),
    // A pull request into develop leaves the full UI suite and the Release
    // archive to its queue candidate; every other event plans them in full.
    IOS_NATIVE_EVENT_NAME: github('event_name'),
    IOS_NATIVE_BASE_BRANCH: ciEventField('baseBranch'),
    // On a queue candidate the planner comes from the queue base checkout.
    IOS_PLANNING_PROGRAM_ROOT: PLANNING_PROGRAM_ROOT,
  },
  command: 'node "$IOS_PLANNING_PROGRAM_ROOT/ci/src/actions/planIosNative.ts"',
});

/** The selection this gate computed, before a covered re-plan replaces any output. */
const selectionEnvironment = {
  SELECTION_STOREKIT_REQUIRED: expr(
    "steps.detect.outputs.storekit_required || steps.precheck.outputs.storekit_required || 'false'",
  ),
  SELECTION_MAIN_REQUIRED: expr("steps.detect.outputs.main_required || 'false'"),
  SELECTION_ONBOARDING_REQUIRED: expr(
    "steps.detect.outputs.onboarding_required || steps.precheck.outputs.onboarding_required || 'false'",
  ),
  SELECTION_CHAT_PLAID_REQUIRED: expr(
    "steps.detect.outputs.chat_plaid_required || steps.precheck.outputs.chat_plaid_required || 'false'",
  ),
  SELECTION_BUDGET_REQUIRED: expr(
    "steps.detect.outputs.budget_required || steps.precheck.outputs.budget_required || 'false'",
  ),
  SELECTION_INCOME_REQUIRED: expr(
    "steps.detect.outputs.income_required || steps.precheck.outputs.income_required || 'false'",
  ),
  SELECTION_EVIDENCE_REQUIRED: expr(
    "steps.detect.outputs.evidence_required || steps.precheck.outputs.evidence_required || 'false'",
  ),
  NATIVE_PLANNED: expr("steps.classify.outcome == 'success' && 'true' || 'false'"),
  NATIVE_MODE: expr("steps.selection.outputs.mode || 'skip'"),
  NATIVE_SHOULD_RUN: expr("steps.selection.outputs.should_run || 'false'"),
  NATIVE_RELEASE_ARCHIVE_REQUIRED: expr("steps.classify.outputs.release_archive_required || 'false'"),
  NATIVE_NARROW_PAYWALL_REQUIRED: expr("steps.selection.outputs.narrow_paywall_required || 'false'"),
  NATIVE_EVIDENCE_GROUPS: expr("steps.selection.outputs.evidence_groups || ''"),
  NATIVE_ONLY_TESTING_FILE: expr("steps.selection.outputs.only_testing_file || ''"),
  NATIVE_EVIDENCE_ONLY_TESTING_FILE: expr("steps.evidence-selection.outputs.only_testing_file || ''"),
  NATIVE_WELLNESS_REQUIRED: expr("steps.selection.outputs.wellness_required || 'false'"),
  NATIVE_WELLNESS_ONLY_TESTING_FILE: expr("steps.selection.outputs.wellness_only_testing_file || ''"),
  NATIVE_PRODUCER_MODE: expr("steps.classify.outputs.producer_mode || 'skip'"),
  NATIVE_EXECUTION_LANES: expr("steps.classify.outputs.execution_lanes || '[]'"),
  NATIVE_FULL_EXECUTION_LANES: expr("steps.classify.outputs.full_execution_lanes || '[]'"),
  NATIVE_EXECUTION_REQUIRED: expr("steps.classify.outputs.execution_required || 'false'"),
  NATIVE_UI_REQUIRED: expr("steps.classify.outputs.ui_required || 'false'"),
  NATIVE_HANDOFF_REQUIRED: expr("steps.classify.outputs.handoff_required || 'false'"),
};

/**
 * A queue candidate may carry its pull request's Mac evidence. Both programs
 * run from the queue base's trusted detector, never from the candidate; a
 * base that predates them plans no reuse and every selected lane executes.
 */
const QUEUE_REUSE_ROOT = `${QUEUE_DETECTOR_ROOT}/ci/src/actions/ios`;
const QUEUE_REUSE = `${QUEUE_DETECTOR} && steps.classify.outcome == 'success' `
  + `&& hashFiles('${QUEUE_REUSE_ROOT}/findQueuedPullRequestEvidence.ts') != '' `
  + `&& hashFiles('${QUEUE_REUSE_ROOT}/planQueueEvidenceReuse.ts') != ''`;
const QUEUE_SOURCE_RECORD_DIRECTORY = '${{ runner.temp }}/ios-queue-source-selection-record';
const QUEUE_REUSE_RECORD_DIRECTORY = '${{ runner.temp }}/ios-queue-evidence-reuse';

/**
 * The evidence Mac lane reruns the selector for its own lane, so the record
 * captures that lane's identifiers too. Only a recorded or re-planned pull
 * request needs them; the lane jobs still select for themselves.
 */
const evidenceSelection = typedStep({
  id: 'evidence-selection',
  name: 'Select evidence-lane iOS tests for the selection record',
  doc: {
    purpose: 'Computes the identifiers an evidence Mac lane would run, for the selection record and re-plan.',
    recovery: 'read the selection the step prints; it fails where the main-lane selection would',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(`steps.classify.outcome == 'success' && ((${RECORD}) || (${CHECK_REPLAN}) || (${QUEUE_REUSE}))`),
  outputs: ['only_testing_file'] as const,
  env: selectorEnvironment('evidence'),
  command: 'node .ci/trusted-native-controls/scripts/select-ios-affected-tests.ts',
});

const installRecordDependencies = installTypedCiDependencies(
  'Install trusted native control dependencies',
  '.ci/trusted-native-controls/ci', {
    if: expr(`steps.precheck.outputs.production_promotion == 'true' || (${RECORD}) || (${CHECK_REPLAN})`),
  },
);

const downloadPriorRecord = typedStep({
  id: 'prior-selection-record',
  name: 'Download the retained run selection record',
  doc: {
    purpose: 'Fetches the selection the retained run recorded, for the re-planned selection to be compared with.',
    recovery: 'a missing record is not an error: the re-planned selection then runs in full',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  // A carried-forward gate wrote its record in an earlier attempt; the
  // classifier names that attempt, or nothing when it cannot prove one.
  if: expr(`${CHECK_REPLAN} && steps.base-update.outputs.replan_record_attempt != ''`),
  continueOnError: true,
  uses: DOWNLOAD_ARTIFACT,
  with: {
    name: expr(`format('${NATIVE_SELECTION_RECORD_ARTIFACT_PREFIX}{0}', `
      + 'steps.base-update.outputs.replan_record_attempt)'),
    'run-id': expr('steps.base-update.outputs.replan_evidence_run_id'),
    'github-token': github('token'),
    path: REPLAN_RECORD_DIRECTORY,
  },
});

const replan = typedStep({
  id: 'replan',
  name: 'Compare the re-planned selection with the retained run',
  doc: {
    purpose: 'Keeps the retained run\'s evidence only when it covers every lane and test the re-planned selection needs.',
    recovery: 'read the reason it prints: replan-expanded names the first uncovered lane or test',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(CHECK_REPLAN),
  outputs: ['covered', 'reason', ...coveredReplanOutputs] as const,
  env: {
    ...selectionEnvironment,
    RECORD_DIRECTORY: REPLAN_RECORD_DIRECTORY,
    EXPECTED_RUN_ID: expr('steps.base-update.outputs.replan_evidence_run_id'),
    RECORD_ATTEMPT: expr("steps.base-update.outputs.replan_record_attempt || ''"),
    RECORD_DETAIL: expr("steps.base-update.outputs.replan_record_detail || ''"),
    SUCCESS_ATTEMPT: expr('steps.base-update.outputs.replan_evidence_run_attempt'),
    SUCCESSFUL_JOBS: expr("steps.base-update.outputs.replan_successful_jobs || '[]'"),
    EXPECTED_HEAD_SHA: expr('steps.base-update.outputs.replan_evidence_head_sha'),
  },
  command: `node ${SELECTION_RECORD_ROOT}/checkReplannedSelection.ts`,
});

const findQueuedEvidence = typedStep({
  id: 'queue-evidence-source',
  name: 'Find the queued pull request Mac evidence',
  doc: {
    purpose: 'Names the newest completed Test - iOS run on the queued pull request head and the attempt that recorded its selection.',
    recovery: 'read the queue evidence source line; a refusal only means the candidate runs its selected lanes',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(QUEUE_REUSE),
  outputs: [
    'status', 'detail', 'pr_number', 'pr_head_sha', 'run_id', 'run_attempt', 'record_attempt',
    'successful_jobs',
  ] as const,
  env: {
    GITHUB_API_URL: github('api_url'),
    REPOSITORY: github('repository'),
    GITHUB_TOKEN: github('token'),
    GITHUB_FALLBACK_TOKEN: prMetadataTokenStep.outputs.token,
  },
  command: `node ${QUEUE_REUSE_ROOT}/findQueuedPullRequestEvidence.ts`,
});

const downloadQueuedSelectionRecord = typedStep({
  id: 'queue-source-selection-record',
  name: 'Download the queued pull request selection record',
  doc: {
    purpose: 'Fetches the selection the pull request run recorded, for the candidate selection to be compared with.',
    recovery: 'none needed; a missing record makes every selected lane execute on the candidate',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(`${QUEUE_REUSE} && steps.queue-evidence-source.outputs.status == 'found'`),
  continueOnError: true,
  uses: DOWNLOAD_ARTIFACT,
  with: {
    name: expr(`format('${NATIVE_SELECTION_RECORD_ARTIFACT_PREFIX}{0}', `
      + 'steps.queue-evidence-source.outputs.record_attempt)'),
    'run-id': expr('steps.queue-evidence-source.outputs.run_id'),
    'github-token': github('token'),
    path: QUEUE_SOURCE_RECORD_DIRECTORY,
  },
});

const queueReuse = typedStep({
  id: 'queue-reuse',
  name: 'Decide which Mac lanes the queue candidate reuses',
  doc: {
    purpose: 'Reuses a pull request lane only when its whole input closure is tree-identical in the candidate and its evidence covers the candidate selection.',
    recovery: 'read the reused/executed line per lane; an executed lane runs on the candidate as it would without reuse',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(QUEUE_REUSE),
  outputs: ['record', REAL_SERVER_EVIDENCE_REUSED_OUTPUT, ...coveredReplanOutputs] as const,
  env: {
    ...selectionEnvironment,
    GITHUB_API_URL: github('api_url'),
    REPOSITORY: github('repository'),
    GITHUB_TOKEN: github('token'),
    GITHUB_FALLBACK_TOKEN: prMetadataTokenStep.outputs.token,
    SOURCE_STATUS: expr("steps.queue-evidence-source.outputs.status || ''"),
    SOURCE_DETAIL: expr("steps.queue-evidence-source.outputs.detail || ''"),
    PR_NUMBER: expr("steps.queue-evidence-source.outputs.pr_number || ''"),
    PR_HEAD_SHA: expr("steps.queue-evidence-source.outputs.pr_head_sha || ''"),
    SOURCE_RUN_ID: expr("steps.queue-evidence-source.outputs.run_id || ''"),
    SOURCE_RUN_ATTEMPT: expr("steps.queue-evidence-source.outputs.run_attempt || ''"),
    RECORD_ATTEMPT: expr("steps.queue-evidence-source.outputs.record_attempt || ''"),
    SUCCESSFUL_JOBS: expr("steps.queue-evidence-source.outputs.successful_jobs || '[]'"),
    RECORD_DIRECTORY: QUEUE_SOURCE_RECORD_DIRECTORY,
    OUTPUT_DIRECTORY: QUEUE_REUSE_RECORD_DIRECTORY,
    BUDGET_E2E_ENABLED: expr("vars.IOS_ENABLE_BUDGET_E2E == 'true' && 'true' || 'false'"),
  },
  command: `node ${QUEUE_REUSE_ROOT}/planQueueEvidenceReuse.ts`,
});

const uploadQueueReuseRecord = typedStep({
  name: 'Upload the queue evidence reuse record',
  doc: {
    purpose: 'Keeps the per-lane reused/executed record beside the candidate run for audit.',
    recovery: 'retry; a repeated failure is a GitHub artifact service problem',
  },
  owner: 'automation',
  category: 'artifact',
  unit: 'step',
  if: expr("steps.queue-reuse.outcome == 'success'"),
  uses: UPLOAD_ARTIFACT,
  with: {
    name: expr(`format('${QUEUE_EVIDENCE_REUSE_ARTIFACT_PREFIX}{0}', github.run_attempt)`),
    path: QUEUE_REUSE_RECORD_DIRECTORY,
    'retention-days': 30,
    'if-no-files-found': 'error',
  },
});

const writeSelectionRecord = typedStep({
  name: 'Record the native iOS selection',
  doc: {
    purpose: 'Writes what this gate selected so a later base update can compare a re-planned selection with it.',
    recovery: 'read the schema error it prints; it names the selection output that did not parse',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(RECORD),
  env: {
    ...selectionEnvironment,
    RUN_ID: github('run_id'),
    RUN_ATTEMPT: github('run_attempt'),
    // The precheck's pull request head, which the classifier matches runs by.
    HEAD_SHA: expr('steps.precheck.outputs.expected_head_sha'),
    VERIFIER_SHA: expr("steps.precheck.outputs.verifier_sha || env.EXAMPLE_CI_TRUSTED_BASE_SHA"),
    NATIVE_CHANGED_FILES: expr("steps.detect.outputs.native_changed_files || ''"),
    REPLAN_COVERED: expr("steps.replan.outputs.covered || 'false'"),
    REPLAN_EVIDENCE_RUN_ID: expr("steps.base-update.outputs.replan_evidence_run_id || ''"),
    REPLAN_EVIDENCE_RUN_ATTEMPT: expr("steps.base-update.outputs.replan_evidence_run_attempt || ''"),
    OUTPUT_DIRECTORY: SELECTION_RECORD_DIRECTORY,
  },
  command: `node ${SELECTION_RECORD_ROOT}/writeNativeSelectionRecord.ts`,
});

const uploadSelectionRecord = typedStep({
  name: 'Upload the native iOS selection record',
  doc: {
    purpose: 'Keeps this run\'s selection record beside its evidence for a later base update to read.',
    recovery: 'retry; a repeated failure is a GitHub artifact service problem',
  },
  owner: 'automation',
  category: 'artifact',
  unit: 'step',
  if: expr(RECORD),
  uses: UPLOAD_ARTIFACT,
  with: {
    name: expr(`format('${NATIVE_SELECTION_RECORD_ARTIFACT_PREFIX}{0}', github.run_attempt)`),
    path: SELECTION_RECORD_DIRECTORY,
    'retention-days': 30,
    'if-no-files-found': 'error',
  },
});

/**
 * A covered re-plan (pull request) or a reused queue lane (merge queue
 * candidate) replaces these outputs; any other run keeps the gate's own
 * values. The two steps never run on the same event.
 */
const replanned = (name: CoveredReplanOutput, fallback: string) =>
  expr(`steps.queue-reuse.outputs.${name} || steps.replan.outputs.${name} || ${fallback}`);

export const iosGateOutputs = {
  // A deferred head runs no detection (its selector checkout is skipped), so
  // the gate states the answer the skipped step used to write.
  should_run: replanned('should_run',
    "(steps.precheck.outputs.production_promotion == 'true' && 'false' "
    + "|| github.event_name == 'workflow_dispatch' && inputs.test_scope == 'promotion-evidence' && 'true' "
    + "|| steps.base-update.outputs.deferred == 'true' && 'false' "
    + '|| steps.detect.outputs.should_run || steps.precheck.outputs.should_run)',
  ),
  main_required: replanned('main_required', "steps.detect.outputs.main_required || 'false'"),
  storekit_required: replanned('storekit_required',
    "steps.detect.outputs.storekit_required || steps.precheck.outputs.storekit_required || 'unknown'",
  ),
  onboarding_required: replanned('onboarding_required',
    "(steps.precheck.outputs.production_promotion == 'true' && 'true' "
    + "|| github.event_name == 'workflow_dispatch' && inputs.test_scope == 'promotion-evidence' && 'true' "
    + "|| steps.detect.outputs.onboarding_required || steps.precheck.outputs.onboarding_required || 'false')",
  ),
  chat_plaid_required: replanned('chat_plaid_required',
    "steps.detect.outputs.chat_plaid_required || steps.precheck.outputs.chat_plaid_required || 'false'",
  ),
  budget_required: replanned('budget_required',
    "steps.detect.outputs.budget_required || steps.precheck.outputs.budget_required || 'false'",
  ),
  income_required: replanned('income_required',
    "steps.detect.outputs.income_required || steps.precheck.outputs.income_required || 'false'",
  ),
  evidence_required: replanned('evidence_required',
    "steps.detect.outputs.evidence_required || steps.precheck.outputs.evidence_required || 'false'",
  ),
  native_changed_files: expr("steps.detect.outputs.native_changed_files || ''"),
  native_changed_files_explicit_empty: replanned('native_changed_files_explicit_empty',
    "steps.detect.outputs.native_changed_files_explicit_empty || 'false'"),
  rerun_ios_lanes: expr("steps.base-update.outputs.rerun_ios_lanes || '[]'"),
  base_update_valid: expr("steps.base-update.outputs.valid || 'false'"),
  base_update_superseded: expr("steps.base-update.outputs.superseded || 'false'"),
  // The detector proved the merge queue deleted this candidate; a separate
  // trusted job cancels the run (cancel-deleted-queue-candidate.ts).
  merge_queue_candidate_gone: expr("steps.detect.outputs.candidate_gone || 'false'"),
  base_update_deferred: expr("steps.base-update.outputs.deferred || 'false'"),
  base_update_predecessor_run_id: expr("steps.base-update.outputs.predecessor_run_id || ''"),
  base_update_predecessor_run_ids: expr("steps.base-update.outputs.predecessor_run_ids || ''"),
  base_update_deferred_base_sha: expr("steps.base-update.outputs.deferred_base_sha || ''"),
  reuse_e2e_products: expr("steps.base-update.outputs.reuse_e2e_products || 'false'"),
  reused_e2e_run_id: expr("steps.base-update.outputs.reused_e2e_run_id || ''"),
  reused_e2e_run_attempt: expr("steps.base-update.outputs.reused_e2e_run_attempt || ''"),
  reused_e2e_head_sha: expr("steps.base-update.outputs.reused_e2e_head_sha || ''"),
  production_promotion: expr("steps.precheck.outputs.production_promotion || 'false'"),
  promotion_proven: expr("steps.promotion-proof.outputs.proven || 'false'"),
  promotion_run_id: expr("steps.promotion-proof.outputs.run_id || ''"),
  promotion_checkpoint_sha: expr("steps.precheck.outputs.checkpoint_sha || ''"),
  pr_number: expr("steps.precheck.outputs.pr_number || ''"),
  expected_head_sha: expr("steps.precheck.outputs.expected_head_sha || ''"),
  expected_base_sha: expr("steps.precheck.outputs.expected_base_sha || ''"),
  expected_base_ref: expr("steps.precheck.outputs.expected_base_ref || ''"),
  verifier_sha: expr("steps.precheck.outputs.verifier_sha || ''"),
  // Folded from resolve-ios-mac-runner. Only the thresholds are consumed;
  // every Mac job pins its own runs-on group and labels.
  ios_macos_minimum_free_kb: pick.outputs.ios_macos_minimum_free_kb,
  ios_macos_minimum_execution_free_kb: pick.outputs.ios_macos_minimum_execution_free_kb,
  ios_evidence_macos_minimum_free_kb: pick.outputs.ios_evidence_macos_minimum_free_kb,
  ios_evidence_macos_minimum_execution_free_kb:
    pick.outputs.ios_evidence_macos_minimum_execution_free_kb,
  mac_runner_resolution: expr('steps.pick.outcome'),
  // Folded from prepare-ios-native-tests. native_planned replaces that job's
  // result: true only when the typed planner ran and passed.
  native_should_run: replanned('native_should_run',
    "(steps.classify.outputs.producer_mode != 'skip' && 'true' || 'false')"),
  native_mode: replanned('native_mode', 'steps.selection.outputs.mode'),
  native_ui_required: replanned('native_ui_required', 'steps.classify.outputs.ui_required'),
  native_execution_required: replanned('native_execution_required',
    'steps.classify.outputs.execution_required'),
  native_execution_lanes: replanned('native_execution_lanes', 'steps.classify.outputs.execution_lanes'),
  native_full_execution_lanes: replanned('native_full_execution_lanes',
    'steps.classify.outputs.full_execution_lanes'),
  native_release_archive_required: replanned('native_release_archive_required',
    'steps.classify.outputs.release_archive_required'),
  native_handoff_required: replanned('native_handoff_required',
    'steps.classify.outputs.handoff_required'),
  native_planned: expr("steps.classify.outcome == 'success' && 'true' || 'false'"),
  // Exact affected UI identifier → native lane, computed once by the planner.
  // A re-plan or queue reuse that keeps a lane keeps this selection, so the
  // map is not re-planned.
  native_ui_method_owners: expr("steps.classify.outputs.ui_method_owners || ''"),
  // A queue candidate's per-lane reused/executed record; empty on every other event.
  queue_evidence_reuse: expr("steps.queue-reuse.outputs.record || ''"),
  // A reused real-server lane no longer executes, but its evidence still
  // stands on the shared development database, so the schema check still runs.
  real_server_evidence_reused: expr(
    `steps.queue-reuse.outputs.${REAL_SERVER_EVIDENCE_REUSED_OUTPUT} || 'false'`,
  ),
  native_preparation: expr('steps.classify.outcome'),
  control_runner_labels: expr('steps.control-route.outputs.control_runner_labels'),
} as const;

export const iosChangeGate = typedJob('ios-change-gate', {
  name: byEvent({ workflow_dispatch: 'Manual - iOS Change Gate' }, 'iOS Change Gate'),
  requiredCheckContext: 'iOS Change Gate',
  doc: {
    purpose: 'Decides whether this event needs iOS coverage and which lanes its changes reach.',
    successMeaning: 'Every downstream iOS job now has the plan it selects itself from.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  needs: [iosInitialControlRoute],
  // Failed admission must still let the required gate use its external fallback.
  if: expr(`always() && !cancelled() && (${IOS_PLANNING_CONDITION})`),
  runsOn: iosGateRunner,
  // The workflow's read scopes, plus `checks: read` for the route planner,
  // which reads an older queue candidate's route from its gate's check-run
  // annotations.
  permissions: { actions: 'read', checks: 'read', contents: 'read', 'pull-requests': 'read' },
  timeoutMinutes: 10,
  lane: controlLane,
  outputs: iosGateOutputs,
  steps: [
    prMetadataTokenStep,
    checkoutPrecheck,
    setupNode('Setup Node for the typed iOS gate precheck'),
    installTypedCiDependencies('Install typed iOS gate precheck dependencies', '.ci/trusted-ios-gate/ci'),
    precheck,
    controlRoute,
    checkoutBaseUpdateClassifier,
    installTypedCiDependencies('Install trusted base-update classifier dependencies',
      '.ci/trusted-base-update/ci', { if: baseUpdate.config.if }),
    baseUpdate,
    checkoutSelector,
    setupNode('Setup Node for iOS change selector', { if: expr(SELECTOR_CHECKOUT) }),
    installTypedCiDependencies('Install typed iOS gate dependencies', 'ci', { if: expr(SELECTOR_CHECKOUT) }),
    checkoutQueueDetector,
    installTypedCiDependencies('Install trusted queue candidate detector dependencies',
      `${QUEUE_DETECTOR_ROOT}/ci`, { if: expr(QUEUE_DETECTOR) }),
    lintEnabledStateReads,
    detect,
    checkoutRunnerResolver,
    setupNode('Setup Node for the typed iOS runner resolver', { if: expr(RESOLVER) }),
    installTypedCiDependencies('Install typed iOS runner resolver dependencies', 'ci', { if: expr(RESOLVER) }),
    pick,
    checkoutExactNativeRevision,
    checkoutTrustedNativeControls,
    // Manual dispatches skip the selector's Node setup above (needs_checkout is
    // false), so the planner pins its runtime here under its own condition.
    setupNode('Setup Node for the typed planner', { if: expr(NATIVE) }),
    installTypedCiDependencies('Install typed planner dependencies', 'ci', { if: expr(NATIVE) }),
    selection,
    classify,
    evidenceSelection,
    installRecordDependencies,
    downloadPriorRecord,
    replan,
    findQueuedEvidence,
    downloadQueuedSelectionRecord,
    queueReuse,
    uploadQueueReuseRecord,
    writeSelectionRecord,
    uploadSelectionRecord,
    promotionProof,
  ],
});

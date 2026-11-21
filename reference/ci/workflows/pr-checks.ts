import { installTypedCiDependencies } from './lib/typedCiDependencies.ts';
import { initialControlAdmission } from './lib/controlAdmission.ts';
import { linuxServerShardCommand, linuxServerShardIds } from '../src/linuxServerShard.ts';
import { prValidationPlanning, planningOutput, planningResult, inventoryOutput, type PrPlanningOutput } from '../src/prValidationPlanning.ts';
import type { PrLintPlan } from '../src/prLintPlan.ts';
import { PR_VALIDATION_WORKFLOW_NAMES } from '../src/terminalPrCleanupContract.ts';
import type { ReusableLinuxLane } from '../src/queueLaneEvidence.ts';
import {
  ciEventCondition, ciEventField, ciEventFieldSource, ciEventFieldWith, concat, expr, github,
  MERGE_GROUP_TRIGGER, VALIDATION_PULL_REQUEST_EVENTS,
  plannedControlLinuxRunner,
  runner, secret, suffixed, typedJob,
  typedNodeActionStep, typedRequiredPrWorkflow, typedStep,
} from './lib/index.ts';
import { STEP_ACTION_DIRECTORY } from './lib/stepActionContract.ts';
import { prChecksGroup } from './lib/validationConcurrency.ts';
import { PR_LANE_NODE_VERSION, installNodeDependencySteps } from './lib/nodeModulesCache.ts';
import {
  prHostedLinuxLaneTimeoutMinutes as laneTimeout,
  sharedDatabaseLinuxRunnerLabels,
  sharedPortableLinuxRunnerLabels,
} from '../src/runnerPolicy.ts';

/**
 * Everything a pull request must satisfy before it can merge.
 *
 * One gate plans the run and every other job is selected from that plan, so a
 * documentation-only change pays for a plan and nothing else while a server
 * change pays for the lanes it actually touches. The aggregate at the end is
 * the required check: it turns "this lane was skipped" into "this lane was not
 * selected", which is the only way a selective run can still be a gate.
 *
 * A short admission job routes planning to trusted external control
 * capacity when free and to verified hosted overflow when saturated. It uses
 * external control when hosted overflow policy is disabled. The planner
 * also picks between trusted external Linux and hosted overflow for the test
 * lanes, so routing does not need a separately billed runner lease.
 */

/** External `example-lane` capacity, or hosted Linux when the planner found the pool saturated. */
const preferredLinux = expr(
  `fromJson(${planningOutput('pr_linux_runner_labels')})`,
);
/** The same route as `preferredLinux`; a separate output only for older workflow revisions. */
const overflowLinux = expr(
  `fromJson(${planningOutput('pr_linux_overflow_labels')})`,
);
/** The Docker-capable route: only this lane can start a container. */
const databaseLinux = expr(
  `fromJson(${planningOutput('pr_database_runner_labels')})`,
);

/** The trusted base owns these typed planning actions. */
const gateAdapters = [
  'selectPrDeletionInventory', 'loadPrRuntimeManifest',
  'explainCalculationAssurance', prValidationPlanning.inventory.action,
] as const;
type GateAdapter = typeof gateAdapters[number];
const gateAction = (name: GateAdapter) => `node ci/src/actions/${name}.ts`;

const CHECKOUT = 'actions/checkout@v7.0.1';
const SETUP_NODE = 'actions/setup-node@v7.0.0';
const NODE_VERSION = PR_LANE_NODE_VERSION;

const gateOutput = (name: PrPlanningOutput) => expr(planningOutput(name));
// A PR carrying this new workflow initially runs the planner from the older
// trusted base. Until the planner is merged, preserve the old full-lint gate.
const legacyLintPlan = JSON.stringify({ mode: 'full', paths: [] } satisfies PrLintPlan);
const effectiveLintPlan = `${planningOutput('lint_plan')} || '${legacyLintPlan}'`;

/** The workspace checkout every test lane starts from: the pull request's own merge ref. */
const checkoutWorkspace = (fetchDepth?: number) => typedStep({
  name: 'Checkout the workflow revision',
  doc: {
    purpose: 'Puts the revision under review in the workspace so the lane tests that code.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: CHECKOUT,
  with: {
    'persist-credentials': false,
    ...(fetchDepth === undefined ? {} : { 'fetch-depth': fetchDepth }),
  },
});

const setupNode = () => typedStep({
  name: 'Set up the Node.js runtime',
  doc: {
    purpose: 'Installs the Node.js version every lane in this workflow runs its tools with.',
    recovery: 'check the pinned Node version is still published for this runner architecture',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: SETUP_NODE,
  with: { 'node-version': NODE_VERSION, 'package-manager-cache': false },
});

/**
 * The planner and classifier run from the immutable pull request base. Typed
 * adapters missing on older bases come from the already trusted
 * default branch revision resolved by the first checkout. No planner or
 * classifier is imported from that adapter checkout or from the PR head.
 */
const prMetadataToken = typedStep({
  id: 'pr-metadata-token',
  name: 'Create fallback PR metadata token',
  doc: {
    purpose: 'Mints the read-only App token the inventory falls back to when the run token is '
      + 'throttled.',
    recovery: 'check the App installation still grants contents and pull-requests read',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'step',
  if: expr(`${ciEventCondition('sameRepositoryPullRequest')} && github.actor != 'dependabot[bot]'`),
  uses: 'actions/create-github-app-token@v3.2.0',
  with: {
    'app-id': secret('PROMOTION_CHECKPOINT_APP_ID'),
    'private-key': secret('PROMOTION_CHECKPOINT_APP_PRIVATE_KEY'),
    'permission-contents': 'read',
    'permission-pull-requests': 'read',
  },
});

/**
 * Main still predates the typed planner. A promotion comes from this
 * repository's protected develop line, so pin its policy once at the first
 * trusted checkout and run both the planner and verdict from that revision.
 * Ordinary pull requests continue to use their exact base commit, and a queue
 * candidate uses the queue base: never the candidate itself.
 */
const trustedPolicySha = expr(
  `${ciEventCondition('pullRequestIntoMain')} `
  + `&& ${ciEventCondition('sameRepositoryPullRequest')} `
  + '&& steps.trusted-gate-source.outputs.commit '
  + `|| ${ciEventFieldSource('trustedBaseSha')}`,
);

const baseUpdate = typedStep({
  id: 'base-update',
  name: 'Detect verified incremental head delta',
  doc: {
    purpose: 'Asks the trusted classifier whether a base update left the effective patch '
      + 'unchanged.',
    recovery: 'read the classifier log the step prints; it names the base it compared against',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  outputs: [
    'base_delta_route', 'changed_files', 'deleted_files', 'patch_equivalent',
    'pull_request_deleted_files', 'pull_request_files', 'superseded', 'valid',
  ] as const,
  // A queue candidate has no prior head to be an increment of; its inventory
  // is the candidate's own diff against the queue base.
  if: expr(ciEventCondition('pullRequest')),
  command: 'node ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts',
  env: {
    TRUSTED_CHECKOUT_PATH: '.ci/trusted-base-update',
    CONTROLLER_BASE_UPDATE_WORKFLOWS: 'PR Checks',
    // This wrapper verifies the classifier checkout, not the PR's event base.
    // The controller reads the event base from the pull request payload.
    BASE_SHA: trustedPolicySha,
    GITHUB_TOKEN: github('token'),
    GITHUB_FALLBACK_TOKEN: expr('steps.pr-metadata-token.outputs.token'),
  },
});

const detect = typedStep({
  id: prValidationPlanning.inventory.id,
  name: prValidationPlanning.inventory.name,
  outputs: prValidationPlanning.inventory.outputs,
  doc: {
    purpose: 'Collects changed and deleted paths from the verified base-update delta or pull request.',
    recovery: 'read the inventory error; it names the unavailable or unverified PR metadata',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  command: gateAction(prValidationPlanning.inventory.action),
  env: {
    EVENT_NAME: github('event_name'),
    GITHUB_TOKEN: github('token'),
    GITHUB_FALLBACK_TOKEN: expr('steps.pr-metadata-token.outputs.token'),
    BASE_SHA: ciEventField('trustedBaseSha'),
    HEAD_SHA: ciEventField('headSha'),
    PR_NUMBER: ciEventField('prNumber'),
    MERGE_GROUP_REF: ciEventField('mergeGroupRef'),
    REPOSITORY: github('repository'),
    DELETED_FILES_INVENTORY_FILE: concat(runner('temp'), '/pr-inventory-deleted-files.txt'),
    CONTROLLER_BASE_UPDATE_VALID: expr("steps.base-update.outputs.valid || 'false'"),
    CONTROLLER_BASE_UPDATE_SUPERSEDED: expr("steps.base-update.outputs.superseded || 'false'"),
    CONTROLLER_BASE_UPDATE_FILES: expr("steps.base-update.outputs.changed_files || ''"),
    CONTROLLER_BASE_UPDATE_PATCH_EQUIVALENT:
      expr("steps.base-update.outputs.patch_equivalent || 'false'"),
  },
});

/**
 * The inventory step cancels this run when the merge queue already deleted
 * the candidate; the planning steps after it skip until that cancel lands.
 */
const CANDIDATE_PRESENT = `${inventoryOutput('candidate_gone')} != 'true'`;

const deleted = typedStep({
  id: 'deleted',
  name: 'Detect removed changed files',
  doc: {
    purpose: 'Takes the deletion list from whichever inventory the plan was actually built from.',
    recovery: 'an unverified inventory is the failure; rerun so the gate rebuilds it from the PR '
      + 'refs',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(CANDIDATE_PRESENT),
  command: gateAction('selectPrDeletionInventory'),
  env: {
    DELETED_FILES_FILE: concat(runner('temp'), '/pr-deleted-files.txt'),
    METADATA_ONLY: expr(inventoryOutput('metadata_only')),
    CLASSIFIER_INVENTORY_SELECTED:
      expr(`${inventoryOutput('classifier_inventory_selected')} || 'false'`),
    INCREMENTAL_DELETED_FILES: expr("steps.base-update.outputs.deleted_files || ''"),
    FILE_STATUS_INVENTORY_VERIFIED:
      expr(`${inventoryOutput('file_status_inventory_verified')} || 'false'`),
    DELETED_FILES_INVENTORY_FILE: concat(runner('temp'), '/pr-inventory-deleted-files.txt'),
  },
});

const loadRuntimeContracts = typedStep({
  name: 'Load exact-head server test runtime contracts',
  doc: {
    purpose: 'Fetches the runtime manifest from the exact head so the plan budgets the tests under '
      + 'review.',
    recovery: 'a missing manifest after it was changed is the failure; restore it on the head '
      + 'commit',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(CANDIDATE_PRESENT),
  command: gateAction('loadPrRuntimeManifest'),
  env: {
    CHANGED_FILES_FILE: concat(runner('temp'), '/pr-changed-files.txt'),
    DELETED_FILES_FILE: concat(runner('temp'), '/pr-deleted-files.txt'),
    GITHUB_FALLBACK_TOKEN: expr('steps.pr-metadata-token.outputs.token'),
    GITHUB_TOKEN: github('token'),
    BASE_REPOSITORY: github('repository'),
    HEAD_SHA: ciEventField('headSha'),
    METADATA_ONLY: expr(inventoryOutput('metadata_only')),
    PR_NUMBER: ciEventField('prNumber'),
    MERGE_GROUP_REF: ciEventField('mergeGroupRef'),
    RUNTIME_CONTRACT_PATH: 'ci/contracts/server-test-runtimes.json',
    RUNTIME_CONTRACT_OUTPUT: concat(runner('temp'), '/server-test-runtimes.json'),
  },
});

const plan = typedStep({
  id: prValidationPlanning.selection.id,
  name: prValidationPlanning.selection.name,
  doc: {
    purpose: 'Turns the inventory into the lane selection and assurance mode every other job '
      + 'reads.',
    recovery: 'read the planner error; it names the input that did not typecheck against the '
      + 'registry',
  },
  owner: 'product',
  category: 'quality',
  unit: 'step',
  if: expr(CANDIDATE_PRESENT),
  outputs: prValidationPlanning.selection.outputs,
  // The base checkout, never the PR head, executes its own typed policy.
  command: 'node ci/src/actions/planPrValidation.ts',
  env: {
    INPUT_CHANGED_FILES_FILE: concat(runner('temp'), '/pr-changed-files.txt'),
    INPUT_DELETED_FILES_FILE: concat(runner('temp'), '/pr-deleted-files.txt'),
    // Set only when a verified base update is routed by its base delta: the
    // route itself, which package.json classification must know, and the
    // pull request's own paths, which selected lint must still cover.
    INPUT_BASE_DELTA_ROUTE: expr("steps.base-update.outputs.base_delta_route || ''"),
    INPUT_PULL_REQUEST_FILES: expr("steps.base-update.outputs.pull_request_files || ''"),
    INPUT_PULL_REQUEST_DELETED_FILES:
      expr("steps.base-update.outputs.pull_request_deleted_files || ''"),
    INPUT_FILE_STATUS_AVAILABLE: expr('steps.deleted.outputs.file_status_available'),
    INPUT_METADATA_ONLY: expr(inventoryOutput('metadata_only')),
    INPUT_TEST_RUNTIME_CONTRACTS_FILE: concat(runner('temp'), '/server-test-runtimes.json'),
    // A pull request into develop runs the light lanes; its merge queue
    // candidate and every other event run the complete suites.
    INPUT_EVENT_NAME: github('event_name'),
    INPUT_BASE_BRANCH: ciEventField('baseBranch'),
    // Only consulted when the registry declares an enforced package's evidence tests, so
    // this planner can fetch their exact PR-head content instead of trusting this job's
    // trusted-base checkout, which does not reflect the PR under review.
    INPUT_REPOSITORY: github('repository'),
    // Script ownership compares against the checkout that executes this planner.
    // For promotions that trusted policy is develop, while the PR base is main.
    INPUT_TRUSTED_SCRIPT_SOURCE_SHA: trustedPolicySha,
    INPUT_HEAD_SHA: ciEventField('headSha'),
    INPUT_PR_NUMBER: ciEventField('prNumber'),
    INPUT_MERGE_GROUP_REF: ciEventField('mergeGroupRef'),
    INPUT_GITHUB_TOKEN: github('token'),
    INPUT_GITHUB_FALLBACK_TOKEN: expr('steps.pr-metadata-token.outputs.token'),
  },
});

const trustedGateSource = typedStep({
  id: 'trusted-gate-source',
  name: 'Check out the trusted base gate scripts',
  doc: {
    purpose: 'Resolves the trusted default branch once, before the base classifier runs.',
    recovery: 'retry; a repeated failure is a GitHub or runner network problem',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: CHECKOUT,
  outputs: ['commit'] as const,
  with: {
    ref: github('event.repository.default_branch'),
    'persist-credentials': false,
    'sparse-checkout': 'scripts\nci/src\n',
  },
});

// One shared admission owner also routes default-branch continuity controllers.
const initialControlRoute = initialControlAdmission({
  name: 'Route PR planner to available Linux capacity',
  condition: expr(ciEventCondition('ready')),
  trustedSteps: [trustedGateSource, setupNode()],
});

const pick = typedStep({
  id: 'pick',
  name: 'Select free external capacity or hosted overflow',
  doc: {
    purpose: 'Chooses between free trusted external Linux and hosted overflow for this run’s '
      + 'lanes.',
    recovery: 'read the notice it prints; it names which route it chose and why',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  if: expr(`${CANDIDATE_PRESENT} && steps.${prValidationPlanning.selection.id}.outputs.docs_only != 'true'`),
  outputs: [
    'pr_linux_runner_labels', 'pr_database_runner_labels', 'pr_linux_overflow_labels',
    'route_reason',
  ] as const,
  command: 'node ci/src/actions/selectPrLinuxRunners.ts',
  env: {
    GITHUB_TOKEN: github('token'),
    EVENT_NAME: github('event_name'),
    PR_HEAD_REPOSITORY: ciEventField('headRepository'),
    REPOSITORY_DEFAULT_BRANCH: github('event.repository.default_branch'),
    PR_PORTABLE_RUNNER_LABELS: expr(
      'vars.PR_PORTABLE_RUNNER_LABELS '
      + `|| '${JSON.stringify(sharedPortableLinuxRunnerLabels)}'`,
    ),
    PR_DATABASE_RUNNER_LABELS: expr(
      'vars.PR_DATABASE_RUNNER_LABELS '
      + `|| '${JSON.stringify(sharedDatabaseLinuxRunnerLabels)}'`,
    ),
    DATABASE_REQUIRED: plan.outputs.database_required,
    CI_HOSTED_LINUX_AVAILABLE: expr("vars.CI_HOSTED_LINUX_AVAILABLE || '0'"),
  },
});

/**
 * A queue rebuild deletes each superseded group's `gh-readonly-queue/...`
 * branch but leaves that group's runs executing. Each new candidate's planner
 * cancels them once, from the trusted queue base. Housekeeping never fails the
 * required plan, and a base that predates the action skips it.
 */
const cancelSupersededMergeGroupRuns = typedStep({
  name: 'Cancel runs of superseded merge groups',
  doc: {
    purpose: 'Cancels in-flight queue runs whose merge group branch GitHub has already deleted.',
    recovery: 'read the step log; it names each queue branch it kept or cancelled and why',
  },
  owner: 'infrastructure',
  category: 'coordination',
  unit: 'step',
  if: expr(
    `${ciEventCondition('mergeGroup')} `
    + "&& hashFiles('ci/src/actions/cancelSupersededMergeGroupRuns.ts') != ''",
  ),
  continueOnError: true,
  command: 'node ci/src/actions/cancelSupersededMergeGroupRuns.ts',
  env: {
    CI_WORKFLOW_NAMES: PR_VALIDATION_WORKFLOW_NAMES,
    GITHUB_TOKEN: github('token'),
  },
});

/**
 * A merge queue candidate reuses the pull request's own PR Checks lanes when
 * their input trees are byte-identical (`ci/src/queueLaneEvidence.ts`). The
 * decision runs from the trusted base checkout, after the plan, and only on
 * `merge_group`; on a pull request the step is skipped and nothing is reused.
 */
const queueReuse = typedStep({
  id: 'queue-reuse',
  name: 'Match pull request lane evidence to the queue candidate',
  doc: {
    purpose: 'Reuses a selected Linux lane only when the candidate tree carries exactly the lane '
      + 'inputs the pull request run tested; every other lane executes.',
    recovery: 'read the lane lines it prints; an executed lane names the input or run that '
      + 'blocked reuse',
  },
  owner: 'automation',
  category: 'planning',
  unit: 'step',
  // The program runs from the trusted base checkout; a base that predates it
  // skips the step, and an empty output means every selected lane executes.
  if: expr(`${ciEventCondition('mergeGroup')} && ${CANDIDATE_PRESENT} `
    + `&& hashFiles('ci/src/actions/planQueueLaneReuse.ts') != ''`),
  outputs: ['reused_lanes', 'lane_evidence'] as const,
  command: 'node ci/src/actions/planQueueLaneReuse.ts',
  env: {
    REPOSITORY: github('repository'),
    GITHUB_TOKEN: github('token'),
    GITHUB_FALLBACK_TOKEN: expr('steps.pr-metadata-token.outputs.token'),
    PLAN_JSON: plan.outputs.plan_json,
  },
});

/** The lanes a candidate reused are skipped jobs; a pull request reuses none. */
const reusedLanesJson = `fromJSON(${planningOutput('reused_lanes')} || '[]')`;
const notReused = (lane: ReusableLinuxLane): string => `!contains(${reusedLanesJson}, '${lane}')`;

const validationPlanner = typedJob(prValidationPlanning.id, {
  name: prValidationPlanning.name,
  // The trusted-base planner can dispatch a fresh admission probe when
  // external Linux is saturated and scheduled GitHub probes have gone stale,
  // and on a queue candidate it cancels runs of superseded merge groups.
  permissions: { actions: 'write', contents: 'read', 'pull-requests': 'read' },
  retiredNamePatterns: [prValidationPlanning.retiredNamePattern],
  doc: {
    purpose: 'Plans the run from the changed files, so every other lane is selected rather than '
      + 'guessed.',
    successMeaning: 'The pull request has a routing plan every other job in this workflow can '
      + 'read.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  needs: [initialControlRoute],
  if: expr(`always() && !cancelled() && ${ciEventCondition('ready')}`),
  runsOn: plannedControlLinuxRunner('needs.route-initial-control.outputs.control_runner_labels'),
  timeoutMinutes: 15,
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'none',
    selectionOwner: 'always',
  },
  outputs: {
    docs_only: plan.outputs.docs_only,
    lint_plan: plan.outputs.lint_plan,
    database_required: plan.outputs.database_required,
    entitlement_acceptance_required: plan.outputs.entitlement_acceptance_required,
    metadata_only: plan.outputs.metadata_only,
    policy_required: plan.outputs.policy_required,
    workflow_contracts_required: plan.outputs.workflow_contracts_required,
    server_static_required: plan.outputs.server_static_required,
    test_only_helpers_to_typecheck: plan.outputs.test_only_helpers_to_typecheck,
    server_test_mode: plan.outputs.server_test_mode,
    process_heavy_required: plan.outputs.process_heavy_required,
    targeted_server_tests: plan.outputs.targeted_server_tests,
    targeted_integration_tests: plan.outputs.targeted_integration_tests,
    ios_contracts_required: plan.outputs.ios_contracts_required,
    pr_linux_runner_labels: pick.outputs.pr_linux_runner_labels,
    pr_database_runner_labels: pick.outputs.pr_database_runner_labels,
    pr_linux_overflow_labels: pick.outputs.pr_linux_overflow_labels,
    control_runner_labels: expr('needs.route-initial-control.outputs.control_runner_labels'),
    trusted_policy_sha: trustedPolicySha,
    reused_lanes: queueReuse.outputs.reused_lanes,
    lane_evidence: queueReuse.outputs.lane_evidence,
  } satisfies Record<PrPlanningOutput, ReturnType<typeof expr>>,
  steps: [
    // Resolve the trusted wrappers once before the classifier. Reuse that
    // commit only if the subsequent base checkout predates extraction.
    trustedGateSource,
    typedStep({
      name: 'Setup Node for the typed planner',
      doc: {
        purpose: 'Installs the Node.js version the typed planner and its dependencies are built '
          + 'for.',
        recovery: 'check the pinned Node version is still published for this runner architecture',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: SETUP_NODE,
      with: { 'node-version': NODE_VERSION, 'package-manager-cache': false },
    }),
    prMetadataToken,
    typedStep({
      name: 'Checkout base-update classifier',
      doc: {
        purpose: 'Materialises the base commit the classifier runs from, beside the working tree.',
        recovery: 'retry; a repeated failure is a GitHub or runner network problem',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: CHECKOUT,
      with: {
        ref: trustedPolicySha,
        path: '.ci/trusted-base-update',
        'persist-credentials': false,
        // The script is only GitHub orchestration; its execution-input decision
        // and path diagnostics live in the typed iOS layer.
        'sparse-checkout': 'scripts\n.github/workflows\nci\n',
      },
    }),
    installTypedCiDependencies('Install trusted base-update classifier dependencies',
      '.ci/trusted-base-update/ci', { if: expr(ciEventCondition('pullRequest')) }),
    baseUpdate,
    typedStep({
      name: 'Checkout trusted base workspace',
      doc: {
        purpose: 'Replaces the working tree with the base commit, so the planner runs trusted '
          + 'code.',
        recovery: 'retry; a repeated failure is a GitHub or runner network problem',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: CHECKOUT,
      with: { ref: trustedPolicySha, 'persist-credentials': false },
    }),
    typedStep({
      name: 'Install typed planner dependencies',
      doc: {
        purpose: 'Installs only the planner package, which carries its own dependencies for this '
          + 'gate.',
        recovery: 'read the npm log; the gate runs before the application workspace is installed',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      command: 'npm ci --prefix ci --no-audit --no-fund --ignore-scripts',
    }),
    cancelSupersededMergeGroupRuns,
    detect,
    deleted,
    loadRuntimeContracts,
    plan,
    typedStep({
      name: 'Explain financial calculation assurance',
      doc: {
        purpose: 'Writes the assurance mode and any missing layers into the run summary for a '
          + 'reader.',
        recovery: 'read the summary; a malformed planner output is the only way this step fails',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      if: expr(CANDIDATE_PRESENT),
      command: gateAction('explainCalculationAssurance'),
      env: {
        ASSURANCE_MODE: plan.outputs.calculation_assurance_mode,
        ASSURANCE_PACKAGES: plan.outputs.calculation_assurance_packages,
        ASSURANCE_GAPS: plan.outputs.calculation_assurance_gaps,
        INDEPENDENT_AUDIT_REQUIRED: plan.outputs.calculation_assurance_independent_audit_required,
      },
    }),
    pick,
    queueReuse,
  ],
});

const lint = typedJob('lint', {
  name: 'Lint changed code',
  requiredCheckContext: 'Lint changed code',
  doc: {
    purpose: 'Lints changed source files, expanding to the repository when lint configuration '
      + 'changes, with zero warnings allowed.',
    successMeaning: 'The selected PR source has no lint error or warning.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  needs: [validationPlanner],
  if: expr(
    `${ciEventCondition('ready')} `
    + `&& ${planningResult} == 'success' `
    + `&& ${planningOutput('docs_only')} != 'true'`,
  ),
  // Lint is one lane among the others: the validate aggregate requires it,
  // but no lane waits for it, so a lint queue never delays the tests. Like
  // every portable lane it leaves the external pool only when the planner
  // found that pool saturated.
  runsOn: overflowLinux,
  timeoutMinutes: laneTimeout.lint,
  lane: {
    runnerClass: 'linux-hosted-overflow',
    costClass: 'light',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'always',
  },
  steps: [
    checkoutWorkspace(),
    setupNode(),
    ...installNodeDependencySteps(),
    typedStep({
      name: 'Lint selected PR code',
      doc: {
        purpose: 'Reports every lint finding in the revision under review as a failure, not a '
          + 'warning.',
        recovery: 'read the rule and file the linter names and fix it in the branch',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      if: expr(`fromJSON(${effectiveLintPlan}).mode != 'none'`),
      command: 'node ci/src/actions/runSelectedLint.ts',
      env: { PR_LINT_PLAN: expr(effectiveLintPlan) },
    }),
    typedStep({
      name: 'Verify Linux lane documentation inputs',
      doc: {
        purpose: 'Rejects a source change that reads a new docs fixture before queue evidence can omit it.',
        recovery: 'declare the newly read docs path in the Linux lane input list',
      },
      owner: 'infrastructure',
      category: 'quality',
      unit: 'step',
      command: 'node --test ci/tests/linuxLaneDocumentationInputs.test.ts',
    }),
  ],
});

const validationPolicy = typedJob('validation-policy', {
  name: 'Evaluate PR validation policy',
  doc: {
    purpose: 'Runs the secret scan and the dependency preflight the repository policy requires.',
    successMeaning: 'No secret was committed and the debt dependency preflight produced its '
      + 'evidence.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  needs: [validationPlanner],
  if: expr(
    `${planningOutput('metadata_only')} != 'true' `
    + `&& ${planningOutput('policy_required')} == 'true'`,
  ),
  runsOn: plannedControlLinuxRunner(planningOutput('control_runner_labels')),
  timeoutMinutes: 5,
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'typed-pr-validation',
  },
  steps: [
    typedStep({
      name: 'Checkout the workflow revision',
      doc: {
        purpose: 'Checks out the candidate; the preflight fetches only its required ancestry.',
        recovery: 'check checkout connectivity before the targeted policy-history fetch',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: CHECKOUT,
      with: { 'persist-credentials': false, 'fetch-depth': 1 },
    }),
    setupNode(),
    typedStep({
      name: 'Install typed CI dependencies',
      doc: {
        purpose: 'Installs the ci package the typed preflight imports (zod, the event projection).',
        recovery: 'read the npm log and verify ci/package-lock.json matches ci/package.json',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      command: 'npm ci --prefix ci --no-audit --no-fund --ignore-scripts',
    }),
    typedNodeActionStep({
      id: 'debt-preflight',
      name: 'Validate debt dependency preflight',
      doc: {
        purpose: 'Runs the debt projection preflight and writes its evidence for the retention '
          + 'step.',
        recovery: 'read the preflight output; it names the ticket or dependency that is '
          + 'unsatisfied',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      entry: 'ci/src/actions/debt/runDebtDependencyPreflight.ts',
      env: {
        // A queue candidate reads its PR body through the API; its payload has none.
        GITHUB_TOKEN: github('token'),
        DEBT_PREFLIGHT_OUTPUT: concat(
          runner('temp'), '/debt-preflight-', github('run_id'), '-', github('run_attempt'),
        ),
      },
    }),
    typedStep({
      id: 'upload-debt-preflight',
      name: 'Retain debt dependency evidence',
      doc: {
        purpose: 'Uploads the preflight evidence so a decision can be audited after the run '
          + 'expires.',
        recovery: 'the next step keeps the evidence in the summary; artifact storage is the '
          + 'failure',
      },
      owner: 'automation',
      category: 'evidence',
      unit: 'step',
      if: expr("always() && steps.debt-preflight.outcome == 'failure'"),
      continueOnError: true,
      uses: 'actions/upload-artifact@v7.0.1',
      with: {
        name: concat('debt-preflight-', github('run_id'), '-', github('run_attempt')),
        path: concat(
          runner('temp'), '/debt-preflight-', github('run_id'), '-', github('run_attempt'),
        ),
        'if-no-files-found': 'ignore',
        'retention-days': 14,
      },
    }),
    typedNodeActionStep({
      name: 'Preserve debt evidence when artifact storage is unavailable',
      doc: {
        purpose: 'Copies the bounded preflight evidence into the run summary when the upload '
          + 'failed.',
        recovery: 'read the summary section it wrote; the upload failure itself is not fatal',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      summaryTitle: 'Debt dependency evidence',
      if: expr("always() && steps.upload-debt-preflight.outcome == 'failure'"),
      entry: 'ci/src/actions/debt/preserveDebtEvidence.ts',
    }),
  ],
});

const workflowContracts = typedJob('workflow-contracts', {
  name: 'Workflow contracts',
  doc: {
    purpose: 'Runs the suites that describe what every workflow, controller and CI helper must do.',
    successMeaning: 'The workflows and their helpers still behave the way their contracts '
      + 'describe.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  needs: [validationPlanner],
  if: expr(`${planningOutput('workflow_contracts_required')} == 'true' && ${notReused('workflow-contracts')}`),
  runsOn: preferredLinux,
  timeoutMinutes: laneTimeout.workflowContracts,
  lane: {
    runnerClass: 'linux-external-preferred',
    costClass: 'light',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'typed-pr-validation',
  },
  steps: [
    checkoutWorkspace(),
    setupNode(),
    typedStep({
      name: 'Install pinned workflow linters',
      doc: {
        purpose: 'Puts the pinned actionlint and shellcheck builds on PATH for the typed contract '
          + 'check.',
        recovery: 'read the installer log; a download failure is retried, a checksum change is not',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      command: 'node ci/src/actions/installWorkflowLinters.ts',
    }),
    typedStep({
      name: 'Validate typed CI contracts',
      doc: {
        purpose: 'Installs and links the strict CI dependencies once, then runs every ci/tests suite once (the workflow contract inventory included), '
          + 'the typed CI type checks and the generated workflow drift check.',
        recovery: 'run npm run ci:check locally; regenerate the workflows if the drift check '
          + 'failed',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'npm run ci:check -- --workflow-contracts',
    }),
  ],
});

const serverStatic = typedJob('server-static', {
  name: 'Server static validation',
  doc: {
    purpose: 'Type-checks the workspace, proves every server error response keeps its envelope, '
      + 'and proves committed generated types match their generators.',
    successMeaning: 'The revision type-checks, no route can answer outside the error envelope, '
      + 'and no generated type file is stale.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  needs: [validationPlanner],
  if: expr(`${planningOutput('server_static_required')} == 'true' && ${notReused('server-static')}`),
  runsOn: preferredLinux,
  timeoutMinutes: laneTimeout.serverStatic,
  lane: {
    runnerClass: 'linux-external-preferred',
    costClass: 'medium',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'typed-pr-validation',
  },
  steps: [
    checkoutWorkspace(),
    setupNode(),
    ...installNodeDependencySteps(),
    typedStep({
      name: 'Validate error envelopes',
      doc: {
        purpose: 'Checks every server error path answers in the shared envelope the clients parse.',
        recovery: 'read the route the check names and return the shared envelope from it',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'npm run security:error-envelopes',
    }),
    typedStep({
      name: 'Validate generated type files',
      doc: {
        purpose: 'Reruns every type generator and compares its output with the committed '
          + 'generated files, so a YAML change without regeneration fails.',
        recovery: 'run npm run types:all and commit the regenerated files',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'npm run validate:generated-types',
    }),
    typedStep({
      name: 'Check real-server lane inputs',
      doc: {
        purpose: 'Recomputes which real-server E2E lanes load each file and fails when a lane now '
          + 'loads a file the committed lane inputs withhold from it.',
        recovery: 'run npm run ci:server-lane-inputs and commit the regenerated contract; for an '
          + 'undeclared runtime read, declare it in RUNTIME_READS',
      },
      owner: 'automation',
      category: 'quality',
      unit: 'step',
      command: 'npm run ci:server-lane-inputs:check',
    }),
    typedStep({
      name: 'Check TypeScript types',
      doc: {
        purpose: 'Type-checks the whole workspace, which the test runners themselves do not do.',
        recovery: 'read the first type error; the later ones are usually consequences of it',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'npm run type-check',
    }),
    typedStep({
      name: 'Type-check changed server test helpers',
      doc: {
        purpose: 'Compiles changed test-only helpers and their imports, which the app tsconfig '
          + 'deliberately excludes.',
        recovery: 'fix the reported TypeScript error in the changed helper',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      if: expr(`${planningOutput('test_only_helpers_to_typecheck')} != '' `
        + `&& ${planningOutput('test_only_helpers_to_typecheck')} != '[]'`),
      command: 'node ci/src/actions/typecheckChangedTestHelpers.ts',
      env: {
        TEST_ONLY_HELPERS_JSON: expr(planningOutput('test_only_helpers_to_typecheck')),
      },
    }),
  ],
});

const serverProcessTests = typedJob('server-process-tests', {
  name: 'Server process-heavy tests',
  doc: {
    purpose: 'Runs the server suites that need a process of their own, away from the sharded '
      + 'lanes.',
    successMeaning: 'The suites that cannot share a worker passed on a worker of their own.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  needs: [validationPlanner],
  // The trusted-base planner can predate process_heavy_required during rollout.
  // Full mode always needs these suites, including on that older base.
  if: expr(`(${planningOutput('process_heavy_required')} == 'true' || `
    + `${planningOutput('server_test_mode')} == 'full') && ${notReused('server-process-tests')}`),
  runsOn: preferredLinux,
  timeoutMinutes: laneTimeout.serverProcessTests,
  lane: {
    runnerClass: 'linux-external-preferred',
    costClass: 'medium',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'typed-pr-validation',
  },
  steps: [
    checkoutWorkspace(),
    setupNode(),
    ...installNodeDependencySteps(),
    typedStep({
      name: 'Run server process-heavy tests',
      doc: {
        purpose: 'Runs the suites the shared runner cannot host without starving the other shards.',
        recovery: 'read the failing suite; these tests own their process, so a leak is visible in '
          + 'it',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'npm run test:process-heavy',
    }),
  ],
});

const shardReceiptDirectory = concat(runner('temp'), '/linux-shard-', github('run_id'), '-',
  github('run_attempt'), '-', expr('matrix.shard'));
const shardReceiptEnvironment = {
  RECEIPT_DIRECTORY: shardReceiptDirectory,
  PR_NUMBER: ciEventField('prNumber'),
  PR_BASE_SHA: ciEventField('trustedBaseSha'),
  PR_HEAD_SHA: ciEventField('headSha'),
  PR_HEAD_REPOSITORY: ciEventField('headRepository'),
  SHARD: expr('matrix.shard'),
  RECEIPT_WORKFLOW_SHA: github('workflow_sha'),
  RECEIPT_RUNNER_ENVIRONMENT: runner('environment'),
};

const serverTests = typedJob('server-tests', {
  // The shard is data, not a name, but it has to be in the name for four
  // concurrent jobs to be told apart in the checks list.
  name: suffixed('Server tests', concat(expr('matrix.shard'), '/4')),
  doc: {
    purpose: 'Runs the server unit suites in four shards so the whole suite finishes in one lane '
      + 'time.',
    successMeaning: 'Every non-integration server test passed in this quarter of the suite.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'suite',
  needs: [validationPlanner],
  if: expr(`${planningOutput('server_test_mode')} == 'full' && ${notReused('server-tests')}`),
  strategy: { failFast: false, matrix: { shard: [...linuxServerShardIds] } },
  // Shards follow the portable route: external Linux unless the planner
  // found the pool saturated (or busy, for a merge queue candidate).
  runsOn: overflowLinux,
  timeoutMinutes: laneTimeout.serverTestShard,
  lane: {
    runnerClass: 'linux-hosted-overflow',
    costClass: 'medium',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'typed-pr-validation',
  },
  steps: [
    // The shadow coverage selector compares the merge tree with its base parent.
    checkoutWorkspace(2),
    setupNode(),
    ...installNodeDependencySteps(),
    typedStep({
      id: 'capture-shard-inputs',
      name: 'Capture server shard execution inputs',
      continueOnError: true,
      doc: {
        purpose: 'Records the actual merge tree and execution fingerprints before native tests run.',
        recovery: 'Inspect the checkout tuple and changed execution inputs; no reuse is enabled.',
      },
      owner: 'automation', category: 'coordination', unit: 'step',
      // Receipts describe a pull request's merge tree; a queue candidate records none.
      if: expr(ciEventCondition('pullRequest')),
      command: 'node ci/src/actions/recordLinuxShardReceipt.ts',
      env: { ...shardReceiptEnvironment, RECEIPT_PHASE: 'prepare' },
    }),
    typedStep({
      id: 'native-shard',
      name: 'Run server test shard',
      doc: {
        purpose: 'Runs one quarter of the server unit suites and reports partial changed-line '
          + 'coverage when the PR changes server TypeScript.',
        recovery: 'read the failing test; rerun the same shard locally with the printed vitest '
          + 'command',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: linuxServerShardCommand('${{ matrix.shard }}'),
    }),
    typedStep({
      id: 'complete-shard-receipt',
      name: 'Record successful server shard receipt',
      continueOnError: true,
      doc: {
        purpose: 'Records an observational receipt in the successful job log only when shard inputs remain unchanged.',
        recovery: 'Inspect changed inputs or the missing snapshot; this receipt cannot authorize reuse.',
      },
      owner: 'automation', category: 'coordination', unit: 'step',
      if: expr("success() && steps.native-shard.outcome == 'success' && steps.capture-shard-inputs.outcome == 'success'"),
      command: 'node ci/src/actions/recordLinuxShardReceipt.ts',
      env: { ...shardReceiptEnvironment, RECEIPT_PHASE: 'complete', SHARD_OUTCOME: expr('steps.native-shard.outcome') },
    }),
  ],
});

const targetedServerTests = typedJob('targeted-server-tests', {
  name: 'Targeted server tests',
  doc: {
    purpose: 'Runs only the server suites the plan tied to the changed files, instead of all of '
      + 'them.',
    successMeaning: 'Every server suite the changed files own passed.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  needs: [validationPlanner],
  if: expr(`${planningOutput('server_test_mode')} == 'targeted' && ${notReused('targeted-server-tests')}`),
  runsOn: preferredLinux,
  timeoutMinutes: laneTimeout.targetedServerTests,
  lane: {
    runnerClass: 'linux-external-preferred',
    costClass: 'medium',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'typed-pr-validation',
  },
  steps: [
    checkoutWorkspace(),
    setupNode(),
    ...installNodeDependencySteps(),
    typedStep({
      name: 'Run changed server tests',
      doc: {
        purpose: 'Runs the suites the planner selected, and fails when one of them collects no '
          + 'tests.',
        recovery: 'read the failing suite; an empty suite means the selection named a file that '
          + 'moved',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'node ci/src/actions/runTargetedServerTests.ts',
      env: {
        TARGETED_SERVER_TESTS_JSON: gateOutput('targeted_server_tests'),
        TARGETED_TEST_RESULTS_FILE: concat(runner('temp'), '/targeted-server-results.json'),
        RUN_HTTP_TESTS: 'true',
      },
    }),
  ],
});

/** One line, because `run` is one line: the contract suites are a single vitest invocation. */
const IOS_CONTRACT_TEST_COMMAND = [
  'npx vitest run --config server/vitest.config.ts',
  'server/tests/*Contract.test.ts',
  'server/tests/*TypesSync.test.ts',
  'server/tests/budgetRequestTypes.test.ts',
  'server/tests/budgetCategoryEnums.test.ts',
  'server/tests/chatDataTypeRegistry.test.ts',
  'server/tests/dashboardGeneratedTypes.test.ts',
].join(' ');

const iosContracts = typedJob('ios-contracts', {
  name: 'iOS-server contracts',
  doc: {
    purpose: 'Checks the generated iOS payload types still match the server types they came from.',
    successMeaning: 'The iOS app and the server agree on every generated payload and enum.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  needs: [validationPlanner],
  if: expr(`${planningOutput('ios_contracts_required')} == 'true' && ${notReused('ios-contracts')}`),
  runsOn: preferredLinux,
  timeoutMinutes: laneTimeout.iosContracts,
  lane: {
    runnerClass: 'linux-external-preferred',
    costClass: 'medium',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'typed-pr-validation',
  },
  steps: [
    checkoutWorkspace(),
    setupNode(),
    ...installNodeDependencySteps(),
    typedStep({
      name: 'Run iOS-server contract tests',
      doc: {
        purpose: 'Runs the contract and generated-type suites the iOS client is built against.',
        recovery: 'regenerate the types from server/routes/chatTypes.yaml and commit both sides',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: IOS_CONTRACT_TEST_COMMAND,
    }),
    typedStep({
      name: 'Test dashboard manual account generation',
      doc: {
        purpose: 'Proves the dashboard reader keeps its own generated shape and rejects profile alias collisions.',
        recovery: 'read the failing generator assertion and update the source schema or generator',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'node --test ci/tests/dashboardManualAccountGeneration.test.ts',
    }),
  ],
});

const databaseIntegration = typedJob('database-integration', {
  name: 'Run database integration tests',
  doc: {
    purpose: 'Runs the suites that need a real PostgreSQL, against a container this job owns.',
    successMeaning: 'The migrations apply and every database-backed suite passed against them.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  needs: [validationPlanner],
  if: expr(
    `${planningOutput('docs_only')} != 'true' `
    + `&& ${planningOutput('database_required')} == 'true' && ${notReused('database-integration')}`,
  ),
  runsOn: databaseLinux,
  timeoutMinutes: laneTimeout.databaseIntegration,
  lane: {
    runnerClass: 'linux-external-preferred',
    costClass: 'medium',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'typed-pr-validation',
  },
  steps: [
    // The container starts before the workspace checkout and dependency
    // install, so its startup overlaps them. This sparse checkout brings in
    // only the typed container programs and the step action that runs them;
    // the full checkout below replaces it. The action runs its entry with the
    // job's Node, so that is set up first.
    typedStep({
      name: 'Check out the database container scripts',
      doc: {
        purpose: 'Puts the typed container programs in the workspace before the engine and '
          + 'database start.',
        recovery: 'retry; a repeated failure is a GitHub or runner network problem',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: CHECKOUT,
      with: { 'persist-credentials': false, 'sparse-checkout': `${STEP_ACTION_DIRECTORY}\nci/src\n` },
    }),
    setupNode(),
    typedNodeActionStep({
      id: 'container-engine',
      name: 'Ensure container engine',
      doc: {
        purpose: 'Finds a usable Docker or Podman on this runner, installing one when it can.',
        recovery: 'the runner has no engine and cannot install one; route the lane to a Docker '
          + 'host',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      entry: 'ci/src/actions/ensureContainerEngine.ts',
    }),
    typedNodeActionStep({
      name: 'Start isolated PostgreSQL',
      doc: {
        purpose: 'Starts a PostgreSQL container named for this run, on a port the runner picks.',
        recovery: 'read the engine error; a port or name collision means a previous run left a '
          + 'container',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      entry: 'ci/src/actions/startIsolatedPostgresql.ts',
    }),
    checkoutWorkspace(),
    ...installNodeDependencySteps(),
    // Checkout and dependency installation can finish after the first health
    // transition. Inspect current state instead of relying on the engine's
    // bounded event history to still contain that transition.
    typedStep({
      name: 'Await PostgreSQL health',
      doc: {
        purpose: 'Checks current PostgreSQL container health until it is healthy or the startup budget expires.',
        recovery: 'read the inspected state and container log; repair startup or the runner engine',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      command: 'node ci/src/actions/awaitPostgresqlHealth.ts',
    }),
    typedStep({
      name: 'Test Plaid scheduler leases in isolated PostgreSQL',
      doc: {
        purpose: 'Proves the scheduler lease fencing holds against a real PostgreSQL, not a fake.',
        recovery: 'read the failing assertion; a lease test failure is a correctness bug, not '
          + 'flake',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      shell: 'bash',
      command: [
        'PLAID_SCHEDULER_TEST_DATABASE_URL="$DATABASE_URL"',
        'npx vitest run --config server/vitest.config.ts',
        'server/tests/plaidSchedulerLeasePostgres.integration.test.ts',
      ].join(' '),
    }),
    typedNodeActionStep({
      name: 'Verify Wellness migrations and event round trips without skips',
      doc: {
        purpose: 'Applies the Wellness migrations and proves the suites ran rather than skipped.',
        recovery: 'a skipped or empty suite is the failure; read which file collected no tests',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      entry: 'ci/src/actions/verifyWellnessDatabases.ts',
    }),
    typedStep({
      name: 'Apply Drizzle migrations',
      doc: {
        purpose: 'Applies every committed migration to the container, in order, from empty.',
        recovery: 'read the failing migration; it is the first one that cannot apply to a clean '
          + 'database',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      command: 'npm run db:migrate',
    }),
    typedStep({
      name: 'Verify Plaid scheduler schema',
      doc: {
        purpose: 'Checks the migrated schema still matches what the scheduler code expects to '
          + 'find.',
        recovery: 'read the drifted object the verifier names and reconcile the migration with it',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'npm run db:verify-plaid-scheduler',
    }),
    typedStep({
      name: 'Prove Plaid scheduler verifier rejects schema drift',
      doc: {
        purpose: 'Drifts the schema on purpose and requires the verifier to report each drifted '
          + 'object.',
        recovery: 'the verifier accepted drift; read which object it failed to report and fix the '
          + 'check',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'node ci/src/actions/provePlaidSchedulerSchemaDrift.ts',
    }),
    typedNodeActionStep({
      name: 'Test distributed database state',
      doc: {
        purpose: 'Runs the session, notification and Plaid suites that only a real database can '
          + 'answer.',
        recovery: 'a skipped or empty suite is the failure; read which file collected no tests',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      entry: 'ci/src/actions/testDistributedDatabaseState.ts',
    }),
    typedNodeActionStep({
      name: 'Prepare conversation runtime SQL database',
      doc: {
        purpose: 'Creates the runtime databases the conversation and preparation suites connect '
          + 'to.',
        recovery: 'read the psql error; a create failure means the container is no longer healthy',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      entry: 'ci/src/actions/prepareConversationRuntimeDatabases.ts',
    }),
    typedStep({
      name: 'Run selected database acceptance tests',
      doc: {
        purpose: 'Runs selected integration suites and entitlement acceptance against this database.',
        recovery: 'read the failing suite; it names the database contract the changed code owns',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      if: expr(`${planningOutput('targeted_integration_tests')} != '[]' || ${planningOutput('entitlement_acceptance_required')} == 'true'`),
      command: 'node ci/src/actions/runDatabaseIntegrationValidation.ts',
      env: {
        TARGETED_SERVER_TESTS_JSON: gateOutput('targeted_integration_tests'),
        TARGETED_TEST_RESULTS_FILE: concat(runner('temp'), '/targeted-integration-results.json'),
        ENTITLEMENT_ACCEPTANCE_REQUIRED: gateOutput('entitlement_acceptance_required'),
        ENTITLEMENT_TEST_DATABASE_URL: expr('env.DATABASE_URL'),
        PLAID_SYNC_ATTEMPT_TEST_DATABASE_URL: expr('env.DATABASE_URL'),
        STAGING_QA_FIXTURE_TEST_DATABASE_URL: expr('env.DATABASE_URL'),
        AUTH_CODE_TEST_DATABASE_URL: expr('env.DATABASE_URL'),
        APPLE_AUTH_TEST_DATABASE_URL: expr('env.DATABASE_URL'),
        NOTIFICATION_TEST_DATABASE_URL: expr('env.DATABASE_URL'),
        RUNTIME_POSTGRES_TEST_URL: expr('env.RUNTIME_POSTGRES_TEST_URL'),
        VEHICLE_LINK_TEST_DATABASE_URL: expr('env.DATABASE_URL'),
        REQUIRE_VEHICLE_LINK_POSTGRES_TESTS: '1',
        MORTGAGE_PLAN_TEST_DATABASE_URL: expr('env.DATABASE_URL'),
        REQUIRE_MORTGAGE_PLAN_POSTGRES_TESTS: '1',
        RUN_INTEGRATION_TESTS: '1',
      },
    }),
    typedNodeActionStep({
      name: 'Remove PostgreSQL container',
      doc: {
        purpose: 'Removes the container this job started, whatever the outcome of the suites was.',
        recovery: 'a leftover container is the failure; remove it on the runner before the next '
          + 'run',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      if: expr("always() && env.DB_CONTAINER_NAME != ''"),
      entry: 'ci/src/actions/removePostgresqlContainer.ts',
    }),
  ],
});

/**
 * The required check. Every other job may be skipped by the plan, so a green
 * aggregate cannot mean "they all ran": it means each lane the plan selected
 * succeeded, and each lane it did not select is absent rather than failed.
 */
const validate = typedJob('validate', {
  name: 'Validate pull request changes',
  requiredCheckContext: 'Validate pull request changes',
  doc: {
    purpose: 'Requires every lane the plan selected, and rejects a failure in any lane it did not.',
    successMeaning: 'Every validation lane this pull request needed ran and passed.',
  },
  owner: 'product',
  category: 'quality',
  unit: 'job',
  if: expr(`always() && !cancelled() && ${ciEventCondition('ready')}`),
  needs: [
    validationPlanner, lint, validationPolicy, workflowContracts, serverStatic,
    serverProcessTests, serverTests, targetedServerTests, iosContracts, databaseIntegration,
  ],
  runsOn: plannedControlLinuxRunner(planningOutput('control_runner_labels')),
  timeoutMinutes: 3,
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'patch-equivalent',
    selectionOwner: 'typed-pr-validation',
  },
  steps: [
    typedStep({
      name: 'Check out the typed validation verdict',
      doc: {
        purpose: 'Puts the reviewed base revision of the typed aggregate verdict in the workspace.',
        recovery: 'retry; a repeated failure is a GitHub or runner network problem',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: CHECKOUT,
      with: {
        ref: expr(`${planningOutput('trusted_policy_sha')} || ${ciEventFieldSource('trustedBaseSha')}`),
        'persist-credentials': false,
        'sparse-checkout': 'ci/src\n',
      },
    }),
    typedStep({
      name: 'Setup Node for the typed validation verdict',
      doc: {
        purpose: 'Runs the TypeScript verdict on the pinned Node runtime.',
        recovery: 'retry; a repeated failure means the pinned Node version is unavailable',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      uses: SETUP_NODE,
      with: { 'node-version': NODE_VERSION, 'package-manager-cache': false },
    }),
    typedStep({
      name: 'Require every selected validation lane',
      doc: {
        purpose: 'Compares each lane result against the plan that decided whether that lane was '
          + 'needed.',
        recovery: 'read the lane name it prints; that lane, not this one, is what has to be fixed',
      },
      owner: 'product',
      category: 'quality',
      unit: 'step',
      command: 'node ci/src/actions/requireSelectedValidationLanes.ts',
      env: {
        [prValidationPlanning.resultEnvironment]: expr(planningResult),
        LINT: expr('needs.lint.result'),
        LINT_PLAN: expr(effectiveLintPlan),
        POLICY: expr('needs.validation-policy.result'),
        WORKFLOW_CONTRACTS: expr('needs.workflow-contracts.result'),
        SERVER_STATIC: expr('needs.server-static.result'),
        SERVER_PROCESS_TESTS: expr('needs.server-process-tests.result'),
        SERVER_TESTS: expr('needs.server-tests.result'),
        TARGETED_SERVER_TESTS: expr('needs.targeted-server-tests.result'),
        IOS_CONTRACTS: expr('needs.ios-contracts.result'),
        DATABASE: expr('needs.database-integration.result'),
        DOCS_ONLY: gateOutput('docs_only'),
        METADATA_ONLY: gateOutput('metadata_only'),
        POLICY_REQUIRED: gateOutput('policy_required'),
        WORKFLOW_CONTRACTS_REQUIRED: gateOutput('workflow_contracts_required'),
        SERVER_STATIC_REQUIRED: gateOutput('server_static_required'),
        SERVER_TEST_MODE: gateOutput('server_test_mode'),
        PROCESS_HEAVY_REQUIRED: gateOutput('process_heavy_required'),
        IOS_CONTRACTS_REQUIRED: gateOutput('ios_contracts_required'),
        DATABASE_REQUIRED: gateOutput('database_required'),
        // A queue candidate's reused lanes, verified against the evidence record.
        REUSED_LANES: expr(`${planningOutput('reused_lanes')} || '[]'`),
        LANE_EVIDENCE: gateOutput('lane_evidence'),
        // On a pull request the verdict prints the evidence marker a later
        // candidate reads: the merge commit every lane checked out and the
        // plan this run discharged.
        EVENT_NAME: github('event_name'),
        REPOSITORY: github('repository'),
        PR_NUMBER: ciEventField('prNumber'),
        PR_HEAD_SHA: ciEventField('headSha'),
        PR_BASE_SHA: ciEventField('trustedBaseSha'),
        TESTED_MERGE_SHA: github('sha'),
        WORKFLOW_SHA: github('workflow_sha'),
        RUN_ID: github('run_id'),
        RUN_ATTEMPT: github('run_attempt'),
        TARGETED_SERVER_TESTS_PLAN: gateOutput('targeted_server_tests'),
        TARGETED_INTEGRATION_TESTS_PLAN: gateOutput('targeted_integration_tests'),
        ENTITLEMENT_ACCEPTANCE_REQUIRED: gateOutput('entitlement_acceptance_required'),
        TEST_ONLY_HELPERS_PLAN: gateOutput('test_only_helpers_to_typecheck'),
      },
    }),
  ],
});

export const prChecks = typedRequiredPrWorkflow({
  path: '.github/workflows/pr-checks.yml',
  source: 'ci/workflows/pr-checks.ts',
  // The workflow name is an operational input: the review controller and the
  // base-update classifier both subscribe to "PR Checks" by string, so the
  // readable name lives beside it rather than replacing it.
  name: 'PR Checks',
  displayName: 'Validate pull request changes',
  doc: {
    purpose: 'Decides whether a pull request is ready to merge, one selected lane at a time.',
  },
  on: {
    pull_request: { types: [...VALIDATION_PULL_REQUEST_EVENTS] },
    merge_group: MERGE_GROUP_TRIGGER,
  },
  permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read' },
  concurrency: {
    // A PR keeps its number; a queue candidate's ref is unique to that candidate.
    group: prChecksGroup(ciEventFieldWith('prNumber', {
      merge_group: 'github.ref', workflow_dispatch: 'github.ref',
    })),
    cancelInProgress: true,
  },
  requiredContexts: ['lint', 'validate'],
  jobs: [
    initialControlRoute, validationPlanner, lint, validationPolicy, workflowContracts, serverStatic,
    serverProcessTests, serverTests, targetedServerTests, iosContracts, validate,
    databaseIntegration,
  ],
});

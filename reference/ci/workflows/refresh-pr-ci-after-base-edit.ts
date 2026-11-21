import { initialControlAdmission } from './lib/controlAdmission.ts';
import {
  concat, expr, github, secret, plannedTrustedControlLinuxRunner, typedJob, typedNodeActionStep, typedStep,
  typedWorkflow,
} from './lib/index.ts';
import { STEP_ACTION_DIRECTORY } from './lib/stepAction.ts';
import { PR_VALIDATION_WORKFLOW_NAMES } from '../src/terminalPrCleanupContract.ts';

/**
 * The pull-request continuity controller. Everything that can invalidate the
 * evidence an open pull request already has arrives here — a protected base
 * moving under it, a base edit, a new head, a close, or an iOS run finishing —
 * and each job reacts to exactly one of them. Required validation workflows do
 * not subscribe to `edited`: GitHub cannot distinguish a base retarget from a
 * title/body edit at subscription time, and skipped runs can make required
 * contexts pending. This trusted job updates a real retarget, which emits the
 * `synchronize` event that runs the normal validation workflows.
 *
 * Five controller jobs: base pushes fan out in one run per push. With an active
 * merge-queue rule, develop changes report conflicts and leave integration to
 * the queue; without that rule, the adapter updates affected PR branches.
 * PR changes refresh stacked children and
 * cancel obsolete iOS work, completed iOS runs release retained evidence,
 * completed promotion evidence reruns the checkpoint PR's failed iOS gate, and
 * pull requests either fan-out left in merge conflict lose their queued
 * validation. The PR-change job also repairs proven stale integration
 * candidates after a retarget. Required workflows resume on the update's
 * synchronize event.
 */

/** One bounded admission routes the controllers before external queue allocation. */
const controlRunner = plannedTrustedControlLinuxRunner(
  'needs.route-initial-control.outputs.control_runner_labels',
);

/** The controllers run from the default branch, never from the pull request head. */
const trustedCheckout = (name: string, purpose: string, sparse: `${string}\n`) => typedStep({
  name,
  doc: { purpose, recovery: 'retry; a repeated failure is a GitHub or runner network problem' },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: 'actions/checkout@v7.0.1',
  with: {
    ref: github('event.repository.default_branch'),
    'persist-credentials': false,
    // The local typed step action runs from the workspace root. Include its
    // generated metadata for every controller checkout by construction.
    'sparse-checkout': `${sparse}${STEP_ACTION_DIRECTORY}\n`,
  },
});

/**
 * The legacy controllers orchestrate GitHub from scripts/ and delegate iOS
 * execution-input decisions to the typed module. ci/src/sparseCheckouts.ts
 * fails ci:test if a controller dependency escapes this checkout.
 */
const CONTROLLER_SPARSE_CHECKOUT = 'scripts\n.github/workflows\nci/src\nci/contracts\n';

const setupNode = () => typedStep({
  name: 'Setup Node for the trusted controllers',
  doc: {
    purpose: 'Puts the Node runtime the trusted controllers are written against on the runner.',
    recovery: 'retry; a repeated failure means the pinned Node version is no longer downloadable',
  },
  owner: 'infrastructure',
  category: 'environment',
  unit: 'step',
  uses: 'actions/setup-node@v7.0.0',
  with: { 'node-version': '26.5.0', 'package-manager-cache': false },
});

const FAN_OUT_CONDITION = "github.event_name == 'push'";
export const CONTINUITY_PR_CONDITION = "github.event_name == 'pull_request_target' "
    + "&& (github.event.action == 'synchronize' "
    + "|| (github.event.action == 'ready_for_review' "
    + "&& vars.CI_RETARGET_RECOVERY_ENABLED == 'true') "
    + "|| (github.event.action == 'edited' && github.event.changes.base != null "
    + '&& github.event.pull_request.draft == false)) '
    + '&& github.event.pull_request.head.repo.full_name == github.repository';

const iosRun = (field: string) => `github.event.workflow_run.${field}`;
// The PR's head when the run completed. GitHub fills `pull_requests` from the
// pull request's live state, so this differs from the run's own head_sha once
// the pull request has moved on.
const livePrHead = iosRun('pull_requests[0].head.sha');

/**
 * The only Test - iOS completions that can resume retained work, decided from
 * the event payload alone so every other completion never takes a runner:
 *
 * - a deferred run finishing after its predecessor: the run is for the PR's
 *   current head, failed (the deferred aggregate always fails), and that head
 *   is a base-update commit, the only kind of head the classifier defers
 *   (`isEligibleBaseUpdateCommit`: a GitHub web-flow merge or the controller's
 *   `chore: update PR #N from <base>` commit);
 * - a retained predecessor finishing after its successor deferred to it: the
 *   PR has moved past the run's head and the run was not cancelled. Automation
 *   cancels only superseded runs nothing is waiting on; a retained run is never
 *   cancelled for a head that still waits on it.
 *
 * Successful Dependabot runs also start the job, for the auto-merge step.
 */
export const RESUME_RETAINED_IOS_CONDITION = "github.event_name == 'workflow_run' "
  + `&& ${iosRun('name')} == 'Test - iOS' && ${iosRun('event')} == 'pull_request' `
  + `&& ((startsWith(${iosRun('head_branch')}, 'dependabot/') && ${iosRun('conclusion')} == 'success') `
  + `|| (${livePrHead} && ((${livePrHead} == ${iosRun('head_sha')} `
  + `&& ${iosRun('conclusion')} == 'failure' `
  + `&& (${iosRun('head_commit.committer.email')} == 'noreply@github.com' `
  + `|| startsWith(${iosRun('head_commit.message')}, 'chore: update PR #'))) `
  + `|| (${livePrHead} != ${iosRun('head_sha')} `
  + `&& ${iosRun('conclusion')} != 'cancelled' && ${iosRun('conclusion')} != 'skipped'))))`;

const promotionRun = (field: string) => `github.event.workflow_run.${field}`;

/**
 * Successful promotion-evidence dispatches and failed promotion checkpoint PR
 * runs. The controller re-validates the payload and live state; this condition
 * only keeps every other iOS completion off the trusted runner.
 */
// A run-named dispatch reports its run-name as `workflow_run.name`, so the iOS
// workflow is matched by path, never by name.
export const PROMOTION_RECHECK_CONDITION = "github.event_name == 'workflow_run' "
  + `&& ${promotionRun('path')} == '.github/workflows/ios-tests.yml' `
  + `&& ((${promotionRun('event')} == 'workflow_dispatch' && ${promotionRun('conclusion')} == 'success' `
  + `&& ${promotionRun('head_branch')} == 'develop' `
  + `&& startsWith(${promotionRun('display_title')}, 'promotion-evidence:')) `
  + `|| (${promotionRun('event')} == 'pull_request' `
  + `&& startsWith(${promotionRun('head_branch')}, 'promotion/develop-') `
  + `&& (${promotionRun('conclusion')} == 'failure' || ${promotionRun('conclusion')} == 'cancelled' `
  + `|| ${promotionRun('conclusion')} == 'timed_out')))`;

// Every command executes protected default-branch code, including workflow_run
// events. A fork event never runs its head on an external control host.
const initialControlRoute = initialControlAdmission({
  name: 'Route continuity controllers to available Linux capacity',
  condition: expr(`(${FAN_OUT_CONDITION}) || (${CONTINUITY_PR_CONDITION}) `
    + `|| (${RESUME_RETAINED_IOS_CONDITION}) || (${PROMOTION_RECHECK_CONDITION})`),
  sameRepositoryCode: 'true',
  trustedSteps: [trustedCheckout(
    'Checkout trusted controller capacity selector',
    'Reads the existing capacity selector only from the protected default branch.',
    'ci/src\nscripts/ci/generated\n',
  ), setupNode()],
});

type PrMutationPermission = 'contents' | 'pull-requests';
type PrMutationTokenInputs = {
  readonly 'app-id': ReturnType<typeof secret>;
  readonly 'private-key': ReturnType<typeof secret>;
} & {
  readonly [Permission in PrMutationPermission as `permission-${Permission}`]: 'write';
};

const prMutationTokenInputs = {
  'app-id': secret('PROMOTION_CHECKPOINT_APP_ID'),
  'private-key': secret('PROMOTION_CHECKPOINT_APP_PRIVATE_KEY'),
  'permission-contents': 'write',
  'permission-pull-requests': 'write',
} as const satisfies PrMutationTokenInputs;

// Branch updates can merge workflow-file changes. Both update paths need the
// extra grant; Dependabot auto-merge uses only the narrower PR mutation scope.
type BranchUpdateTokenInputs = PrMutationTokenInputs & {
  readonly 'permission-workflows': 'write';
};

const branchUpdateTokenInputs = {
  ...prMutationTokenInputs,
  'permission-workflows': 'write',
} as const satisfies BranchUpdateTokenInputs;

/** A base retarget, or a ready-for-review while retarget recovery is enabled. */
const RETARGET_EVENT = "(github.event.action == 'edited' && github.event.changes.base != null) "
  + "|| (github.event.action == 'ready_for_review' && vars.CI_RETARGET_RECOVERY_ENABLED == 'true')";

const fanOutSteps = (onPullRequestChange: boolean) => {
  // The cancellation step may fail while a stacked child still needs its base
  // refresh. Run the independent fan-out path after that failure, but retain
  // the job's failed conclusion. GitHub's default success() guard would skip
  // the remaining steps without these explicit conditions. One install serves
  // every controller of a pull-request change: cancellation, fan-out and
  // retarget recovery.
  const installCondition = onPullRequestChange
    ? { if: expr(`always() && (github.event.action == 'synchronize' || ${RETARGET_EVENT})`) }
    : {};
  const tokenCondition = onPullRequestChange
    ? { if: expr("always() && github.event.action == 'synchronize' && steps.ci-deps.outcome == 'success'") }
    : {};
  const updateCondition = onPullRequestChange
    ? { if: expr("always() && github.event.action == 'synchronize' && steps.update-token.outcome == 'success'") }
    : {};
  const install = typedNodeActionStep({
    id: 'ci-deps',
    name: 'Install typed planner dependencies',
    doc: {
      purpose: 'Installs the pinned dependencies the typed controllers and planners import.',
      recovery: 're-run once; then check the npm registry and the committed ci/package-lock.json',
    },
    owner: 'infrastructure',
    category: 'environment',
    unit: 'step',
    ...installCondition,
    entry: 'ci/src/actions/installCiPackageDependencies.ts',
  });
  const token = typedStep({
    id: 'update-token',
    name: 'Create scoped pull-request update token',
    doc: {
      purpose: 'Mints the scoped token the fan-out uses to update a pull request branch.',
      recovery: 'check the App installation grants Contents, Pull requests, and Workflows write',
    },
    owner: 'automation',
    category: 'coordination',
    unit: 'step',
    ...tokenCondition,
    uses: 'actions/create-github-app-token@v3.2.0',
    with: branchUpdateTokenInputs,
  });
  return {
    install,
    token,
    updateOverlapping: typedStep({
      id: 'fan-out',
      name: 'Update overlapping pull requests',
      doc: {
        purpose: 'Reports develop conflicts without updating any PR; on main and stacked bases updates overlaps and heads a shared CI repair fixes.',
        recovery: 'read the base-update lines: each names the pull request, its action and the reason',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      ...updateCondition,
      outputs: ['conflicted_pull_requests'] as const,
      command: 'node ci/src/actions/refreshOverlappingPullRequests.ts',
      env: {
        REPOSITORY: github('repository'),
        READ_TOKEN: github('token'),
        UPDATE_TOKEN: expr('steps.update-token.outputs.token'),
      },
    }),
  };
};

const pushFanOut = fanOutSteps(false);
const synchronizeFanOut = fanOutSteps(true);

const fanOutUpdate = typedJob('fan-out-base-update', {
  name: 'Update overlapping pull requests',
  doc: {
    purpose: 'Reports conflicts and updates affected heads when native merge queue does not own their integration candidate.',
    successMeaning: 'Each open pull request has a base-update decision: skipped, conflict reported, or updated for a named reason.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  if: expr(`always() && !cancelled() && (${FAN_OUT_CONDITION})`),
  needs: [initialControlRoute],
  runsOn: controlRunner,
  timeoutMinutes: 5,
  permissions: { actions: 'read', checks: 'read', contents: 'read', 'pull-requests': 'read' },
  outputs: { conflicted_pull_requests: pushFanOut.updateOverlapping.outputs.conflicted_pull_requests },
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'none',
    selectionOwner: 'controller',
  },
  steps: [
    trustedCheckout(
      'Checkout trusted fan-out controller',
      'Puts the typed fan-out planner on the runner from the default branch.',
      'ci\n.github/workflows\n',
    ),
    setupNode(),
    pushFanOut.install,
    pushFanOut.token,
    pushFanOut.updateOverlapping,
  ],
});

const cancelObsoleteIos = typedJob('cancel-obsolete-ios', {
  name: 'Keep PR work current',
  doc: {
    purpose: 'Cancels obsolete iOS runs after a PR head or base changes and updates stacked children after a head change.',
    successMeaning: 'Current evidence is retained; obsolete iOS work is cancelled and stacked children are refreshed.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  if: expr(`always() && !cancelled() && (${CONTINUITY_PR_CONDITION})`),
  needs: [initialControlRoute],
  runsOn: controlRunner,
  timeoutMinutes: 10,
  permissions: { actions: 'write', checks: 'read', contents: 'read', 'pull-requests': 'read' },
  outputs: { conflicted_pull_requests: synchronizeFanOut.updateOverlapping.outputs.conflicted_pull_requests },
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'none',
    selectionOwner: 'controller',
  },
  steps: [
    trustedCheckout(
      'Checkout trusted obsolete-run controller',
      'Puts the cancellation controller and the workflow it reads on the runner.',
      'scripts\n.github/workflows\nci\n',
    ),
    setupNode(),
    synchronizeFanOut.install,
    typedNodeActionStep({
      name: 'Cancel obsolete active iOS work',
      doc: {
        purpose: 'Cancels the iOS runs a new head or a base retarget made obsolete, keeping any predecessor whose evidence the new head reuses.',
        recovery: 'read the step log: it names every run it cancelled, retained or left alone, with a reason code',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      if: expr("steps.ci-deps.outcome == 'success' "
        + "&& ((github.event.action == 'synchronize' && github.event.pull_request.draft == false) "
        + "|| (github.event.action == 'edited' && github.event.changes.base != null))"),
      entry: 'ci/src/actions/cancelObsoleteIosRuns.ts',
      env: { GITHUB_TOKEN: github('token') },
    }),
    synchronizeFanOut.token,
    synchronizeFanOut.updateOverlapping,
    typedStep({
      id: 'retarget-token',
      name: 'Create scoped retarget recovery token',
      doc: {
        purpose: 'Mints the installed App token used to publish the retargeted PR head.',
        recovery: 'verify the installed promotion-checkpoint App grants Contents, Pull requests, and Workflows write',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      if: expr(`always() && steps.ci-deps.outcome == 'success' && (${RETARGET_EVENT})`),
      uses: 'actions/create-github-app-token@v3.2.0',
      with: branchUpdateTokenInputs,
    }),
    typedStep({
      name: 'Recover a retargeted PR integration candidate',
      doc: {
        purpose: 'Publishes a base-pinned GitHub merge after a retarget or proven stale integration candidate.',
        recovery: 'read the typed reason; a conflict needs resolution, and an accepted update needs its synchronize checks',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      if: expr("always() && steps.retarget-token.outcome == 'success'"),
      command: 'node ci/src/actions/recoverRetargetedPullRequest.ts',
      env: {
        REPOSITORY: github('repository'),
        READ_TOKEN: github('token'),
        UPDATE_TOKEN: expr('steps.retarget-token.outputs.token'),
      },
    }),
  ],
});

const resumeRetainedIos = typedJob('resume-retained-ios', {
  name: 'Resume retained iOS run',
  doc: {
    purpose: 'Resumes the deferred iOS run a finished predecessor was holding open for this head.',
    successMeaning: 'A patch-equivalent predecessor released its evidence to the run waiting on it.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  if: expr(`always() && !cancelled() && (${RESUME_RETAINED_IOS_CONDITION})`),
  needs: [initialControlRoute],
  runsOn: controlRunner,
  timeoutMinutes: 5,
  permissions: { actions: 'write', contents: 'read', 'pull-requests': 'read' },
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'none',
    selectionOwner: 'controller',
  },
  steps: [
    trustedCheckout(
      'Checkout trusted controller',
      'Puts the resume controller and the workflow it reads on the runner.',
      CONTROLLER_SPARSE_CHECKOUT,
    ),
    setupNode(),
    typedStep({
      id: 'dependabot-merge-token',
      name: 'Create scoped Dependabot auto-merge token',
      doc: {
        purpose: 'Mints a PR mutation token only for completed Dependabot iOS gate runs.',
        recovery: 'check the installed App still grants Contents and Pull requests write',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      if: expr("startsWith(github.event.workflow_run.head_branch, 'dependabot/')"),
      uses: 'actions/create-github-app-token@v3.2.0',
      with: prMutationTokenInputs,
    }),
    typedStep({
      name: 'Enable native auto-merge for verified Dependabot updates',
      doc: {
        purpose: 'Verifies the current Dependabot head and enables GitHub auto-merge, which still waits for required checks and branch rules.',
        recovery: 'read the typed result; an untrusted or stale head needs a new Dependabot update',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      if: expr("startsWith(github.event.workflow_run.head_branch, 'dependabot/') && steps.dependabot-merge-token.outcome == 'success'"),
      command: 'node ci/src/actions/enableDependabotAutoMerge.ts',
      env: { GITHUB_TOKEN: expr('steps.dependabot-merge-token.outputs.token') },
    }),
    typedStep({
      id: 'update-token',
      name: 'Create scoped pull-request update token',
      doc: {
        purpose: 'Mints the scoped token the resume controller uses to re-emit a head event.',
        recovery: 'check the App installation still grants contents: write to this repository',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      if: expr("!startsWith(github.event.workflow_run.head_branch, 'dependabot/')"),
      uses: 'actions/create-github-app-token@v3.2.0',
      with: {
        'app-id': secret('PROMOTION_CHECKPOINT_APP_ID'),
        'private-key': secret('PROMOTION_CHECKPOINT_APP_PRIVATE_KEY'),
        'permission-contents': 'write',
      },
    }),
    typedStep({
      name: 'Resume a deferred patch-equivalent iOS run',
      doc: {
        purpose: 'Reruns the marker job that a retained predecessor was blocking, once that run completes.',
        recovery: 'read the step log: it names the predecessor it waited on and the run it resumed',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      if: expr("always() && ((startsWith(github.event.workflow_run.head_branch, 'dependabot/') "
        + "&& steps.dependabot-merge-token.outcome == 'success') "
        + "|| (!startsWith(github.event.workflow_run.head_branch, 'dependabot/') "
        + "&& steps.update-token.outcome == 'success'))"),
      command: 'node ci/src/actions/resumeRetainedIosPredecessor.ts',
      env: {
        GITHUB_TOKEN: github('token'),
        GITHUB_EVENT_TOKEN: expr('steps.dependabot-merge-token.outputs.token || steps.update-token.outputs.token'),
      },
    }),
  ],
});

const recheckPromotionAfterEvidence = typedJob('recheck-promotion-after-evidence', {
  name: 'Recheck promotion after evidence',
  doc: {
    purpose: 'Reruns a production promotion PR iOS gate that failed before its exact-develop evidence completed.',
    successMeaning: 'Every open checkpoint PR for the source either had its failed iOS jobs rerun or needed nothing.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  if: expr(`always() && !cancelled() && (${PROMOTION_RECHECK_CONDITION})`),
  needs: [initialControlRoute],
  runsOn: controlRunner,
  timeoutMinutes: 5,
  permissions: { actions: 'write', contents: 'read', 'pull-requests': 'read' },
  // One decision per checkpoint source at a time. Both triggers name the same
  // promotion/develop-<sha> key; each run re-reads live state, so a replaced
  // pending event loses nothing.
  concurrency: {
    group: concat('promotion-recheck-', expr(
      `${promotionRun('event')} == 'workflow_dispatch' `
      + `&& format('promotion/develop-{0}', ${promotionRun('head_sha')}) || ${promotionRun('head_branch')}`,
    )),
    cancelInProgress: false,
  },
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'none',
    selectionOwner: 'controller',
  },
  steps: [
    trustedCheckout(
      'Checkout trusted promotion recheck controller',
      'Puts the typed promotion recheck controller on the runner from the default branch.',
      'scripts\nci\n',
    ),
    setupNode(),
    typedNodeActionStep({
      name: 'Install promotion recheck dependencies',
      doc: {
        purpose: 'Installs the pinned dependencies the typed promotion recheck imports.',
        recovery: 're-run once; then check the npm registry and the committed ci/package-lock.json',
      },
      owner: 'infrastructure',
      category: 'environment',
      unit: 'step',
      entry: 'ci/src/actions/installCiPackageDependencies.ts',
    }),
    typedNodeActionStep({
      name: 'Rerun promotion iOS gate after evidence',
      doc: {
        purpose: 'Reruns failed iOS jobs of the checkpoint PR whose gate ran before the evidence completed.',
        recovery: 'read the promotion-recheck lines: each names the pull request, run and reason',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      summaryTitle: 'Promotion evidence recheck',
      entry: 'ci/src/actions/ios/recheckPromotionAfterEvidence.ts',
      env: {
        REPOSITORY: github('repository'),
        GITHUB_TOKEN: github('token'),
      },
    }),
  ],
});

const conflictedPullRequests = (job: 'fan-out-base-update' | 'cancel-obsolete-ios') =>
  `needs.${job}.outputs.conflicted_pull_requests`;

const cancelConflictedPrCi = typedJob('cancel-conflicted-pr-ci', {
  name: 'Cancel conflicted PR work',
  doc: {
    purpose: 'Cancels queued and running validation of pull requests the fan-out left in merge conflict.',
    successMeaning: 'No active validation remains for a pull request GitHub still reports as conflicted at that head.',
  },
  owner: 'automation',
  category: 'coordination',
  unit: 'job',
  needs: [initialControlRoute, fanOutUpdate, cancelObsoleteIos],
  // Only one producer runs per event. always() keeps this job from being
  // skipped by the other producer's skip or by a failed fan-out that still
  // confirmed a conflict before it failed.
  if: expr(
    `always() && (${conflictedPullRequests('fan-out-base-update')} != '' `
    + `|| ${conflictedPullRequests('cancel-obsolete-ios')} != '')`,
  ),
  runsOn: controlRunner,
  timeoutMinutes: 10,
  permissions: { actions: 'write', contents: 'read', 'pull-requests': 'read' },
  lane: {
    runnerClass: 'hosted-control',
    costClass: 'control',
    evidencePolicy: 'none',
    selectionOwner: 'controller',
  },
  steps: [
    trustedCheckout(
      'Checkout trusted conflict cleanup controller',
      'Puts the terminal-run cleanup controller on the runner from the default branch.',
      'ci/src\n',
    ),
    setupNode(),
    typedStep({
      name: 'Cancel validation of conflicted pull requests',
      doc: {
        purpose: 'Cancels active PR Checks and Test - iOS runs a conflicted head can never merge with.',
        recovery: 'read the step log: it names every run it cancelled and every pull request it left alone',
      },
      owner: 'automation',
      category: 'coordination',
      unit: 'step',
      command: 'node ci/src/actions/cancelTerminalPrRuns.ts',
      env: {
        CI_WORKFLOW_NAMES: PR_VALIDATION_WORKFLOW_NAMES,
        CONFLICTED_PULL_REQUESTS: expr(
          `${conflictedPullRequests('fan-out-base-update')} || ${conflictedPullRequests('cancel-obsolete-ios')}`,
        ),
        GITHUB_TOKEN: github('token'),
      },
    }),
  ],
});

export const refreshPrCiAfterBaseEdit = typedWorkflow({
  path: '.github/workflows/refresh-pr-ci-after-base-edit.yml',
  source: 'ci/workflows/refresh-pr-ci-after-base-edit.ts',
  name: 'Refresh PR CI after base change',
  doc: { purpose: 'Keeps an open pull request carrying CI evidence for the base and head it has now.' },
  on: {
    // Protected-base pushes and same-repository PR synchronizations update
    // child pull requests that share files with the moved base. The latter
    // runs the trusted default-branch workflow, keeping App secrets out of
    // workflow definitions on feature branches.
    push: { branches: ['develop', 'main'] },
    pull_request_target: { types: ['synchronize', 'edited', 'ready_for_review'] },
    workflow_run: {
      workflows: ['Test - iOS'],
      types: ['completed'],
    },
  },
  permissions: { actions: 'read', contents: 'read', 'pull-requests': 'read' },
  // The review controller exclusively owns closed-PR cancellation, so this
  // workflow does not create one cleanup job per iOS lane. Test-iOS
  // completions use the immutable source run id so GitHub's single pending
  // concurrency slot cannot replace a completion event needed to resume
  // retained work.
  //
  // Each pull-request event class has its own per-PR group, so a newer event
  // replaces only an older pending event of the same class, never another
  // class's. Replacement within a class loses nothing:
  // - synchronize: the fan-out judges every eligible stacked child from its
  //   own merge base with the live source tip (FanOutReconciliation in
  //   ci/src/fanOutEvent.ts), and cancellation measures every active iOS run
  //   from its own head to the live head, so neither relies on the replaced
  //   event's `before`;
  // - base retarget and ready-for-review: both controllers act only while the
  //   live PR tuple still equals the event's, so an older event of the same
  //   class could only have been superseded.
  // A title or body edit gets a unique group and can never replace anything.
  concurrency: {
    group: concat('review-controller-', expr(
      "(github.event_name == 'pull_request_target' && github.event.action == 'synchronize' "
      + "&& format('pr-synchronize-{0}', github.event.pull_request.number)) "
      + "|| (github.event_name == 'pull_request_target' && github.event.action == 'edited' "
      + '&& github.event.changes.base != null '
      + "&& format('pr-retarget-{0}', github.event.pull_request.number)) "
      + "|| (github.event_name == 'pull_request_target' && github.event.action == 'ready_for_review' "
      + "&& format('pr-ready-{0}', github.event.pull_request.number)) "
      + "|| (github.event_name == 'workflow_run' "
      + "&& github.event.workflow_run.name == 'Test - iOS' "
      + "&& format('retained-ios-{0}-{1}', github.event.workflow_run.pull_requests[0].url, "
      + 'github.event.workflow_run.id)) '
      + "|| (github.event_name == 'push' && format('base-update-fanout-{0}', github.sha)) "
      + "|| format('continuity-{0}', github.run_id)",
    )),
    cancelInProgress: false,
  },
  jobs: [initialControlRoute, fanOutUpdate, cancelObsoleteIos, resumeRetainedIos, recheckPromotionAfterEvidence, cancelConflictedPrCi],
});

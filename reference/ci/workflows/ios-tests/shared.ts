import type { ConditionLike, StepsJobConfig } from 'gagen';
import {
  reservedMacLabels, sharedMacLabels,
} from '../../src/ios/iosRunnerCapabilities.ts';
import {
  ciEventCondition, ciEventConcurrencyKey, ciEventField, concat, expr, hostedLinuxRunner,
  plannedControlLinuxRunner, pullRequestOnly,
  runner, secret,
  trustedControlLinuxRunner, typedStep,
  type ExpressionValue, type LaneMetadata, type TypedStep,
} from '../lib/index.ts';
import type { iosGateOutputs } from './ios-change-gate.ts';

/**
 * What the iOS validation jobs have in common, in one place.
 *
 * Nineteen jobs share four runner routes, one concurrency shape, six lane
 * descriptions and the three steps that put the typed CI layer on a runner.
 * Written once here they are a decision; copied into nineteen job files they
 * are nineteen decisions that drift — a lane routed to the wrong Mac pool, a
 * checkout that keeps credentials, a cancel rule that stops a required lane.
 *
 * Every value below renders exactly what `.github/workflows/ios-tests.yml`
 * renders today; a job whose shape genuinely differs writes it out itself
 * rather than growing a parameter here.
 */

/** Hosted Linux: what any route falls back to, and the only route a fork gets. */
const HOSTED_LINUX = hostedLinuxRunner;

/**
 * The revision comes from this repository rather than a fork. Self-hosted
 * runners execute whatever they are given, so a fork's head is routed to
 * hosted Linux instead of a trusted worker.
 */
const SAME_REPOSITORY = ciEventCondition('sameRepositoryCode');

/**
 * A repository variable naming the label set, taken only for a revision this
 * repository owns, with hosted Linux for everything else. The variable is the
 * operational lever: clearing it moves the route back to hosted runners
 * without a commit.
 */
export function trustedRouteLabels(variable: string, fallback: readonly string[]): ExpressionValue {
  return expr(
    `fromJson((${SAME_REPOSITORY}) && (vars.${variable} || '${JSON.stringify(fallback)}') `
    + `|| '${JSON.stringify(HOSTED_LINUX)}')`,
  );
}

/** Admission selects available Linux before allocating the gate; unknown routes retain external fallback. */
export const iosGateRunner = plannedControlLinuxRunner('needs.route-initial-control.outputs.control_runner_labels');

const GATE_OUTPUT = 'needs.ios-change-gate.outputs';

/** Control work after the gate: external Linux, or hosted overflow the gate chose. */
export const iosControlRunner = plannedControlLinuxRunner(`${GATE_OUTPUT}.control_runner_labels`);

/** Required verdicts that unblock a completed E2E run use the control route. */
export const iosCompletionVerdictRunner = iosControlRunner;

/**
 * The control route without the fork test, for the two jobs that hold a
 * deployment environment: their secrets and approvals already decide who may
 * run them, so the route is the repository variable or hosted Linux.
 */
export const trustedControlRunner = trustedControlLinuxRunner;

/** The advisory video lane: trusted external Linux, hosted only as a fallback. */
export const videoProcessingRunner = trustedRouteLabels(
  'IOS_CONTROL_RUNNER_LABELS',
  ['self-hosted', 'Linux', 'linux-remote'],
);

/** The reserved Mac is opt-in for a manual dispatch; PRs retain their shared route. */
const RESERVED_MANUAL_MAC = "github.event_name == 'workflow_dispatch' && inputs.mac_runner == 'mitchell-reserved'";
// The admitted exact-develop release run executes reviewed source code, and
// the team Mac pool has no ios-xcode runners. Keep only this release scope in
// the reviewed pool; other ordinary manual dispatches retain their team route.
const PROMOTION_EVIDENCE = "github.event_name == 'workflow_dispatch' && inputs.test_scope == 'promotion-evidence'";

export const selectedMacLabels = expr(
  `(${RESERVED_MANUAL_MAC}) && '${JSON.stringify(reservedMacLabels)}' `
  + `|| '${JSON.stringify(sharedMacLabels)}'`,
);

/** Capability labels for the selected physical Mac pool. */
export const macJobLabels = selectedMacLabels;

function macRunner(group: ExpressionValue): { readonly group: string; readonly labels: string } {
  return { group: String(group), labels: String(expr(`fromJson(${macJobLabels.expression})`)) };
}

/** A step only a physical Mac needs: it reclaims disk the pool keeps between runs. */
export const POOL_MAC_ONLY = "runner.environment == 'self-hosted'";

/** Pull request code and develop queue candidates: reviewed changes on their way in. */
const REVIEWED_CHANGE = ciEventCondition('reviewedChange');

/**
 * Pull request code, queue candidates, the reserved Mac, and exact-develop
 * promotion evidence run in the reviewed pool. Other manual dispatches use
 * the team pool.
 */
export const reviewedPrMacs = macRunner(expr(
  `(${REVIEWED_CHANGE} || (${RESERVED_MANUAL_MAC}) || (${PROMOTION_EVIDENCE})) `
  + "&& 'example-reviewed-pr-macs' || 'example-team-macs'",
));

/**
 * The same split, plus the two evidence scopes a person dispatches against an
 * open pull request: they execute that pull request's code, so they belong on
 * the reviewed pool even though the event is not `pull_request`.
 */
export const evidenceScopeMacs = macRunner(expr(
  `(( ${RESERVED_MANUAL_MAC} ) || ${REVIEWED_CHANGE} `
  + "|| inputs.test_scope == 'financial-independence-evidence' "
  + `|| inputs.test_scope == 'shared-cta-evidence' || (${PROMOTION_EVIDENCE})) `
  + "&& 'example-reviewed-pr-macs' || 'example-team-macs'",
));

/**
 * One lane key per pull request while one is open, per queue candidate, and
 * per run otherwise, so an evidence dispatch can never take the pending slot a
 * pull request's required lane is waiting for.
 */
const LANE_KEY = ciEventConcurrencyKey;

/**
 * The concurrency a scarce lane claims. A new push to the same pull request
 * stops the lanes the old head was holding; every other event waits its turn
 * instead, because nothing else can produce a head this run should abandon.
 */
export function laneConcurrency(...suffix: readonly (string | ExpressionValue)[]): {
  readonly group: ExpressionValue;
  readonly cancelInProgress: string;
} {
  return {
    group: concat('ios-', LANE_KEY, '-', ...suffix),
    cancelInProgress: String(expr(pullRequestOnly.isSynchronize)),
  };
}

/** Linux control work: cheap, reusable across a patch-equivalent head. */
export const controlLane: LaneMetadata = {
  runnerClass: 'hosted-control',
  costClass: 'control',
  evidencePolicy: 'patch-equivalent',
  selectionOwner: 'legacy-ios-selector',
};

/** The native Mac lanes, whose selection the typed native planner owns. */
export const routedNativeMacLane: LaneMetadata = {
  runnerClass: 'macos-physical',
  costClass: 'expensive',
  evidencePolicy: 'patch-equivalent',
  selectionOwner: 'typed-ios-native',
};

/** The real-server E2E Mac lanes, still selected by the shell selector. */
export const e2eMacLane: LaneMetadata = {
  runnerClass: 'macos-physical',
  costClass: 'expensive',
  evidencePolicy: 'patch-equivalent',
  selectionOwner: 'legacy-ios-selector',
};

/** The development-environment schema check: Linux, but it talks to a database. */
export const schemaLane: LaneMetadata = {
  runnerClass: 'hosted-control',
  costClass: 'light',
  evidencePolicy: 'patch-equivalent',
  selectionOwner: 'legacy-ios-selector',
};

/** The advisory video processing lane, on trusted external Linux. */
export const videoLane: LaneMetadata = {
  runnerClass: 'linux-self-hosted',
  costClass: 'medium',
  evidencePolicy: 'patch-equivalent',
  selectionOwner: 'legacy-ios-selector',
};

/** Artifact removal: it produces no evidence and is driven by the controller. */
export const cleanupLane: LaneMetadata = {
  runnerClass: 'hosted-control',
  costClass: 'control',
  evidencePolicy: 'none',
  selectionOwner: 'controller',
};

export const CHECKOUT = 'actions/checkout@v7.0.1';
export const SETUP_NODE = 'actions/setup-node@v7.0.0';
export const CREATE_APP_TOKEN = 'actions/create-github-app-token@v3.2.0';
export const CACHE_SAVE = 'actions/cache/save@v6.1.0';
export const CACHE_RESTORE = 'actions/cache/restore@v6.1.0';
export const UPLOAD_ARTIFACT = 'actions/upload-artifact@v7.0.1';
export const DOWNLOAD_ARTIFACT = 'actions/download-artifact@v8.0.1';
export const NODE_VERSION = '26.5.0';

/** One output of the gate every other job in this workflow is selected from. */
export function iosGateOutputPath(name: keyof typeof iosGateOutputs): string {
  return `needs.ios-change-gate.outputs.${name}`;
}

export function iosGateOutput(name: keyof typeof iosGateOutputs): ExpressionValue {
  return expr(iosGateOutputPath(name));
}

/**
 * When a status aggregate is allowed to publish a verdict.
 *
 * An aggregate is a required check, so it reports however its lanes finished
 * (`always()`) and stays silent only where a verdict would be wrong or
 * useless: after a cancellation, for the credential-sync dispatch that
 * allocates no lanes to report on, while a pull request is still a draft, and
 * for manual credential synchronization. Title/body edits never start this
 * workflow, while base retargets are refreshed by the trusted controller.
 */
export const STATUS_AGGREGATE_CONDITION =
  "always() && !cancelled() && inputs.test_scope != 'observability-credential-sync' "
  + `&& ${ciEventCondition('ready')}`;
export const STATUS_AGGREGATE_IF = expr(STATUS_AGGREGATE_CONDITION);

/** The base revision the workflow pinned at the top, which reviewed code lives at. */
export const TRUSTED_BASE_SHA = expr('env.EXAMPLE_CI_TRUSTED_BASE_SHA');

/** The proved typed revision, with a safe base fallback when admission failed. */
export const TRUSTED_VERIFIER_SHA = expr(
  `${iosGateOutputPath('verifier_sha')} || env.EXAMPLE_CI_TRUSTED_BASE_SHA`,
);

/** The head under test, which is the revision the Mac lanes build and run. */
export const EXACT_HEAD_SHA = expr('env.EXAMPLE_CI_EXACT_HEAD_SHA');

/**
 * The same revision read straight off the event rather than through the
 * workflow's `env`. The two are equal by construction, but a Mac lane names
 * the event: `env` is workflow-level state a later change could redefine,
 * while the head under review (a PR head or a queue candidate) is the thing
 * being tested, and these are the jobs that check out, build and cache-key on it.
 */
export const EXACT_HEAD = ciEventField('headSha');

/**
 * Where the Mac lanes run. The Xcode project is under `ios/`, so every `run`
 * in those jobs resolves against it and reaches the repository through `../`.
 */
export const IOS_PROJECT_DEFAULTS: StepsJobConfig['defaults'] = { run: { workingDirectory: 'ios' } };

export interface TypedLayerCheckout {
  /** What the step is called; it says which program the checkout is for. */
  readonly name: string;
  /** Where it lands, beside the workspace rather than in it. */
  readonly path: `.ci/${string}`;
  /** The revision to materialise, usually the proven typed verifier SHA. */
  readonly ref: ExpressionValue;
  readonly if?: ConditionLike;
  /** Extra trusted paths a control step must inspect without executing them. */
  readonly sparseCheckout?: string;
}

/**
 * The `ci/` layer alone, at one revision, in its own directory: enough to run
 * a typed program and nothing else. A control job that needs the whole
 * workspace uses `trustedBaseCheckout` instead.
 */
export function typedLayerCheckout(options: TypedLayerCheckout): TypedStep {
  return typedStep({
    name: options.name,
    doc: {
      purpose: 'Materialises the typed CI layer this job runs its program from, at the revision it trusts.',
      recovery: 'retry; a repeated failure is a GitHub or runner network problem',
    },
    owner: 'infrastructure',
    category: 'environment',
    unit: 'step',
    ...(options.if === undefined ? {} : { if: options.if }),
    uses: CHECKOUT,
    with: {
      ref: options.ref,
      path: options.path,
      'persist-credentials': false,
      'fetch-depth': 1,
      'sparse-checkout': options.sparseCheckout ?? 'ci\n',
    },
  });
}

/**
 * The whole proved verifier workspace, for aggregates that run typed
 * programs out of `ci/` and install with that revision's lockfile.
 */
export function trustedBaseCheckout(): TypedStep {
  return typedStep({
    name: 'Checkout proven iOS verifier workspace',
    doc: {
      purpose: 'Puts the base verifier, or the proven develop checkpoint on first promotion, in the workspace.',
      recovery: 'retry; a repeated failure is a GitHub or runner network problem',
    },
    owner: 'infrastructure',
    category: 'environment',
    unit: 'step',
    uses: CHECKOUT,
    with: { ref: TRUSTED_VERIFIER_SHA, 'persist-credentials': false },
  });
}

/**
 * Only a job that runs a typed program needs a runtime, and several of them
 * only run one under a condition, so the condition travels with the step
 * rather than being restated beside it.
 */
export interface ConditionalStep {
  readonly if?: ConditionLike;
}

/** The Node.js runtime every typed program on these runners executes under. */
export function setupNode(name: string, options: ConditionalStep = {}): TypedStep {
  return typedStep({
    name,
    doc: {
      purpose: 'Installs the Node.js version the typed CI programs in this job are executed with.',
      recovery: 'check the pinned Node version is still published for this runner architecture',
    },
    owner: 'infrastructure',
    category: 'environment',
    unit: 'step',
    ...(options.if === undefined ? {} : { if: options.if }),
    uses: SETUP_NODE,
    with: { 'node-version': NODE_VERSION, 'package-manager-cache': false },
  });
}

/**
 * The read-only App token the PR metadata reads fall back to when the run
 * token is throttled. A fork head and Dependabot get no token at all: the
 * secrets are not theirs to spend, and the run token already reads what a
 * public pull request exposes.
 */
export function prMetadataToken(name: string): TypedStep<'token'> {
  return typedStep({
    id: 'pr-metadata-token',
    name,
    doc: {
      purpose: 'Mints the read-only App token this job falls back to when the run token is throttled.',
      recovery: 'check the App installation still grants contents and pull-requests read',
    },
    owner: 'automation',
    category: 'coordination',
    unit: 'step',
    if: expr(
      "github.event_name == 'workflow_dispatch' "
      + `|| (${ciEventCondition('sameRepositoryPullRequest')} && github.actor != 'dependabot[bot]')`,
    ),
    outputs: ['token'] as const,
    uses: CREATE_APP_TOKEN,
    with: {
      'app-id': secret('PROMOTION_CHECKPOINT_APP_ID'),
      'private-key': secret('PROMOTION_CHECKPOINT_APP_PRIVATE_KEY'),
      'permission-contents': 'read',
      'permission-pull-requests': 'read',
    },
  });
}

/**
 * The shell `resetOversizedDedicatedRunnerCheckout` runs, byte for byte as the
 * workflow ran it. It refuses any workspace but the one the runner it is named
 * for owns, and refuses a symlink or a file where a directory belongs, so a
 * re-homed runner stops the job rather than deleting something else.
 */
const RESET_OVERSIZED_CHECKOUT_SHELL = `set -euo pipefail
workspace="\${GITHUB_WORKSPACE:-}"
if [ "$workspace" != "$EXPECTED_GITHUB_WORKSPACE" ]; then
  echo "::error::Refusing checkout reset for unexpected workspace: $workspace"
  exit 1
fi
if [ ! -e "$workspace" ]; then
  echo "No prior dedicated-runner checkout exists."
  exit 0
fi
if [ -L "$workspace" ] || [ ! -d "$workspace" ]; then
  echo "::error::Refusing checkout reset for unsafe workspace: $workspace"
  exit 1
fi

git_dir="$workspace/.git"
if [ ! -e "$git_dir" ]; then
  echo "Prior workspace has no Git metadata; checkout will recreate it."
  exit 0
fi
if [ -L "$git_dir" ] || [ ! -d "$git_dir" ]; then
  echo "::error::Refusing checkout reset for unsafe Git metadata: $git_dir"
  exit 1
fi

git_dir_kb="$(du -sk "$git_dir" | awk '{print $1}')"
if [[ ! "$git_dir_kb" =~ ^[0-9]+$ ]]; then
  echo "::error::Unable to measure prior Git metadata."
  exit 1
fi
if (( git_dir_kb <= MAX_REUSABLE_GIT_DIR_KB )); then
  echo "Reusing bounded dedicated-runner Git metadata (\${git_dir_kb} KB)."
  exit 0
fi

echo "Removing oversized runner-owned Git metadata (\${git_dir_kb} KB)."
rm -rf -- "$git_dir"
if [ -e "$git_dir" ]; then
  echo "::error::Oversized Git metadata still exists after reset."
  exit 1
fi
`;

/**
 * The exact head, with enough history for the affected-test selector to reach
 * the pull request base and without the blobs nothing reads. Every Mac lane
 * that builds the code under review takes this checkout; they differ only in
 * what the step is called, which is what says whose revision guard follows it.
 */
export function exactHeadMacCheckout(name: string): TypedStep {
  return typedStep({
    name,
    doc: {
      purpose: 'Materialises the head under test on the Mac that builds and runs it.',
      recovery: 'retry; a repeated failure is a GitHub or runner network problem',
    },
    owner: 'infrastructure',
    category: 'environment',
    unit: 'step',
    uses: CHECKOUT,
    with: {
      // Promotion dispatches explicitly fetch their divergent base after the
      // gate-proven revision guard; PR selection uses this bounded history.
      'fetch-depth': 64,
      filter: 'blob:none',
      'persist-credentials': false,
      ref: EXACT_HEAD,
    },
  });
}

/**
 * The native selector runs without Git credentials on a blob:none checkout, so
 * every blob it reads must be local first. Promotion also fetches and proves
 * its divergent main base; other events keep the checkout's own history.
 */
export function prepareNativeSelectorHistory(): TypedStep {
  return typedStep({
    name: 'Prepare native selector history',
    doc: {
      purpose: 'Fetches, with credentials, the history and file contents the native selector compares.',
      recovery: 'inspect the immutable source/base tuple or Git fetch failure, then rerun the job',
    },
    owner: 'infrastructure',
    category: 'planning',
    unit: 'step',
    env: {
      GITHUB_TOKEN: expr('github.token'),
      IOS_AFFECTED_TESTS_BASE: iosGateOutput('expected_base_sha'),
      IOS_AFFECTED_TESTS_HEAD: EXACT_HEAD,
      IOS_SELECTOR_HISTORY: expr("github.event_name == 'workflow_dispatch' "
        + "&& inputs.test_scope == 'promotion-evidence' && 'promotion' || 'checkout'"),
    },
    command: 'node ../ci/src/actions/ios/prepareNativeSelectorHistory.ts',
  });
}

/**
 * The simulator scripts branch on whether they are on a hosted runner, and
 * `runner.environment` is not in the environment they read. Publishing it once
 * per job is what makes a hosted-only guard reachable from a plain shell.
 *
 * It runs from `runner.temp` because it runs before the checkout: the
 * workspace may not exist yet, and a `run` with nowhere to start fails.
 */
export function exportSimulatorRunnerEnvironment(): TypedStep {
  return typedStep({
    name: 'Export simulator runner environment',
    doc: {
      purpose: 'Publishes the runner environment as a variable the simulator scripts can branch on.',
      recovery: 'retry; a failure here is the runner refusing to write the job environment file',
    },
    owner: 'infrastructure',
    category: 'environment',
    unit: 'step',
    shell: 'bash',
    workingDirectory: String(runner('temp')),
    env: { SIMULATOR_RUNNER_ENVIRONMENT: runner('environment') },
    command: 'printf \'RUNNER_ENVIRONMENT=%s\\n\' "$SIMULATOR_RUNNER_ENVIRONMENT" >> "$GITHUB_ENV"',
  });
}

/**
 * The two dedicated Macs keep their workspace between runs, and a `.git` that
 * is never repacked grows until the volume is full. This drops it when it is
 * past the bound so the next checkout recreates a small one, and leaves it
 * alone when it is still worth reusing.
 *
 * The shell stays in the workflow because it deletes `$GITHUB_WORKSPACE/.git`
 * before the checkout that would put a script there: a `scripts/ci` program
 * would have to live in the tree it is resetting, and would not exist yet.
 */
export function resetOversizedDedicatedRunnerCheckout(): TypedStep {
  return typedStep({
    name: 'Reset oversized dedicated-runner checkout',
    doc: {
      purpose: 'Drops a persistent runner Git directory that has grown past the size worth reusing.',
      recovery: 'read the workspace path it refused; an unexpected path means the runner was re-homed',
    },
    owner: 'infrastructure',
    category: 'cleanup',
    unit: 'step',
    if: expr(
      "runner.name == 'Mitchells-MacBook-Air-ios-24gb' "
      + "|| runner.name == 'Mitchells-MacBook-Air-control-capacity'",
    ),
    shell: 'bash',
    workingDirectory: String(runner('temp')),
    env: {
      EXPECTED_GITHUB_WORKSPACE: expr(
        "runner.name == 'Mitchells-MacBook-Air-ios-24gb' "
        + "&& '/home/example/actions-runner-example-app/_work/example-app/example-app' "
        + "|| '/home/example/actions-runner-example-app-ios-24gb-2-clean/_work/example-app/example-app'",
      ),
      MAX_REUSABLE_GIT_DIR_KB: '300000',
    },
    inlineShell: {
      reason: 'it deletes $GITHUB_WORKSPACE/.git before the checkout that would put a script there, '
        + 'so a scripts/ci program would have to live in the tree it is resetting and would not exist yet',
    },
    command: RESET_OVERSIZED_CHECKOUT_SHELL,
  });
}

export { installTypedCiDependencies } from '../lib/typedCiDependencies.ts';

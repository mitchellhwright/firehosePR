import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifiedGitBlobSource } from '../githubGitBlob.ts';
import { iosE2eProductWorkflowContract } from './queueLaneExecutionContract.ts';

import {
  classifyIosChangedPaths,
  isIosIrrelevantPath,
  IOS_E2E_AUXILIARY_LANES,
  type IosE2eAuxiliaryLane,
} from './iosChangeClassification.ts';

/**
 * A file record from GitHub's compare API. This decision needs only names and
 * rename provenance; keeping that boundary small lets the trusted controller
 * pass the API response through without translating it.
 */
export interface IosExecutionComparisonFile {
  readonly filename?: string;
  readonly previous_filename?: string;
  readonly status?: string;
}

const MAX_COMPLETE_COMPARISON_FILES = 300;

const IOS_WORKFLOW_SOURCE = readFileSync(
  new URL('../../../.github/workflows/ios-tests.yml', import.meta.url),
  'utf8',
);

// Scripts Test - iOS depends on without naming them in generated YAML. A
// source scan catches the ordinary commands; this bounded set carries the
// remaining transitive runtime inputs. ci/tests/iosChangeClassification.test.ts
// proves it stays aligned with the affected-file gate.
const IOS_WORKFLOW_TRANSITIVE_SCRIPT_INPUTS = new Set([
  'ci/src/actions/ios/externalProviderAuditHook.ts',
  'scripts/generate-api-types.js',
  'scripts/generate-chat-context-schema.js',
  'scripts/generate-user-profile-ts-types.js',
  'scripts/generate-user-profile-types.js',
  'scripts/ios-test.ts',
  'ci/src/ios/workflowOnlyPaths.ts',
  'scripts/ios-workflow-native-selection.ts',
  'scripts/prepare-local-gcp-adc.sh',
  'scripts/swift-test-impact.ts',
  'ci/src/actions/ios/validateFinancialIndependenceEvidence.ts',
  'ci/src/actions/ios/validateOnboardingCopyEvidence.ts',
  'ci/src/videoReview/identities.ts',
  'scripts/ci/generated/workflow-names.ts',
]);

// Fleet maintenance may install these programs outside the Test - iOS
// workflow. Unlike its dispatch workflow, they configure the Mac environment
// in which native products are built and tested.
const IOS_MAC_HOST_ENVIRONMENT_INPUTS = new Set([
  'scripts/activate-github-actions-runner-environment.sh',
  'scripts/setup-github-macos-runner.sh',
  'scripts/provision-github-macos-runner-tools.sh',
]);

export { IOS_E2E_AUXILIARY_LANES, type IosE2eAuxiliaryLane } from './iosChangeClassification.ts';

// Typed CI is repository-wide, but only runtime programs can change a Test -
// iOS result directly. Workflow-generator sources are deliberately absent:
// their runtime contract is the checked generated ios-tests.yml artifact, so
// comment, type-only, and refactor-only generator edits cannot invalidate Mac
// evidence when that artifact is unchanged.
const IOS_TYPED_CI_EXECUTION_INPUTS = new Set([
  'ci/package.json',
  'ci/package-lock.json',
  'ci/src/runnerPolicy.ts',
  'ci/src/githubGit.ts',
  'ci/src/githubGitBlob.ts',
  'ci/src/githubReadRetry.ts',
  'ci/src/workflowContract.ts',
  'ci/workflows/action-pins.json',
]);

/**
 * Role of an iOS CI source that cannot change how a Test - iOS lane builds or
 * runs, what a passing Test - iOS result means, or whether earlier evidence
 * counts. `selection` decides which tests and lanes a head needs; `controller`
 * routes control jobs, cancels runs, cleans up artifacts, or syncs credentials.
 * Either role makes a base update re-plan selection instead of discarding Mac
 * evidence. Every other file under the iOS CI trees is an execution input:
 * build and run programs, verdict and status programs, promotion proofs, the
 * gate precheck and its lints, and any file added later.
 */
export type IosCiPlanningRole = 'selection' | 'controller';

export const IOS_CI_PLANNING_ROLES = {
  // These inputs change which native UI methods a head selects. A PR touching
  // only them needs CI contracts, but a later base update must re-plan before
  // earlier Mac evidence can be reused.
  'ios/ci/ui-test-duration-weights.json': 'selection',
  'ios/ci/ui-test-primary-exclusions.txt': 'selection',
  'scripts/select-ios-affected-tests.ts': 'selection',
  'ci/src/ios/changedFileCoverage.ts': 'selection',
  'ci/src/ios/changedFileOwnership.ts': 'selection',
  'ci/src/ios/iosChangeClassification.ts': 'selection',
  'ci/src/ios/iosChangeGate.ts': 'selection',
  'ci/src/ios/iosExecutionInputs.ts': 'selection',
  // The iOS gate reads shared runner labels to place its control jobs. A
  // Linux routing edit cannot change completed Mac execution; the
  // gate re-plans on the current head, while generated YAML captures any
  // changed iOS job definition.
  'ci/src/runnerPolicy.ts': 'controller',
  // Fleet maintenance dispatches work to durable hosts but does not define
  // their Xcode, simulator, build, or test inputs. Changes to the host setup
  // programs remain execution inputs under scripts/ and ios/.
  '.github/workflows/install-runner-cleanup-hooks.yml': 'controller',
  'ci/src/ios/promotionChangedFiles.ts': 'selection',
  'ci/src/ios/workflowOnlyPaths.ts': 'selection',
  'ci/src/actions/ios/detectIosChanges.ts': 'selection',
  'ci/src/actions/ios/ensureIosMergeBase.ts': 'selection',
  'ci/src/actions/ios/prepareNativeSelectorHistory.ts': 'selection',
  'ci/src/actions/ios/prewarmNativeSelectorBlobs.ts': 'selection',
  'ci/src/ios/observabilityCredentialSync.ts': 'controller',
  'ci/src/ios/runArtifactCleanup.ts': 'controller',
  'ci/src/actions/ios/removeRunArtifacts.ts': 'controller',
  'ci/src/actions/ios/syncObservabilityCredential.ts': 'controller',
  // These programs run in the queue control job after the PR's Mac evidence
  // exists. They decide whether to use that evidence; no Mac lane executes them.
  'ci/src/ios/queueEvidenceReuse.ts': 'controller',
  'ci/src/ios/queueEvidenceReuseRecord.ts': 'controller',
  'ci/src/ios/queueLaneExecutionContract.ts': 'controller',
  'ci/src/ios/workflowEvidenceInputs.ts': 'controller',
  'ci/src/actions/ios/planQueueEvidenceReuse.ts': 'controller',
  // The trusted Linux adapter decides reuse and re-plans selection; Mac jobs
  // never load it to compile or execute the selected tests.
  'ci/src/ios/controllers/baseUpdateDelta.ts': 'controller',
  'ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts': 'controller',
  'ci/src/actions/ios/findQueuedPullRequestEvidence.ts': 'controller',
} as const satisfies Readonly<Record<string, IosCiPlanningRole>>;

export type IosCiPlanningPath = keyof typeof IOS_CI_PLANNING_ROLES;

export function iosCiPlanningRole(path: string): IosCiPlanningRole | undefined {
  return Object.hasOwn(IOS_CI_PLANNING_ROLES, path)
    ? IOS_CI_PLANNING_ROLES[path as IosCiPlanningPath]
    : undefined;
}

export function isIosTypedCiExecutionInput(path: string): boolean {
  return IOS_TYPED_CI_EXECUTION_INPUTS.has(path)
    || path.startsWith('ci/src/actions/ios/')
    || path.startsWith('ci/src/ios/');
}

function isCompleteComparison(
  files: readonly IosExecutionComparisonFile[] | null | undefined,
): files is readonly (IosExecutionComparisonFile & { readonly filename: string })[] {
  return Array.isArray(files)
    && files.length < MAX_COMPLETE_COMPARISON_FILES
    && files.every((file) => typeof file.filename === 'string' && file.filename.length > 0);
}

function isIosWorkflowScriptInput(path: string): boolean {
  return IOS_WORKFLOW_TRANSITIVE_SCRIPT_INPUTS.has(path)
    || (path.startsWith('scripts/')
      && !path.startsWith('scripts/tests/')
      && IOS_WORKFLOW_SOURCE.includes(path));
}

/** A path in the input closure of every Mac lane: changing it invalidates earlier iOS evidence. */
export function isIosEvidenceInvalidatingInput(path: string): boolean {
  if (iosCiPlanningRole(path) !== undefined) return false;
  // Xcode Cloud tag reconciliation is a separate post-build control workflow.
  // Its script names contain "xcode", but it never builds or tests the PR app.
  // A future direct ios-tests.yml reference still invalidates through the
  // workflow-script closure below.
  const unrelatedTagReconciler = path.startsWith('scripts/ci/xcode-cloud-build-tags/');
  return (path.startsWith('ios/') && !isIosIrrelevantPath(path))
    || path.startsWith('shared/schemas/fixtures/')
    || IOS_MAC_HOST_ENVIRONMENT_INPUTS.has(path)
    || isIosWorkflowScriptInput(path)
    || (!unrelatedTagReconciler
      && /^scripts\/.*(?:ios|xcode|simulator|xcresult|e2e|onboarding)/i.test(path))
    || isIosTypedCiExecutionInput(path)
    || path === '.github/workflows/ios-tests.yml'
    || path === 'package.json'
    || path === 'package-lock.json';
}

const LANE_CLAIMS: Readonly<Record<
  IosE2eAuxiliaryLane,
  'onboardingRequired' | 'chatPlaidRequired' | 'incomeRequired' | 'budgetRequired'
>> = {
  onboarding: 'onboardingRequired',
  'chat-plaid': 'chatPlaidRequired',
  income: 'incomeRequired',
  budget: 'budgetRequired',
};

/**
 * The real-server lanes a changed path must rerun: the lanes a journey claims
 * for it, otherwise every lane that reads it (`isIosRealServerRuntimeInput`).
 */
function realServerLanesFor(path: string): {
  readonly lanes: readonly IosE2eAuxiliaryLane[];
  readonly claimed: boolean;
} {
  const reading = IOS_E2E_AUXILIARY_LANES.filter((lane) => isIosRealServerRuntimeInput(path, lane));
  if (reading.length === 0 || !path.startsWith('server/')) return { lanes: reading, claimed: false };
  const classification = classifyIosChangedPaths([path]);
  const claimed = reading.filter((lane) => classification[LANE_CLAIMS[lane]]);
  return claimed.length > 0 ? { lanes: claimed, claimed: true } : { lanes: reading, claimed: false };
}

export interface IosBaseLineageReusePlan {
  /** Any one of these paths means no earlier iOS lane may be reused. */
  readonly invalidatingPaths: readonly string[];
  /**
   * Selection or controller paths. Earlier lanes stay usable only when the
   * re-planned selection is covered by the selection that produced them.
   */
  readonly replanPaths: readonly string[];
  /** Server/runtime paths the current head must exercise against the reused app. */
  readonly changedFiles: readonly string[];
  /** Real-server lanes selected by those runtime paths. */
  readonly rerunAuxiliary: readonly IosE2eAuxiliaryLane[];
}

/**
 * Separates compiled-product/Test-iOS changes from server-only changes. A
 * server-only base advance may keep exact prior native evidence while the
 * affected real-server lane exercises the current backend. Server paths a
 * journey claims rerun that journey's lane; every other real-server runtime
 * input reruns each lane `isIosRealServerRuntimeInput` says reads it.
 */
export function iosBaseLineageReusePlan(
  files: readonly IosExecutionComparisonFile[] | null | undefined,
): IosBaseLineageReusePlan | null {
  if (!isCompleteComparison(files)) return null;
  const paths = [...new Set(files.flatMap((file) => [
    file.filename,
    ...(file.status === 'renamed' && typeof file.previous_filename === 'string'
      ? [file.previous_filename]
      : []),
  ]))];
  const invalidatingPaths = paths.filter(isIosEvidenceInvalidatingInput);
  const replanPaths = paths.filter((path) => iosCiPlanningRole(path) !== undefined);
  const routes = paths
    .map((path) => ({ path, ...realServerLanesFor(path) }))
    .filter((route) => route.lanes.length > 0);
  const serverPaths = routes.map((route) => route.path);
  // A runtime input no journey claims (chat docs, an unlisted service, shared
  // code, root configuration) reruns every lane whose closure contains it
  // rather than being treated as irrelevant.
  const changedFiles = routes.every((route) => route.claimed)
    ? classifyIosChangedPaths(serverPaths).iosChangedFiles
    : serverPaths;
  const rerunAuxiliary = IOS_E2E_AUXILIARY_LANES.filter((lane) => (
    routes.some((route) => route.lanes.includes(lane))
  ));
  return { invalidatingPaths, replanPaths, changedFiles, rerunAuxiliary };
}

/**
 * Returns the exact base-lineage paths that prevent reusing iOS evidence
 * without a new decision: execution inputs, and the selection and controller
 * paths only the base-update classifier can re-plan. `null` means GitHub did
 * not provide a complete inventory and therefore remains a fail-closed answer.
 */
export function iosExecutionScopeChangedPaths(
  files: readonly IosExecutionComparisonFile[] | null | undefined,
): string[] | null {
  const plan = iosBaseLineageReusePlan(files);
  return plan === null ? null : [...plan.invalidatingPaths, ...plan.replanPaths];
}

/**
 * Whether a base-lineage comparison changed anything that can alter a Test -
 * iOS result. Missing, truncated and malformed comparisons fail closed.
 */
export function iosExecutionScopeChanged(
  files: readonly IosExecutionComparisonFile[] | null | undefined,
): boolean {
  const changed = iosExecutionScopeChangedPaths(files);
  return changed === null || changed.length > 0;
}

interface GitTreeEntry {
  readonly path?: string;
  readonly type?: string;
  readonly sha?: string;
  readonly mode?: string;
}

interface GitTreeResponse {
  readonly truncated?: boolean;
  readonly tree?: readonly GitTreeEntry[];
}

const GIT_OBJECT_SHA = /^[a-f0-9]{40}$/;
const GIT_OBJECT_MODE = /^[0-9]{6}$/;

function isGitTreeResponse(value: unknown): value is GitTreeResponse {
  return typeof value === 'object' && value !== null;
}

/**
 * Cryptographically names every iOS source, test plan, referenced build script,
 * verified producer/dependency workflow contract, and typed runtime program that can produce
 * the shared E2E products. Generator sources are represented by their checked
 * generated artifact. The archive's exact-head and Xcode manifest then bind
 * the opaque cache payload to this digest.
 */
function completeProductTree(value: unknown): readonly GitTreeEntry[] | null {
  if (!isGitTreeResponse(value) || value.truncated !== false || !Array.isArray(value.tree)
    || !value.tree.every((entry) => (
      entry !== null && typeof entry === 'object'
      && typeof entry.path === 'string' && entry.path.length > 0
      && ['blob', 'tree', 'commit'].includes(entry.type ?? '')
      && GIT_OBJECT_SHA.test(entry.sha ?? '')
      && GIT_OBJECT_MODE.test(entry.mode ?? '')
    )) || new Set(value.tree.map((entry) => entry.path)).size !== value.tree.length) return null;
  return value.tree;
}

export function iosE2eProductWorkflowSha(value: unknown): string | null {
  const entries = completeProductTree(value)?.filter((entry) => entry.path === '.github/workflows/ios-tests.yml');
  const entry = entries?.[0];
  return entries?.length === 1 && entry?.type === 'blob' ? entry.sha ?? null : null;
}

export function iosE2eProductInputDigest(value: unknown, workflowBlob: unknown): string | null {
  const tree = completeProductTree(value);
  if (tree === null) return null;
  const workflowSha = iosE2eProductWorkflowSha(value);
  const workflowSource = workflowSha === null ? null : verifiedGitBlobSource(workflowBlob, workflowSha);
  const workflowContract = workflowSource === null ? null : iosE2eProductWorkflowContract(workflowSource);
  if (workflowContract === null) return null;
  const entries = tree.filter((entry) => entry.type === 'blob' && (
    entry.path?.startsWith('ios/')
    || (entry.path !== undefined && isIosTypedCiExecutionInput(entry.path)
      && iosCiPlanningRole(entry.path) === undefined)
    || (entry.path !== undefined && isIosWorkflowScriptInput(entry.path))
  )).sort((left, right) => (left.path ?? '').localeCompare(right.path ?? ''));
  if (!entries.some((entry) => entry.path?.startsWith('ios/'))
    || !entries.some((entry) => entry.path === 'scripts/build-ios-e2e-test-products.sh')) {
    return null;
  }
  // Git permits whitespace and separators in file names. JSON keeps the
  // content framing unambiguous, so one unusual path cannot masquerade as two
  // ordinary inventory entries in the digest preimage.
  const canonical = JSON.stringify({
    schema: 'example-ios-e2e-product-inputs-v2',
    workflowContract,
    testPlan: 'CI-E2E',
    entries: entries.map((entry) => [entry.mode, entry.path, entry.sha]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** The trees the real-server lanes' backend comes from. */
export const REAL_SERVER_SOURCE_ROOTS = ['server/', 'pages/', 'shared/'] as const;

export const REAL_SERVER_LANE_INPUTS_SCHEMA = 'example.real-server-lane-inputs.v1';

/**
 * The generated per-lane input exceptions (`ci/contracts/real-server-lane-inputs.v1.json`):
 * the paths whose lanes differ from `defaultRealServerLanes`.
 */
export interface RealServerLaneInputsContract {
  readonly schema: typeof REAL_SERVER_LANE_INPUTS_SCHEMA;
  /** Each known path appears in exactly one group; `lanes` may be empty. */
  readonly groups: readonly {
    readonly lanes: readonly IosE2eAuxiliaryLane[];
    readonly paths: readonly string[];
  }[];
}

/** Paths only a test runner reads. No lane loads one; the generator enforces it. */
export function isRealServerTestOnlyPath(path: string): boolean {
  return path.startsWith('server/tests/')
    || path === 'server/vitest.config.ts'
    || /\.test\.tsx?$/.test(path);
}

function isLaneList(value: unknown): value is readonly IosE2eAuxiliaryLane[] {
  return Array.isArray(value)
    && value.every((lane) => (IOS_E2E_AUXILIARY_LANES as readonly unknown[]).includes(lane));
}

/** Indexes a contract by path, rejecting anything but a well-formed v1 contract. */
export function realServerLaneInputIndex(
  value: unknown,
): ReadonlyMap<string, readonly IosE2eAuxiliaryLane[]> {
  const contract = value as Partial<RealServerLaneInputsContract> | null;
  if (contract?.schema !== REAL_SERVER_LANE_INPUTS_SCHEMA || !Array.isArray(contract.groups)) {
    throw new Error(`Real-server lane inputs are not a ${REAL_SERVER_LANE_INPUTS_SCHEMA} contract; `
      + 'regenerate them with `npm run ci:server-lane-inputs`.');
  }
  const index = new Map<string, readonly IosE2eAuxiliaryLane[]>();
  for (const group of contract.groups) {
    if (!isLaneList(group.lanes) || !Array.isArray(group.paths)) {
      throw new Error('Real-server lane inputs contain a malformed group; regenerate them.');
    }
    for (const path of group.paths) {
      if (typeof path !== 'string' || index.has(path)) {
        throw new Error(`Real-server lane inputs list ${String(path)} twice or malformed; regenerate them.`);
      }
      index.set(path, group.lanes);
    }
  }
  return index;
}

let committedLaneInputs: ReadonlyMap<string, readonly IosE2eAuxiliaryLane[]> | undefined;

function laneInputs(): ReadonlyMap<string, readonly IosE2eAuxiliaryLane[]> {
  committedLaneInputs ??= realServerLaneInputIndex(JSON.parse(readFileSync(
    new URL('../../contracts/real-server-lane-inputs.v1.json', import.meta.url),
    'utf8',
  )));
  return committedLaneInputs;
}

/**
 * The lanes a path counts for when the contract does not list it: every lane
 * for a non-test file under the backend roots, none for anything else. The
 * contract lists only the paths whose computed lanes differ from this.
 */
export function defaultRealServerLanes(path: string): readonly IosE2eAuxiliaryLane[] {
  return !isRealServerTestOnlyPath(path) && REAL_SERVER_SOURCE_ROOTS.some((root) => path.startsWith(root))
    ? IOS_E2E_AUXILIARY_LANES
    : [];
}

/**
 * Whether real-server E2E lane `lane` can observe `path`: the lanes the
 * contract lists for it, otherwise `defaultRealServerLanes`. Deliberately
 * wider than `iosBaseLineageReusePlan`'s journey routing: a merge queue
 * candidate reuses a real-server result only when none of these moved.
 */
export function isIosRealServerRuntimeInput(path: string, lane: IosE2eAuxiliaryLane): boolean {
  if (isRealServerTestOnlyPath(path)) return false;
  return (laneInputs().get(path) ?? defaultRealServerLanes(path)).includes(lane);
}

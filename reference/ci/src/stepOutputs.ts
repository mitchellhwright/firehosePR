import { prValidationPlanning } from './prValidationPlanning.ts';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';
import { invokedScripts, scriptNamesKey, stepInvocation } from './invokedSources.ts';
import { loadWorkflowGraph, type WorkflowGraph, type WorkflowJob } from './workflowOutputs.ts';

/**
 * Typed contract for step outputs.
 *
 * `workflowOutputs.ts` proves that every `steps.<id>` a job references is a
 * step of that job. This module proves the next level down: that the `<key>`
 * in `steps.<id>.outputs.<key>` is a key the step actually writes. A step
 * writes outputs in one of four ways, and each is resolved statically:
 *
 * 1. A `run:` block appending `key=value` (or `key<<EOF`) to `$GITHUB_OUTPUT`;
 *    the keys are parsed from the shell text.
 * 2. A local action (`./.github/actions/<name>`); the keys are its
 *    `action.yml` outputs.
 * 3. An external action; the keys are pinned in `externalActionOutputs`, so an
 *    action that renames an output is a reviewed change here, not an empty
 *    string at runtime.
 * 4. A `run:` block or typed step action entry that delegates the write to a
 *    script under `scripts/` or `ci/src/`; the keys are pinned in
 *    `scriptStepOutputs`, and every pinned key must be named by the script the
 *    step invokes, or by a script that script invokes in turn, so the table
 *    cannot drift from the source.
 *
 * `validateStepOutputs` reports every reference that none of the four provide.
 * It runs inside `npm run ci:check`.
 */

const actionSchema = z.object({
  outputs: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export interface StepOutputIssue {
  readonly job: string;
  readonly message: string;
}

/** Outputs of the external actions whose outputs this repository reads. */
export const externalActionOutputs = {
  'actions/cache': ['cache-hit', 'cache-primary-key', 'cache-matched-key'],
  'actions/cache/restore': ['cache-hit', 'cache-primary-key', 'cache-matched-key'],
  'actions/checkout': ['ref', 'commit'],
  'actions/create-github-app-token': ['token', 'installation-id', 'app-slug'],
  'actions/download-artifact': ['download-path'],
  'actions/github-script': ['result'],
  'actions/setup-node': ['node-version', 'cache-hit'],
  'actions/upload-artifact': ['artifact-id', 'artifact-url', 'artifact-digest'],
  'google-github-actions/auth': ['project_id', 'credentials_file_path', 'auth_token', 'access_token', 'id_token'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Outputs written by a script a step invokes rather than by the step's own
 * shell text. Keyed by workflow path, job id and step id.
 */
/**
 * The real-server E2E step anchor, shared by all four lanes. Each entry is a
 * typed step program whose keys are written through the shared
 * `$GITHUB_OUTPUT` writer rather than spelled in shell.
 */
const realServerE2eLaneOutputs = {
  'node-modules-key': ['key'],
  sim: ['dest', 'provisioned_udid', 'storekit_runtime_fallback'],
  'prepare-e2e-products': ['rebuild_required'],
  'onboarding-paths': ['debt_card_cache_dir', 'debt_card_cache_manifest', 'debt_card_test_products'],
  'debt-card-build-key': ['build_fingerprint', 'cache_key'],
  'validate-debt-card-test-products': ['usable'],
  'provision-development-full-onboarding-users': ['cleanup_required'],
} as const;

export const scriptStepOutputs = {
  '.github/workflows/ios-tests.yml': {
    'route-initial-control': { 'control-route': ['control_runner_labels'] },
    'ios-change-gate': {
      'control-route': ['control_runner_labels'],
      precheck: [
        'budget_required', 'chat_plaid_required', 'checkpoint_sha', 'evidence_required', 'expected_base_ref',
        'expected_base_sha', 'expected_head_sha', 'income_required', 'needs_checkout',
        'onboarding_required', 'pr_number', 'production_promotion', 'should_run',
        'storekit_required', 'summary', 'verifier_sha',
      ],
      'base-update': [
        'changed_files', 'deferred', 'deferred_base_sha', 'predecessor_run_id', 'predecessor_run_ids',
        'rerun_ios_auxiliary', 'rerun_ios_lanes', 'reuse_e2e_products', 'reuse_native_evidence',
        'reused_e2e_head_sha', 'reused_e2e_producer_job_id', 'reused_e2e_run_attempt',
        'reused_e2e_run_id', 'replan_evidence_head_sha', 'replan_evidence_run_attempt',
        'replan_evidence_run_id', 'replan_record_attempt', 'replan_record_detail', 'replan_selection',
        'replan_successful_jobs', 'superseded', 'valid',
      ],
      detect: [
        'budget_required', 'candidate_gone', 'chat_plaid_required', 'evidence_required',
        'income_required', 'main_required', 'native_changed_files', 'native_changed_files_explicit_empty',
        'onboarding_required', 'should_run', 'storekit_required',
      ],
      pick: [
        'ios_evidence_macos_minimum_execution_free_kb', 'ios_evidence_macos_minimum_free_kb',
        'ios_macos_minimum_execution_free_kb', 'ios_macos_minimum_free_kb',
      ],
      selection: [
        'evidence_groups', 'mode', 'narrow_paywall_required', 'only_testing_file', 'release_archive_required', 'should_run',
        'wellness_only_testing_file', 'wellness_required',
      ],
      'evidence-selection': ['only_testing_file'],
      classify: ['execution_lanes', 'execution_required', 'full_execution_lanes', 'handoff_required', 'producer_mode', 'release_archive_required', 'ui_method_owners', 'ui_required'],
      'promotion-proof': ['proven', 'run_id', 'run_attempt'],
      replan: [
        'budget_required', 'chat_plaid_required', 'covered', 'evidence_required', 'income_required',
        'main_required', 'native_changed_files_explicit_empty', 'native_execution_lanes',
        'native_execution_required', 'native_full_execution_lanes', 'native_handoff_required',
        'native_mode', 'native_release_archive_required', 'native_should_run', 'native_ui_required',
        'onboarding_required', 'reason', 'should_run', 'storekit_required',
      ],
      'queue-evidence-source': [
        'detail', 'pr_head_sha', 'pr_number', 'record_attempt', 'run_attempt', 'run_id', 'status',
        'successful_jobs',
      ],
      'queue-reuse': [
        'budget_required', 'chat_plaid_required', 'evidence_required', 'income_required',
        'main_required', 'native_changed_files_explicit_empty', 'native_execution_lanes',
        'native_execution_required', 'native_full_execution_lanes', 'native_handoff_required',
        'native_mode', 'native_release_archive_required', 'native_should_run', 'native_ui_required',
        'onboarding_required', 'real_server_evidence_reused', 'record', 'should_run',
        'storekit_required',
      ],
    },
    'build-ios-native-test-products': {
      'affected-tests': ['evidence_groups', 'mode', 'narrow_paywall_required', 'only_testing_file'],
      'primary-simulator': ['dest', 'provisioned_udid'],
      'product-build-mode': ['evidence_plan_required', 'mode'],
      'storekit-result': ['result'],
      'storekit-simulator': ['destination', 'provisioned_udid'],
    },
    'build-ios-e2e-test-products': {
      'rebind-reused-e2e-test-products': ['rebuild_required'],
    },
    'test-ios-execution': {
      'affected-tests': [
        'account_update_test_count', 'evidence_groups', 'mode', 'narrow_paywall_required', 'only_testing_file',
        'should_run', 'summary', 'wellness_only_testing_file', 'wellness_required', 'wellness_test_count',
      ],
      'lane-selection': ['mode'],
      'evidence-shard': ['evidence_groups'],
      'prepare-native-products': ['rebuild_required'],
      'primary-simulator': ['dest', 'provisioned_udid'],
      'narrow-simulator': ['dest', 'provisioned_udid'],
    },
    'confirm-current-ios-pr': { current: ['current'] },
    'prepare-dev-e2e-schema': { 'trusted-schema-revision-verifier': ['available'] },
    'onboarding-e2e': realServerE2eLaneOutputs,
    'chat-plaid-e2e': realServerE2eLaneOutputs,
    'income-e2e': realServerE2eLaneOutputs,
    'budget-e2e': realServerE2eLaneOutputs,  },
  '.github/workflows/pr-checks.yml': {
    'route-initial-control': {
      'control-route': ['control_runner_labels'],
    },
    [prValidationPlanning.id]: {
      'base-update': [
        'base_delta_route', 'changed_files', 'deleted_files', 'patch_equivalent',
        'pull_request_deleted_files', 'pull_request_files', 'superseded', 'valid',
      ],
      [prValidationPlanning.inventory.id]: prValidationPlanning.inventory.outputs,
      deleted: ['file_status_available'],
      [prValidationPlanning.selection.id]: prValidationPlanning.selection.outputs,
      pick: [
        'pr_database_runner_labels', 'pr_linux_overflow_labels', 'pr_linux_runner_labels',
        'route_reason',
      ],
      'queue-reuse': ['lane_evidence', 'reused_lanes'],
    },
    ...Object.fromEntries([
      'lint', 'server-static', 'server-process-tests', 'server-tests', 'targeted-server-tests',
      'ios-contracts', 'database-integration',
    ].map((job) => [job, { 'node-modules-key': ['key'] }])),
  },
  '.github/workflows/node-modules-cache.yml': { populate: { 'node-modules-key': ['key'] } },
  '.github/workflows/promotion-checkpoint.yml': {
    checkpoint: {
      checkpoint: [
        'checkpoint_base', 'checkpoint_branch', 'checkpoint_head', 'checkpoint_pr_number', 'checkpoint_url',
      ],
    },
  },
  '.github/workflows/refresh-pr-ci-after-base-edit.yml': {
    'route-initial-control': { 'control-route': ['control_runner_labels'] },
    'fan-out-base-update': { 'fan-out': ['conflicted_pull_requests'] },
    'cancel-obsolete-ios': { 'fan-out': ['conflicted_pull_requests'] },
  },
  '.github/workflows/trusted-production-onboarding-e2e.yml': {
    'validate-trusted-ref': { validate: ['exact_sha'] },
    'production-onboarding-e2e': {
      sim: ['dest', 'provisioned_udid'],
      'provision-production-users': ['cleanup_required'],
      recording: ['available'],
    },
  },
} as const satisfies Record<string, Record<string, Record<string, readonly string[]>>>;

const keyToken = '[A-Za-z_][A-Za-z0-9_-]*';
const echoKeyPattern = new RegExp(`(?:^|[;{(&|]|\\bthen|\\belse|\\bdo)\\s*(?:echo|printf)\\s+(?:-[a-zA-Z]+\\s+)?["']?(${keyToken})(?:=|<<)`, 'gm');
const heredocOpenPattern = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?.*GITHUB_OUTPUT|GITHUB_OUTPUT.*<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;
const bareKeyLinePattern = new RegExp(`^\\s*(${keyToken})=`);
const stepOutputReferencePattern = /steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g;

/**
 * Keys a shell block writes to `$GITHUB_OUTPUT`, parsed statically. A block
 * that never names `GITHUB_OUTPUT` writes nothing. Keys are over-approximated
 * on purpose: an `echo "key=…"` anywhere in a block that also appends to
 * `$GITHUB_OUTPUT` counts, so a grouped `{ … } >> "$GITHUB_OUTPUT"` write is
 * found without parsing shell blocks.
 */
export function writtenOutputKeys(run: string): Set<string> {
  const keys = new Set<string>();
  if (!run.includes('GITHUB_OUTPUT')) return keys;
  for (const match of run.matchAll(echoKeyPattern)) {
    const key = match[1];
    if (key !== undefined) keys.add(key);
  }
  const lines = run.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heredoc = lines[index]?.match(heredocOpenPattern);
    const delimiter = heredoc?.[1] ?? heredoc?.[2];
    if (delimiter === undefined) continue;
    for (index += 1; index < lines.length && lines[index]?.trim() !== delimiter; index += 1) {
      const bare = lines[index]?.match(bareKeyLinePattern);
      if (bare?.[1] !== undefined) keys.add(bare[1]);
    }
  }
  return keys;
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') { yield value; return; }
  if (Array.isArray(value)) { for (const entry of value) yield* strings(entry); return; }
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) yield* strings(entry); }
}

function actionName(uses: string): string {
  return uses.split('@')[0] ?? uses;
}

function localActionOutputs(repositoryRoot: string, uses: string): readonly string[] | undefined {
  const actionPath = resolve(repositoryRoot, uses, 'action.yml');
  if (!existsSync(actionPath)) return undefined;
  const action = actionSchema.parse(load(readFileSync(actionPath, 'utf8')));
  return Object.keys(action.outputs ?? {});
}


type StepOutputProvider =
  | { readonly kind: 'run'; readonly keys: ReadonlySet<string> }
  | { readonly kind: 'action'; readonly keys: readonly string[] }
  | { readonly kind: 'unknown-action'; readonly action: string }
  | { readonly kind: 'no-outputs' };

function providerFor(
  step: NonNullable<WorkflowJob['steps']>[number],
  declared: readonly string[] | undefined,
  repositoryRoot: string,
): StepOutputProvider {
  // The typed step action writes whatever its entry program writes.
  if (step.run !== undefined || stepInvocation(step) !== '') {
    const keys = writtenOutputKeys(step.run ?? '');
    for (const key of declared ?? []) keys.add(key);
    return { kind: 'run', keys };
  }
  if (step.uses !== undefined) {
    const local = step.uses.startsWith('./') ? localActionOutputs(repositoryRoot, step.uses) : undefined;
    if (local !== undefined) return { kind: 'action', keys: local };
    const name = actionName(step.uses);
    const external = (externalActionOutputs as Record<string, readonly string[]>)[name];
    if (external !== undefined) return { kind: 'action', keys: external };
    return { kind: 'unknown-action', action: name };
  }
  return { kind: 'no-outputs' };
}

/**
 * Report every `steps.<id>.outputs.<key>` whose key the step does not write,
 * every pinned script-delegated key the invoked script does not mention, and
 * every pinned entry for a step that no longer exists.
 */
export type PinnedScriptOutputs = Record<string, Record<string, readonly string[]>>;

export function validateStepOutputs(
  graph: WorkflowGraph,
  workflowPath: string,
  repositoryRoot = process.cwd(),
  pinnedWorkflow: PinnedScriptOutputs = (scriptStepOutputs as Record<string, PinnedScriptOutputs>)[workflowPath] ?? {},
): StepOutputIssue[] {
  const issues: StepOutputIssue[] = [];
  for (const [jobId, job] of Object.entries(graph.jobs)) {
    const steps = new Map((job.steps ?? []).flatMap((step) => (step.id ? [[step.id, step] as const] : [])));
    const pinnedJob = pinnedWorkflow[jobId] ?? {};
    for (const [stepId, keys] of Object.entries(pinnedJob)) {
      const step = steps.get(stepId);
      if (step === undefined) {
        issues.push({ job: jobId, message: `pins script outputs for steps.${stepId}, which is not a step id in this job` });
        continue;
      }
      const scripts = invokedScripts(repositoryRoot, stepInvocation(step));
      for (const key of keys) {
        if (!scriptNamesKey(repositoryRoot, scripts, key)) {
          issues.push({ job: jobId, message: `pins steps.${stepId}.outputs.${key} as script-written, but no script the step invokes names "${key}"` });
        }
      }
    }
    const seen = new Set<string>();
    for (const text of strings(job)) {
      for (const match of text.matchAll(stepOutputReferencePattern)) {
        const [, stepId, key] = match;
        if (stepId === undefined || key === undefined || seen.has(`${stepId}.${key}`)) continue;
        seen.add(`${stepId}.${key}`);
        const step = steps.get(stepId);
        if (step === undefined) continue;
        const provider = providerFor(step, pinnedJob[stepId], repositoryRoot);
        switch (provider.kind) {
          case 'run':
            if (!provider.keys.has(key)) issues.push({ job: jobId, message: `reads steps.${stepId}.outputs.${key}, which the step's shell never writes to GITHUB_OUTPUT` });
            break;
          case 'action':
            if (!provider.keys.includes(key)) issues.push({ job: jobId, message: `reads steps.${stepId}.outputs.${key}, which action "${step.uses ?? ''}" does not declare` });
            break;
          case 'unknown-action':
            issues.push({ job: jobId, message: `reads steps.${stepId}.outputs.${key} from "${provider.action}", whose outputs are not pinned in externalActionOutputs` });
            break;
          case 'no-outputs':
            issues.push({ job: jobId, message: `reads steps.${stepId}.outputs.${key}, but the step has neither run nor uses` });
            break;
        }
      }
    }
  }
  return issues;
}

/** Workflows whose step-output references must all resolve. */
export const stepOutputValidatedWorkflows = [
  '.github/workflows/ios-tests.yml',
  '.github/workflows/pr-checks.yml',
  '.github/workflows/cancel-blocked-pr-ci.yml',
  '.github/workflows/cancel-dequeued-candidate.yml',
  '.github/workflows/promotion-checkpoint.yml',
  '.github/workflows/refresh-pr-ci-after-base-edit.yml',
  '.github/workflows/trusted-production-onboarding-e2e.yml',
  '.github/workflows/actions-artifact-cleanup.yml',
  '.github/workflows/xcode-cloud-build-tags.yml',
  '.github/workflows/video-review-writer.yml',
  '.github/workflows/vendored-linkkit-version-check.yml',
  '.github/workflows/node-modules-cache.yml',
] as const;

export function stepOutputIssuesFor(path: string, repositoryRoot = process.cwd()): StepOutputIssue[] {
  return validateStepOutputs(loadWorkflowGraph(path), path, repositoryRoot);
}

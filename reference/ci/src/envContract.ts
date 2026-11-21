import { invokedScripts, scriptNamesKey, stepInvocation } from './invokedSources.ts';
import { loadWorkflowGraph, type WorkflowGraph, type WorkflowJob } from './workflowOutputs.ts';

/**
 * Typed contract for the `env` context.
 *
 * A step that reads `${{ env.NAME }}` (or `env.NAME` in an `if:`) gets an
 * empty string unless NAME was declared by a workflow, job or step `env:`
 * block, or appended to `$GITHUB_ENV` by an *earlier* step of the same job.
 * GitHub checks none of that. This module resolves every such reference
 * statically, in step order, against:
 *
 * 1. `env:` blocks at workflow, job and step level;
 * 2. `NAME=value` and `NAME<<EOF` writes to `$GITHUB_ENV` in earlier steps,
 *    parsed from the shell text;
 * 3. `scriptStepEnv`: names an earlier step writes through a script or typed
 *    program it invokes, pinned here and verified against that source;
 * 4. `optionalEnv`: names a step shared by several jobs (a YAML anchor) reads
 *    knowing only some of those jobs define them; each entry records why.
 *
 * `validateEnvContract` reports every reference none of the four provide, and
 * every pin that no longer matches the workflow. It runs inside
 * `npm run ci:check`.
 */

export interface EnvIssue {
  readonly job: string;
  readonly message: string;
}

/**
 * Variables written to `$GITHUB_ENV` by a script a step invokes. Keyed by
 * workflow, job and step label (the step's `id`, else its `name`).
 */
/**
 * The real-server E2E step anchor, shared by all four lanes. Every entry is a
 * typed step program: the names it exports live in the decision module it
 * imports, which `invokedScripts` follows.
 */
const realServerE2eLaneEnv = {
  'Bound persistent real-server build cache': ['IOS_CI_BUILD_CACHE_ENTRY', 'IOS_CI_DERIVED_DATA', 'IOS_CI_PACKAGE_CACHE', 'IOS_CI_SOURCE_PACKAGES'],
  // The Income proxy's port and PID reach the later Income steps through
  // \$GITHUB_ENV, written by the typed start program rather than by the step's
  // own shell; the four lanes share one anchored steps: block.
  'Start Income E2E Cloud SQL proxy': ['INCOME_E2E_DB_PROXY_PID', 'INCOME_E2E_DB_PROXY_PORT'],
  'prepare-e2e-products': ['IOS_E2E_TEST_PRODUCTS'],
  'Export exact-toolchain E2E launch paths': [
    'BUDGET_E2E_TEST_PRODUCTS', 'DEFER_VIDEO_PROCESSING', 'IOS_TEST_PRODUCTS_PATH', 'SKIP_BUILD',
    'TEST_PRODUCTS', 'TEST_PRODUCTS_PATH', 'XCTESTRUN_PATH',
  ],
  'onboarding-paths': [
    'BACKEND_DIAGNOSTICS_DIR', 'BUDGET_E2E_COMPRESSED_VIDEO', 'BUDGET_E2E_RAW_VIDEO',
    'BUDGET_E2E_RESULT_BUNDLE', 'BUDGET_E2E_VIDEO_LOG', 'BUDGET_E2E_XCODEBUILD_LOG',
    'CHAT_PLAID_E2E_EVIDENCE_DIR', 'CHAT_PLAID_E2E_RESULT_BUNDLE', 'CHAT_PLAID_E2E_XCODEBUILD_LOG',
    'DASHBOARD_OFFLINE_EVIDENCE_JSON', 'DASHBOARD_OFFLINE_PROXY_EVENTS', 'DASHBOARD_OFFLINE_PROXY_LOG',
    'DEBT_CARD_TEST_PRODUCTS', 'DEBT_CARD_TEST_PRODUCTS_MANIFEST',
    'DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE', 'INCOME_E2E_COMPRESSED_VIDEO',
    'INCOME_E2E_DB_PROXY_LOG', 'INCOME_E2E_PROVIDER_AUDIT_LOG', 'INCOME_E2E_RAW_VIDEO',
    'INCOME_E2E_RESULT_BUNDLE', 'INCOME_E2E_RUN_DIR', 'INCOME_E2E_XCODEBUILD_LOG',
    'IOS_3996_CLEANUP_RECEIPT', 'IOS_3996_EVIDENCE_DIR', 'IOS_3996_EVIDENCE_JSON',
    'IOS_3998_CLEANUP_RECEIPT', 'IOS_3998_EVIDENCE_DIR', 'IOS_3998_FRESHNESS_RECEIPT',
    'IOS_3999_ARCHIVE_EVIDENCE', 'ONBOARDING_DEV_BACKEND_LOG', 'ONBOARDING_DEV_BACKEND_PID_FILE',
    'ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG', 'ONBOARDING_E2E_COMPRESSED_VIDEO',
    'ONBOARDING_E2E_RAW_VIDEO', 'ONBOARDING_E2E_RESULT_BUNDLE', 'ONBOARDING_E2E_REVIEW_JSON',
    'ONBOARDING_E2E_REVIEW_MD', 'ONBOARDING_E2E_RUN_DIR', 'ONBOARDING_E2E_XCODEBUILD_LOG',
  ],
  'Isolate Google Cloud SDK state': ['CLOUDSDK_CONFIG', 'EXAMPLE_ISOLATED_CLOUDSDK_CONFIG'],
  'Configure Cloud SDK Python': ['CLOUDSDK_PYTHON'],
  'Load dev GCP runtime config': [
    'AUTH_CODE_PEPPER', 'DB_IAM_USER', 'DB_NAME', 'GCP_PROJECT_ID', 'GCP_SERVICE_ACCOUNT',
    'GCP_WORKLOAD_IDENTITY_PROVIDER', 'GCS_ASSET_BUCKET', 'IDENTITY_PLATFORM_API_KEY',
    'INSTANCE_CONNECTION_NAME',
  ],
  'Allocate lane-isolated dev backend port': ['ONBOARDING_DEV_BACKEND_PORT', 'TEST_RUNNER_UI_TEST_API_BASE_URL'],
  'Prepare fresh Chat Plaid E2E user': ['CHAT_PLAID_E2E_CLEANUP_TOKEN', 'CHAT_PLAID_E2E_EMAIL', 'CHAT_PLAID_E2E_PASSWORD'],
  'provision-development-full-onboarding-users': [
    'UI_TEST_SYNTHETIC_ONBOARDING_EMAIL', 'UI_TEST_SYNTHETIC_PASSWORD', 'UI_TEST_SYNTHETIC_PRIVACY_EMAIL',
  ],
  'start-dashboard-offline-proxy': [
    'DASHBOARD_OFFLINE_PROXY_CONTROL_TOKEN', 'DASHBOARD_OFFLINE_PROXY_PID', 'DASHBOARD_OFFLINE_PROXY_PORT',
  ],
} as const;

export const scriptStepEnv = {
  '.github/workflows/ios-tests.yml': {
    'verify-ios-release-archive': {
      'Prepare Release archive build cache': ['IOS_CI_BUILD_CACHE_ENTRY'],
      'compile-release-archive': ['IOS_RELEASE_ARCHIVE_XCODEBUILD_LOG'],
    },
    'build-ios-native-test-products': {
      'build-test-products': [
        'IOS_STOREKIT_RESULT_BUNDLE', 'IOS_STOREKIT_XCODEBUILD_LOG', 'IOS_TEST_RESULT_BUNDLE', 'IOS_TEST_XCODEBUILD_LOG',
      ],
    },
    // The typed lane runner invokes manage-ios-build-cache.sh when it has to
    // discard the cache, but the pin resolves scripts from a step's own shell
    // text, so it names the earlier step that invokes the same script inline.
    'test-ios-execution': { 'Prepare native consumer build cache': ['IOS_CI_BUILD_CACHE_ENTRY'] },
    'build-ios-e2e-test-products': {
      'Prepare shared E2E build cache': ['IOS_CI_DERIVED_DATA', 'IOS_CI_SOURCE_PACKAGES'],
    },
    'budget-e2e-video-processing': {
      'Prepare isolated Budget video workspace': ['BUDGET_E2E_COMPRESSED_VIDEO', 'BUDGET_VIDEO_RUN_DIR'],
    },    'onboarding-e2e': realServerE2eLaneEnv,
    'chat-plaid-e2e': realServerE2eLaneEnv,
    'income-e2e': realServerE2eLaneEnv,
    'budget-e2e': realServerE2eLaneEnv,  },  '.github/workflows/trusted-production-onboarding-e2e.yml': {
    'production-onboarding-e2e': {
      'Prepare shared E2E build cache': ['IOS_CI_BUILD_CACHE_ENTRY', 'IOS_CI_DERIVED_DATA', 'IOS_CI_SOURCE_PACKAGES'],
      'Prepare production onboarding paths': [
        'ONBOARDING_E2E_RESULT_BUNDLE', 'ONBOARDING_E2E_RUN_DIR', 'ONBOARDING_E2E_XCODEBUILD_LOG', 'XCTESTRUN_PATH',
      ],
      'provision-production-users': [
        'PRODUCTION_E2E_PASSWORD', 'UI_TEST_SYNTHETIC_ONBOARDING_EMAIL', 'UI_TEST_SYNTHETIC_PASSWORD',
        'UI_TEST_SYNTHETIC_PRIVACY_EMAIL',
      ],
    },
    'production-video-review': {
      'Prepare isolated onboarding video workspace': [
        'ONBOARDING_E2E_COMPRESSED_VIDEO', 'ONBOARDING_E2E_REVIEW_JSON', 'ONBOARDING_E2E_REVIEW_MD',
        'ONBOARDING_VIDEO_RUN_DIR',
      ],
      'process-video': ['ONBOARDING_E2E_XCODEBUILD_LOG'],
    },
  },
  '.github/workflows/pr-checks.yml': {
    'database-integration': {
      // The container name the cleanup step guards on: the last step runs only
      // when the database container was actually started.
      'Start isolated PostgreSQL': ['DATABASE_URL', 'DB_CONTAINER_NAME'],
    },
  },
} as const satisfies Record<string, Record<string, Record<string, readonly string[]>>>;

/**
 * Variables a job reads that only some jobs sharing the same step anchor
 * define. The reading step guards on the lane, so the empty value never
 * reaches a command.
 */
export const optionalEnv = {
  '.github/workflows/ios-tests.yml': {
    // The real-server E2E step anchor is shared by four lanes; only budget-e2e
    // defines its shard, and every step that reads it is guarded on
    // `env.E2E_LANE == 'budget'`.
    'onboarding-e2e': ['BUDGET_E2E_ARTIFACT_SUFFIX', 'BUDGET_E2E_SHARD'],
    'chat-plaid-e2e': ['BUDGET_E2E_ARTIFACT_SUFFIX', 'BUDGET_E2E_SHARD'],
    'income-e2e': ['BUDGET_E2E_ARTIFACT_SUFFIX', 'BUDGET_E2E_SHARD'],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

const nameToken = '[A-Za-z_][A-Za-z0-9_]*';
const envWritePattern = new RegExp(`(?:^|[;{(&|]|\\bthen|\\belse|\\bdo)\\s*(?:echo|printf)\\s+(?:-[a-zA-Z]+\\s+)?["']?(${nameToken})(?:=|<<)`, 'gm');
const heredocOpenPattern = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?.*GITHUB_ENV|GITHUB_ENV.*<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;
const bareNameLinePattern = new RegExp(`^\\s*(${nameToken})=`);
const expressionPattern = /\$\{\{([^}]*)\}\}/g;
const envReferencePattern = /\benv\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** Variables a shell block appends to `$GITHUB_ENV`, parsed statically; over-approximated like step outputs. */
export function writtenEnvNames(run: string): Set<string> {
  const names = new Set<string>();
  if (!run.includes('GITHUB_ENV')) return names;
  for (const match of run.matchAll(envWritePattern)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  const lines = run.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heredoc = lines[index]?.match(heredocOpenPattern);
    const delimiter = heredoc?.[1] ?? heredoc?.[2];
    if (delimiter === undefined) continue;
    for (index += 1; index < lines.length && lines[index]?.trim() !== delimiter; index += 1) {
      const bare = lines[index]?.match(bareNameLinePattern);
      if (bare?.[1] !== undefined) names.add(bare[1]);
    }
  }
  return names;
}

/** `env.NAME` references inside `${{ }}` expressions of a string. */
function* expressionEnvReferences(text: string): Generator<string> {
  for (const expression of text.matchAll(expressionPattern)) {
    for (const reference of (expression[1] ?? '').matchAll(envReferencePattern)) {
      if (reference[1] !== undefined) yield reference[1];
    }
  }
}

/** `env.NAME` references in a bare expression such as an `if:` value. */
function* bareEnvReferences(text: string): Generator<string> {
  if (text.includes('${{')) { yield* expressionEnvReferences(text); return; }
  for (const reference of text.matchAll(envReferencePattern)) {
    if (reference[1] !== undefined) yield reference[1];
  }
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') { yield value; return; }
  if (Array.isArray(value)) { for (const entry of value) yield* strings(entry); return; }
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) yield* strings(entry); }
}


type Step = NonNullable<WorkflowJob['steps']>[number];

/** References a step makes to `env.NAME`: `${{ }}` anywhere in it, plus its bare `if:`. */
function* stepEnvReferences(step: Step): Generator<string> {
  const { if: condition, ...rest } = step;
  for (const text of strings(rest)) yield* expressionEnvReferences(text);
  if (typeof condition === 'string') yield* bareEnvReferences(condition);
}

export function validateEnvContract(
  graph: WorkflowGraph,
  workflowPath: string,
  repositoryRoot = process.cwd(),
  pinnedScriptEnv: Record<string, Record<string, readonly string[]>> = (scriptStepEnv as Record<string, Record<string, Record<string, readonly string[]>>>)[workflowPath] ?? {},
  pinnedOptional: Record<string, readonly string[]> = (optionalEnv as Record<string, Record<string, readonly string[]>>)[workflowPath] ?? {},
): EnvIssue[] {
  const issues: EnvIssue[] = [];
  const workflowEnv = new Set(Object.keys((graph as { env?: Record<string, unknown> }).env ?? {}));
  for (const [jobId, job] of Object.entries(graph.jobs)) {
    const steps = job.steps ?? [];
    const labelOf = (step: Step): string => step.id ?? step.name ?? '(unnamed step)';
    const pinnedJob = pinnedScriptEnv[jobId] ?? {};
    for (const [label, names] of Object.entries(pinnedJob)) {
      const step = steps.find((candidate) => labelOf(candidate) === label);
      if (step === undefined) {
        issues.push({ job: jobId, message: `pins script env for step "${label}", which is not a step in this job` });
        continue;
      }
      const scripts = invokedScripts(repositoryRoot, stepInvocation(step));
      for (const name of names) {
        if (!scriptNamesKey(repositoryRoot, scripts, name)) {
          issues.push({ job: jobId, message: `pins env.${name} as written by step "${label}"'s script, but no source the step reaches names "${name}"` });
        }
      }
    }
    const optional = new Set(pinnedOptional[jobId] ?? []);
    const usedOptional = new Set<string>();
    const available = new Set<string>([...workflowEnv, ...Object.keys(job.env ?? {})]);
    for (const text of strings(job.env ?? {})) {
      for (const name of expressionEnvReferences(text)) {
        if (!workflowEnv.has(name)) issues.push({ job: jobId, message: `job env reads env.${name}, which the workflow env does not define` });
      }
    }
    const reported = new Set<string>();
    for (const step of steps) {
      const stepEnv = new Set(Object.keys(step.env ?? {}));
      for (const name of stepEnvReferences(step)) {
        if (available.has(name) || stepEnv.has(name)) continue;
        if (optional.has(name)) { usedOptional.add(name); continue; }
        const label = labelOf(step);
        if (reported.has(`${label}:${name}`)) continue;
        reported.add(`${label}:${name}`);
        issues.push({ job: jobId, message: `step "${label}" reads env.${name}, which no env block or earlier GITHUB_ENV write in this job defines` });
      }
      for (const name of writtenEnvNames(step.run ?? '')) available.add(name);
      if (stepInvocation(step) !== '') {
        for (const name of pinnedJob[labelOf(step)] ?? []) available.add(name);
      }
    }
    for (const name of optional) {
      if (!usedOptional.has(name)) issues.push({ job: jobId, message: `lists env.${name} as optional, but no step reads it without a definition` });
    }
  }
  return issues;
}

/** Workflows whose env references must all resolve. */
export const envValidatedWorkflows = [
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
  '.github/workflows/install-runner-cleanup-host.yml',
  '.github/workflows/install-runner-cleanup-hooks.yml',
  '.github/workflows/linux-runner-heartbeat.yml',
  '.github/workflows/vendored-linkkit-version-check.yml',
] as const;

export function envIssuesFor(path: string, repositoryRoot = process.cwd()): EnvIssue[] {
  return validateEnvContract(loadWorkflowGraph(path), path, repositoryRoot);
}

import { readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';

import { z } from 'zod';
import ts from 'typescript';

import { validationDepthSchema, type ValidationDepth } from './ciEvent.ts';
import {
  calculationAssurancePlanSchema,
  calculationAssuranceRegistry,
  calculationAssuranceSelectionPaths,
  deriveCalculationAssurancePlan,
} from './calculationAssurancePlan.ts';
import { workflowContractTestSet } from './workflowContractTests.ts';
import { prValidationPolicyTestSet } from './prValidationPolicyTests.ts';
import type { ScriptReference } from './scriptConsumers.ts';
import {
  isServerDeclaration,
  isServerProductSource,
  serverProcessHeavyTests,
} from './serverSourceTestOwnership.ts';
import { webDeployIgnoredFilesPath } from '../cloudbuild/trigger.ts';

export const serverTestModeSchema = z.enum(['none', 'targeted', 'full']);
export type ServerTestMode = z.infer<typeof serverTestModeSchema>;

export const prValidationInputSchema = z.object({
  changedFiles: z.array(z.string().min(1)),
  deletedFiles: z.array(z.string().min(1)).default([]),
  fileStatusAvailable: z.boolean().default(true),
  metadataOnly: z.boolean(),
  // True when the change to package.json is confined to keys that cannot reach
  // runtime (`manifestChangeIsRuntimeNeutral`); the manifest then only
  // schedules the workflow contracts lane, like any other CI control file.
  packageManifestRuntimeNeutral: z.boolean().default(false),
  entitlementAcceptanceScriptChanged: z.boolean().default(false),
  websiteContractTestChanged: z.boolean().default(false),
  // Scripts that only CI runs (`workflowOnlyScripts` over the trusted base):
  // a change to one is a CI control change and schedules the workflow
  // contracts lane only. Deletions count too, since the consumers were read
  // from the base the change is measured against.
  scriptImpact: z.object({
    ciOnlyScripts: z.array(z.string().min(1)),
    // The exact-head import graph proves these helpers are used only by
    // targetable tests. Their readers are already in affectedServerTests.
    testOnlyHelpers: z.array(z.string().regex(/^server\/tests\/.+\.ts$/)).default([]),
    // Ownership cannot be supplied without its targeted test obligations.
    affectedServerTests: z.array(z.string().regex(/^server\/tests\/.+\.test\.ts$/)),
    validationRenames: z.array(z.object({
      from: z.string().regex(/^scripts\/.+\.mjs$/),
      to: z.string().regex(/^scripts\/.+\.ts$/),
    }).strict()).default([]),
  }).default({ ciOnlyScripts: [], testOnlyHelpers: [], affectedServerTests: [], validationRenames: [] }),
  serverSourceImpact: z.object({
    ownedSources: z.array(z.string().regex(/^server\/(?!tests\/).+\.tsx?$/)),
    affectedUnitTests: z.array(z.string().regex(/^server\/tests\/.+\.test\.ts$/)),
    affectedIntegrationTests: z.array(z.string().regex(/^server\/tests\/.+\.integration\.test\.ts$/)),
    totalUnitTests: z.number().int().nonnegative(),
  }).default({ ownedSources: [], affectedUnitTests: [], affectedIntegrationTests: [], totalUnitTests: 0 }),
});
export type PrValidationInput = z.input<typeof prValidationInputSchema>;

const serverTestRuntimeContractSchema = z.object({
  path: z.string().min(1),
  profile: z.literal('isolated-postgres'),
}).strict();

export const serverTestRuntimeManifestSchema = z.object({
  schema: z.literal('example.server-test-runtimes.v1'),
  tests: z.array(serverTestRuntimeContractSchema).max(500),
}).strict();
export type ServerTestRuntimeManifest = z.infer<typeof serverTestRuntimeManifestSchema>;

export const prValidationPlanSchema = z.object({
  schema: z.literal('example.pr-validation-plan.v1'),
  docsOnly: z.boolean(),
  metadataOnly: z.boolean(),
  policyRequired: z.boolean(),
  workflowContractsRequired: z.boolean(),
  serverStaticRequired: z.boolean(),
  testOnlyHelpersToTypecheck: z.array(z.string().regex(/^server\/tests\/.+\.ts$/)).default([]),
  serverTestMode: serverTestModeSchema,
  /** Application server tests are in scope, not only infrastructure contracts. */
  applicationTestImpact: z.boolean().default(false),
  /** Absent on the impact plan; set once `planForValidationDepth` applies the event. */
  validationDepth: validationDepthSchema.optional(),
  processHeavyRequired: z.boolean().default(false),
  targetedServerTests: z.array(z.string()),
  targetedIntegrationTests: z.array(z.string()),
  databaseRequired: z.boolean(),
  entitlementAcceptanceRequired: z.boolean().default(false),
  iosContractsRequired: z.boolean(),
  calculationAssurance: calculationAssurancePlanSchema,
});
export type PrValidationPlan = z.infer<typeof prValidationPlanSchema>;

// The repository deliberately does not use CODEOWNERS, and GitHub reads such a
// file from exactly three locations. `ci/tests/reviewOwnership.test.ts` asserts
// all three stay absent and that the decision stays stated in the security
// document — but a guard test is only as strong as the path that schedules it,
// and that test runs only in the `Workflow contracts` job. Two of those three
// locations (`CODEOWNERS`, `docs/CODEOWNERS`) and the document itself would
// otherwise never route there.
//
// `reviewOwnershipTouched` below is what schedules the job, for all four paths
// and off both the changed and the deleted list. The memberships this set
// grants in `isWorkflowContract` and in the `nonDocumentation` filter are
// redundant with it, and are kept so each predicate answers truthfully about a
// file that decides review ownership rather than describing it. The membership
// that changes a plan is `isWorkflowControlOnly`: without it root `CODEOWNERS`
// is an unclassified top-level path and pulls in the full server suite and a
// database, which is the cost this routing exists to avoid.
export const reviewOwnershipControlFiles = new Set([
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  'docs/github-repository-security.md',
]);

/** Retired entry points stay registered so deleting or reintroducing one remains CI-owned. */
export const errorMonitorDeploymentGuardInputs = {
  retiredDeploy: 'functions/error-monitor/deploy.sh',
  manifest: 'functions/error-monitor/package.json',
  retiredTest: 'functions/error-monitor/test/deploy-guard.test.mjs',
} as const satisfies Record<string, `functions/error-monitor/${string}`>;

const errorMonitorDeploymentGuardPaths: ReadonlySet<string> = new Set(
  Object.values(errorMonitorDeploymentGuardInputs),
);

function isReviewOwnershipControl(path: string): boolean {
  return reviewOwnershipControlFiles.has(path);
}

// Only the public marketing routes and their component tree take the static
// presentation shortcut. Other Next pages can own authentication, server-side
// handlers, and application behavior, so they retain conservative validation.
// Website modules with server test readers select those owners below.
function isWebPresentation(path: string): boolean {
  return path.startsWith('src/website/')
    || path === 'pages/index.tsx'
    || path === 'pages/about.tsx'
    || [
      'pages/legal/cookies.tsx',
      'pages/legal/privacy.tsx',
      'pages/legal/social-media.tsx',
      'pages/legal/terms.tsx',
      'pages/marketing-og.tsx',
    ].includes(path)
    || /^pages\/health(?:\/index)?\.[jt]sx?$/.test(path);
}

// Markdown and known documentation directories are documentation. A nested
// .txt can be an iOS selection contract, training input, or deployed asset;
// only root-level .txt files receive the documentation shortcut.
function isDocumentation(path: string): boolean {
  return path.endsWith('.md')
    || path.startsWith('docs/')
    || path.startsWith('ios/docs/')
    || path.startsWith('server/docs/')
    || (!path.includes('/') && path.endsWith('.txt'));
}

// All files in these trees control repository validation, not product runtime.
// Directory ownership also covers hooks added after the trusted-base planner
// was built, without a filename allowlist.
const workflowControlDirectories = ['.github/', '.husky/', 'ci/', 'scripts/tests/'] as const;

function isWorkflowControlDirectory(path: string): boolean {
  return workflowControlDirectories.some((directory) => path.startsWith(directory));
}

function isWorkflowContract(path: string): boolean {
  return isCloudBuildConfig(path)
    || infrastructureControlFiles.has(path)
    || errorMonitorDeploymentGuardPaths.has(path)
    || path === 'package.json'
    || path === 'package-lock.json'
    || isWorkflowControlDirectory(path)
    || path.startsWith('scripts/')
    || isReviewOwnershipControl(path);
}

// Existing deployed Cloud Build triggers still point at repository-root YAML.
// New generated configurations live under ci/ and inherit directory ownership.
// Keep this naming rule for the legacy root paths until their triggers migrate.
// Known server readers are selected separately through infrastructureContractTests.
function isCloudBuildConfig(path: string): boolean {
  return /^cloudbuild(?:-[a-z0-9-]+)?\.ya?ml$/.test(path);
}

const workflowControlFiles = new Set([
  'scripts/cancel-blocked-pr-ci.mjs',
  'scripts/controller-base-update-delta.mjs',
  'scripts/run-entitlement-repository-tests.mjs',
  // Existing operator bootstrap for the generated TestFlight Cloud Build is
  // deployment control, not application runtime. New control files live in ci/.
  'scripts/deploy-testflight-feedback-scheduler.sh',
  // Retain deleted controller paths here. The planner is executed from the
  // trusted base while the path inventory describes the PR head, so a removed
  // controller or contract test is no longer present in the current typed
  // execution inventory even though its deletion remains a control-plane-only
  // change.
  'scripts/refresh-pr-ci-after-base-edit.mjs',
  // Historical deployment-guard paths remain narrow when a migration removes
  // both the helper and its old test from the exact head in one PR.
  'scripts/select-newer-cloud-build.py',
]);

// Package-level validation programs are not application runtime. Preserve
// their distinct obligations rather than selecting every server test.
const validationPrograms = {
  'scripts/check-error-envelope-boundary.mjs': 'server-static',
  'scripts/check-error-envelope-boundary.ts': 'server-static',
  'scripts/run-entitlement-repository-tests.mjs': 'entitlement-acceptance',
  'ci/src/actions/runEntitlementRepositoryTests.ts': 'entitlement-acceptance',
  'scripts/source-text.mjs': 'test-support',
  'scripts/source-text.ts': 'test-support',
} as const satisfies Record<string, 'server-static' | 'entitlement-acceptance' | 'test-support'>;

type ValidationProgram = (typeof validationPrograms)[keyof typeof validationPrograms];
type ValidationRename = { readonly from: string; readonly to: string };

/**
 * A typed successor inherits a trusted base validation role only when the
 * exact-head ownership graph has no deploy or product reader. Package-owned
 * programs also require the entire manifest to differ solely by this path
 * replacement, preserving the trusted command's role and all other scripts.
 */
export function validationScriptRenames(
  baseConsumers: ReadonlyMap<string, readonly ScriptReference[]>,
  headConsumers: ReadonlyMap<string, readonly ScriptReference[]>,
  baseManifest: string,
  headManifest: string | undefined,
  changedFiles: readonly string[],
  deletedFiles: readonly string[],
): ValidationRename[] {
  const changed = new Set(changedFiles);
  const deleted = new Set(deletedFiles);
  const aliases: ValidationRename[] = [];
  for (const from of Object.keys(validationPrograms)) {
    if (!from.startsWith('scripts/') || !from.endsWith('.mjs')
      || !deleted.has(from) || !baseConsumers.has(from)) continue;
    const to = `${from.slice(0, -'.mjs'.length)}.ts`;
    if (!changed.has(to) || !headConsumers.has(to)) continue;
    const refs = headConsumers.get(to) ?? [];
    if (refs.length === 0 || refs.some((ref) => !['package', 'workflow', 'server-test'].includes(ref.consumer))) {
      continue;
    }
    if (refs.some((ref) => ref.consumer === 'package')) {
      if (headManifest === undefined || !baseManifest.includes(from) || !headManifest.includes(to)) continue;
      try {
        const expected: unknown = JSON.parse(baseManifest.replaceAll(from, to));
        const actual: unknown = JSON.parse(headManifest);
        if (JSON.stringify(expected) !== JSON.stringify(actual)) continue;
      } catch {
        continue;
      }
    }
    aliases.push({ from, to });
  }
  return aliases;
}

const sourceTextTestConsumers = [
  'server/tests/containerSecurity.test.ts',
  'server/tests/healthRoute.test.ts',
  'server/tests/monitoringContract.test.ts',
] as const;

const serverTestSupportConsumers = {
  'scripts/check-error-envelope-boundary.mjs': ['server/tests/healthRoute.test.ts'],
  'scripts/check-error-envelope-boundary.ts': ['server/tests/healthRoute.test.ts'],
  'scripts/source-text.mjs': sourceTextTestConsumers,
  'scripts/source-text.ts': sourceTextTestConsumers,
} as const satisfies Record<string, readonly `server/tests/${string}.test.ts`[]>;

function isValidationProgram(path: string): path is keyof typeof validationPrograms {
  return Object.hasOwn(validationPrograms, path);
}

function selectsValidationProgram(
  paths: readonly string[],
  obligation: ValidationProgram,
  aliases: ReadonlyMap<string, string>,
): boolean {
  return paths.some((path) => {
    const original = aliases.get(path) ?? path;
    return isValidationProgram(original) && validationPrograms[original] === obligation;
  });
}

function isServerTestSupport(path: string): path is keyof typeof serverTestSupportConsumers {
  return Object.hasOwn(serverTestSupportConsumers, path);
}

const iosServerContractFiles = new Set([
  'scripts/generate-api-types.js',
  'ci/tests/dashboardManualAccountGeneration.test.ts',
  'server/routes/dashboard.yaml',
  'server/swagger/userProfile.yaml',
]);

const iosCiContractFiles = new Set([
  ...iosServerContractFiles,
  '.github/workflows/ios-tests.yml',
  'ci/src/actions/cancelObsoleteIosRuns.ts',
  'scripts/reclaim-ios-runner-disk.sh',
  'ci/src/actions/resumeRetainedIosPredecessor.ts',
  'scripts/run-ios-ci-main-tests.sh',
  'scripts/ios-test-income-e2e.sh',
  'scripts/select-ios-affected-tests.ts',
  'scripts/ios-workflow-native-selection.mjs',
  'scripts/ios-workflow-native-selection.ts',
  'scripts/swift-test-impact.mjs',
  'scripts/swift-test-impact.ts',
  'scripts/stop-onboarding-dev-backend.sh',
]);

function isIosCiContract(path: string): boolean {
  return path.startsWith('ios/')
    || (path.startsWith('scripts/tests/ios-') && path.endsWith('.test.mjs'))
    || iosCiContractFiles.has(path);
}

/** Inputs to the server-to-iOS payload suite, distinct from iOS CI control files. */
function isIosServerContractInput(path: string): boolean {
  return path.startsWith('ios/')
    || iosServerContractFiles.has(path);
}

// `npm run validate:generated-types` runs in the server static lane. These
// paths are generator inputs or the generated type files it compares; route
// YAML shared with iOS and generated Swift otherwise select only iOS lanes.
function affectsGeneratedTypes(path: string): boolean {
  return /^server\/(routes|swagger)\/[^/]+\.ya?ml$/.test(path)
    || /^scripts\/generate-[^/]+\.(js|cjs|mjs)$/.test(path)
    || /^server\/scripts\/(generate-[^/]+|validate-generated-types)\.ts$/.test(path)
    || path.startsWith('server/generated/')
    || (/^(server|src|shared|ios\/example-ios)\//.test(path) && /\.generated\.[^/]+$/.test(path));
}

interface ControlClassification {
  readonly packageManifestRuntimeNeutral: boolean;
  readonly ciOnlyScripts: ReadonlySet<string>;
  readonly testOnlyHelpers: ReadonlySet<string>;
  readonly validationAliases: ReadonlyMap<string, string>;
}

function isWorkflowControlOnly(path: string, control: ControlClassification): boolean {
  return isCloudBuildConfig(path)
    || infrastructureControlFiles.has(path)
    || errorMonitorDeploymentGuardPaths.has(path)
    || isWorkflowControlDirectory(path)
    // Generated workflow step programs and projections live below
    // `scripts/ci/`. The trusted planner runs from the base checkout, so a
    // newly generated path cannot appear in `scriptConsumers(base)` yet. Its
    // location is nevertheless a complete, typed ownership declaration: no
    // file in this tree is an application or server runtime. Classifying the
    // prefix directly prevents a newly added CI step from widening an
    // incremental head delta to every server shard and the database lane.
    || path.startsWith('scripts/ci/')
    || workflowControlFiles.has(path)
    || isValidationProgram(path)
    || control.validationAliases.has(path)
    || isServerTestSupport(path)
    || workflowContractTestSet.has(path)
    || prValidationPolicyTestSet.has(path)
    || isReviewOwnershipControl(path)
    || control.ciOnlyScripts.has(path)
    || (path === 'package.json' && control.packageManifestRuntimeNeutral);
}

function isTargetableServerTest(path: string): boolean {
  return path.startsWith('server/tests/')
    && (path.endsWith('.test.ts') || path.endsWith('.integration.test.ts'));
}

// New isolated-PostgreSQL suites live in one directory. A generic integration
// suffix cannot imply this runtime: some root suites call paid external APIs.
function isServerIntegrationTest(path: string): boolean {
  return path.startsWith('server/tests/isolated-postgres/')
    && path.endsWith('.integration.test.ts');
}

const undeclaredTargetedTestRuntimes = new Set([
  'server/tests/modelBenchmark.test.ts',
]);

export const curatedDatabaseIntegrationTests = new Set([
  'server/tests/appleAuthorization.postgres.integration.test.ts',
  'server/tests/connectedAccountCoverageHomeAssets.integration.test.ts',
  'server/tests/notificationDeliveryPostgres.integration.test.ts',
  'server/tests/notificationEvaluationPostgres.integration.test.ts',
  'server/tests/notificationHistoryPostgres.integration.test.ts',
  'server/tests/notificationPolicyPostgres.integration.test.ts',
  'server/tests/notificationReceiptsPostgres.integration.test.ts',
  'server/tests/plaidSyncAttemptFencing.integration.test.ts',
  'server/tests/stagingQaFixturePostgres.integration.test.ts',
  'server/tests/userProfileDisconnectMortgageAssignments.postgres.integration.test.ts',
  'server/tests/verificationCodeService.postgres.integration.test.ts',
  'server/tests/webSession.postgres.integration.test.ts',
  'server/tests/integration/profileUpdateConfirmation.integration.test.ts',
  'server/tests/integration/spendingQuestionReadinessCache.integration.test.ts',
]);

/**
 * Suites that read a real shared environment (seeded users such as
 * alerts@example.invalid, Identity Platform) and run only when a developer
 * selects credentials with ENV_FILE. No CI lane can execute them: an isolated
 * database has none of their fixtures, so they would skip or fail there. A
 * change to one is compiled by the focused test type-checker and needs no
 * runtime lane.
 */
export const realEnvironmentIntegrationTests = new Set([
  'server/tests/integration/alerts.existingUser.integration.test.ts',
  'server/tests/integration/alerts.integration.test.ts',
  'server/tests/integration/cardActivationAlerts.integration.test.ts',
]);

const serverTestRuntimeManifestPath = 'ci/contracts/server-test-runtimes.json';

/**
 * Server tests that assert on files outside `server/`: deployment, Terraform,
 * workflow and documentation contracts. A change to one of those files must
 * run the test that reads it even when nothing under `server/` changed, or the
 * contract is only checked once the change is already on develop (which is how
 * #5752 reached Cloud Build with a red contract). `ci/tests/prValidationPlan.test.ts`
 * derives this map from each test's source, so it cannot drift.
 */
export const infrastructureContractTests = {
  'server/tests/appleAuthorizationDeployment.contract.test.ts': [
    'cloudbuild-prod.yaml',
    'cloudbuild.yaml',
  ],
  'server/tests/gcpPlatformMigration.contract.test.ts': [
    '.env.example',
    'AGENTS.md',
    'cloudbuild-prod.yaml',
    'cloudbuild.yaml',
    'docs/gcp-platform-migration-runbook.md',
    'e2e/utils/auth.ts',
    'package.json',
    'scripts/select-ios-affected-tests.ts',
    'terraform/platform/environments/prod.tfvars',
    'terraform/platform/main.tf',
    'terraform/platform/variables.tf',
  ],
  'server/tests/monitoringContract.test.ts': [
    'terraform/monitoring/.gitignore',
    'terraform/monitoring/README.md',
    'terraform/monitoring/environments/prod.tfvars',
    'terraform/monitoring/main.tf',
    'terraform/monitoring/variables.tf',
  ],
  'server/tests/observabilityDeploymentSecrets.contract.test.ts': [
    'ci/cloudbuild/runtime/stagingPromotion.ts',
    'ci/cloudbuild/runtime/runStagingPromotion.ts',
    'cloudbuild.yaml',
    'terraform/platform/environments/dev.tfvars',
    'terraform/platform/main.tf',
  ],
  'server/tests/plaidSchedulerMigration.test.ts': [
    '.github/workflows/pr-checks.yml',
    'cloudbuild-plaid-sync.yaml',
    'cloudbuild-prod.yaml',
    'cloudbuild.yaml',
  ],
  'server/tests/privateProfileMediaInfrastructure.test.ts': [
    'cloudbuild-prod.yaml',
    'cloudbuild.yaml',
    'docs/private-profile-media-migration.md',
    'terraform/platform/environments/dev.tfvars',
    'terraform/platform/environments/prod.tfvars',
    'terraform/platform/main.tf',
  ],
  'server/tests/pushTokenCleanupInfrastructure.test.ts': [
    'terraform/platform/main.tf',
  ],
} as const satisfies Record<string, readonly string[]>;

// These server suites import website modules directly. A presentation-only
// edit may skip the broad server shards only when its known readers still run.
// The test below verifies every declared edge against the actual imports.
export const webPresentationContractTests = {
  'server/tests/askExampleDisclosureCopy.test.ts': ['src/website/legal/PrivacyPolicy.tsx'],
  'server/tests/modalFocusContainment.test.ts': ['src/website/hero/modalFocusContainment.ts'],
  'server/tests/storeKitTermsConsistency.test.ts': ['src/website/legal/TermsAndConditions.tsx'],
} as const satisfies Record<`server/tests/${string}.test.ts`, readonly `src/website/${string}`[]>;

// This route was removed deliberately; its contract asserts it stays absent.
// Reintroducing it must run that assertion even though other pages are static.
export const forbiddenPresentationContractTests = {
  'server/tests/healthRoute.test.ts': [
    'pages/health.js', 'pages/health.jsx', 'pages/health.ts', 'pages/health.tsx',
    'pages/health/index.js', 'pages/health/index.jsx',
    'pages/health/index.ts', 'pages/health/index.tsx',
  ],
} as const satisfies Record<`server/tests/${string}.test.ts`, readonly `pages/${string}`[]>;

function runtimeModuleSpecifiers(path: string, source: string): string[] {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  const add = (specifier: ts.Node | undefined): void => {
    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) imports.add(specifier.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(callee) && callee.text === 'require'
        || ts.isPropertyAccessExpression(callee)
          && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi'
          && callee.name.text === 'importActual') {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...imports].sort();
}

/** Literal website paths named by a test, including imports and file reads. */
export function websiteSourceSpecifiersFromServerTest(source: string): string[] {
  const parsed = ts.createSourceFile('server-test.ts', source, ts.ScriptTarget.Latest, true);
  const references = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)
      && (/^(?:\.\.\/)+src\/website\//.test(node.text)
        || node.text.startsWith('src/website/'))) {
      references.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...references].sort();
}

/** A direct website reader needs the alignment guard when its test changes. */
export function referencesWebsiteFromServerTest(source: string): boolean {
  return websiteSourceSpecifiersFromServerTest(source).length > 0;
}

/** Read website source from the trusted checkout; exact-head overlays are supplied separately. */
export function repositoryWebsiteSources(root = process.cwd()): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(posix.join(root, directory), { withFileTypes: true })) {
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.[jt]sx?$/.test(path)) {
        sources.set(path, readFileSync(posix.join(root, path), 'utf8'));
      }
    }
  };
  visit('src/website');
  return sources;
}

function resolvedWebsiteModules(
  from: string,
  specifier: string,
  sources: ReadonlyMap<string, string>,
): string[] {
  if (!specifier.startsWith('.') && !specifier.startsWith('src/website/')) return [];
  const module = specifier.startsWith('src/website/') ? posix.normalize(specifier)
    : posix.normalize(posix.join(posix.dirname(from), specifier));
  if (!module.startsWith('src/website/')) return [];
  const base = module.replace(/\.[jt]sx?$/, '');
  const candidates = [...new Set([
    module, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ])];
  const existing = candidates.filter((path) => sources.has(path));
  return existing.length > 0 ? existing : candidates;
}

/** Include transitive runtime dependencies without maintaining another ownership projection. */
function websiteDependencyClosure(
  test: string,
  directSpecifiers: readonly string[],
  sources: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const visited = new Set<string>();
  const work = directSpecifiers.flatMap((specifier) =>
    resolvedWebsiteModules(test, specifier, sources));
  for (let index = 0; index < work.length; index += 1) {
    const path = work[index];
    if (path === undefined || visited.has(path)) continue;
    visited.add(path);
    const source = sources.get(path);
    if (source === undefined) continue;
    for (const specifier of runtimeModuleSpecifiers(path, source)) {
      work.push(...resolvedWebsiteModules(path, specifier, sources));
    }
  }
  return visited;
}

/** PR-owned tests must be reconsidered when a base delta changes their website imports. */
export function selectedPrWebsiteContractTests(
  changedFiles: readonly string[],
  deletedFiles: readonly string[],
  prTestSources: ReadonlyMap<string, string>,
  websiteSources?: ReadonlyMap<string, string>,
): string[] {
  const touched = new Set([...changedFiles, ...deletedFiles].filter((path) =>
    path.startsWith('src/website/')));
  if (touched.size === 0) return [];
  const sources = websiteSources ?? repositoryWebsiteSources();
  return [...prTestSources]
    .filter(([test, source]) => /^server\/tests\/.+\.test\.ts$/.test(test)
      && [...websiteDependencyClosure(test, websiteSourceSpecifiersFromServerTest(source),
        sources)].some((path) => touched.has(path)))
    .map(([test]) => test)
    .sort();
}

export function selectedPresentationContractTests(
  changedFiles: readonly string[],
  deletedFiles: readonly string[],
  websiteSources?: ReadonlyMap<string, string>,
): string[] {
  const touched = new Set([...changedFiles, ...deletedFiles]);
  const websiteTouched = [...touched].some((path) => path.startsWith('src/website/'));
  const sources = websiteTouched ? websiteSources ?? repositoryWebsiteSources() : undefined;
  const selectedWebsiteTests = sources === undefined ? [] : Object.entries(webPresentationContractTests)
    .filter(([test, directSources]) => [...websiteDependencyClosure(test,
      directSources.map((source) => posix.relative(posix.dirname(test), source)),
      sources)].some((source) => touched.has(source)))
    .map(([test]) => test);
  return selectedWebsiteTests
    .concat(Object.entries(forbiddenPresentationContractTests)
      .filter(([, sources]) => sources.some((source) => touched.has(source)))
      .map(([test]) => test))
    .sort();
}

// Infrastructure inputs have their own typed/targeted contracts. Derive the
// planner's ownership from those same declarations so a Terraform edit does
// not silently turn into four server shards plus a database job. Unknown
// Terraform paths deliberately retain the full-suite fallback.
const infrastructureControlFiles: ReadonlySet<string> = new Set([
  ...Object.values(infrastructureContractTests)
    .flatMap((files) => files)
    .filter((path) => path.startsWith('terraform/')),
  webDeployIgnoredFilesPath,
]);

/** The infrastructure contract tests whose read files a change touches. */
export function selectedInfrastructureContractTests(
  changedFiles: readonly string[],
  deletedFiles: readonly string[],
): string[] {
  const touched = new Set([...changedFiles, ...deletedFiles]);
  return Object.entries(infrastructureContractTests)
    .filter(([, files]) => files.some((file) => touched.has(file)))
    .map(([test]) => test)
    .sort();
}

function requiresServerValidation(path: string, control: ControlClassification): boolean {
  if (isDocumentation(path)
      || isIosCiContract(path)
      || isWebPresentation(path)
      || control.testOnlyHelpers.has(path)
      || isWorkflowControlOnly(path, control)) {
    return false;
  }
  return true;
}

// Committed migration artifacts belong to static validation and the isolated
// database lane. Executable schema definitions, runtime validators and the
// migrator stay application-owned until their effects can be typed separately.
function isDatabaseMigrationArtifact(path: string): boolean {
  return path.startsWith('server/db/migrations/')
    && (path.endsWith('.sql') || path.endsWith('.json'));
}

// These unit contracts read migration SQL, snapshots or the journal directly.
// The database lane proves that migrations execute, but does not cover their
// historical snapshot/lineage assertions. Keep them in one targeted Linux job.
export const migrationArtifactContractTests = [
  'server/tests/chatPendingStateMigration.test.ts',
  'server/tests/cloudSqlRuntimeFunctions.test.ts',
  'server/tests/cspReportQuota.test.ts',
  'server/tests/devE2eSchemaRevision.test.ts',
  'server/tests/docsIndexerService.test.ts',
  'server/tests/insuranceCategoryMigration.test.ts',
  'server/tests/investmentSnapshotCascadeMigration.test.ts',
  'server/tests/mortgageRelationshipMigration.test.ts',
  'server/tests/notificationPlanningStateIndexes.test.ts',
  'server/tests/notificationReportingMigration.test.ts',
  'server/tests/notificationSourceLoader.test.ts',
  'server/tests/notificationSourceMutationTriggers.test.ts',
  'server/tests/plaidSchedulerMigration.test.ts',
  'server/tests/profileUpdateConfirmationMigration.test.ts',
  'server/tests/spendingQuestionReadinessCacheMigration.test.ts',
  'server/tests/spendingSnapshotScopeMigration.test.ts',
  'server/tests/transactionRuleRetryMigration.test.ts',
] as const satisfies readonly `server/tests/${string}.test.ts`[];

// Larger suites that read only named historical artifacts run for those edits.
export const specificMigrationArtifactContracts = {
  'server/tests/exampleInsightsService.test.ts': [
    'server/db/migrations/0001_shallow_firebrand.sql',
    'server/db/migrations/0024_dear_paladin.sql',
  ],
} as const satisfies Record<
  `server/tests/${string}.test.ts`,
  readonly `server/db/migrations/${string}.sql`[]
>;

function requiresDatabase(
  path: string,
  isolatedPostgresTests: ReadonlySet<string>,
  control: ControlClassification,
): boolean {
  if (isServerDeclaration(path) || realEnvironmentIntegrationTests.has(path)) return false;
  if (isolatedPostgresTests.has(path)
      || path.startsWith('server/db/')
      || path.startsWith('server/persistence/')
      || path === 'server/platform/cloudSql.ts'
      || path.endsWith('.integration.test.ts')) {
    return true;
  }
  if (isDocumentation(path)
      || isIosCiContract(path)
      || isWebPresentation(path)
      || control.testOnlyHelpers.has(path)
      || path.startsWith('src/')
      || path.startsWith('public/')
      || isTargetableServerTest(path)
      || isWorkflowControlOnly(path, control)
      || path.startsWith('scripts/tests/')
      || [
        'ci/src/actions/reconcileXcodeCloudBuildTags.ts',
        'scripts/ios-test-onboarding-e2e.sh',
        'scripts/stop-onboarding-dev-backend.sh',
      ].includes(path)) {
    return false;
  }
  return true;
}

/**
 * @param assuranceEvidenceContent Verified exact-PR-head content for the declared evidence test
 *   paths of the calculation assurance packages this change selects. Required for the isolation
 *   check to mean anything when this planner runs from a trusted-base checkout that cannot be
 *   trusted to reflect the PR under review; omit only when `process.cwd()` is already known to be
 *   the exact PR head (e.g. local development or tests).
 */
export function derivePrValidationPlan(
  rawInput: PrValidationInput,
  rawRuntimeManifest: unknown,
  assuranceEvidenceContent?: ReadonlyMap<string, string>,
  websiteSources?: ReadonlyMap<string, string>,
): PrValidationPlan {
  const input = prValidationInputSchema.parse(rawInput);
  const validationAliases = new Map<string, string>();
  for (const { from, to } of input.scriptImpact.validationRenames) {
    if (!isValidationProgram(from) || !input.deletedFiles.includes(from)
      || !input.changedFiles.includes(to)
      || to !== `${from.slice(0, -'.mjs'.length)}.ts`
      || validationAliases.has(to)) {
      throw new Error(`Invalid trusted validation script rename: ${from} -> ${to}`);
    }
    validationAliases.set(to, from);
  }
  const runtimeManifest = serverTestRuntimeManifestSchema.parse(rawRuntimeManifest);
  const calculationAssurance = deriveCalculationAssurancePlan(
    input.metadataOnly
      ? []
      : calculationAssuranceSelectionPaths(input.changedFiles, input.deletedFiles),
    calculationAssuranceRegistry,
    process.cwd(),
    assuranceEvidenceContent,
  );
  const isolatedPostgresTests = new Set<string>();
  for (const contract of runtimeManifest.tests) {
    if (!contract.path.startsWith('server/tests/') || !isTargetableServerTest(contract.path)) {
      throw new Error(`Invalid server test runtime contract path: ${contract.path}`);
    }
    if (isolatedPostgresTests.has(contract.path)) {
      throw new Error(`Duplicate server test runtime contract: ${contract.path}`);
    }
    isolatedPostgresTests.add(contract.path);
  }
  for (const test of Object.keys(webPresentationContractTests)) {
    if (test.endsWith('.integration.test.ts') || serverProcessHeavyTests.has(test)
      || isolatedPostgresTests.has(test) || curatedDatabaseIntegrationTests.has(test)
      || realEnvironmentIntegrationTests.has(test)) {
      throw new Error(`Website presentation contract requires a non-unit runtime: ${test}`);
    }
  }
  if (input.metadataOnly) {
    return prValidationPlanSchema.parse({
      schema: 'example.pr-validation-plan.v1',
      docsOnly: true,
      metadataOnly: true,
      policyRequired: false,
      workflowContractsRequired: false,
      serverStaticRequired: false,
      testOnlyHelpersToTypecheck: [],
      serverTestMode: 'none',
      targetedServerTests: [],
      targetedIntegrationTests: [],
      databaseRequired: false,
      entitlementAcceptanceRequired: false,
      iosContractsRequired: false,
      calculationAssurance,
    });
  }

  if (input.changedFiles.length === 0) {
    throw new Error('Changed-file inventory is empty for a non-metadata validation plan.');
  }

  const changedSourcePaths = [...new Set([...input.changedFiles, ...input.deletedFiles]
    .filter(isServerProductSource))].sort();
  if (JSON.stringify(changedSourcePaths) !== JSON.stringify([...input.serverSourceImpact.ownedSources].sort())) {
    throw new Error(`Exact-head server test ownership is missing or mismatched for: ${changedSourcePaths.join(', ')}`);
  }

  const nonDocumentation = input.changedFiles.filter((path) => (
    !isDocumentation(path) || isReviewOwnershipControl(path)
  ));
  // A rename reports only its new path as changed and its previous path as
  // deleted, so moving `docs/github-repository-security.md` out from under the
  // guard would otherwise skip the job that runs it — the guard would vanish
  // with the decision it records. Deletion appends to both lists and is already
  // covered; this is the rename half.
  const reviewOwnershipTouched = input.changedFiles.some(isReviewOwnershipControl)
    || input.deletedFiles.some(isReviewOwnershipControl);
  // These files schedule the contracts job and nothing else. Escalating on them
  // would run the full server suite and a database for a one-line change, which
  // is the cost this routing exists to avoid.
  const escalatableWithoutFileStatus = nonDocumentation.filter(
    (path) => !isReviewOwnershipControl(path),
  );
  const inferredTests = [...new Set([
    ...input.scriptImpact.affectedServerTests,
    ...input.serverSourceImpact.affectedUnitTests,
    ...input.serverSourceImpact.affectedIntegrationTests,
  ])].filter(path => !input.deletedFiles.includes(path));
  const supportTests = [...new Set(nonDocumentation
    .map((path) => validationAliases.get(path) ?? path)
    .filter(isServerTestSupport)
    .flatMap((path) => serverTestSupportConsumers[path]))]
    .filter((path) => !input.deletedFiles.includes(path));
  const entitlementAcceptanceRequired = input.entitlementAcceptanceScriptChanged
    || selectsValidationProgram(nonDocumentation, 'entitlement-acceptance', validationAliases);
  const runtimeManifestChanged = nonDocumentation.includes(serverTestRuntimeManifestPath);
  if (!input.fileStatusAvailable && escalatableWithoutFileStatus.length > 0) {
    throw new Error(`Changed-file status is unavailable for ${escalatableWithoutFileStatus.join(', ')}; refresh the exact-head inventory before planning tests.`);
  }
  const control: ControlClassification = {
    packageManifestRuntimeNeutral: input.packageManifestRuntimeNeutral,
    ciOnlyScripts: new Set(input.scriptImpact.ciOnlyScripts),
    testOnlyHelpers: new Set(input.scriptImpact.testOnlyHelpers),
    validationAliases,
  };
  const changedServerRelevant = nonDocumentation.filter((path) =>
    requiresServerValidation(path, control));
  const serverRelevant = [...new Set([...changedServerRelevant, ...inferredTests, ...supportTests])];
  const ownedSources = new Set(input.serverSourceImpact.ownedSources);
  const applicationTestRelevant = serverRelevant.filter((path) =>
    !isDatabaseMigrationArtifact(path) && !ownedSources.has(path)
      && !isServerDeclaration(path));
  const deletedFiles = new Set(input.deletedFiles);
  const unsupportedRuntimeTests = serverRelevant.filter((path) => (
    !deletedFiles.has(path)
    && !realEnvironmentIntegrationTests.has(path)
    && (undeclaredTargetedTestRuntimes.has(path)
      || (path.endsWith('.integration.test.ts')
        && !isServerIntegrationTest(path)
        && !isolatedPostgresTests.has(path)
        && !curatedDatabaseIntegrationTests.has(path)))
  ));
  if (unsupportedRuntimeTests.length > 0) {
    throw new Error(
      `Test runtime contract is not declared: ${unsupportedRuntimeTests.join(', ')}`,
    );
  }
  const changedTargetedIntegrationTests = serverRelevant.filter((path) => (
    !deletedFiles.has(path)
    && !curatedDatabaseIntegrationTests.has(path)
    && (isolatedPostgresTests.has(path) || isServerIntegrationTest(path))
  ));
  const targetedIntegrationTests = [...new Set([
    ...changedTargetedIntegrationTests,
    ...(runtimeManifestChanged ? [...isolatedPostgresTests].sort() : []),
  ])];
  const curatedIntegrationTests = serverRelevant.filter((path) => (
    !deletedFiles.has(path) && curatedDatabaseIntegrationTests.has(path)
  ));
  const infrastructureTests = [
    ...selectedInfrastructureContractTests(input.changedFiles, input.deletedFiles),
    ...selectedPresentationContractTests(input.changedFiles, input.deletedFiles, websiteSources),
  ]
    .filter((path) => !deletedFiles.has(path));
  const touchedMigrationArtifacts = [...input.changedFiles, ...input.deletedFiles]
    .filter(isDatabaseMigrationArtifact);
  if (touchedMigrationArtifacts.length > 0) {
    infrastructureTests.push(...migrationArtifactContractTests.filter((path) => !deletedFiles.has(path)));
    for (const [test, artifacts] of Object.entries(specificMigrationArtifactContracts)) {
      if (!deletedFiles.has(test) && artifacts.some((artifact) => touchedMigrationArtifacts.includes(artifact))) {
        infrastructureTests.push(test);
      }
    }
  }
  const changedTargetedServerTests = serverRelevant
    .filter(isTargetableServerTest)
    .filter((path) => !deletedFiles.has(path))
    .filter((path) => !serverProcessHeavyTests.has(path))
    .filter((path) => !isolatedPostgresTests.has(path))
    .filter((path) => !path.endsWith('.integration.test.ts'));
  const selectedProcessHeavyTests = serverRelevant.filter((path) =>
    !deletedFiles.has(path) && serverProcessHeavyTests.has(path));
  const targetedServerTests = [...new Set([...changedTargetedServerTests, ...infrastructureTests])].sort();
  const deletedServerTests = serverRelevant.filter((path) => (
    deletedFiles.has(path) && isTargetableServerTest(path)
  ));
  const realEnvironmentTests = serverRelevant.filter((path) => (
    !deletedFiles.has(path) && realEnvironmentIntegrationTests.has(path)
  ));
  const serverStaticRelevant = changedServerRelevant.filter((path) => (
    !(deletedFiles.has(path) && isTargetableServerTest(path))
  ));
  const onlyTargetableServerTests = applicationTestRelevant.length > 0
    && changedTargetedServerTests.length + selectedProcessHeavyTests.length
      + changedTargetedIntegrationTests.length
      + curatedIntegrationTests.length + deletedServerTests.length
      + realEnvironmentTests.length === applicationTestRelevant.length;
  // An infrastructure contract test rides along in targeted mode; it never
  // widens a change to the full suite on its own.
  const broadVerifiedImpact = input.serverSourceImpact.totalUnitTests > 0
    && input.serverSourceImpact.affectedUnitTests.length * 4
      >= input.serverSourceImpact.totalUnitTests;
  const serverTestMode: ServerTestMode = applicationTestRelevant.length === 0
    ? infrastructureTests.length > 0 ? 'targeted' : 'none'
    : onlyTargetableServerTests
      ? targetedServerTests.length > 0 ? broadVerifiedImpact ? 'full' : 'targeted' : 'none'
      : 'full';

  return prValidationPlanSchema.parse({
    schema: 'example.pr-validation-plan.v1',
    // A documentation file can be an infrastructure contract's input; the
    // targeted lane must then run, so the change is not documentation-only.
    docsOnly: nonDocumentation.length === 0 && !reviewOwnershipTouched && infrastructureTests.length === 0 && inferredTests.length === 0,
    metadataOnly: false,
    policyRequired: true,
    workflowContractsRequired: input.websiteContractTestChanged
      || nonDocumentation.some(isWorkflowContract)
      || nonDocumentation.some((path) => isServerTestSupport(path) && path.endsWith('.ts'))
      || reviewOwnershipTouched,
    serverStaticRequired: serverStaticRelevant.length > 0
      || nonDocumentation.some(isWebPresentation)
      || nonDocumentation.some(path => control.testOnlyHelpers.has(path))
      || nonDocumentation.some(affectsGeneratedTypes)
      || selectsValidationProgram(nonDocumentation, 'server-static', validationAliases),
    // The root tsconfig excludes server/tests, so a real-environment suite is
    // compiled by the focused test type-checker or by nothing.
    testOnlyHelpersToTypecheck: [...new Set([
      ...input.scriptImpact.testOnlyHelpers,
      ...realEnvironmentTests,
    ])].filter((path) => !deletedFiles.has(path)).sort(),
    serverTestMode,
    applicationTestImpact: applicationTestRelevant.length > 0,
    processHeavyRequired: serverTestMode === 'full' || selectedProcessHeavyTests.length > 0,
    targetedServerTests: serverTestMode === 'targeted' ? targetedServerTests : [],
    targetedIntegrationTests,
    databaseRequired: entitlementAcceptanceRequired || runtimeManifestChanged || targetedIntegrationTests.length > 0
      || curatedIntegrationTests.length > 0 || nonDocumentation.some((path) => (
      requiresDatabase(path, isolatedPostgresTests, control)
      && !(deletedFiles.has(path) && isTargetableServerTest(path))
    )),
    entitlementAcceptanceRequired,
    iosContractsRequired: nonDocumentation.some(isIosServerContractInput),
    calculationAssurance,
  });
}

/**
 * Applies the event's validation depth to the impact plan
 * (docs/ci/merge-queue-plan.md, "PR versus queue split").
 *
 * `pull-request` keeps the impact-selected server mode: targeted when the
 * change narrows, full when it cannot (unknown paths, or impact at or above
 * the broad threshold). The database lane and selected process-heavy suites
 * move to the queue candidate; a full fallback keeps the process-heavy suites
 * because the verdict requires them beside the four shards.
 *
 * `complete` runs the four shards and the process-heavy suites for every
 * application change (`applicationTestImpact`), because the pull request head
 * may have run only its targeted tests or none. The database lane keeps the
 * impact plan's selection. An infrastructure-only contract stays targeted.
 */
export function planForValidationDepth(
  plan: PrValidationPlan,
  depth: ValidationDepth,
): PrValidationPlan {
  if (depth === 'pull-request') {
    return prValidationPlanSchema.parse({
      ...plan,
      validationDepth: depth,
      processHeavyRequired: plan.serverTestMode === 'full',
      targetedIntegrationTests: [],
      databaseRequired: false,
      entitlementAcceptanceRequired: false,
    });
  }
  // Any application impact selects the shards, whatever mode the impact plan
  // chose (targeted, or none for integration-only and process-heavy-only).
  const serverTestMode: ServerTestMode = plan.applicationTestImpact ? 'full' : plan.serverTestMode;
  return prValidationPlanSchema.parse({
    ...plan,
    validationDepth: depth,
    serverTestMode,
    processHeavyRequired: plan.processHeavyRequired || serverTestMode === 'full',
    targetedServerTests: serverTestMode === 'targeted' ? plan.targetedServerTests : [],
  });
}

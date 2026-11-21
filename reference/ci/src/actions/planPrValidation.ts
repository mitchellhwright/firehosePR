import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import {
  collectSelectedEvidencePaths,
  fetchExactHeadEvidenceContent,
  fetchExactHeadFile,
} from '../assuranceEvidenceFetcher.ts';
import {
  calculationAssuranceRegistry,
  calculationAssuranceSelectionPaths,
  selectCalculationAssurancePackageIds,
} from '../calculationAssurancePlan.ts';
import { validationDepth } from '../ciEvent.ts';
import { packageManifestLaneImpact } from '../packageManifest.ts';
import {
  curatedDatabaseIntegrationTests,
  derivePrValidationPlan,
  referencesWebsiteFromServerTest,
  planForValidationDepth,
  repositoryWebsiteSources,
  selectedPrWebsiteContractTests,
  serverTestRuntimeManifestSchema,
  validationScriptRenames,
} from '../prValidationPlan.ts';
import { derivePrLintPlan, type PullRequestLintScope } from '../prLintPlan.ts';
import type { PrSelectionOutput } from '../prValidationPlanning.ts';
import { exactHeadScriptSources } from '../exactHeadScriptSources.ts';
import {
  isServerTestHelper,
  repositoryScriptSources,
  scriptConsumers,
  scriptConsumersFromSources,
  retainDeletedScriptConsumers,
  retainedDeletedWorkflowOnlyScripts,
  scriptValidationImpact,
} from '../scriptConsumers.ts';
import { deriveServerSourceTestImpact, isServerProductSource } from '../serverSourceTestOwnership.ts';
import { installSignalTraps } from '../ios/shared/processRunner.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function input(name: string, required = false): string {
  const hyphenated = `INPUT_${name.toUpperCase()}`;
  const underscored = hyphenated.replaceAll('-', '_');
  const value = process.env[hyphenated] ?? process.env[underscored] ?? '';
  if (required && value.length === 0) throw new Error(`Missing required action input: ${name}`);
  return value;
}

function parseBoolean(value: string | undefined): boolean {
  if (value === 'true') return true;
  if (value === undefined || value === '' || value === 'false') return false;
  throw new Error(`Expected true or false, received: ${value}`);
}

function writeOutput(name: PrSelectionOutput, value: string): void {
  appendFileSync(requiredEnvironment('GITHUB_OUTPUT'), `${name}=${value}\n`, 'utf8');
}

async function loadAssuranceEvidenceContent(
  selectionPaths: readonly string[],
  metadataOnly: boolean
): Promise<ReadonlyMap<string, string> | undefined> {
  if (metadataOnly) return undefined;
  // The validation plan must determine which assurance packages the change selects before any
  // evidence is fetched, so unrelated changes never perform an evidence API call and a selected
  // package never spends the fail-closed fetch budget on an unselected package's evidence.
  const selectedPackageIds = selectCalculationAssurancePackageIds(
    selectionPaths,
    calculationAssuranceRegistry
  );
  if (selectedPackageIds.length === 0) return undefined;
  const declaredEvidencePaths = collectSelectedEvidencePaths(
    calculationAssuranceRegistry,
    selectedPackageIds
  );
  if (declaredEvidencePaths.length === 0) return undefined;

  return fetchExactHeadEvidenceContent({
    repository: input('repository', true),
    headSha: input('head-sha', true),
    prNumber: input('pr-number'),
    queueRef: input('merge-group-ref'),
    tokens: credentialTokens(),
    entryPaths: declaredEvidencePaths,
  });
}

function credentialTokens(): string[] {
  return [input('github-token', true), input('github-fallback-token')].filter(
    (token) => token.length > 0
  );
}

/**
 * Compares the trusted base's package.json (this checkout) with the PR head's. Only consulted
 * for manifest changes or script ownership. Incremental deltas may omit a manifest
 * changed in an earlier PR commit, so script classification must still read the head.
 */
async function packageManifestImpact(
  changedFiles: readonly string[],
  baseDeltaRoute: boolean,
  exactHeadSources?: ReadonlyMap<string, string>,
): Promise<{
  readonly runtimeNeutral: boolean;
  readonly head: string | undefined;
  readonly entitlementAcceptanceScriptChanged: boolean;
}> {
  const scriptOwnershipRequired = changedFiles.some(path => path.startsWith('scripts/'));
  if (!changedFiles.includes('package.json') && !scriptOwnershipRequired) {
    return { runtimeNeutral: false, head: undefined, entitlementAcceptanceScriptChanged: false };
  }
  const head = scriptOwnershipRequired
    ? exactHeadSources?.get('package.json') ?? null
    : await fetchExactHeadFile({
      repository: input('repository', true),
      headSha: input('head-sha', true),
      prNumber: input('pr-number'),
      queueRef: input('merge-group-ref'),
      tokens: credentialTokens(),
      path: 'package.json',
    });
  return {
    ...packageManifestLaneImpact({
      base: existsSync('package.json') ? readFileSync('package.json', 'utf8') : null,
      head,
      manifestChanged: changedFiles.includes('package.json'),
      baseDeltaRoute,
    }),
    head: head ?? undefined,
  };
}

function pathList(contents: string): string[] {
  return contents
    .split('\n')
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

/** Present only when the base-update classifier routed this head by its base delta. */
function pullRequestLintScope(baseDeltaRoute: boolean): PullRequestLintScope | undefined {
  if (!baseDeltaRoute) return undefined;
  return {
    changed: pathList(input('pull-request-files')),
    deleted: pathList(input('pull-request-deleted-files')),
  };
}

async function run(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const changedFiles = pathList(readFileSync(input('changed-files-file', true), 'utf8'));
  const deletedFiles = pathList(readFileSync(input('deleted-files-file', true), 'utf8'));
  const runtimeManifest: unknown = JSON.parse(
    readFileSync(input('test-runtime-contracts-file', true), 'utf8'),
  );
  const runnableIntegrationTests = new Set([
    ...serverTestRuntimeManifestSchema.parse(runtimeManifest).tests.map((test) => test.path),
    ...curatedDatabaseIntegrationTests,
  ]);
  const metadataOnly = parseBoolean(input('metadata-only'));
  const baseDeltaRoute = parseBoolean(input('base-delta-route'));
  const assuranceEvidenceContent = await loadAssuranceEvidenceContent(
    metadataOnly ? [] : calculationAssuranceSelectionPaths(changedFiles, deletedFiles),
    metadataOnly,
  );

  const scriptOwnershipRequired = !metadataOnly
    && [...changedFiles, ...deletedFiles].some((path) => path.startsWith('scripts/')
      || isServerTestHelper(path) || isServerProductSource(path));
  const exactSources = scriptOwnershipRequired
    ? await exactHeadScriptSources(process.cwd(), {
      repository: input('repository', true),
      baseSha: input('trusted-script-source-sha', true),
      headSha: input('head-sha', true),
      prNumber: input('pr-number'),
      queueRef: input('merge-group-ref'),
      tokens: credentialTokens(),
    }, undefined, signal)
    : undefined;
  signal?.throwIfAborted();

  const sameRevision = input('head-sha') !== ''
    && input('head-sha') === input('trusted-script-source-sha');
  const headTestSource = async (path: string): Promise<string | null> => {
    if (sameRevision) return existsSync(path) ? readFileSync(path, 'utf8') : null;
    return exactSources?.get(path) ?? fetchExactHeadFile({
      repository: input('repository', true),
      headSha: input('head-sha', true),
      prNumber: input('pr-number'),
      queueRef: input('merge-group-ref'),
      tokens: credentialTokens(),
      path,
      maxBytes: 2 * 1024 * 1024,
    });
  };
  const prTestSources = new Map<string, string>();
  let websiteSources: Map<string, string> | undefined;
  if (baseDeltaRoute && !metadataOnly
    && [...changedFiles, ...deletedFiles].some((path) => path.startsWith('src/website/'))) {
    const prDeleted = new Set(pathList(input('pull-request-deleted-files')));
    const prFiles = [...new Set(pathList(input('pull-request-files')))];
    websiteSources = new Map(repositoryWebsiteSources());
    await Promise.all(prFiles.filter((path) => /^src\/website\/.+\.[jt]sx?$/.test(path))
      .map(async (path) => {
        if (prDeleted.has(path)) {
          websiteSources?.delete(path);
          return;
        }
        const source = await headTestSource(path);
        if (source === null) throw new Error(`PR-owned website source is missing at exact head: ${path}`);
        websiteSources?.set(path, source);
      }));
    const prTests = prFiles
      .filter((path) => /^server\/tests\/.+\.test\.ts$/.test(path) && !prDeleted.has(path));
    await Promise.all(prTests.map(async (path) => {
      const source = await headTestSource(path);
      if (source === null) throw new Error(`PR-owned server test is missing at exact head: ${path}`);
      prTestSources.set(path, source);
    }));
  }
  const selectedPrContracts = selectedPrWebsiteContractTests(
    changedFiles, deletedFiles, prTestSources, websiteSources,
  );
  const planningChangedFiles = [...new Set([...changedFiles, ...selectedPrContracts])];
  // The ownership guard also rejects website readers hidden in test helpers.
  // A helper edit must therefore schedule that guard even when no test file
  // changed in this PR.
  const touchedServerTestSources = metadataOnly ? [] : [...new Set([...changedFiles, ...deletedFiles,
    ...selectedPrContracts].filter((path) => /^server\/tests\/.+\.ts$/.test(path)))];
  const websiteContractTestChanged = (await Promise.all(touchedServerTestSources.map(async (path) => {
    const base = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const head = prTestSources.get(path) ?? await headTestSource(path) ?? '';
    return referencesWebsiteFromServerTest(base) || referencesWebsiteFromServerTest(head);
  }))).some(Boolean);

  const manifest = metadataOnly
    ? { runtimeNeutral: false, head: undefined, entitlementAcceptanceScriptChanged: false }
    : await packageManifestImpact(changedFiles, baseDeltaRoute, exactSources);
  const baseConsumers = metadataOnly ? new Map() : scriptConsumers(process.cwd(), manifest.head);
  const deletedOwnershipInputs = deletedFiles.filter((path) =>
    path.startsWith('scripts/') || isServerTestHelper(path));
  const deletedScripts = deletedOwnershipInputs.filter((path) => path.startsWith('scripts/'));
  const headConsumers = exactSources === undefined
    ? baseConsumers
    : scriptConsumersFromSources(exactSources, deletedOwnershipInputs);
  const consumers: ReturnType<typeof scriptConsumers> = exactSources === undefined
    ? baseConsumers
    : retainDeletedScriptConsumers(
      baseConsumers,
      headConsumers,
      exactSources,
      deletedOwnershipInputs,
    );
  const scriptImpact = scriptValidationImpact(consumers, [...changedFiles, ...deletedFiles]);
  const trustedSources = !metadataOnly && [...changedFiles, ...deletedFiles].some(isServerProductSource)
    ? repositoryScriptSources(process.cwd()) : new Map<string, string>();
  const serverSourceImpact = metadataOnly
    ? { ownedSources: [], affectedUnitTests: [], affectedIntegrationTests: [], totalUnitTests: 0 }
    : deriveServerSourceTestImpact(
      trustedSources,
      exactSources ?? trustedSources,
      changedFiles,
      deletedFiles,
      runnableIntegrationTests,
    );
  const retainedDeletedScripts = exactSources === undefined ? [] : retainedDeletedWorkflowOnlyScripts(
    baseConsumers,
    headConsumers,
    exactSources,
    deletedScripts,
  );
  const impactPlan = derivePrValidationPlan({
    changedFiles: planningChangedFiles,
    deletedFiles,
    fileStatusAvailable: parseBoolean(input('file-status-available')),
    metadataOnly,
    packageManifestRuntimeNeutral: manifest.runtimeNeutral,
    entitlementAcceptanceScriptChanged: manifest.entitlementAcceptanceScriptChanged,
    websiteContractTestChanged,
    // Complete exact-head source graph read from Git objects; no PR code is executed.
    scriptImpact: {
      ...scriptImpact,
      ciOnlyScripts: [...new Set([...scriptImpact.ciOnlyScripts, ...retainedDeletedScripts])],
      validationRenames: validationScriptRenames(
        baseConsumers,
        headConsumers,
        readFileSync('package.json', 'utf8'),
        manifest.head,
        changedFiles,
        deletedFiles,
      ),
    },
    serverSourceImpact: {
      ownedSources: [...serverSourceImpact.ownedSources],
      affectedUnitTests: [...serverSourceImpact.affectedUnitTests],
      affectedIntegrationTests: [...serverSourceImpact.affectedIntegrationTests],
      totalUnitTests: serverSourceImpact.totalUnitTests,
    },
  }, runtimeManifest, assuranceEvidenceContent, websiteSources);
  // Missing event inputs (an older workflow) resolve to the complete suites.
  const plan = planForValidationDepth(
    impactPlan,
    validationDepth(input('event-name'), input('base-branch')),
  );

  writeOutput('docs_only', String(plan.docsOnly));
  writeOutput('lint_plan', JSON.stringify(derivePrLintPlan(
    changedFiles, deletedFiles, parseBoolean(input('file-status-available')),
    pullRequestLintScope(baseDeltaRoute),
  )));
  writeOutput('metadata_only', String(plan.metadataOnly));
  writeOutput('policy_required', String(plan.policyRequired));
  writeOutput('workflow_contracts_required', String(plan.workflowContractsRequired));
  writeOutput('server_static_required', String(plan.serverStaticRequired));
  writeOutput('test_only_helpers_to_typecheck', JSON.stringify(plan.testOnlyHelpersToTypecheck));
  writeOutput('server_test_mode', plan.serverTestMode);
  writeOutput('process_heavy_required', String(plan.processHeavyRequired));
  writeOutput('targeted_server_tests', JSON.stringify(plan.targetedServerTests));
  writeOutput('targeted_integration_tests', JSON.stringify(plan.targetedIntegrationTests));
  writeOutput('database_required', String(plan.databaseRequired));
  writeOutput('entitlement_acceptance_required', String(plan.entitlementAcceptanceRequired));
  writeOutput('ios_contracts_required', String(plan.iosContractsRequired));
  writeOutput('calculation_assurance_mode', plan.calculationAssurance.mode);
  writeOutput(
    'calculation_assurance_packages',
    JSON.stringify(plan.calculationAssurance.selectedPackages),
  );
  writeOutput(
    'calculation_assurance_gaps',
    JSON.stringify(plan.calculationAssurance.gaps),
  );
  writeOutput(
    'calculation_assurance_independent_audit_required',
    String(plan.calculationAssurance.independentAuditRequired),
  );
  writeOutput('plan_json', JSON.stringify(plan));
}

const cancellation = new AbortController();
process.once('SIGINT', () => cancellation.abort());
process.once('SIGTERM', () => cancellation.abort());
let operation: Promise<void> | undefined;
installSignalTraps(async () => {
  // A signal first reaps the tracked Git child. Await the planner so its
  // finally-owned temporary ref is removed before the process exits.
  try { await operation; } catch { /* The signal handler owns the exit status. */ }
});
operation = run(cancellation.signal);
try {
  await operation;
  cancellation.signal.throwIfAborted();
} catch (error: unknown) {
  if (!cancellation.signal.aborted) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Typed PR validation planning failed: ${message}\n`);
    process.exitCode = 1;
  }
}

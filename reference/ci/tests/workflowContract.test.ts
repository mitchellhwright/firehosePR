import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';
import { z } from 'zod';

import {
  remediationEligibility,
  remediationOutcomeTelemetrySchema,
  remediationTaskSchema,
} from '../src/agentRemediation.ts';
import {
  type CiStateDocument,
  ciAgentStatusDocumentSchema,
  ciAgentSurfaceStatusSchema,
  ciFleetStatusPageSchema,
  ciStateDocumentSchema,
  computeAgentStatusDigest,
  computeEvidenceDigest,
  computeStateDigest,
  renderAgentHumanSummary,
} from '../src/ciState.ts';
import {
  ciDecisionTelemetrySchema,
  ciMigrationSlos,
  adaptLegacyPrValidationOutput,
  derivePrValidationDecisionTelemetry,
  legacyPrValidationRawOutputSchema,
  prValidationStageLaneIds,
} from '../src/ciMigrationTelemetry.ts';
import { canCutOverMigrationStage, evaluateMigrationStage } from '../src/migrationAcceptance.ts';
import {
  derivePrValidationPlan,
  prValidationInputSchema,
  prValidationPlanSchema,
  type PrValidationPlan,
} from '../src/prValidationPlan.ts';
import { canOpenSelfImprovementPullRequest, deriveImprovementRatio } from '../src/selfImprovement.ts';
import {
  loadRegisteredWorkflows,
  loadRepositoryWorkflows,
  legacyUiDebtIssues,
  legacyUiDebtInventorySchema,
  parseWorkflowDocument,
  validateWorkflowCompatibility,
  validateWorkflowCoverage,
  validateLegacyUiDebt,
  workflowCoverage,
} from '../src/workflowCompatibility.ts';
import {
  computeRegistryDigest,
  humanReadableNameSchema,
  requiredCheckContextSchema,
  workflowContractRegistrySchema,
  workflowContractRegistry,
} from '../src/workflowContract.ts';

const parityFixtureSchema = z.object({
  schema: z.literal('example.ci-migration-parity-fixtures.v1'),
  fixtures: z.array(z.object({
    name: z.string().min(1),
    source: z.string().min(1),
    legacy: z.object({
      adapter: z.literal('pr-validation-controller-output.v1'),
      sourceRunUrl: z.string().url(),
      sourceHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
      rawOutput: legacyPrValidationRawOutputSchema,
    }).strict().optional(),
    legacyIosContractsRequired: z.boolean().optional(),
    input: prValidationInputSchema,
    expected: prValidationPlanSchema,
  }).strict()),
}).strict();

const runtimeManifest: unknown = JSON.parse(
  readFileSync('ci/contracts/server-test-runtimes.json', 'utf8'),
);

function assertRedactionRejected(result: z.ZodSafeParseResult<unknown>): void {
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((issue) => (
      issue.message.includes('secret-like') || issue.message.includes('redacted interface')
    )), JSON.stringify(result.error.issues));
  }
}

function migrationTuple(pullRequest: number) {
  return {
    pullRequest,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    patchDigest: 'c'.repeat(64),
    planVersion: 'example.workflow-contract.v2' as const,
    registryDigest: workflowContractRegistry.registryDigest,
  };
}

function skippedRegistryLanes(exceptLaneId: string): CiStateDocument['lanes'] {
  return workflowContractRegistry.lanes
    .filter((lane) => lane.id !== exceptLaneId)
    .map((lane) => {
      const job = workflowContractRegistry.workflows
        .find((workflow) => workflow.path === lane.workflowPath)
        ?.jobs.find((entry) => entry.id === lane.jobId);
      assert.ok(job);
      return {
        laneId: lane.id,
        displayName: job.displayName,
        purpose: job.purpose,
        progressVocabulary: job.progressVocabulary,
        successMeaning: job.successMeaning,
        failureOwner: job.failureOwner,
        nextAction: job.nextAction,
        statusDetail: 'This lane was not selected for the current tuple.',
        decision: 'skip' as const,
        reasonCode: 'not-selected' as const,
        dependencies: lane.dependencies,
        runner: { requirement: lane.runnerClass },
        evidence: { policy: lane.evidencePolicy, source: 'none' as const },
        phase: 'skipped' as const,
        blockerOwner: 'none' as const,
        expectedNextTransition: 'Continue with the selected lanes.',
        costClass: lane.costClass,
        budget: { maxQueueSeconds: 300, maxExecutionSeconds: 1200, maxGithubHostedCostUsd: 1 },
        links: [],
      };
    });
}

const matchingPrPlan = {
  schema: 'example.pr-validation-plan.v1' as const,
  docsOnly: false,
  metadataOnly: false,
  policyRequired: true,
  workflowContractsRequired: true,
  serverStaticRequired: true,
  testOnlyHelpersToTypecheck: [],
  serverTestMode: 'full' as const,
  applicationTestImpact: true,
  processHeavyRequired: true,
  targetedServerTests: [],
  targetedIntegrationTests: [],
  databaseRequired: true,
  entitlementAcceptanceRequired: false,
  iosContractsRequired: true,
  calculationAssurance: {
    schema: 'example.calculation-assurance-plan.v1' as const,
    mode: 'skip' as const,
    selectedPackages: [],
    independentAuditRequired: false,
    targetedTests: [],
    gaps: [],
    reasons: ['no registered financial calculation package changed'],
  },
};

function prComparison(
  pullRequest: number,
  typedPlan: PrValidationPlan = matchingPrPlan,
  legacyPlan: PrValidationPlan = matchingPrPlan,
) {
  const { schema: _schema, ...legacyOutput } = legacyPlan;
  const flag = (value: boolean): 'true' | 'false' => value ? 'true' : 'false';
  return {
    legacy: {
      adapter: 'pr-validation-controller-output.v1' as const,
      sourceRunUrl: `https://github.com/example-org/example-app/actions/runs/${pullRequest}`,
      sourceHeadSha: 'a'.repeat(40),
      rawOutput: {
        docs_only: flag(legacyOutput.docsOnly),
        metadata_only: flag(legacyOutput.metadataOnly),
        policy_required: flag(legacyOutput.policyRequired),
        workflow_contracts_required: flag(legacyOutput.workflowContractsRequired),
        server_static_required: flag(legacyOutput.serverStaticRequired),
        server_test_mode: legacyOutput.serverTestMode,
        targeted_server_tests: JSON.stringify(legacyOutput.targetedServerTests),
        targeted_integration_tests: JSON.stringify(legacyOutput.targetedIntegrationTests),
        database_required: flag(legacyOutput.databaseRequired),
        ios_contracts_required: flag(legacyOutput.iosContractsRequired),
      },
    },
    typedPlan,
  };
}

test('canonical registry completely covers every current workflow, job, and step', () => {
  const workflows = loadRepositoryWorkflows();
  assert.deepEqual(validateWorkflowCoverage(workflowContractRegistry, workflows), []);
  // The totals come from the workflows on disk, never from a hand-pinned
  // literal: coverage above already fails on any missing or extra entry, and a
  // pinned count made every PR that added a step conflict with every other.
  const onDisk = { workflows: workflows.size, jobs: 0, steps: 0 };
  for (const workflow of workflows.values()) {
    for (const job of Object.values(workflow.jobs)) {
      onDisk.jobs += 1;
      onDisk.steps += (job.steps ?? []).length;
    }
  }
  assert.deepEqual(workflowCoverage(workflowContractRegistry), onDisk);
});

test('legacy UI debt matches its pinned inventory and updates it for every reduction', () => {
  const issues = validateWorkflowCompatibility(
    workflowContractRegistry,
    loadRepositoryWorkflows(),
  );
  const inventory = legacyUiDebtInventorySchema.parse(JSON.parse(
    readFileSync('ci/contracts/legacy-ui-debt.v1.json', 'utf8'),
  ));
  const legacyIssues = legacyUiDebtIssues(issues);
  const legacyIssueSet = new Set(legacyIssues);
  assert.deepEqual(issues.filter((entry) => !legacyIssueSet.has(entry)), []);
  // Derived, never a hand-edited literal: a pinned count made every change
  // that retires one entry conflict with every other change to this file.
  assert.equal(inventory.baselineCount, inventory.entries.length);
  assert.equal(legacyIssues.length, inventory.baselineCount);
  assert.deepEqual(validateLegacyUiDebt(issues, inventory), []);
  assert.ok(validateLegacyUiDebt([], inventory).some((entry) => (
    entry.message.includes('update the inventory in the same change')
  )));
  const reducedInventory = {
    ...inventory,
    baselineCount: inventory.baselineCount - 1,
    entries: inventory.entries.slice(1),
  };
  assert.ok(validateLegacyUiDebt(issues, reducedInventory).some((entry) => (
    entry.message.startsWith('New legacy UI debt:')
  )));
  assert.ok(validateLegacyUiDebt([
    ...issues,
    { laneId: 'new-surface', message: 'GitHub-visible surface is unnamed' },
  ], inventory).some((entry) => entry.message.startsWith('New legacy UI debt:')));
});

test('coverage rejects an undeclared workflow, job, or surfaced step', () => {
  const workflows = loadRepositoryWorkflows();
  workflows.set('.github/workflows/undeclared.yaml', parseWorkflowDocument(`
name: Undeclared workflow
jobs:
  undeclared:
    name: Execute undeclared work
    runs-on: ubuntu-24.04
    steps:
      - name: Perform undeclared work
        run: 'true'
`));
  let issues = validateWorkflowCoverage(workflowContractRegistry, workflows);
  assert.ok(issues.some((entry) => entry.message.includes('Undeclared workflow')));

  workflows.delete('.github/workflows/undeclared.yaml');
  const source = readFileSync('.github/workflows/actions-artifact-cleanup.yml', 'utf8')
    .replace('jobs:\n', 'jobs:\n  undeclared-job:\n    runs-on: ubuntu-24.04\n    steps: []\n');
  workflows.set('.github/workflows/actions-artifact-cleanup.yml', parseWorkflowDocument(source));
  issues = validateWorkflowCoverage(workflowContractRegistry, workflows);
  assert.ok(issues.some((entry) => entry.message.includes('Undeclared job')));

  const extraStep = readFileSync('.github/workflows/actions-artifact-cleanup.yml', 'utf8')
    .replace(
      '      - name: Prune superseded debt-card XCTest caches\n',
      '      - name: Inspect cleanup inputs\n        run: echo inspected\n      - name: Prune superseded debt-card XCTest caches\n',
    );
  workflows.set('.github/workflows/actions-artifact-cleanup.yml', parseWorkflowDocument(extraStep));
  issues = validateWorkflowCoverage(workflowContractRegistry, workflows);
  assert.ok(issues.some((entry) => entry.message.includes('declared steps')));
});

test('strict compatibility rejects raw, generic, and duplicate visible names', () => {
  assert.equal(humanReadableNameSchema.safeParse('run-tests.sh').success, false);
  assert.equal(humanReadableNameSchema.safeParse('PR Checks').success, false);
  const workflows = loadRepositoryWorkflows();
  const source = readFileSync('.github/workflows/actions-artifact-cleanup.yml', 'utf8')
    .replace('name: Actions Artifact Cleanup', 'name: ${{ opaque.expression }}')
    .replace('name: Prune superseded XCTest caches', 'name: run')
    .replace('name: Prune superseded debt-card XCTest caches', 'name: Check out the cleanup scripts');
  workflows.set('.github/workflows/actions-artifact-cleanup.yml', parseWorkflowDocument(source));
  const issues = validateWorkflowCompatibility(workflowContractRegistry, workflows);
  assert.ok(issues.some((entry) => entry.message.includes('opaque or generic')));
  assert.ok(issues.some((entry) => entry.message.includes('Duplicate visible step name')));
});

test('every desired UI surface has bounded human and agent status semantics', () => {
  for (const workflow of workflowContractRegistry.workflows) {
    for (const surface of [workflow, ...workflow.jobs, ...workflow.jobs.flatMap((job) => job.steps)]) {
      assert.ok(humanReadableNameSchema.safeParse(surface.displayName).success
        || (requiredCheckContextSchema.safeParse(surface.displayName).success
          && workflowContractRegistry.lanes.some((lane) => lane.workflowPath === workflow.path
            && lane.checkContext === surface.displayName)));
      assert.ok(surface.purpose.length >= 10);
      assert.ok(surface.progressVocabulary.includes('running'));
      assert.ok(surface.statusDetail.running.length >= 10);
      assert.ok(surface.statusDetail.nextUpdateSeconds <= 300);
      assert.ok(surface.successMeaning.length >= 10);
      assert.ok(surface.nextAction.length >= 10);
      assert.ok(surface.purpose.includes(surface.displayName));
      assert.ok(surface.successMeaning.includes(surface.displayName));
      assert.ok(surface.nextAction.includes(surface.displayName));
      assert.notEqual(surface.purpose, `Coordinates ${surface.displayName}.`);
      assert.notEqual(surface.purpose, `Executes ${surface.displayName}.`);
      assert.notEqual(surface.purpose, `Performs ${surface.displayName}.`);
      assert.doesNotMatch(surface.successMeaning, /declared responsibility/);
      assert.doesNotMatch(surface.nextAction, /inspects bounded (workflow|job|step) evidence/);
    }
  }
  const productOwned = workflowContractRegistry.workflows.flatMap((workflow) => workflow.jobs)
    .filter((job) => job.failureOwner === 'product');
  assert.ok(productOwned.some((job) => job.id === 'database-integration'));
  assert.ok(productOwned.some((job) => job.id === 'test-ios-execution'));
  assert.ok(productOwned.some((job) => job.id === 'onboarding-e2e'));
  const infrastructureOwned = workflowContractRegistry.workflows.flatMap((workflow) => workflow.jobs)
    .filter((job) => job.failureOwner === 'infrastructure');
  assert.ok(infrastructureOwned.some((job) => job.id === 'portable-heartbeat'));
  const infrastructureSetupSteps = workflowContractRegistry.workflows.flatMap((workflow) => workflow.jobs)
    .flatMap((job) => job.steps)
    .filter((step) => /^(?:check\s*out|checkout|set up (?:node|the node\.js runtime|google cloud sdk)|install .*dependencies|configure cloud sdk python|ensure (?:container engine|simulator host)|export simulator)/i.test(step.displayName));
  assert.ok(infrastructureSetupSteps.length > 0);
  for (const step of infrastructureSetupSteps) {
    assert.equal(step.failureOwner, 'infrastructure');
    assert.equal(step.statusDetail.unit, 'step');
    assert.match(step.purpose, /execution capabilities/);
    assert.match(step.nextAction, /infrastructure owner/i);
  }
});

test('registry digest changes with canonical UI content', () => {
  const { registryDigest: _registryDigest, ...unpinned } = workflowContractRegistry;
  assert.equal(computeRegistryDigest(unpinned), workflowContractRegistry.registryDigest);
  const changed = structuredClone(unpinned);
  const firstWorkflow = changed.workflows[0];
  assert.ok(firstWorkflow);
  firstWorkflow.displayName = `${firstWorkflow.displayName} updated`;
  assert.notEqual(computeRegistryDigest(unpinned), computeRegistryDigest(changed));
  assert.throws(() => workflowContractRegistrySchema.parse({
    ...workflowContractRegistry,
    workflows: changed.workflows,
  }));
});

test('registry assigns each workflow job to exactly one typed lane', () => {
  const { registryDigest: _registryDigest, ...registry } = structuredClone(workflowContractRegistry);
  const lane = registry.lanes[0];
  assert.ok(lane);
  registry.lanes.push({ ...lane, id: `${lane.id}.duplicate` });
  const duplicatedJobRegistry = {
    ...registry,
    registryDigest: computeRegistryDigest(registry),
  };
  assert.throws(
    () => workflowContractRegistrySchema.parse(duplicatedJobRegistry),
    /Each workflow job must map to exactly one typed lane/,
  );
});

test('registry binds a generic required-context name to its lane and branch rules', () => {
  const withoutLaneContext = structuredClone(workflowContractRegistry);
  const lane = withoutLaneContext.lanes.find((candidate) => candidate.id === 'ios.native-aggregate');
  assert.ok(lane);
  const workflow = withoutLaneContext.workflows.find(
    (candidate) => candidate.path === lane.workflowPath,
  );
  const job = workflow?.jobs.find((candidate) => candidate.id === lane.jobId);
  assert.ok(job);
  lane.displayName = 'Test - iOS';
  job.displayName = 'Test - iOS';
  delete lane.checkContext;
  const { registryDigest: _laneDigest, ...unpinnedLaneRegistry } = withoutLaneContext;
  assert.throws(
    () => workflowContractRegistrySchema.parse({
      ...unpinnedLaneRegistry,
      registryDigest: computeRegistryDigest(unpinnedLaneRegistry),
    }),
    /generic job name is allowed only when its lane publishes that required check context/,
  );

  const withoutBranchRequirement = structuredClone(workflowContractRegistry);
  const branchLane = withoutBranchRequirement.lanes.find(
    (candidate) => candidate.id === 'ios.native-aggregate',
  );
  assert.ok(branchLane);
  const branchWorkflow = withoutBranchRequirement.workflows.find(
    (candidate) => candidate.path === branchLane.workflowPath,
  );
  const branchJob = branchWorkflow?.jobs.find((candidate) => candidate.id === branchLane.jobId);
  assert.ok(branchJob);
  branchLane.displayName = 'Test - iOS';
  branchJob.displayName = 'Test - iOS';
  withoutBranchRequirement.requiredChecks.develop = withoutBranchRequirement.requiredChecks.develop
    .filter((context) => context !== 'Test - iOS');
  withoutBranchRequirement.requiredChecks.main = withoutBranchRequirement.requiredChecks.main
    .filter((context) => context !== 'Test - iOS');
  const { registryDigest: _branchDigest, ...unpinnedBranchRegistry } = withoutBranchRequirement;
  assert.throws(
    () => workflowContractRegistrySchema.parse({
      ...unpinnedBranchRegistry,
      registryDigest: computeRegistryDigest(unpinnedBranchRegistry),
    }),
    /generic job name is allowed only when its lane publishes that required check context/,
  );
});

test('compatibility validation detects a dropped macOS capability label', () => {
  const source = readFileSync('.github/workflows/ios-tests.yml', 'utf8')
    .replaceAll('ios-xcode', 'missing-ios-capability');
  const workflows = loadRegisteredWorkflows(workflowContractRegistry);
  workflows.set('.github/workflows/ios-tests.yml', parseWorkflowDocument(source));
  const issues = validateWorkflowCompatibility(workflowContractRegistry, workflows);
  assert.ok(issues.some((issue) => (
    issue.laneId === 'ios.native-build' && issue.message.includes('runner contract')
  )));
});

/**
 * Swap the native-build lane's `runs-on` for a decoy. The two tests below
 * inject one to prove the compatibility check catches it, and both used a
 * literal `.replace()` of the hand-written YAML. That text is generated now
 * and the emitter quotes the expression, so the literal stopped matching and
 * the injection silently did nothing — a test that passes while testing
 * nothing. This tolerates the quoting and fails loudly if it matches neither.
 */
function replaceNativeBuildRunsOn(source: string, replacement: string): string {
  // The emitter writes `labels` as a block sequence where the hand-written
  // YAML used the flow form, so both spellings are accepted.
  const block = new RegExp(
    "runs-on:\\n      group: '?\\$\\{\\{[^\\n]*?\\}\\}'?\\n      labels:"
    + '(?: \\[self-hosted, macOS, ios-xcode\\]|\\n        - self-hosted\\n        - macOS\\n        - ios-xcode| [^\\n]*fromJson\\([^\\n]*ios-xcode[^\\n]*)'
    // The routed form: one expression whose pool branch still names ios-xcode.
    + "|runs-on: '\\$\\{\\{ fromJson\\(needs\\.ios-change-gate\\.outputs\\.native_mac_route[^\\n]*ios-xcode[^\\n]*\\}\\}'",
  );
  // Scope to the job this decoy is about. Every Mac lane shares this runs-on,
  // and the hand-written file reached them through one YAML anchor while the
  // emitter writes each lane's copy out, so an unscoped replace lands in
  // whichever lane happens to come first and the decoy tests nothing.
  const header = '\n  build-ios-native-test-products:\n';
  const headerStart = source.indexOf(header);
  assert.notEqual(headerStart, -1, 'the native-build job must still be present to inject a decoy');
  const bodyStart = headerStart + header.length;
  const nextJob = source.slice(bodyStart).search(/^ {2}[a-z0-9-]+:$/m);
  const bodyEnd = nextJob === -1 ? source.length : bodyStart + nextJob;
  const body = source.slice(bodyStart, bodyEnd);
  assert.match(body, block, 'the native-build runs-on block must still be recognisable to inject a decoy');
  return source.slice(0, bodyStart) + body.replace(block, replacement) + source.slice(bodyEnd);
}

test('physical macOS compatibility requires positive capability labels after coordinated drift', () => {
  const registry = structuredClone(workflowContractRegistry);
  const lane = registry.lanes.find((entry) => entry.id === 'ios.native-build');
  assert.ok(lane);
  lane.runsOnCanonical = '["self-hosted","Linux"]';
  const source = replaceNativeBuildRunsOn(
    readFileSync('.github/workflows/ios-tests.yml', 'utf8'),
    'runs-on: [self-hosted, Linux]',
  );
  const workflows = loadRegisteredWorkflows(workflowContractRegistry);
  workflows.set('.github/workflows/ios-tests.yml', parseWorkflowDocument(source));
  const issues = validateWorkflowCompatibility(registry, workflows);
  assert.ok(issues.some((entry) => (
    entry.laneId === 'ios.native-build' && entry.message.includes('required self-hosted Mac capability labels')
  )));
});

test('parsed runner and concurrency contracts reject false-branch decoys', () => {
  // Both decoys are injected through a quote-tolerant pattern and asserted to
  // have landed: a literal that silently stops matching leaves the test green
  // while proving nothing, which is what the generated YAML's quoting did.
  const runnerGroup = /group: '?\$\{\{ \(+github\.event_name == ''?pull_request''?[^\n]*?\}\}'?/;
  const concurrencyGroup = /group: '?ios-\$\{\{ (?:fromJSON\(\()?github\.event_name == ''?pull_request''?[^\n]*?\}\}-/;
  const original = readFileSync('.github/workflows/ios-tests.yml', 'utf8');
  assert.match(original, runnerGroup, 'the runner group must still be recognisable to inject a decoy');
  assert.match(original, concurrencyGroup, 'the concurrency group must still be recognisable to inject a decoy');
  const source = original
    .replace(runnerGroup, "group: ${{ false && 'example-reviewed-pr-macs' || 'untrusted-runner-group' }}")
    .replace(
      concurrencyGroup,
      "group: decoy-${{ false && 'exact-tuple' || 'wrong-tuple' }}-${{ github.event.pull_request.number || github.run_id }}-",
    );
  const workflows = loadRegisteredWorkflows(workflowContractRegistry);
  workflows.set('.github/workflows/ios-tests.yml', parseWorkflowDocument(source));
  const issues = validateWorkflowCompatibility(workflowContractRegistry, workflows);
  assert.ok(issues.some((entry) => entry.message.includes('Parsed runner contract')));
  assert.ok(issues.some((entry) => entry.message.includes('Parsed concurrency contract')));
});

/**
 * The registered workflows with one field of `pr-checks.yml` changed. The
 * change is made on the parsed document, not on the YAML text: that file is
 * generated, so its quoting and line breaks belong to the emitter, and a text
 * substitution would silently stop matching — leaving a test that proves
 * nothing while still passing.
 */
function prChecksMutated(
  mutate: (document: { concurrency?: unknown; jobs: Record<string, Record<string, unknown>> }) => void,
): ReturnType<typeof loadRegisteredWorkflows> {
  const document = load(readFileSync('.github/workflows/pr-checks.yml', 'utf8')) as {
    concurrency?: unknown;
    jobs: Record<string, Record<string, unknown>>;
  };
  mutate(document);
  const workflows = loadRegisteredWorkflows(workflowContractRegistry);
  // YAML is a superset of JSON, so the mutated document round-trips through
  // the same parser the registered workflows came from.
  workflows.set('.github/workflows/pr-checks.yml', parseWorkflowDocument(JSON.stringify(document)));
  return workflows;
}

test('workflow-level concurrency is pinned and rejects a global serialization change', () => {
  const workflows = prChecksMutated((document) => {
    document.concurrency = { group: 'global-pr-checks', 'cancel-in-progress': true };
  });
  const issues = validateWorkflowCompatibility(workflowContractRegistry, workflows);
  assert.ok(issues.some((entry) => entry.message.includes('Parsed workflow concurrency')));
});

test('job concurrency is compared unconditionally, so an expected absence is also protected', () => {
  const lintLane = workflowContractRegistry.lanes.find((lane) => lane.id === 'pr.lint');
  assert.ok(lintLane);
  assert.equal(lintLane.concurrencyCanonical, undefined);
  const workflows = prChecksMutated((document) => {
    const lint = document.jobs['lint'];
    assert.ok(lint, 'pr-checks.yml must still have a lint job');
    lint['concurrency'] = { group: 'lint-${{ github.ref }}' };
  });
  const issues = validateWorkflowCompatibility(workflowContractRegistry, workflows);
  assert.ok(issues.some((issue) => (
    issue.laneId === 'pr.lint' && issue.message.includes('Parsed concurrency contract')
  )));
});

test('compatibility validation detects a changed aggregate dependency', () => {
  const workflows = prChecksMutated((document) => {
    const validate = document.jobs['validate'];
    assert.ok(validate, 'pr-checks.yml must still have a validate job');
    const needs = validate['needs'];
    assert.ok(Array.isArray(needs) && needs.includes('database-integration'));
    validate['needs'] = needs.filter((dependency) => dependency !== 'database-integration');
  });
  const issues = validateWorkflowCompatibility(workflowContractRegistry, workflows);
  assert.ok(issues.some((issue) => (
    issue.laneId === 'pr.aggregate' && issue.message.includes('dependencies')
  )));
});

test('required check names remain stable across the migration', () => {
  // `lint` and `validate` were renamed with the pr-checks migration, which is
  // why every name here reads as a sentence about the change it guards. The
  // branch protection on develop and main is edited in the same change; these
  // are the contexts it must list.
  assert.deepEqual(workflowContractRegistry.requiredChecks.develop, [
    'Lint changed code',
    'Validate pull request changes',
    'Test - iOS',
    'Onboarding E2E',
    'iOS Change Gate',
    'StoreKit Purchase - iOS',
  ]);
  assert.deepEqual(workflowContractRegistry.requiredChecks.main, [
    'Lint changed code',
    'Validate pull request changes',
    'Test - iOS',
    'Onboarding E2E',
    'iOS Change Gate',
    'StoreKit Purchase - iOS',
  ]);
});

test('every registered lane has a stable human-readable name', () => {
  for (const lane of workflowContractRegistry.lanes) {
    assert.ok(lane.displayName.length <= 80);
    assert.doesNotMatch(lane.displayName, /\$\{\{/);
  }
});

test('historical and current fixtures preserve typed-plan decisions', () => {
  const fixtures = parityFixtureSchema.parse(JSON.parse(
    readFileSync('ci/contracts/migration-parity-fixtures.json', 'utf8'),
  ));
  for (const fixture of fixtures.fixtures) {
    assert.deepEqual(
      derivePrValidationPlan(fixture.input, runtimeManifest),
      fixture.expected,
      fixture.name,
    );
    if (fixture.legacy) {
      const {
        schema: _schema,
        calculationAssurance: _calculationAssurance,
        entitlementAcceptanceRequired: _entitlementAcceptanceRequired,
        testOnlyHelpersToTypecheck: _testOnlyHelpersToTypecheck,
        processHeavyRequired: _processHeavyRequired,
        applicationTestImpact: _applicationTestImpact,
        ...expectedLegacy
      } = fixture.expected;
      const legacyPlan = adaptLegacyPrValidationOutput(fixture.legacy.rawOutput);
      if (fixture.legacyIosContractsRequired !== undefined) {
        assert.notEqual(fixture.legacyIosContractsRequired, expectedLegacy.iosContractsRequired);
      }
      assert.deepEqual(legacyPlan, {
        ...expectedLegacy,
        iosContractsRequired: fixture.legacyIosContractsRequired ?? expectedLegacy.iosContractsRequired,
      });
    }
  }
  assert.equal(fixtures.fixtures.filter((fixture) => fixture.legacy).length, 2);
});

test('migration telemetry derives complete registry-bound decisions from legacy output', () => {
  const tuple = migrationTuple(5432);
  const comparison = prComparison(5432, { ...matchingPrPlan, databaseRequired: false });
  const telemetry = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison,
    disposition: 'current',
  });
  assert.deepEqual(telemetry.map((entry) => entry.laneId), prValidationStageLaneIds);
  assert.equal(telemetry.find((entry) => entry.laneId === 'pr.database')?.parity, false);
  assert.ok(telemetry.every((entry) => (
    entry.costClass === workflowContractRegistry.lanes.find((lane) => lane.id === entry.laneId)?.costClass
  )));
  // pr-checks.validation-policy is owned by typed-pr-validation and gates the
  // debt dependency checks; parity must reflect its own drift, not just the
  // lanes that happened to already be tracked.
  const policyMismatch = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(5432, { ...matchingPrPlan, policyRequired: false }),
    disposition: 'current',
  });
  const policyLaneEntry = policyMismatch.find((entry) => entry.laneId === 'pr-checks.validation-policy');
  assert.ok(policyLaneEntry);
  assert.equal(policyLaneEntry.legacyDecision, 'execute');
  assert.equal(policyLaneEntry.typedDecision, 'skip');
  assert.equal(policyLaneEntry.parity, false);
  assert.throws(() => ciDecisionTelemetrySchema.parse({ ...telemetry[0], laneId: 'invented-lane' }));
  assert.throws(() => ciDecisionTelemetrySchema.parse({ ...telemetry[0], costClass: 'expensive' }));
  assert.throws(() => derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow', tuple,
    comparison: {
      ...comparison,
      legacy: { ...comparison.legacy, sourceHeadSha: '9'.repeat(40) },
    },
    disposition: 'current',
  }));
  assert.throws(() => derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00', mode: 'shadow', tuple,
    comparison: {
      ...comparison,
      legacy: {
        ...comparison.legacy,
        rawOutput: { ...comparison.legacy.rawOutput, targeted_server_tests: 'not-json' },
      },
    },
    disposition: 'current',
  }));
  assert.equal(ciMigrationSlos.decisionParityRatio, 1);
});

test('migration telemetry treats a docsOnly disagreement as a parity mismatch on every lane', () => {
  // pr-checks.yml gates the lint job's Install Dependencies and Lint steps on
  // plan-pr-validation's docs_only output directly (lines 623/627), independent
  // of every other *_required flag selected() already reads. A disagreement
  // here changes what actually runs even when every tracked lane decision
  // still happens to match.
  const tuple = migrationTuple(5434);
  const telemetry = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(
      5434,
      { ...matchingPrPlan, docsOnly: true },
      { ...matchingPrPlan, docsOnly: false },
    ),
    disposition: 'current',
  });
  assert.deepEqual(telemetry.map((entry) => entry.laneId), prValidationStageLaneIds);
  assert.ok(telemetry.every((entry) => entry.legacyDecision === entry.typedDecision));
  assert.ok(telemetry.every((entry) => entry.parity === false));
  assert.ok(telemetry.every((entry) => entry.reasonCode === 'shadow-decision-mismatch'));

  const agreeingTelemetry = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(5434, { ...matchingPrPlan, docsOnly: false }, { ...matchingPrPlan, docsOnly: false }),
    disposition: 'current',
  });
  assert.ok(agreeingTelemetry.every((entry) => entry.parity === true));
});

test('migration telemetry treats a metadataOnly disagreement as a parity mismatch on every lane', () => {
  // metadata_only is consumed by pr-checks.yml outside the lane flags
  // selected() reads: the removed-file and runtime-contract steps
  // short-circuit on it (lines 412/447) and the aggregate require_success
  // step reads it (line 986). A disagreement changes what actually runs even
  // when every tracked lane decision still matches.
  const tuple = migrationTuple(5438);
  const telemetry = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(
      5438,
      { ...matchingPrPlan, metadataOnly: true, policyRequired: false },
      { ...matchingPrPlan, metadataOnly: false, policyRequired: false },
    ),
    disposition: 'current',
  });
  assert.deepEqual(telemetry.map((entry) => entry.laneId), prValidationStageLaneIds);
  assert.ok(telemetry.every((entry) => entry.legacyDecision === entry.typedDecision));
  assert.ok(telemetry.every((entry) => entry.parity === false));
  assert.ok(telemetry.every((entry) => entry.reasonCode === 'shadow-decision-mismatch'));

  const agreeingTelemetry = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(
      5438,
      { ...matchingPrPlan, metadataOnly: false, policyRequired: false },
      { ...matchingPrPlan, metadataOnly: false, policyRequired: false },
    ),
    disposition: 'current',
  });
  assert.ok(agreeingTelemetry.every((entry) => entry.parity === true));
});

test('validation-policy selection models the metadata_only gate, not policy_required alone', () => {
  // pr-checks.yml:688 gates validation-policy on
  // `metadata_only != 'true' && policy_required == 'true'`. The bootstrap
  // fallback publishes policy_required from its own expression, so reading
  // policy_required alone would score the job as executing for a
  // metadata-only tuple the workflow skips outright.
  const tuple = migrationTuple(5439);
  const metadataOnlyPlan = {
    ...matchingPrPlan,
    docsOnly: true,
    metadataOnly: true,
    policyRequired: false,
    workflowContractsRequired: false,
    serverStaticRequired: false,
    serverTestMode: 'none' as const,
    processHeavyRequired: false,
    databaseRequired: false,
    iosContractsRequired: false,
  };
  const telemetry = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(
      5439,
      metadataOnlyPlan,
      { ...metadataOnlyPlan, policyRequired: true },
    ),
    disposition: 'current',
  });
  const policyLane = telemetry.find((entry) => entry.laneId === 'pr-checks.validation-policy');
  assert.ok(policyLane);
  assert.equal(policyLane.legacyDecision, 'skip');
  assert.equal(policyLane.typedDecision, 'skip');
  assert.ok(telemetry.every((entry) => entry.parity === true));

  // The gate only suppresses the lane while metadata_only holds; an ordinary
  // tuple still selects validation-policy from policy_required.
  const ordinary = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(5439),
    disposition: 'current',
  });
  assert.equal(
    ordinary.find((entry) => entry.laneId === 'pr-checks.validation-policy')?.typedDecision,
    'execute',
  );
});

test('targeted-server parity requires matching targeted test payloads, not just matching selection', () => {
  const tuple = migrationTuple(5433);
  const targetedPlan = {
    ...matchingPrPlan,
    serverTestMode: 'targeted' as const,
    targetedServerTests: ['server/tests/a.test.ts', 'server/tests/b.test.ts'],
    targetedIntegrationTests: [],
  };
  const matchingTelemetry = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(5433, targetedPlan, targetedPlan),
    disposition: 'current',
  });
  const matchingEntry = matchingTelemetry.find((entry) => entry.laneId === 'pr.targeted-server');
  assert.ok(matchingEntry);
  assert.equal(matchingEntry.legacyDecision, 'execute');
  assert.equal(matchingEntry.typedDecision, 'execute');
  assert.equal(matchingEntry.parity, true);

  // Both controllers pick targeted mode, but the typed controller would omit
  // a test the legacy controller still runs. pr-checks.yml passes these
  // arrays straight to the targeted test runners, so this must not read as
  // parity even though both sides selected 'execute'.
  const divergentTelemetry = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(5433, {
      ...targetedPlan,
      targetedServerTests: ['server/tests/a.test.ts'],
    }, targetedPlan),
    disposition: 'current',
  });
  const divergentEntry = divergentTelemetry.find((entry) => entry.laneId === 'pr.targeted-server');
  assert.ok(divergentEntry);
  assert.equal(divergentEntry.legacyDecision, 'execute');
  assert.equal(divergentEntry.typedDecision, 'execute');
  assert.equal(divergentEntry.parity, false);
  assert.equal(divergentEntry.reasonCode, 'shadow-decision-mismatch');

  // Ordering and duplicates must not defeat the comparison.
  const reorderedTelemetry = derivePrValidationDecisionTelemetry({
    recordedAt: '2026-09-14T18:00:00-04:00',
    mode: 'shadow',
    tuple,
    comparison: prComparison(5433, {
      ...targetedPlan,
      targetedServerTests: ['server/tests/b.test.ts', 'server/tests/a.test.ts', 'server/tests/a.test.ts'],
    }, targetedPlan),
    disposition: 'current',
  });
  assert.equal(
    reorderedTelemetry.find((entry) => entry.laneId === 'pr.targeted-server')?.parity,
    true,
  );

  // A mismatched target set on an unrelated lane must not affect its parity.
  assert.equal(
    divergentTelemetry.find((entry) => entry.laneId === 'pr.database')?.parity,
    true,
  );

  // The schema still rejects a fabricated parity claim when the decisions
  // themselves disagree.
  assert.throws(() => ciDecisionTelemetrySchema.parse({
    ...matchingEntry,
    typedDecision: 'skip',
    parity: true,
  }));
});

test('agent remediation requires diagnosis, narrow scope, and available budget', () => {
  const fingerprint = 'd'.repeat(64);
  const task = {
    schema: 'example.agent-remediation-task.v1',
    agent: 'github-copilot-cloud',
    pullRequest: 5432,
    issue: 5440,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    diagnosis: {
      schema: 'example.ci-diagnosis.v1',
      fingerprint,
      category: 'test-assertion',
      reproducible: true,
      failingLaneId: 'pr.targeted-server',
      failingFiles: ['server/tests/example.test.ts'],
      logArtifactUrl: 'https://github.com/example-org/example-app/actions/runs/1',
    },
    allowedPaths: ['server/tests/example.test.ts'],
    maxAttempts: 2,
    maxAiCredits: 25,
    maxActionsMinutes: 10,
    requireIndependentReview: true,
    allowProtectionChanges: false,
    allowSelfApproval: false,
  };
  const budget = {
    attemptsForPullRequest: 0,
    aiCreditsUsedToday: 10,
    aiCreditsDailyCap: 100,
    actionsMinutesUsedToday: 5,
    actionsMinutesDailyCap: 60,
    priorFingerprints: [],
  };
  assert.deepEqual(remediationEligibility(task, budget), { eligible: true });
  assert.deepEqual(
    remediationEligibility(task, { ...budget, priorFingerprints: [fingerprint] }),
    { eligible: false, reason: 'diagnostic-loop-suppressed' },
  );
  assert.deepEqual(
    remediationEligibility({
      ...task,
      diagnosis: { ...task.diagnosis, category: 'runner-capability' },
    }, budget),
    { eligible: false, reason: 'deterministic-infrastructure-repair-required' },
  );
});

test('remediation scope admits only normalized repository-relative paths', () => {
  const baseTask = {
    schema: 'example.agent-remediation-task.v1',
    agent: 'external-codex',
    pullRequest: 5432,
    issue: 5440,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    diagnosis: {
      schema: 'example.ci-diagnosis.v1',
      fingerprint: 'd'.repeat(64),
      category: 'test-assertion',
      reproducible: true,
      failingLaneId: 'pr.targeted-server',
      failingFiles: ['server/tests/example.test.ts'],
      logArtifactUrl: 'https://github.com/example-org/example-app/actions/runs/1',
    },
    allowedPaths: ['server/tests/example.test.ts'],
    maxAttempts: 2,
    maxAiCredits: 25,
    maxActionsMinutes: 10,
    requireIndependentReview: true,
    allowProtectionChanges: false,
    allowSelfApproval: false,
  };
  const budgetWithHeadroom = {
    attemptsForPullRequest: 0,
    aiCreditsUsedToday: 10,
    aiCreditsDailyCap: 100,
    actionsMinutesUsedToday: 5,
    actionsMinutesDailyCap: 60,
    priorFingerprints: [],
  };

  // A leading dot names a real repository directory, and a doubled dot inside a
  // file name is not a path segment, so the guard can reduce neither to
  // "reject anything starting with a dot" nor to a bare `includes('..')`.
  const safePaths = [
    'server/tests/example.test.ts',
    'ci/src/agentRemediation.ts',
    '.github/workflows/pr-checks.yml',
    'package.json',
    'server/tests/fixtures/plaid..sandbox.json',
  ];
  for (const path of safePaths) {
    assert.equal(remediationTaskSchema.safeParse({
      ...baseTask,
      diagnosis: { ...baseTask.diagnosis, failingFiles: [path] },
      allowedPaths: [path],
    }).success, true, `expected ${JSON.stringify(path)} to be admissible`);
  }

  const unsafePaths = [
    '/etc/passwd',
    '/',
    '../../etc/passwd',
    '..',
    '.',
    'server/../../etc/passwd',
    // Traversal that normalizes back inside the repository is still traversal:
    // the contract requires the already-normalized form.
    'server/../server/tests/example.test.ts',
    './server/tests/example.test.ts',
    'server//tests/example.test.ts',
    'server/./tests/example.test.ts',
    'server/tests/',
    'server/tests/example.test.ts/..',
    'server\\tests\\example.test.ts',
    'C:\\server\\tests\\example.test.ts',
    'server/tests/example\n.test.ts',
    '',
  ];
  for (const path of unsafePaths) {
    // Both scope fields are attacker-influenced, so each must reject independently.
    const rejectedAllowedPaths = remediationTaskSchema.safeParse({
      ...baseTask,
      allowedPaths: [path],
    });
    assert.equal(rejectedAllowedPaths.success, false, `expected allowedPaths ${JSON.stringify(path)} to be rejected`);
    assert.ok(rejectedAllowedPaths.error?.issues.some((issue) => issue.path[0] === 'allowedPaths'));

    const rejectedFailingFiles = remediationTaskSchema.safeParse({
      ...baseTask,
      diagnosis: { ...baseTask.diagnosis, failingFiles: [path] },
    });
    assert.equal(rejectedFailingFiles.success, false, `expected failingFiles ${JSON.stringify(path)} to be rejected`);
    assert.ok(rejectedFailingFiles.error?.issues.some((issue) => (
      issue.path[0] === 'diagnosis' && issue.path[1] === 'failingFiles'
    )));

    // Eligibility parses the task, so an escaping scope fails closed rather
    // than being reported as an eligible remediation.
    assert.throws(() => remediationEligibility({ ...baseTask, allowedPaths: [path] }, budgetWithHeadroom));
  }

  assert.deepEqual(remediationEligibility(baseTask, budgetWithHeadroom), { eligible: true });
});

test('remediation evidence stays on query-free repository Actions URLs', () => {
  const baseTask = {
    schema: 'example.agent-remediation-task.v1',
    agent: 'external-codex',
    pullRequest: 5432,
    issue: 5440,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    diagnosis: {
      schema: 'example.ci-diagnosis.v1',
      fingerprint: 'd'.repeat(64),
      category: 'test-assertion',
      reproducible: true,
      failingLaneId: 'pr.targeted-server',
      failingFiles: ['server/tests/example.test.ts'],
      logArtifactUrl: 'https://github.com/example-org/example-app/actions/runs/1',
    },
    allowedPaths: ['server/tests/example.test.ts'],
    maxAttempts: 2,
    maxAiCredits: 25,
    maxActionsMinutes: 10,
    requireIndependentReview: true,
    allowProtectionChanges: false,
    allowSelfApproval: false,
  };
  for (const logArtifactUrl of [
    'https://github.com/example-org/example-app/actions/runs/1',
    'https://github.com/example-org/example-app/actions/runs/1/artifacts/2',
  ]) {
    assert.equal(remediationTaskSchema.safeParse({
      ...baseTask,
      diagnosis: { ...baseTask.diagnosis, logArtifactUrl },
    }).success, true);
  }
  for (const logArtifactUrl of [
    'file:///etc/passwd',
    'ftp://github.com/example-org/example-app/actions/runs/1',
    'https://github.com:444/example-org/example-app/actions/runs/1',
    'https://attacker.example/example-org/example-app/actions/runs/1',
    'https://github.com/Other-Org/example-app/actions/runs/1',
    'https://github.com/example-org/example-app/actions/runs/1?token=abcdefghijklmnopqrstuvwxyz',
    'https://github.com/example-org/example-app/actions/runs/1#logs',
  ]) {
    const result = remediationTaskSchema.safeParse({
      ...baseTask,
      diagnosis: { ...baseTask.diagnosis, logArtifactUrl },
    });
    assert.equal(result.success, false, `expected ${logArtifactUrl} to be rejected`);
    assert.ok(result.error?.issues.some((issue) => (
      issue.path[0] === 'diagnosis' && issue.path[1] === 'logArtifactUrl'
    )));
  }
});

test('remediation outcome telemetry ties mergedPullRequest to the merged outcome', () => {
  const baseTelemetry = {
    schema: 'example.agent-remediation-outcome.v1',
    agent: 'github-copilot-cloud',
    pullRequest: 5432,
    issue: 5440,
    diagnosisFingerprint: 'd'.repeat(64),
    sessionId: 'session-1',
    attempt: 1,
    aiCredits: 5,
    actionsMinutes: 3,
    humanInterventionAvoided: true,
  };

  // A merged outcome must report which PR was merged.
  assert.deepEqual(
    remediationOutcomeTelemetrySchema.parse({
      ...baseTelemetry,
      outcome: 'merged',
      mergedPullRequest: 5432,
    }).mergedPullRequest,
    5432,
  );

  // A merged outcome without a merged PR number is a contradictory record.
  assert.throws(() => remediationOutcomeTelemetrySchema.parse({
    ...baseTelemetry,
    outcome: 'merged',
  }));

  // Non-merged outcomes must not carry a merged PR number.
  for (const outcome of ['no-change', 'candidate-opened', 'checks-failed', 'stopped']) {
    assert.deepEqual(
      remediationOutcomeTelemetrySchema.parse({ ...baseTelemetry, outcome }).outcome,
      outcome,
    );
    assert.throws(() => remediationOutcomeTelemetrySchema.parse({
      ...baseTelemetry,
      outcome,
      mergedPullRequest: 5432,
    }));
  }
});

test('self-improvement candidates need replay, shadow parity, safety, and measurable gain', () => {
  const proposal = {
    schema: 'example.ci-self-improvement-proposal.v1',
    proposalId: 'reduce-native-cache-misses',
    configDigest: 'e'.repeat(64),
    allowedPaths: ['ci/src/nativeExecutionPlan.ts'],
    historicalReplayCount: 100,
    historicalReplayPassed: true,
    shadowDecisionCount: 50,
    shadowParityRatio: 1,
    outcomes: [
      { metric: 'execution-p95', baseline: 1200, candidate: 960 },
      { metric: 'github-hosted-cost', baseline: 5, candidate: 5 },
      { metric: 'agent-cost-per-merged-pr', baseline: 2, candidate: 2 },
      { metric: 'manual-interventions-per-merged-pr', baseline: 1, candidate: 1 },
      { metric: 'deploy-success-rate', baseline: 1, candidate: 1 },
    ],
    safetyInvariants: {
      requiredContextsPreserved: true,
      selectedChecksNeverDropped: true,
      physicalMacOnly: true,
      noFabricatedEvidence: true,
      noProtectionWeakening: true,
    },
    experiment: {
      maxPullRequests: 10,
      maxHours: 12,
      maxGithubHostedCostUsd: 10,
      maxAgentAiCredits: 100,
    },
    rollbackRef: 'refs/heads/develop',
  };
  assert.equal(canOpenSelfImprovementPullRequest(proposal), true);
  assert.equal(canOpenSelfImprovementPullRequest({
    ...proposal,
    outcomes: proposal.outcomes.map((outcome) => outcome.metric === 'execution-p95'
      ? { ...outcome, candidate: 1140 } : outcome),
  }), false);
  assert.equal(canOpenSelfImprovementPullRequest({
    ...proposal,
    outcomes: proposal.outcomes.map((outcome) => outcome.metric === 'deploy-success-rate'
      ? { ...outcome, candidate: 0.9 } : outcome),
  }), false);
  assert.equal(canOpenSelfImprovementPullRequest({
    ...proposal,
    outcomes: proposal.outcomes.map((outcome) => outcome.metric === 'agent-cost-per-merged-pr'
      ? { ...outcome, candidate: 2.01 } : outcome),
  }), false);
  assert.equal(canOpenSelfImprovementPullRequest({
    ...proposal,
    outcomes: proposal.outcomes.filter((outcome) => outcome.metric !== 'github-hosted-cost'),
  }), false);
  assert.throws(() => canOpenSelfImprovementPullRequest({
    ...proposal,
    allowedPaths: ['.github/workflows/ios-tests.yml'],
  }));
  assert.equal(canOpenSelfImprovementPullRequest({
    ...proposal,
    outcomes: proposal.outcomes.map((outcome) => outcome.metric === 'execution-p95'
      ? { ...outcome, baseline: 100, candidate: 200 } : outcome),
  }), false);
  assert.ok(Math.abs(deriveImprovementRatio({
    metric: 'cache-hit-ratio', baseline: 0.5, candidate: 0.6,
  }) - 0.2) < Number.EPSILON);
  assert.throws(() => canOpenSelfImprovementPullRequest({
    ...proposal,
    outcomes: [{
      metric: 'execution-p95', baseline: 100, candidate: 200, improvementRatio: 0.2,
    }],
  }));
  // Corrupt telemetry or a unit mistake (e.g. a percentage reported as 0-100
  // instead of 0-1) must not be able to satisfy the experiment gate.
  for (const metric of ['runner-utilization', 'deploy-success-rate', 'cache-hit-ratio', 'flake-rate']) {
    assert.throws(() => canOpenSelfImprovementPullRequest({
      ...proposal,
      outcomes: [...proposal.outcomes, { metric, baseline: 0.5, candidate: 2 }],
    }), /must not exceed 1/);
  }
  // A repeated metric must not let an earlier disqualifying observation be
  // silently overwritten by a later, acceptable duplicate when the outcome
  // map is constructed.
  assert.throws(() => canOpenSelfImprovementPullRequest({
    ...proposal,
    outcomes: [
      { metric: 'github-hosted-cost', baseline: 5, candidate: 20 },
      ...proposal.outcomes,
    ],
  }), /must not repeat/);
});

test('migration cutover derives parity and permits a zero-to-zero intervention baseline', () => {
  const baselineObservations = Array.from({ length: 20 }, (_, index) => ({
    pullRequest: 5300 + index,
    observedAt: '2026-09-14T18:00:00-04:00',
    sourceRunUrl: `https://github.com/example-org/example-app/actions/runs/${5300 + index}`,
    eligibility: 'ordinary-eligible',
    outcome: 'merged',
    manualInterventions: 0,
    stuckPendingContexts: 0,
    operatorOnlyRecoveries: 0,
    protectionBypasses: 0,
    fabricatedEvidenceEvents: 0,
  } as const));
  const observations = Array.from({ length: 20 }, (_, index) => ({
    pullRequest: 5400 + index,
    observedAt: '2026-09-14T18:00:00-04:00',
    sourceRunUrl: `https://github.com/example-org/example-app/actions/runs/${5400 + index}`,
    eligibility: 'ordinary-eligible',
    outcome: 'merged',
    manualInterventions: 0,
    stuckPendingContexts: 0,
    operatorOnlyRecoveries: 0,
    protectionBypasses: 0,
    fabricatedEvidenceEvents: 0,
    tuple: migrationTuple(5400 + index),
    comparison: prComparison(5400 + index),
  } as const));
  const sample = {
    schema: 'example.ci-migration-acceptance.v3',
    stage: 'pr-validation-plan',
    baselineObservations,
    observations,
  };
  const accepted = evaluateMigrationStage(sample);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.baselineManualInterventionsPerMergedPullRequest, 0);
  assert.equal(accepted.candidateManualInterventionsPerMergedPullRequest, 0);
  const parityFailure = evaluateMigrationStage({
    ...sample,
    observations: [
      {
        ...observations[0],
        comparison: prComparison(5400, { ...matchingPrPlan, databaseRequired: false }),
      },
      ...observations.slice(1),
    ],
  });
  assert.equal(parityFailure.accepted, false);
  assert.ok(parityFailure.reasons.includes('typed-decision-parity-below-one'));
  assert.equal(canCutOverMigrationStage({
    ...sample,
    observations: [
      { ...observations[0], operatorOnlyRecoveries: 1 },
      ...observations.slice(1),
    ],
  }), false);
  assert.equal(canCutOverMigrationStage({
    ...sample,
    observations: [
      { ...observations[0], outcome: 'completed-unmerged' },
      ...observations.slice(1),
    ],
  }), false);
  assert.throws(() => canCutOverMigrationStage({
    ...sample,
    baselineManualInterventionsPerMergedPullRequest: 0,
  }));
  assert.throws(() => canCutOverMigrationStage({ ...sample, stage: 'invented-stage' }));
  const firstObservation = observations[0];
  assert.ok(firstObservation);
  assert.throws(() => canCutOverMigrationStage({
    ...sample,
    observations: [{ ...firstObservation, tuple: { ...firstObservation.tuple, pullRequest: 9999 } }, ...observations.slice(1)],
  }));
  assert.throws(() => canCutOverMigrationStage({
    ...sample,
    observations: [
      { ...firstObservation, eligibility: 'genuine-escalation' as const },
      ...observations.slice(1),
    ],
  }), /exactly one typed escalation reason/);
});

test('acceptance sample rejects observations pinned to a registry other than the currently loaded one', () => {
  const staleRegistryDigest = '1'.repeat(64);
  const baselineObservations = Array.from({ length: 20 }, (_, index) => ({
    pullRequest: 5300 + index,
    observedAt: '2026-09-14T18:00:00-04:00',
    sourceRunUrl: `https://github.com/example-org/example-app/actions/runs/${5300 + index}`,
    eligibility: 'ordinary-eligible',
    outcome: 'merged',
    manualInterventions: 0,
    stuckPendingContexts: 0,
    operatorOnlyRecoveries: 0,
    protectionBypasses: 0,
    fabricatedEvidenceEvents: 0,
  } as const));
  // Every observation is internally self-consistent (they all share the same
  // registryDigest), but that digest is not the one the loaded contract
  // actually computes, so replaying it against workflowContractRegistry.lanes
  // would score parity against a different lane graph than the one pinned.
  const observations = Array.from({ length: 20 }, (_, index) => ({
    pullRequest: 5400 + index,
    observedAt: '2026-09-14T18:00:00-04:00',
    sourceRunUrl: `https://github.com/example-org/example-app/actions/runs/${5400 + index}`,
    eligibility: 'ordinary-eligible',
    outcome: 'merged',
    manualInterventions: 0,
    stuckPendingContexts: 0,
    operatorOnlyRecoveries: 0,
    protectionBypasses: 0,
    fabricatedEvidenceEvents: 0,
    tuple: { ...migrationTuple(5400 + index), registryDigest: staleRegistryDigest },
    comparison: prComparison(5400 + index),
  } as const));
  const staleSample = {
    schema: 'example.ci-migration-acceptance.v3',
    stage: 'pr-validation-plan',
    baselineObservations,
    observations,
  };
  assert.throws(() => evaluateMigrationStage(staleSample), /currently loaded registry/);
  assert.throws(() => canCutOverMigrationStage(staleSample), /currently loaded registry/);
});

test('canonical PR state pins registry semantics and requires queue reason codes', () => {
  const contractLane = workflowContractRegistry.lanes.find((lane) => lane.id === 'ios.native-build');
  assert.ok(contractLane);
  const contractJob = workflowContractRegistry.workflows
    .find((workflow) => workflow.path === contractLane.workflowPath)
    ?.jobs.find((job) => job.id === contractLane.jobId);
  assert.ok(contractJob);
  const tuple = {
    pullRequest: 5432,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    patchDigest: 'c'.repeat(64),
    planVersion: 'example.workflow-contract.v2',
    registryDigest: workflowContractRegistry.registryDigest,
  } as const;
  const state: CiStateDocument = {
    schema: 'example.ci-state.v2',
    generatedAt: '2026-09-14T18:00:00-04:00',
    tuple,
    currentPhase: 'validation',
    lanes: [{
      laneId: 'ios.native-build',
      displayName: contractJob.displayName,
      purpose: contractJob.purpose,
      progressVocabulary: contractJob.progressVocabulary,
      successMeaning: contractJob.successMeaning,
      failureOwner: contractJob.failureOwner,
      nextAction: contractJob.nextAction,
      statusDetail: 'Waiting for a healthy physical Mac with the required Xcode image.',
      decision: 'execute',
      reasonCode: 'ios-source-changed',
      dependencies: contractLane.dependencies,
      runner: {
        requirement: contractLane.runnerClass,
        queueReasonCode: 'waiting-for-ios-xcode-runner',
        queueReason: 'All healthy physical Macs are currently running selected iOS work.',
      },
      evidence: { policy: 'patch-equivalent', source: 'none' },
      phase: 'queued',
      blockerOwner: 'automation',
      expectedNextTransition: 'Start when a healthy physical macOS runner is leased.',
      costClass: 'expensive',
      budget: {
        maxQueueSeconds: 300,
        maxExecutionSeconds: 1200,
        maxGithubHostedCostUsd: 0,
      },
      links: ['https://github.com/example-org/example-app/pull/5432'],
    }, ...skippedRegistryLanes(contractLane.id)],
    nextTransition: 'Start the selected native build.',
    agentView: {
      schema: 'example.ci-agent-view.v2',
      revision: 7,
      stateDigest: 'd'.repeat(64),
      summary: 'Native iOS compilation is selected and waiting for a capable runner.',
      blockingLaneIds: ['ios.native-build'],
      nextActionCode: 'wait-for-runner-lease',
    },
    stateArtifactUrl: 'https://github.com/example-org/example-app/actions/runs/1',
    pullRequestUrl: 'https://github.com/example-org/example-app/pull/5432',
  };
  state.agentView.stateDigest = computeStateDigest(state);
  const parsedState = ciStateDocumentSchema.parse(state);
  assert.equal(parsedState.lanes[0]?.reasonCode, 'ios-source-changed');
  assert.equal(parsedState.lanes.length, workflowContractRegistry.lanes.length);
  for (const pullRequestUrl of [
    'https://github.com/example-org/example-app/pull/9999',
    'https://github.com/Other-Org/example-app/pull/5432',
    'https://github.com/example-org/other-repo/pull/5432',
    'https://github.com/example-org/example-app/pull/5432#files',
  ]) {
    const mismatchedPullRequest = structuredClone(state);
    mismatchedPullRequest.pullRequestUrl = pullRequestUrl;
    mismatchedPullRequest.agentView.stateDigest = computeStateDigest(mismatchedPullRequest);
    assert.throws(
      () => ciStateDocumentSchema.parse(mismatchedPullRequest),
      /Pull request URL must identify the tuple pull request/,
    );
  }
  const missingExpectedLane = structuredClone(state);
  missingExpectedLane.lanes.pop();
  missingExpectedLane.agentView.stateDigest = computeStateDigest(missingExpectedLane);
  assert.throws(
    () => ciStateDocumentSchema.parse(missingExpectedLane),
    /State lanes must exactly cover the pinned registry/,
  );
  const emptyCompleteState = structuredClone(state);
  emptyCompleteState.currentPhase = 'complete';
  emptyCompleteState.lanes = [];
  emptyCompleteState.agentView.blockingLaneIds = [];
  emptyCompleteState.agentView.nextActionCode = 'no-action';
  emptyCompleteState.agentView.stateDigest = computeStateDigest(emptyCompleteState);
  assert.throws(
    () => ciStateDocumentSchema.parse(emptyCompleteState),
    /State lanes must exactly cover the pinned registry/,
  );
  const contradictoryState = (laneChanges: Record<string, unknown>) => {
    const changed = structuredClone(state);
    changed.lanes[0] = { ...changed.lanes[0]!, ...laneChanges } as typeof changed.lanes[number];
    changed.agentView.stateDigest = computeStateDigest(changed);
    return changed;
  };
  assert.throws(() => ciStateDocumentSchema.parse(contradictoryState({
    decision: 'skip', reasonCode: 'not-selected', phase: 'queued',
  })));
  assert.throws(() => ciStateDocumentSchema.parse(contradictoryState({
    decision: 'execute', reasonCode: 'not-selected', phase: 'skipped', blockerOwner: 'none',
    runner: { requirement: contractLane.runnerClass },
  })));
  assert.throws(() => ciStateDocumentSchema.parse(contradictoryState({
    decision: 'reuse', reasonCode: 'prior-evidence-reused', phase: 'passed', blockerOwner: 'none',
    runner: { requirement: contractLane.runnerClass },
  })));
  assert.throws(() => ciStateDocumentSchema.parse(contradictoryState({
    retryCauseCode: 'runner-replaced', blockerOwner: 'product',
  })));
  assert.throws(() => ciStateDocumentSchema.parse(contradictoryState({
    phase: 'cancelled', runner: { requirement: contractLane.runnerClass }, cancellationCauseCode: undefined,
  })));
  assert.throws(() => ciStateDocumentSchema.parse(contradictoryState({
    cancellationCauseCode: 'superseded-lane',
    supersededByRunUrl: 'https://github.com/example-org/example-app/actions/runs/999',
  })));
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    currentPhase: 'complete',
    agentView: { ...state.agentView, stateDigest: computeStateDigest({ ...state, currentPhase: 'complete' }) },
  }));
  const missingBlocker = structuredClone(state);
  missingBlocker.lanes[0]!.blockerOwner = 'none';
  missingBlocker.agentView.stateDigest = computeStateDigest(missingBlocker);
  assert.throws(() => ciStateDocumentSchema.parse(missingBlocker));
  const missingBlockingLane = structuredClone(state);
  missingBlockingLane.agentView.blockingLaneIds = [];
  missingBlockingLane.agentView.stateDigest = computeStateDigest(missingBlockingLane);
  assert.throws(() => ciStateDocumentSchema.parse(missingBlockingLane));
  const wrongQueuedAction = structuredClone(state);
  wrongQueuedAction.agentView.nextActionCode = 'no-action';
  wrongQueuedAction.agentView.stateDigest = computeStateDigest(wrongQueuedAction);
  assert.throws(() => ciStateDocumentSchema.parse(wrongQueuedAction));
  const currentProvenance = {
    policy: 'patch-equivalent' as const,
    source: 'current-execution' as const,
    sourceRunUrl: 'https://github.com/example-org/example-app/actions/runs/998',
    sourceHeadSha: tuple.headSha,
    sourceBaseSha: tuple.baseSha,
    sourcePatchDigest: tuple.patchDigest,
    sourcePlanVersion: tuple.planVersion,
    sourceRegistryDigest: tuple.registryDigest,
    sourceLaneId: 'ios.native-build',
    conclusion: 'success' as const,
    resultDigest: 'f'.repeat(64),
  };
  const passedCurrent = structuredClone(state);
  passedCurrent.currentPhase = 'complete';
  passedCurrent.lanes[0] = {
    ...passedCurrent.lanes[0]!, phase: 'passed', blockerOwner: 'none',
    runner: { requirement: contractLane.runnerClass },
    evidence: { ...currentProvenance, evidenceDigest: computeEvidenceDigest(currentProvenance) },
  };
  passedCurrent.agentView.blockingLaneIds = [];
  passedCurrent.agentView.nextActionCode = 'no-action';
  passedCurrent.agentView.stateDigest = computeStateDigest(passedCurrent);
  assert.doesNotThrow(() => ciStateDocumentSchema.parse(passedCurrent));
  const secretEvidenceUrl = structuredClone(passedCurrent);
  const secretProvenance = {
    ...currentProvenance,
    sourceRunUrl: 'https://github.com/example-org/example-app/actions/runs/998/token=abcdefghijklmnopqrstuvwxyz',
  };
  secretEvidenceUrl.lanes[0]!.evidence = {
    ...secretProvenance,
    evidenceDigest: computeEvidenceDigest(secretProvenance),
  };
  secretEvidenceUrl.agentView.stateDigest = computeStateDigest(secretEvidenceUrl);
  assertRedactionRejected(ciStateDocumentSchema.safeParse(secretEvidenceUrl));
  for (const changed of [
    { ...state, stateArtifactUrl: 'https://github.com/example-org/example-app/actions/runs/1/token=abcdefghijklmnopqrstuvwxyz' },
    { ...state, pullRequestUrl: 'https://github.com/example-org/example-app/pull/5432?token=abcdefghijklmnopqrstuvwxyz' },
    { ...state, lanes: [{ ...state.lanes[0]!, runner: { ...state.lanes[0]!.runner, assignedRunner: 'token=abcdefghijklmnopqrstuvwxyz' } }] },
    { ...state, lanes: [{ ...state.lanes[0]!, dependencies: ['secret=abcdefghijklmnopqrstuvwxyz'] }] },
    { ...state, lanes: [{ ...state.lanes[0]!, statusDetail: 'token=abcdefghijklmnopqrstuvwxyz' }] },
    { ...state, lanes: [{ ...state.lanes[0]!, runner: { ...state.lanes[0]!.runner, queueReason: 'token=abcdefghijklmnopqrstuvwxyz' } }] },
    { ...state, lanes: [{ ...state.lanes[0]!, expectedNextTransition: 'token=abcdefghijklmnopqrstuvwxyz' }] },
    { ...state, nextTransition: 'token=abcdefghijklmnopqrstuvwxyz' },
    { ...state, agentView: { ...state.agentView, summary: 'token=abcdefghijklmnopqrstuvwxyz' } },
    {
      ...state,
      lanes: [{ ...state.lanes[0]!, laneId: 'token=abcdefghijklmnopqrstuvwxyz' }],
      agentView: { ...state.agentView, blockingLaneIds: ['token=abcdefghijklmnopqrstuvwxyz'] },
    },
  ]) {
    changed.agentView.stateDigest = computeStateDigest(changed);
    assertRedactionRejected(ciStateDocumentSchema.safeParse(changed));
  }
  const supersededCancellation = structuredClone(state);
  supersededCancellation.lanes[0] = {
    ...supersededCancellation.lanes[0]!, phase: 'cancelled', cancellationCauseCode: 'superseded-lane',
    supersededByRunUrl: 'https://github.com/example-org/example-app/actions/runs/997',
    runner: { requirement: contractLane.runnerClass }, evidence: { policy: 'patch-equivalent', source: 'none' },
  };
  supersededCancellation.agentView.nextActionCode = 'retry-deterministically';
  supersededCancellation.agentView.stateDigest = computeStateDigest(supersededCancellation);
  assert.doesNotThrow(() => ciStateDocumentSchema.parse(supersededCancellation));
  supersededCancellation.lanes[0]!.supersededByRunUrl = 'https://github.com/example-org/example-app/actions/runs/997/token=abcdefghijklmnopqrstuvwxyz';
  supersededCancellation.agentView.stateDigest = computeStateDigest(supersededCancellation);
  assertRedactionRejected(ciStateDocumentSchema.safeParse(supersededCancellation));
  const skippedWithEvidence = structuredClone(state);
  skippedWithEvidence.currentPhase = 'complete';
  skippedWithEvidence.lanes[0] = {
    ...skippedWithEvidence.lanes[0]!,
    decision: 'skip', reasonCode: 'not-selected', phase: 'skipped', blockerOwner: 'none',
    runner: { requirement: contractLane.runnerClass },
    evidence: { ...currentProvenance, evidenceDigest: computeEvidenceDigest(currentProvenance) },
  };
  skippedWithEvidence.agentView.blockingLaneIds = [];
  skippedWithEvidence.agentView.nextActionCode = 'no-action';
  skippedWithEvidence.agentView.stateDigest = computeStateDigest(skippedWithEvidence);
  assert.throws(() => ciStateDocumentSchema.parse(skippedWithEvidence));
  const passedWithPriorEvidence = structuredClone(skippedWithEvidence);
  passedWithPriorEvidence.lanes[0] = {
    ...passedWithPriorEvidence.lanes[0]!, decision: 'execute', reasonCode: 'ios-source-changed', phase: 'passed',
    evidence: {
      ...currentProvenance,
      source: 'prior-tuple',
      evidenceDigest: computeEvidenceDigest({ ...currentProvenance, source: 'prior-tuple' }),
    },
  };
  passedWithPriorEvidence.agentView.stateDigest = computeStateDigest(passedWithPriorEvidence);
  assert.throws(() => ciStateDocumentSchema.parse(passedWithPriorEvidence));
  const mismatchedLaneContract = structuredClone(state);
  mismatchedLaneContract.lanes[0]!.runner.requirement = 'hosted-control';
  mismatchedLaneContract.lanes[0]!.costClass = 'control';
  mismatchedLaneContract.lanes[0]!.dependencies = [];
  mismatchedLaneContract.agentView.stateDigest = computeStateDigest(mismatchedLaneContract);
  assert.throws(() => ciStateDocumentSchema.parse(mismatchedLaneContract));
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    agentView: { ...state.agentView, stateDigest: '0'.repeat(64) },
  }));
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    lanes: [{
      ...state.lanes[0],
      displayName: '${{ opaque.expression }}',
      runner: { requirement: contractLane.runnerClass },
    }],
  }));
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    lanes: [{
      ...state.lanes[0],
      runner: {
        requirement: contractLane.runnerClass,
        queueReasonCode: 'waiting-for-ios-xcode-runner',
      },
    }],
  }));
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    agentView: { ...state.agentView, blockingLaneIds: ['missing-lane'] },
  }));
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    agentView: { ...state.agentView, nextActionCode: 'invented-action' },
  }));
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    lanes: [{ ...state.lanes[0], reasonCode: 'invented-reason' }],
  }));
});

test('malformed redacted URLs fail validation instead of throwing out of safeParse', () => {
  // Every one of these makes `new URL(value)` throw, so an unguarded refinement
  // escapes safeParse as a TypeError instead of reporting a validation issue.
  const malformedUrls = [
    'not a url',
    'https://',
    '://github.com/example-org/example-app/pull/5438',
    'http://[',
    'https://git hub.com/example-org/example-app/pull/5438',
    'https://user:password@',
    '',
  ];
  const issuesAt = (result: z.ZodSafeParseResult<unknown>, field: string) => (
    result.success ? [] : result.error.issues.filter((issue) => issue.path[0] === field)
  );

  for (const url of malformedUrls) {
    // safeParse is total: a malformed URL is a validation failure, never a throw.
    const state = ciStateDocumentSchema.safeParse({ pullRequestUrl: url, stateArtifactUrl: url });
    assert.equal(state.success, false);
    assert.ok(issuesAt(state, 'pullRequestUrl').length > 0, `expected pullRequestUrl issue for ${JSON.stringify(url)}`);
    assert.ok(issuesAt(state, 'stateArtifactUrl').length > 0, `expected stateArtifactUrl issue for ${JSON.stringify(url)}`);

    const status = ciAgentSurfaceStatusSchema.safeParse({
      evidence: [{ kind: 'log', identifier: 'runner log', url }],
      supersession: { supersededByRunUrl: url },
    });
    assert.equal(status.success, false);
    assert.ok(issuesAt(status, 'evidence').length > 0, `expected evidence issue for ${JSON.stringify(url)}`);
    assert.ok(issuesAt(status, 'supersession').length > 0, `expected supersession issue for ${JSON.stringify(url)}`);
  }

  // Well-formed URLs keep their existing verdicts: safe ones raise no issue on
  // the URL field, and parsable-but-unsafe ones are still rejected.
  const safeUrl = 'https://github.com/example-org/example-app/pull/5438';
  assert.equal(issuesAt(ciStateDocumentSchema.safeParse({ pullRequestUrl: safeUrl }), 'pullRequestUrl').length, 0);
  for (const unsafeUrl of [
    'http://github.com/example-org/example-app/pull/5438',
    'https://user:password123@github.com/example-org/example-app/pull/5438',
    'https://github.com/example-org/example-app/pull/5438?token=abcdefghijklmnopqrstuvwxyz',
  ]) {
    assertRedactionRejected(ciStateDocumentSchema.safeParse({ pullRequestUrl: unsafeUrl }));
  }
});

test('an always-run, evidence-policy-none lane can reach a valid passed state', () => {
  const planLane = workflowContractRegistry.lanes.find((lane) => lane.id === 'pr.plan');
  assert.ok(planLane);
  assert.equal(planLane.evidencePolicy, 'none');
  const planJob = workflowContractRegistry.workflows
    .find((workflow) => workflow.path === planLane.workflowPath)
    ?.jobs.find((job) => job.id === planLane.jobId);
  assert.ok(planJob);
  const tuple = migrationTuple(5434);
  const currentProvenance = {
    policy: 'none' as const,
    source: 'current-execution' as const,
    sourceRunUrl: 'https://github.com/example-org/example-app/actions/runs/1',
    sourceHeadSha: tuple.headSha,
    sourceBaseSha: tuple.baseSha,
    sourcePatchDigest: tuple.patchDigest,
    sourcePlanVersion: tuple.planVersion,
    sourceRegistryDigest: tuple.registryDigest,
    sourceLaneId: 'pr.plan',
    conclusion: 'success' as const,
    resultDigest: 'f'.repeat(64),
  };
  const state: CiStateDocument = {
    schema: 'example.ci-state.v2',
    generatedAt: '2026-09-14T18:00:00-04:00',
    tuple,
    currentPhase: 'complete',
    lanes: [{
      laneId: 'pr.plan',
      displayName: planJob.displayName,
      purpose: planJob.purpose,
      progressVocabulary: planJob.progressVocabulary,
      successMeaning: planJob.successMeaning,
      failureOwner: planJob.failureOwner,
      nextAction: planJob.nextAction,
      statusDetail: 'Computed the deterministic validation plan.',
      decision: 'execute',
      reasonCode: 'always-run',
      dependencies: planLane.dependencies,
      runner: { requirement: planLane.runnerClass },
      evidence: { ...currentProvenance, evidenceDigest: computeEvidenceDigest(currentProvenance) },
      phase: 'passed',
      blockerOwner: 'none',
      expectedNextTransition: 'Continue with the selected lanes.',
      costClass: planLane.costClass,
      budget: { maxQueueSeconds: 300, maxExecutionSeconds: 1200, maxGithubHostedCostUsd: 1 },
      links: [],
    }, ...skippedRegistryLanes(planLane.id)],
    nextTransition: 'Pipeline complete.',
    agentView: {
      schema: 'example.ci-agent-view.v2',
      revision: 1,
      stateDigest: 'd'.repeat(64),
      summary: 'Plan PR validation computed its plan and the remaining lanes were not selected.',
      blockingLaneIds: [],
      nextActionCode: 'no-action',
    },
    stateArtifactUrl: 'https://github.com/example-org/example-app/actions/runs/1',
    pullRequestUrl: 'https://github.com/example-org/example-app/pull/5434',
  };
  state.agentView.stateDigest = computeStateDigest(state);
  assert.equal(ciStateDocumentSchema.parse(state).lanes[0]?.phase, 'passed');
  // Reuse is still forbidden for a policy that promises no evidence carries
  // over: prior-tuple evidence never accepts an evidence policy of 'none'.
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    lanes: [
      {
        ...state.lanes[0],
        decision: 'reuse',
        reasonCode: 'prior-evidence-reused',
        phase: 'reused',
        evidence: {
          ...currentProvenance,
          source: 'prior-tuple',
          sourceRunUrl: 'https://github.com/example-org/example-app/actions/runs/2',
          evidenceDigest: 'e'.repeat(64),
        },
      },
      ...state.lanes.slice(1),
    ],
  }));
});

test('an automation-owned retry can be running without tripping the blocking-phase invariant', () => {
  const contractLane = workflowContractRegistry.lanes.find((lane) => lane.id === 'ios.native-build');
  assert.ok(contractLane);
  const contractJob = workflowContractRegistry.workflows
    .find((workflow) => workflow.path === contractLane.workflowPath)
    ?.jobs.find((job) => job.id === contractLane.jobId);
  assert.ok(contractJob);
  const tuple = migrationTuple(5438);
  const state: CiStateDocument = {
    schema: 'example.ci-state.v2',
    generatedAt: '2026-09-14T18:00:00-04:00',
    tuple,
    currentPhase: 'validation',
    lanes: [{
      laneId: contractLane.id,
      displayName: contractJob.displayName,
      purpose: contractJob.purpose,
      progressVocabulary: contractJob.progressVocabulary,
      successMeaning: contractJob.successMeaning,
      failureOwner: contractJob.failureOwner,
      nextAction: contractJob.nextAction,
      statusDetail: 'Retrying automatically after a confirmed flake.',
      decision: 'execute',
      reasonCode: 'ios-source-changed',
      dependencies: contractLane.dependencies,
      runner: { requirement: contractLane.runnerClass, assignedRunner: 'macos-14-xlarge-3' },
      evidence: { policy: contractLane.evidencePolicy, source: 'none' },
      phase: 'running',
      retryCauseCode: 'flake-confirmed',
      blockerOwner: 'automation',
      expectedNextTransition: 'Wait for the automated retry to complete.',
      costClass: contractLane.costClass,
      budget: { maxQueueSeconds: 300, maxExecutionSeconds: 1200, maxGithubHostedCostUsd: 0 },
      links: [],
    }, ...skippedRegistryLanes(contractLane.id)],
    nextTransition: 'Wait for the automated retry.',
    agentView: {
      schema: 'example.ci-agent-view.v2',
      revision: 2,
      stateDigest: 'd'.repeat(64),
      summary: 'Native iOS compilation is retrying automatically after a flake.',
      blockingLaneIds: [],
      nextActionCode: 'no-action',
    },
    stateArtifactUrl: 'https://github.com/example-org/example-app/actions/runs/1',
    pullRequestUrl: 'https://github.com/example-org/example-app/pull/5438',
  };
  state.agentView.stateDigest = computeStateDigest(state);
  assert.doesNotThrow(() => ciStateDocumentSchema.parse(state));
  // Ownership is not weakened: a running lane with no retry in flight still
  // must not claim an owner.
  const unownedRunning = structuredClone(state);
  unownedRunning.lanes[0]!.retryCauseCode = undefined;
  unownedRunning.agentView.stateDigest = computeStateDigest(unownedRunning);
  assert.throws(() => ciStateDocumentSchema.parse(unownedRunning));
});

test('exact-head lanes reject patch-equivalent predecessor evidence', () => {
  const contractLane = workflowContractRegistry.lanes.find((lane) => lane.id === 'review.aggregate');
  assert.ok(contractLane);
  const contractJob = workflowContractRegistry.workflows
    .find((workflow) => workflow.path === contractLane.workflowPath)
    ?.jobs.find((job) => job.id === contractLane.jobId);
  assert.ok(contractJob);
  const tuple = migrationTuple(5438);
  const provenance = {
    policy: 'patch-equivalent' as const,
    source: 'prior-tuple' as const,
    sourceRunUrl: 'https://github.com/example-org/example-app/actions/runs/100',
    sourceHeadSha: 'd'.repeat(40),
    sourceBaseSha: 'e'.repeat(40),
    sourcePatchDigest: tuple.patchDigest,
    sourcePlanVersion: tuple.planVersion,
    sourceRegistryDigest: tuple.registryDigest,
    sourceLaneId: contractLane.id,
    conclusion: 'success' as const,
    resultDigest: 'f'.repeat(64),
  };
  const state = {
    schema: 'example.ci-state.v2', generatedAt: '2026-09-14T18:00:00-04:00', tuple,
    currentPhase: 'review',
    lanes: [{
      laneId: contractLane.id, displayName: contractJob.displayName, purpose: contractJob.purpose,
      progressVocabulary: contractJob.progressVocabulary, successMeaning: contractJob.successMeaning,
      failureOwner: contractJob.failureOwner, nextAction: contractJob.nextAction,
      statusDetail: 'Claimed reused review evidence.', decision: 'reuse', reasonCode: 'prior-evidence-reused',
      dependencies: contractLane.dependencies, runner: { requirement: contractLane.runnerClass },
      evidence: { ...provenance, evidenceDigest: computeEvidenceDigest(provenance) }, phase: 'reused',
      blockerOwner: 'none', expectedNextTransition: 'Continue.', costClass: contractLane.costClass,
      budget: { maxQueueSeconds: 60, maxExecutionSeconds: 60, maxGithubHostedCostUsd: 1 }, links: [],
    }],
    nextTransition: 'Continue.',
    agentView: { schema: 'example.ci-agent-view.v2', revision: 1, stateDigest: '0'.repeat(64), summary: 'Claimed reusable review evidence.', blockingLaneIds: [], nextActionCode: 'continue-pipeline' },
    stateArtifactUrl: 'https://github.com/example-org/example-app/actions/runs/101',
    pullRequestUrl: 'https://github.com/example-org/example-app/pull/5438',
  };
  state.agentView.stateDigest = computeStateDigest(state);
  assert.throws(() => ciStateDocumentSchema.parse(state));
});

test('reused evidence requires complete, digest-bound patch provenance', () => {
  const contractLane = workflowContractRegistry.lanes.find((lane) => lane.id === 'ios.native-build');
  assert.ok(contractLane);
  const contractJob = workflowContractRegistry.workflows
    .find((workflow) => workflow.path === contractLane.workflowPath)
    ?.jobs.find((job) => job.id === contractLane.jobId);
  assert.ok(contractJob);
  const tuple = {
    pullRequest: 5432,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    patchDigest: 'c'.repeat(64),
    planVersion: 'example.workflow-contract.v2',
    registryDigest: workflowContractRegistry.registryDigest,
  } as const;
  const provenance = {
    policy: 'patch-equivalent',
    source: 'prior-tuple',
    sourceRunUrl: 'https://github.com/example-org/example-app/actions/runs/123',
    sourceHeadSha: 'd'.repeat(40),
    sourceBaseSha: 'e'.repeat(40),
    sourcePatchDigest: tuple.patchDigest,
    sourcePlanVersion: tuple.planVersion,
    sourceRegistryDigest: tuple.registryDigest,
    sourceLaneId: 'ios.native-build',
    conclusion: 'success',
    resultDigest: 'f'.repeat(64),
  } as const;
  const evidence = { ...provenance, evidenceDigest: computeEvidenceDigest(provenance) };
  const lane = {
    laneId: 'ios.native-build',
    displayName: contractJob.displayName,
    purpose: contractJob.purpose,
    progressVocabulary: contractJob.progressVocabulary,
    successMeaning: contractJob.successMeaning,
    failureOwner: contractJob.failureOwner,
    nextAction: contractJob.nextAction,
    statusDetail: 'Reused passing native build evidence from an equivalent patch.',
    decision: 'reuse',
    reasonCode: 'prior-evidence-reused',
    dependencies: contractLane.dependencies,
    runner: { requirement: contractLane.runnerClass },
    evidence,
    phase: 'reused',
    blockerOwner: 'none',
    expectedNextTransition: 'Continue to selected native test shards.',
    costClass: 'expensive',
    budget: { maxQueueSeconds: 300, maxExecutionSeconds: 1200, maxGithubHostedCostUsd: 0 },
    links: ['https://github.com/example-org/example-app/actions/runs/123'],
  } as const;
  const state = {
    schema: 'example.ci-state.v2',
    generatedAt: '2026-09-14T18:00:00-04:00',
    tuple,
    currentPhase: 'complete',
    lanes: [lane, ...skippedRegistryLanes(contractLane.id)],
    nextTransition: 'Continue to native test shards.',
    agentView: {
      schema: 'example.ci-agent-view.v2',
      revision: 8,
      stateDigest: '1'.repeat(64),
      summary: 'Native build evidence was reused from an equivalent patch.',
      blockingLaneIds: [],
      nextActionCode: 'no-action',
    },
    stateArtifactUrl: 'https://github.com/example-org/example-app/actions/runs/124',
    pullRequestUrl: 'https://github.com/example-org/example-app/pull/5432',
  };
  state.agentView.stateDigest = computeStateDigest(state);
  assert.equal(ciStateDocumentSchema.parse(state).lanes[0]?.phase, 'reused');
  const { sourceHeadSha: _sourceHeadSha, ...missingSourceIdentity } = evidence;
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    lanes: [{ ...lane, evidence: missingSourceIdentity }],
  }));
  const wrongPatchProvenance = { ...provenance, sourcePatchDigest: '9'.repeat(64) };
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    lanes: [{
      ...lane,
      evidence: {
        ...wrongPatchProvenance,
        evidenceDigest: computeEvidenceDigest(wrongPatchProvenance),
      },
    }],
  }));
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    lanes: [{ ...lane, evidence: { ...evidence, evidenceDigest: '0'.repeat(64) } }],
  }));
  const staleExactHead = { ...provenance, policy: 'exact-head' as const };
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    lanes: [{
      ...lane,
      evidence: {
        ...staleExactHead,
        evidenceDigest: computeEvidenceDigest(staleExactHead),
      },
    }],
  }));
  const wrongRegistry = { ...provenance, sourceRegistryDigest: '2'.repeat(64) };
  assert.throws(() => ciStateDocumentSchema.parse({
    ...state,
    lanes: [{
      ...lane,
      evidence: {
        ...wrongRegistry,
        evidenceDigest: computeEvidenceDigest(wrongRegistry),
      },
    }],
  }));
});

test('bounded agent status covers every lifecycle state and registry identity level', () => {
  const workflow = workflowContractRegistry.workflows[0];
  const job = workflow?.jobs[0];
  const step = job?.steps[0];
  assert.ok(workflow && job && step);
  const states = ['queued', 'running', 'skipped', 'failed', 'cancelled', 'superseded', 'successful'] as const;
  const outcome = {
    skipped: 'skipped', failed: 'failed', cancelled: 'cancelled',
    superseded: 'superseded', successful: 'passed',
  } as const;
  const reasonCode = {
    queued: 'waiting-for-dependency', running: 'work-in-progress', skipped: 'not-selected',
    failed: 'check-failed', cancelled: 'cancelled-obsolete',
    superseded: 'superseded-by-current', successful: 'completed-successfully',
  } as const;
  const additionalWorkflows = workflowContractRegistry.workflows.slice(1, 5);
  assert.equal(additionalWorkflows.length, 4);
  const descriptors = [
    { contract: workflow, identity: { surfaceId: workflow.path, kind: 'workflow' as const, workflowPath: workflow.path } },
    { contract: job, identity: { surfaceId: `${workflow.path}:${job.id}`, kind: 'job' as const, workflowPath: workflow.path, jobId: job.id } },
    { contract: step, identity: { surfaceId: `${workflow.path}:${job.id}:${step.id}`, kind: 'step' as const, workflowPath: workflow.path, jobId: job.id, stepId: step.id } },
    ...additionalWorkflows.map((entry) => ({
      contract: entry,
      identity: { surfaceId: entry.path, kind: 'workflow' as const, workflowPath: entry.path },
    })),
  ];
  const statuses = states.map((state, index) => {
    const descriptor = descriptors[index];
    assert.ok(descriptor);
    const { contract, identity } = descriptor;
    const lane = identity.kind === 'workflow' ? undefined : workflowContractRegistry.lanes.find((entry) => entry.workflowPath === identity.workflowPath && entry.jobId === identity.jobId);
    const terminal = state !== 'queued' && state !== 'running';
    const status = {
      identity,
      displayName: contract.displayName,
      purpose: contract.purpose,
      progressVocabulary: contract.progressVocabulary,
      successMeaning: contract.successMeaning,
      failureOwner: contract.failureOwner,
      nextAction: contract.nextAction,
      state,
      reasonCode: reasonCode[state],
      currentAction: state === 'running' ? 'Evaluating the current bounded operation.' : undefined,
      waitReason: state === 'queued' ? 'Waiting for a declared dependency.' : undefined,
      outcome: terminal ? outcome[state] : undefined,
      cancellationCauseCode: state === 'cancelled' ? 'obsolete-tuple' as const : undefined,
      timestamps: {
        observedAt: '2026-09-14T18:00:00-04:00',
        queuedAt: state === 'queued' ? '2026-09-14T17:59:00-04:00' : undefined,
        startedAt: state === 'running' || terminal ? '2026-09-14T17:59:00-04:00' : undefined,
        finishedAt: terminal ? '2026-09-14T18:00:00-04:00' : undefined,
        durationSeconds: terminal ? 60 : undefined,
      },
      runnerClass: lane?.runnerClass ?? 'hosted-control',
      costClass: lane?.costClass ?? 'control',
      dependencies: lane?.dependencies.map((dependency) => ({ surfaceId: `${lane.workflowPath}:${dependency}`, state: 'successful' as const })) ?? [],
      evidence: [{ kind: 'state', identifier: `${state}-state`, digest: 'e'.repeat(64) }],
      retry: { attempt: 1, maxAttempts: 2 },
      supersession: state === 'superseded' ? {
        supersededBySurfaceId: 'replacement-surface',
        supersededByRunUrl: 'https://github.com/example-org/example-app/actions/runs/999',
      } : {},
      permittedNextActions: [state === 'queued' ? 'wait-for-dependency'
        : state === 'running' ? 'no-action'
          : state === 'failed' ? 'inspect-failure'
            : state === 'cancelled' ? 'retry-deterministically'
              : state === 'superseded' ? 'no-action'
                : 'continue-pipeline'] as const,
      humanSummary: '',
    };
    status.humanSummary = renderAgentHumanSummary(status);
    return status;
  });
  const document = {
    schema: 'example.ci-agent-status.v3',
    tuple: migrationTuple(5438),
    registryDigest: workflowContractRegistry.registryDigest,
    revision: 1,
    generatedAt: '2026-09-14T18:00:00-04:00',
    redaction: 'secrets-removed',
    statuses,
    statusDigest: '0'.repeat(64),
  };
  document.statusDigest = computeAgentStatusDigest(document);
  assert.equal(ciAgentStatusDocumentSchema.parse(document).statuses.length, states.length);
  assert.throws(() => ciAgentStatusDocumentSchema.parse({
    ...document,
    statuses: [{ ...statuses[0], waitReason: undefined }, ...statuses.slice(1)],
    statusDigest: computeAgentStatusDigest({
      ...document,
      statuses: [{ ...statuses[0], waitReason: undefined }, ...statuses.slice(1)],
    }),
  }));
  assert.throws(() => ciAgentStatusDocumentSchema.parse({ ...document, statusDigest: '0'.repeat(64) }));
  const secretBearing = {
    ...document,
    statuses: [{
      ...statuses[0],
      evidence: [{ kind: 'log', identifier: 'token=should-not-appear' }],
    }, ...statuses.slice(1)],
    statusDigest: '0'.repeat(64),
  };
  secretBearing.statusDigest = computeAgentStatusDigest(secretBearing);
  assert.throws(() => ciAgentStatusDocumentSchema.parse(secretBearing));
  const successful = statuses.find((status) => status.state === 'successful');
  assert.ok(successful);
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({ ...successful, outcome: 'failed' }));
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({ ...successful, waitReason: 'Waiting after success.' }));
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({ ...successful, currentAction: 'Still running after success.' }));
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({
    ...successful,
    supersession: {
      supersededBySurfaceId: 'replacement-surface',
      supersededByRunUrl: 'https://github.com/example-org/example-app/actions/runs/999',
    },
  }));
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({
    ...successful, retry: { attempt: 1, maxAttempts: 2, causeCode: 'deterministic-retry' },
  }));
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({
    ...successful, retry: { attempt: 2, maxAttempts: 2 },
  }));
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({
    ...successful, cancellationCauseCode: 'obsolete-tuple',
  }));
  const cancelled = statuses.find((status) => status.state === 'cancelled');
  assert.ok(cancelled);
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({ ...cancelled, cancellationCauseCode: undefined }));
  const cancellationContracts = [
    ['cancelled-duplicate', 'duplicate-tuple'],
    ['cancelled-obsolete', 'obsolete-tuple'],
    ['cancelled-superseded', 'superseded-lane'],
  ] as const;
  for (const [cancellationReason, cancellationCause] of cancellationContracts) {
    assert.doesNotThrow(() => ciAgentSurfaceStatusSchema.parse({
      ...cancelled,
      reasonCode: cancellationReason,
      cancellationCauseCode: cancellationCause,
    }));
    assert.throws(() => ciAgentSurfaceStatusSchema.parse({
      ...cancelled,
      reasonCode: cancellationReason,
      cancellationCauseCode: cancellationCause === 'duplicate-tuple' ? 'obsolete-tuple' : 'duplicate-tuple',
    }), /Cancellation reason and cause are inconsistent/);
  }
  const skipped = statuses.find((status) => status.state === 'skipped');
  assert.ok(skipped);
  const neverStartedSkip = {
    ...skipped,
    timestamps: { ...skipped.timestamps, startedAt: undefined, durationSeconds: 0 },
  };
  assert.doesNotThrow(() => ciAgentSurfaceStatusSchema.parse(neverStartedSkip));
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({
    ...neverStartedSkip,
    timestamps: { ...neverStartedSkip.timestamps, durationSeconds: 5 },
  }), /Duration for a step that never started must be zero/);
  const queued = statuses.find((status) => status.state === 'queued');
  assert.ok(queued);
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({
    ...queued,
    permittedNextActions: ['wait-for-runner-lease'],
    humanSummary: renderAgentHumanSummary({
      ...queued,
      permittedNextActions: ['wait-for-runner-lease'],
    }),
  }), /Next action is not permitted for the current reason/);
  const queuedForRunner = {
    ...queued,
    reasonCode: 'waiting-for-runner' as const,
    permittedNextActions: ['wait-for-runner-lease'] as const,
  };
  assert.doesNotThrow(() => ciAgentSurfaceStatusSchema.parse({
    ...queuedForRunner,
    humanSummary: renderAgentHumanSummary(queuedForRunner),
  }));
  const failed = statuses.find((status) => status.state === 'failed');
  assert.ok(failed);
  assert.match(failed.humanSummary, /Owner: Automation\./);
  assert.match(failed.humanSummary, /Next: inspect the failure evidence\./);
  assert.doesNotMatch(failed.humanSummary, /inspect-failure/);
  assertRedactionRejected(ciAgentSurfaceStatusSchema.safeParse({
    ...successful,
    identity: { ...successful.identity, surfaceId: 'token=abcdefghijklmnopqrstuvwxyz' },
  }));
  assertRedactionRejected(ciAgentSurfaceStatusSchema.safeParse({
    ...successful, assignedRunner: 'runner-token=abcdefghijklmnopqrstuvwxyz',
  }));
  assertRedactionRejected(ciAgentSurfaceStatusSchema.safeParse({
    ...successful,
    dependencies: [{ surfaceId: 'secret=abcdefghijklmnopqrstuvwxyz', state: 'successful' }],
  }));
  const superseded = statuses.find((status) => status.state === 'superseded');
  assert.ok(superseded);
  assertRedactionRejected(ciAgentSurfaceStatusSchema.safeParse({
    ...superseded,
    supersession: {
      ...superseded.supersession,
      supersededBySurfaceId: 'token=abcdefghijklmnopqrstuvwxyz',
    },
  }));
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({
    ...successful,
    timestamps: {
      ...successful.timestamps,
      startedAt: '2026-09-14T18:01:00-04:00',
      durationSeconds: 60,
    },
  }));
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({
    ...successful,
    timestamps: { ...successful.timestamps, durationSeconds: 3_600 },
  }));
  for (const url of [
    'https://example.com/logs/Bearer%20example-redacted-jwt',
    'https://example-redacted-jwt.example.com/log',
    'https://example.com/log?download=example-redacted-jwt',
  ]) {
    assert.throws(() => ciAgentSurfaceStatusSchema.parse({
      ...successful,
      evidence: [{ kind: 'log', identifier: 'redaction-check', url }],
    }));
  }
  const nestedEncode = (value: string, count: number) => {
    let encoded = value;
    for (let iteration = 0; iteration < count; iteration += 1) encoded = encodeURIComponent(encoded);
    return encoded;
  };
  const bearer = 'Bearer example-redacted-jwt';
  const encodedHostSecret = [...'ghp_abcdefghijklmnopqrstuvwxyz']
    .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
  for (const depth of [4, 5, 8, 16, 20]) {
    assert.throws(() => ciAgentSurfaceStatusSchema.parse({
      ...successful,
      evidence: [{ kind: 'log', identifier: nestedEncode(bearer, depth) }],
    }));
    assert.throws(() => ciAgentSurfaceStatusSchema.parse({
      ...successful,
      evidence: [{ kind: 'log', identifier: 'nested-path', url: `https://example.com/${nestedEncode(bearer, depth)}` }],
    }));
    assert.throws(() => ciAgentSurfaceStatusSchema.parse({
      ...successful,
      evidence: [{ kind: 'log', identifier: 'nested-query', url: `https://example.com/log?download=${nestedEncode(bearer, depth)}` }],
    }));
    assert.throws(() => ciAgentSurfaceStatusSchema.parse({
      ...successful,
      evidence: [{ kind: 'log', identifier: 'nested-host', url: `https://${nestedEncode(encodedHostSecret, depth - 1)}.example.com/log` }],
    }));
  }
  assert.throws(() => ciAgentSurfaceStatusSchema.parse({
    ...successful,
    evidence: [{ kind: 'log', identifier: 'secret-host', url: 'https://ghp_abcdefghijklmnopqrstuvwxyz.example.com/log' }],
  }));
  assertRedactionRejected(ciAgentSurfaceStatusSchema.safeParse({
    ...successful,
    evidence: [{ kind: 'log', identifier: 'oversize-url', url: `https://example.com/${'a'.repeat(8_200)}` }],
  }));
  assert.doesNotThrow(() => ciFleetStatusPageSchema.parse({
    schema: 'example.ci-fleet-status-page.v1',
    generatedAt: document.generatedAt,
    redaction: 'secrets-removed',
    pageSize: 1,
    nextCursor: 'next-page-token',
    items: [{
      tuple: document.tuple,
      revision: document.revision,
      statusDigest: document.statusDigest,
      aggregate: {
        queued: 1, running: 1, skipped: 1, failed: 1,
        cancelled: 1, superseded: 1, successful: 1,
      },
    }],
  }));
  assertRedactionRejected(ciFleetStatusPageSchema.safeParse({
    schema: 'example.ci-fleet-status-page.v1',
    generatedAt: document.generatedAt,
    redaction: 'secrets-removed',
    pageSize: 1,
    nextCursor: 'token=abcdefghijklmnopqrstuvwxyz',
    items: [],
  }));
  for (const workflowContract of workflowContractRegistry.workflows) {
    const surfaces = [
      { contract: workflowContract, identity: { surfaceId: workflowContract.path, kind: 'workflow' as const, workflowPath: workflowContract.path } },
      ...workflowContract.jobs.flatMap((jobContract) => ([
        { contract: jobContract, identity: { surfaceId: `${workflowContract.path}:${jobContract.id}`, kind: 'job' as const, workflowPath: workflowContract.path, jobId: jobContract.id } },
        ...jobContract.steps.map((stepContract) => ({
          contract: stepContract,
          identity: { surfaceId: `${workflowContract.path}:${jobContract.id}:${stepContract.id}`, kind: 'step' as const, workflowPath: workflowContract.path, jobId: jobContract.id, stepId: stepContract.id },
        })),
      ])),
    ];
    for (const { contract, identity } of surfaces) {
      const lane = identity.kind !== 'workflow'
        ? workflowContractRegistry.lanes.find((entry) => entry.workflowPath === workflowContract.path && entry.jobId === identity.jobId)
        : undefined;
      const complete = {
        identity,
        displayName: contract.displayName,
        purpose: contract.purpose,
        progressVocabulary: contract.progressVocabulary,
        successMeaning: contract.successMeaning,
        failureOwner: contract.failureOwner,
        nextAction: contract.nextAction,
        state: 'successful' as const,
        reasonCode: 'completed-successfully' as const,
        outcome: 'passed' as const,
        timestamps: { observedAt: document.generatedAt, startedAt: '2026-09-14T17:59:59-04:00', finishedAt: document.generatedAt, durationSeconds: 1 },
        runnerClass: lane?.runnerClass ?? 'hosted-control',
        costClass: lane?.costClass ?? 'control',
        estimatedDurationSeconds: lane?.id === 'ios.native-shards' ? 600 : undefined,
        dependencies: lane?.dependencies.map((dependency) => ({
          surfaceId: `${lane.workflowPath}:${dependency}`,
          state: 'successful' as const,
        })) ?? [],
        evidence: [{ kind: 'state' as const, identifier: 'successful-surface-state', digest: 'f'.repeat(64) }],
        retry: { attempt: 1, maxAttempts: 1 }, supersession: {},
        permittedNextActions: ['continue-pipeline'] as const,
        humanSummary: renderAgentHumanSummary({
          displayName: contract.displayName, state: 'successful', outcome: 'passed',
          failureOwner: contract.failureOwner,
          estimatedDurationSeconds: lane?.id === 'ios.native-shards' ? 600 : undefined,
          permittedNextActions: ['continue-pipeline'],
        }),
      };
      assert.equal(ciAgentSurfaceStatusSchema.safeParse(complete).success, true, identity.surfaceId);
    }
  }
});

test('document validation reconciles embedded dependency state against its surface status', () => {
  const workflowContract = workflowContractRegistry.workflows.find((entry) => (
    entry.path === '.github/workflows/pr-checks.yml'
  ));
  assert.ok(workflowContract);
  const policyJob = workflowContract.jobs.find((entry) => entry.id === 'validate');
  const lintJob = workflowContract.jobs.find((entry) => entry.id === 'lint');
  assert.ok(policyJob && lintJob);
  const policyLane = workflowContractRegistry.lanes.find((entry) => (
    entry.workflowPath === workflowContract.path && entry.jobId === 'validate'
  ));
  const lintLane = workflowContractRegistry.lanes.find((entry) => (
    entry.workflowPath === workflowContract.path && entry.jobId === 'lint'
  ));
  assert.ok(policyLane && lintLane);
  assert.ok(policyLane.dependencies.includes('lint'));

  function jobStatus(
    lane: NonNullable<typeof policyLane>,
    job: NonNullable<typeof policyJob>,
    state: 'successful' | 'failed',
    lintDependencyState: 'successful' | 'failed',
  ) {
    const status = {
      identity: {
        surfaceId: `${lane.workflowPath}:${lane.jobId}`,
        kind: 'job' as const,
        workflowPath: lane.workflowPath,
        jobId: lane.jobId,
      },
      displayName: job.displayName,
      purpose: job.purpose,
      progressVocabulary: job.progressVocabulary,
      successMeaning: job.successMeaning,
      failureOwner: job.failureOwner,
      nextAction: job.nextAction,
      state,
      reasonCode: state === 'successful' ? 'completed-successfully' as const : 'check-failed' as const,
      outcome: state === 'successful' ? 'passed' as const : 'failed' as const,
      timestamps: {
        observedAt: '2026-09-14T18:00:00-04:00',
        startedAt: '2026-09-14T17:59:00-04:00',
        finishedAt: '2026-09-14T18:00:00-04:00',
        durationSeconds: 60,
      },
      runnerClass: lane.runnerClass,
      costClass: lane.costClass,
      dependencies: lane.dependencies.map((dependency) => ({
        surfaceId: `${lane.workflowPath}:${dependency}`,
        state: dependency === 'lint' ? lintDependencyState : 'successful' as const,
      })),
      evidence: [{ kind: 'state' as const, identifier: `${state}-state`, digest: 'e'.repeat(64) }],
      retry: { attempt: 1, maxAttempts: 1 },
      supersession: {},
      permittedNextActions: state === 'successful' ? ['continue-pipeline'] as const : ['inspect-failure'] as const,
      humanSummary: '',
    };
    status.humanSummary = renderAgentHumanSummary(status);
    return status;
  }

  function documentWith(statuses: unknown[]) {
    const document = {
      schema: 'example.ci-agent-status.v3',
      tuple: migrationTuple(5439),
      registryDigest: workflowContractRegistry.registryDigest,
      revision: 1,
      generatedAt: '2026-09-14T18:00:00-04:00',
      redaction: 'secrets-removed',
      statuses,
      statusDigest: '0'.repeat(64),
    };
    document.statusDigest = computeAgentStatusDigest(document);
    return document;
  }

  const lintFailed = jobStatus(lintLane, lintJob, 'failed', 'successful');
  // validate claims its lint dependency is successful, but the
  // document's own lint status says otherwise; uniqueness alone would let
  // this contradictory pair parse and silently misdirect agents.
  const policyClaimsLintSuccessful = jobStatus(policyLane, policyJob, 'successful', 'successful');
  assert.throws(
    () => ciAgentStatusDocumentSchema.parse(documentWith([policyClaimsLintSuccessful, lintFailed])),
    /Embedded dependency state does not match its surface status/,
  );

  const policyClaimsLintFailed = jobStatus(policyLane, policyJob, 'successful', 'failed');
  assert.doesNotThrow(() => ciAgentStatusDocumentSchema.parse(documentWith([policyClaimsLintFailed, lintFailed])));
});

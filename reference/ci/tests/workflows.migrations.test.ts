import { prValidationPlanning } from '../src/prValidationPlanning.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { dump, load } from 'js-yaml';
import {
  equivalenceIssues, normaliseWorkflow, type NormalisedWorkflow,
} from '../src/workflowEquivalence.ts';
import { definitions } from '../workflows/all.ts';
import { emitYaml, loadPins } from '../workflows/lib/emit.ts';
import { RUNNER_NPM_CACHE_ENV } from '../workflows/lib/model.ts';
import {
  reviewedEventControlLinuxRunner,
  reviewedEventPortableVerdictLinuxRunner,
  trustedControlLinuxRunner,
} from '../workflows/lib/runners.ts';

/**
 * One test per migrated workflow: the generated YAML must describe the same
 * job graph as the hand-written version it replaced, apart from the renames
 * the migration declares. That is what lets a migration commit claim it
 * changed nothing but the source of truth.
 *
 * The hand-written version is a frozen snapshot committed alongside this
 * test, not something read out of git history: a shallow CI checkout has no
 * origin/develop, and once the migration merges, develop would hold the
 * generated file and the comparison would quietly become vacuous.
 */

const root = process.cwd();
const SNAPSHOTS = 'ci/tests/fixtures/pre-migration';
const TYPED_NATIVE_WORKFLOWS = new Set([
  '.github/workflows/branch-policy-monitor.yml',
  '.github/workflows/cancel-blocked-pr-ci.yml',
  '.github/workflows/cancel-dequeued-candidate.yml',
  '.github/workflows/enable-internal-pr-auto-merge.yml',
  '.github/workflows/hosted-linux-admission.yml',
  '.github/workflows/native-terminal-ios-cancel.yml',
  '.github/workflows/native-terminal-pr-checks-cancel.yml',
  '.github/workflows/node-modules-cache.yml',
  '.github/workflows/production-deploy-dispatch.yml',
  '.github/workflows/promotion-checkpoint.yml',
  '.github/workflows/refresh-pr-ci-after-base-edit.yml',
  '.github/workflows/vendored-linkkit-version-check.yml',
]);

interface MigrationCorrection {
  readonly before: string;
  readonly after: string;
  readonly occurrences: number;
  readonly reason: string;
}

function preMigration(path: string): string {
  return readFileSync(join(root, SNAPSHOTS, path.replace('.github/workflows/', '')), 'utf8');
}

/**
 * PR Checks as generated when merge-queue stage S1 branched. S1 rewrote its
 * event reads through the typed projection; `mergeGroupEquivalence.test.ts`
 * proves by evaluation that the rewrite computes the same values on
 * pull_request, so this migration comparison stays against that snapshot.
 */
const PRE_MERGE_GROUP_PR_CHECKS = 'ci/tests/fixtures/pre-merge-group/pr-checks.yml';

function migratedYaml(path: string): string {
  return path === '.github/workflows/pr-checks.yml'
    ? readFileSync(PRE_MERGE_GROUP_PR_CHECKS, 'utf8')
    : generated(path);
}

function generated(path: string): string {
  const definition = definitions.find((candidate) => candidate.config.path === path);
  assert.ok(definition, `${path} has a definition`);
  return emitYaml(definition, { pins: loadPins(root), existing: readFileSync(path, 'utf8') });
}

function correctedPreMigration(
  path: string,
  corrections: readonly MigrationCorrection[],
): string {
  let snapshot = preMigration(path).replaceAll('\r\n', '\n');
  for (const correction of corrections) {
    const actualOccurrences = snapshot.split(correction.before).length - 1;
    assert.equal(
      actualOccurrences,
      correction.occurrences,
      `${path}: ${correction.reason} matched ${actualOccurrences} time(s)`,
    );
    snapshot = snapshot.replaceAll(correction.before, correction.after);
  }
  return snapshot;
}

function assertEquivalent(
  path: string,
  renames: Readonly<Record<string, string>> = {},
  addedSteps: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>> = {},
  corrections: readonly MigrationCorrection[] = [],
  expectedChanges: Readonly<Partial<Pick<NormalisedWorkflow, 'concurrency'>>> = {},
): void {
  let snapshot = correctedPreMigration(path, corrections);
  if (path === '.github/workflows/xcode-cloud-build-tags.yml') {
    // Tagging commits that change workflows requires the approved App's
    // Workflows grant, which GITHUB_TOKEN cannot obtain. Pin this deliberate
    // post-migration credential change while leaving the frozen fixture intact.
    const document = load(snapshot) as {
      permissions: { contents: string };
      jobs: { reconcile: { 'runs-on': unknown; steps: Array<{
        name?: string;
        id?: string;
        uses?: string;
        with?: Record<string, string>;
        env?: Record<string, string>;
      }> } };
    };
    assert.equal(document.permissions.contents, 'write');
    document.permissions.contents = 'read';
    assert.equal(document.jobs.reconcile['runs-on'],
      '${{ fromJson(vars.IOS_CONTROL_RUNNER_LABELS || \'["self-hosted","Linux","linux-remote"]\') }}');
    document.jobs.reconcile['runs-on'] = [...trustedControlLinuxRunner];
    const steps = document.jobs.reconcile.steps;
    const preflight = steps.find((step) => step.name === 'Validate App Store Connect configuration') as
      { name: string; shell?: string; run?: string } | undefined;
    assert.ok(preflight);
    assert.match(preflight.run ?? '', /Missing App Store Connect secrets: \$\{missing\[\*\]\}/);
    assert.equal(preflight.shell, 'bash');
    delete preflight.shell;
    preflight.run = 'node ci/src/actions/validateAppStoreConnectConfiguration.ts';
    const reconcileIndex = steps.findIndex((step) => step.name === 'Reconcile Xcode Cloud build tags');
    assert.ok(reconcileIndex >= 0);
    const reconcile = steps[reconcileIndex];
    assert.ok(reconcile?.env);
    assert.equal(reconcile.env.GH_TOKEN, '${{ github.token }}');
    reconcile.env.GH_TOKEN = '${{ steps.app-token.outputs.token }}';
    steps.splice(reconcileIndex, 0, {
      name: 'Create GitHub App token for Xcode Cloud tags',
      id: 'app-token',
      uses: 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
      with: {
        'app-id': '${{ secrets.PROMOTION_CHECKPOINT_APP_ID }}',
        'private-key': '${{ secrets.PROMOTION_CHECKPOINT_APP_PRIVATE_KEY }}',
        'permission-contents': 'write',
        'permission-workflows': 'write',
        owner: '${{ github.repository_owner }}',
        repositories: '${{ github.event.repository.name }}',
      },
    });
    snapshot = dump(document);
  }
  if (path === '.github/workflows/install-runner-cleanup-hooks.yml') {
    // Post-migration ref validation and dispatch are typed programs. Keep the
    // frozen shell fixture and name both replacements in this proof. Native
    // push filtering now tracks the host inventory instead of dispatcher-only edits.
    const document = load(snapshot) as {
      on: { push: { paths: string[] } };
      jobs: { 'reconcile-host': { steps: Array<{ name?: string; run?: string; shell?: string }> } };
    };
    const preflight = document.jobs['reconcile-host'].steps.find(
      (step) => step.name === 'Validate maintenance dispatch ref',
    );
    assert.ok(preflight);
    assert.match(preflight.run ?? '', /Runner maintenance requires a trusted develop or main ref\./);
    preflight.run = 'node ci/src/actions/validateMaintenanceDispatchRef.ts';
    const dispatch = document.jobs['reconcile-host'].steps.find(
      (step) => step.name === 'Dispatch isolated exact-host maintenance',
    );
    assert.ok(dispatch);
    assert.match(dispatch.run ?? '', /actions\/workflows\/install-runner-cleanup-host\.yml\/dispatches/);
    assert.equal(dispatch.shell, 'bash');
    delete dispatch.shell;
    dispatch.run = 'node ci/src/actions/dispatchRunnerMaintenance.ts';
    assert.ok(document.on.push.paths.includes(path));
    document.on.push.paths = document.on.push.paths.map((input) =>
      input === path ? 'ci/src/maintainedRunnerHosts.ts' : input);
    snapshot = dump(document);
  }
  if (path === '.github/workflows/trusted-production-onboarding-e2e.yml') {
    // The selector now executes under Node, so setup-node must precede it.
    // Keep the historical fixture intact and pin this deliberate move.
    const document = load(snapshot) as {
      jobs: Record<string, { steps?: Array<{ name?: string }> }>;
    };
    const steps = document.jobs['production-onboarding-e2e']?.steps;
    assert.ok(steps);
    const setupIndex = steps.findIndex((step) => step.name === 'Set up Node');
    const selectorIndex = steps.findIndex((step) => step.name === 'Select exact Xcode');
    assert.ok(setupIndex > selectorIndex && selectorIndex >= 0);
    const [setup] = steps.splice(setupIndex, 1);
    assert.ok(setup);
    steps.splice(selectorIndex, 0, setup);
    const productionSteps = document.jobs['production-onboarding-e2e']?.steps as
      Array<{ name?: string; id?: string; if?: string }> | undefined;
    const summary = productionSteps?.find((step) => step.name === 'Summarize production onboarding failures');
    const upload = productionSteps?.find((step) => step.name === 'Upload production onboarding evidence');
    assert.ok(summary && upload);
    assert.equal(summary.id, undefined);
    summary.id = 'summarize-production-onboarding-failures';
    assert.equal(upload.if, "always() && env.ONBOARDING_E2E_RUN_DIR != ''");
    upload.if += " && (steps.production-onboarding-e2e.outcome == 'failure' "
      + "|| steps.summarize-production-onboarding-failures.outcome == 'failure' "
      + "|| (steps.production-onboarding-e2e.outcome == 'skipped' && failure()))";
    // Deploy reports moved to production-deploy-dispatch.yml, which
    // dispatches this workflow on main: a repository_dispatch run has the
    // default branch as its ref, so neither the ref check nor the
    // production-e2e environment (main only) could ever admit it here. With
    // workflow_dispatch the only trigger, runs are keyed by the revision.
    const trusted = document as unknown as {
      on: Record<string, unknown>;
      concurrency: { group: string };
      jobs: Record<string, {
        steps?: Array<{ id?: string; env?: Record<string, string>; run?: string }>;
      }>;
    };
    assert.deepEqual(trusted.on.repository_dispatch, { types: ['production-deployed'] });
    delete trusted.on.repository_dispatch;
    assert.equal(trusted.concurrency.group, 'trusted-production-onboarding-e2e');
    trusted.concurrency.group = 'trusted-production-onboarding-e2e-${{ inputs.exact_sha }}';
    const validate = trusted.jobs['validate-trusted-ref']?.steps
      ?.find((step) => step.id === 'validate');
    assert.ok(validate?.env && validate.run);
    assert.equal(
      validate.env.REQUESTED_SHA,
      "${{ inputs.exact_sha || github.event.client_payload.sha || '' }}",
    );
    validate.env.REQUESTED_SHA = '${{ inputs.exact_sha }}';
    assert.match(validate.run, /repository_dispatch\)/);
    validate.run = readFileSync(
      'scripts/ci/trusted-production-onboarding-e2e/validate-trusted-ref/validate-immutable-main-revision.sh',
      'utf8',
    ).replace(/^#!.*\n/, '');
    snapshot = dump(document);
  }
  {
    // A repository variable once allowed every trusted controller to be
    // redirected to hosted Linux at runtime. That made review and iOS gates
    // fail together when billing admission was unavailable. Preserve the
    // frozen fixtures and overlay only the two exact legacy route forms: a
    // trusted controller is fixed to the external role, while pull-request
    // revision code retains its fork-safe hosted branch.
    const document = load(snapshot) as { jobs: Record<string, { 'runs-on'?: unknown }> };
    const mutableTrustedRoute = "${{ fromJson(vars.CI_CONTROL_RUNNER_LABELS || '[\"ubuntu-24.04\"]') }}";
    const mutableReviewedRoute = "${{ fromJson((github.event_name != 'pull_request' "
      + "|| github.event.pull_request.head.repo.full_name == github.repository) "
      + "&& (vars.CI_CONTROL_RUNNER_LABELS || '[\"ubuntu-24.04\"]') || '[\"ubuntu-24.04\"]') }}";
    const fixedReviewedRoute = "${{ fromJson((github.event_name != 'pull_request' "
      + "|| github.event.pull_request.head.repo.full_name == github.repository) "
      + "&& '[\"self-hosted\",\"Linux\",\"example-trusted-control\"]' || '[\"ubuntu-24.04\"]') }}";
    for (const job of Object.values(document.jobs)) {
      if (job['runs-on'] === mutableTrustedRoute) {
        job['runs-on'] = ['self-hosted', 'Linux', 'example-trusted-control'];
      } else if (job['runs-on'] === mutableReviewedRoute) {
        job['runs-on'] = fixedReviewedRoute;
      }
    }
    // Read-only verdicts use reviewed code. Completion verdicts borrow the
    // controller pool so passing E2E work is not blocked behind long Linux
    // tests; StoreKit and PR validation remain on the portable fleet.
    if (path === '.github/workflows/pr-checks.yml') {
      const verdict = document.jobs.validate;
      assert.ok(verdict);
      verdict['runs-on'] = (load(readFileSync(PRE_MERGE_GROUP_PR_CHECKS, 'utf8')) as {
        jobs: { validate: { 'runs-on': string } };
      }).jobs.validate['runs-on'];
    }
    if (path === '.github/workflows/ios-tests.yml') {
      for (const id of ['test-ios', 'storekit-purchase-status', 'onboarding-e2e-status']) {
        const verdict = document.jobs[id];
        assert.ok(verdict, id);
        verdict['runs-on'] = String(id === 'storekit-purchase-status'
          ? reviewedEventPortableVerdictLinuxRunner : reviewedEventControlLinuxRunner);
      }
    }
    snapshot = dump(document);
  }
  if ([
    '.github/workflows/cancel-blocked-pr-ci.yml',
    '.github/workflows/pr-checks.yml',
    '.github/workflows/refresh-pr-ci-after-base-edit.yml',
    '.github/workflows/ios-tests.yml',
  ].includes(path)) {
    // controller-base-update-delta.mjs now delegates its iOS path decision to
    // ci/src/ios. Every sparse controller checkout must materialise that typed
    // dependency; this exact overlay keeps the migration fixture immutable.
    const document = load(snapshot) as {
      jobs: Record<string, { steps?: Record<string, unknown>[] }>;
    };
    for (const job of Object.values(document.jobs)) {
      for (const step of job.steps ?? []) {
        const withValues = step.with as Record<string, unknown> | undefined;
        if (withValues?.['sparse-checkout'] === 'scripts\n.github/workflows\n') {
          withValues['sparse-checkout'] = 'scripts\n.github/workflows\nci/src/ios\n';
        }
      }
    }
    snapshot = dump(document);
  }
  if (path === '.github/workflows/ios-tests.yml') {
    // Manual dispatch may opt into the reserved Mac in the reviewed group.
    // The frozen migration snapshot predates this route; pin every changed
    // field so future workflow edits cannot be hidden by the overlay.
    const document = load(snapshot) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
      jobs: Record<string, {
        'runs-on'?: { group: string; labels: string[] | string };
        steps?: Array<{ name?: string; env?: Record<string, unknown> }>;
      }>;
    };
    document.on.workflow_dispatch.inputs.mac_runner = {
      description: 'Mac pool for this manual run (reserved Mitchell Mac is opt-in)',
      required: false,
      default: 'shared',
      type: 'choice',
      options: ['shared', 'mitchell-reserved'],
    };
    const selectReserved = "github.event_name == 'workflow_dispatch' && inputs.mac_runner == 'mitchell-reserved'";
    const promotionEvidence = "github.event_name == 'workflow_dispatch' && inputs.test_scope == 'promotion-evidence'";
    const selectedLabels = `\${{ fromJson((${selectReserved}) && '["self-hosted","macOS","ios-reserved-mitchell"]' || '["self-hosted","macOS","ios-xcode"]') }}`;
    const selectedLabelsText = `\${{ (${selectReserved}) && '["self-hosted","macOS","ios-reserved-mitchell"]' || '["self-hosted","macOS","ios-xcode"]' }}`;
    const reviewedGroup = `\${{ (github.event_name == 'pull_request' || (${selectReserved}) || (${promotionEvidence})) && 'example-reviewed-pr-macs' || 'example-team-macs' }}`;
    const evidenceGroup = `\${{ (( ${selectReserved} ) || github.event_name == 'pull_request' || inputs.test_scope == 'financial-independence-evidence' || inputs.test_scope == 'shared-cta-evidence' || (${promotionEvidence})) && 'example-reviewed-pr-macs' || 'example-team-macs' }}`;
    for (const id of [
      'verify-ios-release-archive', 'build-ios-native-test-products',
      'test-ios-execution', 'build-ios-e2e-test-products',
      'onboarding-e2e', 'chat-plaid-e2e', 'income-e2e', 'budget-e2e',
    ]) {
      const route = document.jobs[id]?.['runs-on'];
      assert.ok(route, `Expected ${id} in the frozen iOS migration graph`);
      assert.deepEqual(route.labels, ['self-hosted', 'macOS', 'ios-xcode']);
      route.group = ['build-ios-native-test-products', 'test-ios-execution'].includes(id)
        ? evidenceGroup : reviewedGroup;
      route.labels = selectedLabels;
    }
    const pick = document.jobs['ios-change-gate']?.steps?.find(
      (step) => step.name === 'Resolve iOS macOS runner labels',
    );
    assert.ok(pick?.env);
    for (const key of [
      'IOS_MACOS_RUNNER_LABELS', 'IOS_EVIDENCE_MACOS_RUNNER_LABELS',
      'IOS_ONBOARDING_MACOS_RUNNER_LABELS', 'IOS_CHAT_PLAID_MACOS_RUNNER_LABELS',
      'IOS_BUDGET_MACOS_RUNNER_LABELS',
    ]) {
      assert.equal(pick.env[key], '["self-hosted","macOS","ios-xcode"]');
      pick.env[key] = selectedLabelsText;
    }
    pick.env.MAC_RUNNER = "${{ inputs.mac_runner || 'shared' }}";
    snapshot = dump(document);
  }
  if (path === '.github/workflows/ios-tests.yml') {
    // Account-update evidence shards consume the combined main selector so
    // exact main-owned methods are not dropped from a mixed affected change.
    type MigrationStep = {
      name?: string;
      if?: string;
      env?: Record<string, unknown>;
    };
    const document = load(snapshot) as {
      jobs: Record<string, { steps: MigrationStep[] }>;
    };
    const execution = document.jobs['test-ios-execution'];
    assert.ok(execution);
    const selector = execution.steps.find((step) => step.name === 'Determine Affected iOS Tests');
    assert.ok(selector?.env);
    assert.equal(selector.env.IOS_AFFECTED_TESTS_LANE,
      "${{ startsWith(matrix.lane, 'evidence-') && 'evidence' || 'main' }}");
    selector.env.IOS_AFFECTED_TESTS_LANE =
      "${{ startsWith(matrix.lane, 'evidence-') "
      + "&& !(matrix.lane == 'evidence-account-update' "
      + "|| matrix.lane == 'evidence-account-update-2') "
      + "&& 'evidence' || 'main' }}";

    // The combined selector also carries main-only paywall flags. Account
    // evidence lanes must ignore them to keep that work on its owning lane.
    const accountLanes = "matrix.lane == 'evidence-account-update' "
      + "|| matrix.lane == 'evidence-account-update-2'";
    const oldPaywall = "steps.affected-tests.outputs.narrow_paywall_required == 'true'";
    const lanePaywall = `!(${accountLanes}) && ${oldPaywall}`;
    const narrow = execution.steps.find((step) => step.name === 'Provision narrow iOS Simulator');
    assert.ok(narrow);
    const narrowIf = narrow.if;
    assert.ok(narrowIf);
    assert.ok(narrowIf.includes(oldPaywall));
    narrow.if = narrowIf.replace(oldPaywall, `(${lanePaywall})`);
    for (const name of [
      'Rebuild native test products for consumer Xcode',
      'Execute Precompiled iOS Tests',
    ]) {
      const step: MigrationStep | undefined = execution.steps.find(
        (candidate) => candidate.name === name,
      );
      assert.ok(step?.env);
      assert.equal(step.env.IOS_NARROW_PAYWALL_REQUIRED,
        '${{ steps.affected-tests.outputs.narrow_paywall_required }}');
      step.env.IOS_NARROW_PAYWALL_REQUIRED = '${{ ' + lanePaywall
        + " && 'true' || 'false' }}";
    }
    snapshot = dump(document);
  }
  if (path === '.github/workflows/pr-checks.yml') {
    // The frozen migration fixture is unchanged. This later bootstrap repair
    // intentionally supports the planner packaging on old trusted bases.
    // Permit only the enumerated exact property changes, not arbitrary job drift.
    const document = load(snapshot) as {
      jobs: Record<string, {
        name?: unknown;
        if?: unknown;
        needs?: string[];
        outputs?: Record<string, unknown>;
        'runs-on'?: unknown;
        steps: Record<string, unknown>[];
      }>;
    };
    const nativeShard = document.jobs['server-tests']?.steps.find(
      step => step.name === 'Run server test shard',
    );
    assert.ok(nativeShard);
    assert.equal(nativeShard.id, undefined);
    nativeShard.id = 'native-shard';
    assert.equal(nativeShard.run,
      "npx vitest run --config server/vitest.config.ts --exclude '**/*.integration.test.ts' "
      + "--exclude 'server/tests/chatProviderBoundaryManifest.test.ts' "
      + "--exclude 'server/tests/dateWindowTimezone.test.ts' --shard=${{ matrix.shard }}/4");
    nativeShard.run = 'node ci/src/actions/runLinuxCoverageShard.ts ${{ matrix.shard }}';
    const shardCheckout = document.jobs['server-tests']?.steps.find(
      step => step.name === 'Checkout',
    );
    assert.ok(shardCheckout);
    assert.deepEqual(shardCheckout.with, { 'persist-credentials': false });
    shardCheckout.with = { 'persist-credentials': false, 'fetch-depth': 2 };
    // The policy job keeps its dependency-free suites and preflight command;
    // only their typed entry points changed. Pin the exact frozen commands so
    // this overlay cannot hide other changes to policy execution.
    const debtPreflight = document.jobs['validation-policy']?.steps.find(
      step => step.name === 'Validate debt dependency preflight',
    );
    assert.ok(debtPreflight);
    assert.equal(typeof debtPreflight.run, 'string');
    assert.equal(String(debtPreflight.run).trim(),
      'node --test scripts/tests/debt-projection-tickets.test.mjs scripts/tests/debt-projection-preflight-ci.test.mjs\n'
      + 'node scripts/run-debt-projection-preflight-ci.mjs --event-path "$GITHUB_EVENT_PATH" --output-dir "$DEBT_PREFLIGHT_OUTPUT"');
    debtPreflight.run = 'node ci/src/actions/runPrValidationPolicyTests.ts\n'
      + 'node ci/src/actions/debt/runDebtProjectionPreflight.ts --event-path "$GITHUB_EVENT_PATH" --output-dir "$DEBT_PREFLIGHT_OUTPUT"';

    const planner = document.jobs['docs-change-gate'];
    assert.ok(planner);
    planner.if = 'github.event.pull_request.draft == false';
    const steps = planner.steps;
    assert.ok(steps);
    const install = steps.find((step) => step.name === 'Install typed planner dependencies');
    const plan = steps.find((step) => step.name === 'Compile typed validation plan');
    assert.ok(install);
    assert.ok(plan);
    assert.equal(install.if, undefined);
    assert.equal(install.run, 'npm ci --prefix ci --no-audit --no-fund --ignore-scripts');
    assert.equal(plan.run, 'node ci/src/actions/planPrValidation.ts');
    install.if = "hashFiles('ci/package-lock.json') != ''";
    const adapterCommand = (name: string) =>
      `node \${{ hashFiles('ci/src/actions/${name}.ts') != '' && 'ci/src/actions' || '.ci/trusted-gate-scripts/ci/src/actions' }}/${name}.ts`;
    plan.run = adapterCommand('runTrustedPrPlanner');
    plan.name = prValidationPlanning.selection.name;
    plan.env = {
      ...(plan.env as Record<string, unknown>),
      INPUT_TRUSTED_SCRIPT_SOURCE_SHA: "${{ github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository && steps.trusted-gate-source.outputs.commit || github.event.pull_request.base.sha }}",
      INPUT_BASE_SHA: "${{ github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository && steps.trusted-gate-source.outputs.commit || github.event.pull_request.base.sha }}",
    };
    for (const [name, action] of [
      ['Detect removed changed files', 'selectPrDeletionInventory'],
      ['Load exact-head server test runtime contracts', 'loadPrRuntimeManifest'],
      ['Explain financial calculation assurance', 'explainCalculationAssurance'],
    ]) {
      const converted = steps.find(candidate => candidate.name === name);
      assert.ok(converted);
      converted.run = adapterCommand(action ?? '');
      delete converted.shell;
    }
    const classifier = steps.find(candidate => candidate.name === 'Detect verified incremental head delta');
    assert.ok(classifier);
    classifier.run = 'node ci/src/actions/ios/runTrustedBaseUpdateClassifier.ts';
    classifier.env = { ...(classifier.env as Record<string, unknown>), TRUSTED_CHECKOUT_PATH: '.ci/trusted-base-update' };
    // Current-state inspection replaces a late health-event subscription that
    // can miss a healthy PostgreSQL container after dependency installation.
    const postgresHealth = document.jobs['database-integration']?.steps.find(
      candidate => candidate.name === 'Await PostgreSQL health',
    );
    assert.ok(postgresHealth);
    postgresHealth.run = 'node ci/src/actions/awaitPostgresqlHealth.ts';
    delete postgresHealth.shell;
    // Schema-drift mutation, compensation and diagnostics are now executable
    // TypeScript, covered by the Plaid migration and adapter behavior suites.
    const drift = document.jobs['database-integration']?.steps.find(
      candidate => candidate.name === 'Prove Plaid scheduler verifier rejects schema drift',
    );
    assert.ok(drift);
    drift.run = 'node ci/src/actions/provePlaidSchedulerSchemaDrift.ts';
    delete drift.shell;
    // The lane's container, suite and cleanup shell now runs as typed programs
    // through the generated step action. That action runs its entry with the
    // job's Node, so Node is set up before the container engine is resolved,
    // and the engine reaches the start step through $GITHUB_ENV because the
    // shared action declares no step outputs.
    const database = document.jobs['database-integration'];
    assert.ok(database);
    for (const [name, entry] of [
      ['Ensure container engine', 'ensureContainerEngine'],
      ['Start isolated PostgreSQL', 'startIsolatedPostgresql'],
      ['Verify Wellness migrations and event round trips without skips', 'verifyWellnessDatabases'],
      ['Test distributed database state', 'testDistributedDatabaseState'],
      ['Prepare conversation runtime SQL database', 'prepareConversationRuntimeDatabases'],
      ['Remove PostgreSQL container', 'removePostgresqlContainer'],
    ] as const) {
      const typed: Record<string, unknown> | undefined = database.steps.find(
        candidate => candidate.name === name,
      );
      assert.ok(typed, name);
      assert.equal(typed.shell, 'bash', name);
      assert.equal(typeof typed.run, 'string', name);
      delete typed.run;
      delete typed.shell;
      typed.uses = './.github/actions/typed-step-runner';
      typed.with = { entry: `ci/src/actions/${entry}.ts` };
    }
    const start = database.steps.find(candidate => candidate.name === 'Start isolated PostgreSQL');
    assert.deepEqual(start?.env, { CONTAINER_CMD: '${{ steps.container-engine.outputs.container_cmd }}' });
    delete start.env;
    const databaseNode = database.steps.find(candidate => candidate.name === 'Setup Node');
    assert.ok(databaseNode);
    database.steps.splice(database.steps.indexOf(databaseNode), 1);
    database.steps.unshift(databaseNode);
    const detector = steps.find(candidate => candidate.name === 'Detect documentation-only changes');
    assert.ok(detector);
    detector.run = adapterCommand(prValidationPlanning.inventory.action);
    detector.name = prValidationPlanning.inventory.name;
    detector.id = prValidationPlanning.inventory.id;
    delete detector.shell;
    const inventoryEnv = detector.env as Record<string, unknown>;
    delete inventoryEnv.GIT_CHANGED_FILES_FILE;
    delete inventoryEnv.GIT_NAME_STATUS_FILE;
    const nodeSetup = steps.find(candidate => candidate.name === 'Setup Node for the typed planner');
    assert.ok(nodeSetup);
    steps.splice(steps.indexOf(nodeSetup), 1);
    steps.splice(0, 0, nodeSetup);


    // The runner selector previously occupied a separate 8-12 second job,
    // incurring a full billed minute and one scheduler transition. Fold its
    // typed step into the planner, which already has the trusted base checkout,
    // Node, and ci dependencies it needs.
    const gate = document.jobs['docs-change-gate'];
    const resolver = document.jobs['resolve-pr-linux-runner'];
    assert.ok(gate?.outputs);
    assert.ok(resolver);
    const pick = resolver.steps.find(
      (step) => step.name === 'Select free external capacity or hosted overflow',
    );
    assert.ok(pick);
    pick.if = "steps.plan.outputs.docs_only != 'true'";
    gate.steps.push(pick);
    Object.assign(gate.outputs, {
      pr_linux_runner_labels: '${{ steps.pick.outputs.pr_linux_runner_labels }}',
      pr_database_runner_labels: '${{ steps.pick.outputs.pr_database_runner_labels }}',
      pr_linux_overflow_labels: '${{ steps.pick.outputs.pr_linux_overflow_labels }}',
    });
    delete document.jobs['resolve-pr-linux-runner'];
    const lint = document.jobs.lint;
    assert.ok(lint);
    lint.if = "github.event.pull_request.draft == false && needs.docs-change-gate.result == 'success' && needs.docs-change-gate.outputs.docs_only != 'true'";
    const validate = document.jobs.validate;
    assert.ok(validate);
    // The legacy suites the direct contract step listed now live under
    // ci/tests, which `npm run ci:check` already runs in the same job. The
    // direct step ran them a second time, so it is gone.
    const contractSteps = document.jobs['workflow-contracts']?.steps;
    assert.ok(contractSteps);
    const contractSuite = contractSteps.findIndex(
      (step) => step.name === 'Validate workflow contracts',
    );
    assert.ok(contractSuite >= 0);
    contractSteps.splice(contractSuite, 1);
    for (const job of Object.values(document.jobs)) {
      if (job.needs) job.needs = job.needs.filter((need) => need !== 'resolve-pr-linux-runner');
      if (typeof job['runs-on'] === 'string') {
        job['runs-on'] = job['runs-on'].replace(
          /needs\.resolve-pr-linux-runner\.outputs\./g,
          'needs.docs-change-gate.outputs.',
        );
      }
    }
    const aggregate = document.jobs.validate?.steps.find(
      (step) => step.name === 'Require every selected validation lane',
    );
    assert.ok(aggregate);
    const aggregateEnv = aggregate.env as Record<string, unknown>;
    delete aggregateEnv.RESOLVER;
    // The verdict now runs from the typed action instead of maintained shell.
    aggregate.run = 'node ci/src/actions/requireSelectedValidationLanes.ts';
    snapshot = dump(document);
  }
  if (path === '.github/workflows/ios-tests.yml') {
    const document = load(snapshot) as {
      jobs: Record<string, { name?: string; if?: string; outputs?: Record<string, unknown>;
        steps?: Record<string, unknown>[] }>;
    };
    // No iOS lane is allocated when the planner selected no iOS work.
    const confirm = document.jobs['confirm-current-ios-pr'];
    assert.ok(confirm);
    assert.equal(confirm.if, "always() && !cancelled() && needs.ios-change-gate.result == 'success'");
    confirm.if += " && needs.ios-change-gate.outputs.should_run == 'true'";
    assert.ok(confirm.outputs);
    confirm.outputs.current = "${{ steps.current.outputs.current == 'true' && (steps.runtime.outcome == 'success' || steps.runtime.outcome == 'skipped') }}";
    const trustedCheckout = confirm.steps?.find((step) => step.name === 'Checkout typed live tuple guard');
    assert.ok(trustedCheckout);
    const checkoutWith = trustedCheckout.with as Record<string, unknown>;
    assert.equal(checkoutWith['sparse-checkout'], 'ci\n');
    const gate = document.jobs['ios-change-gate'];
    assert.ok(gate);
    assert.ok(gate.outputs);
    assert.equal(gate.outputs.storekit_required,
      "${{ steps.detect.outputs.storekit_required || steps.precheck.outputs.storekit_required || 'false' }}");
    // The typed gate preserves missing selection evidence for the required verdict.
    gate.outputs.storekit_required =
      "${{ steps.detect.outputs.storekit_required || steps.precheck.outputs.storekit_required || 'unknown' }}";
    const aggregate = "always() && !cancelled() && inputs.test_scope != 'observability-credential-sync' "
      + "&& (github.event_name != 'pull_request' || github.event.pull_request.draft == false)";
    const storekitStatus = document.jobs['storekit-purchase-status'];
    assert.ok(storekitStatus);
    assert.equal(storekitStatus.name,
      "${{ github.event_name == 'workflow_dispatch' && 'Manual - StoreKit Purchase - iOS' || 'StoreKit Purchase - iOS' }}");
    // A skipped job publishes its literal dynamic name, so the required
    // context now uses one static name for both PR and manual runs.
    storekitStatus.name = 'StoreKit Purchase - iOS';
    storekitStatus.if = aggregate
      + " && !(github.event_name == 'pull_request' && needs.ios-change-gate.result == 'success' "
      + "&& needs.ios-change-gate.outputs.storekit_required == 'false')";
    document.jobs['onboarding-e2e-status']!.if = aggregate;
    document.jobs['test-ios']!.if = aggregate;
    // The typed revision guard needs Node before it can admit the exact head.
    // The four real-server jobs share this same step array through the frozen
    // fixture's YAML anchor, so move the one pinned setup step once.
    const e2eSteps = document.jobs['onboarding-e2e']?.steps;
    assert.ok(e2eSteps);
    for (const lane of ['chat-plaid-e2e', 'income-e2e', 'budget-e2e']) {
      assert.equal(document.jobs[lane]?.steps, e2eSteps);
    }
    const guardIndex = e2eSteps.findIndex((step) => step.name === 'Verify exact iOS test revision');
    const reclaimIndex = e2eSteps.findIndex((step) => step.name === 'Reclaim stale iOS runner artifacts');
    const nodeIndex = e2eSteps.findIndex((step) => step.name === 'Setup Node');
    assert.ok(guardIndex >= 0 && guardIndex < reclaimIndex && reclaimIndex < nodeIndex);
    const [nodeSetup] = e2eSteps.splice(nodeIndex, 1);
    assert.ok(nodeSetup);
    e2eSteps.splice(guardIndex, 0, nodeSetup);
    // Dependency installation now uses the exact-key owner already used by
    // PR Linux lanes. Hosted-only restore steps never execute on these Macs.
    const dependencyIndex = e2eSteps.findIndex(step => step.name === 'Install onboarding Node dependencies');
    assert.ok(dependencyIndex >= 0);
    assert.equal(e2eSteps[dependencyIndex]?.run, 'npm ci');
    e2eSteps.splice(dependencyIndex, 1,
      { id: 'node-modules-key', name: 'Compute the dependency cache key',
        if: "runner.environment == 'github-hosted'", run: 'node ci/src/actions/nodeModulesCacheKey.ts' },
      { id: 'node-modules-restore', name: 'Restore cached Node.js dependencies',
        if: "runner.environment == 'github-hosted'",
        uses: 'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
        with: { path: 'node_modules', key: '${{ steps.node-modules-key.outputs.key }}' } },
      { name: 'Install Node.js dependencies', run: 'node ci/src/actions/installNodeDependencies.ts',
        env: { RUNNER_ENVIRONMENT: '${{ runner.environment }}',
          NODE_MODULES_CACHE_HIT: '${{ steps.node-modules-restore.outputs.cache-hit }}' } });
    snapshot = dump(document);
  }
  if (path === '.github/workflows/pr-checks.yml') {
    // Keep the historical fixture frozen while declaring the entitlement gate
    // output and the selected database action that now owns both obligations.
    const document = load(snapshot) as {
      jobs: Record<string, { outputs?: Record<string, unknown>; steps?: Record<string, unknown>[] }>;
    };
    const gate = document.jobs['docs-change-gate'];
    assert.ok(gate?.outputs);
    gate.outputs.entitlement_acceptance_required = '${{ steps.plan.outputs.entitlement_acceptance_required }}';
    const selected = document.jobs['database-integration']?.steps?.find(
      (step) => step.name === 'Run changed integration tests',
    );
    assert.ok(selected);
    selected.if = "needs.docs-change-gate.outputs.targeted_integration_tests != '[]' || needs.docs-change-gate.outputs.entitlement_acceptance_required == 'true'";
    selected.env = {
      TARGETED_SERVER_TESTS_JSON: '${{ needs.docs-change-gate.outputs.targeted_integration_tests }}',
      TARGETED_TEST_RESULTS_FILE: '${{ runner.temp }}/targeted-integration-results.json',
      ENTITLEMENT_ACCEPTANCE_REQUIRED: '${{ needs.docs-change-gate.outputs.entitlement_acceptance_required }}',
      ENTITLEMENT_TEST_DATABASE_URL: '${{ env.DATABASE_URL }}',
      PLAID_SYNC_ATTEMPT_TEST_DATABASE_URL: '${{ env.DATABASE_URL }}',
      STAGING_QA_FIXTURE_TEST_DATABASE_URL: '${{ env.DATABASE_URL }}',
      AUTH_CODE_TEST_DATABASE_URL: '${{ env.DATABASE_URL }}',
      APPLE_AUTH_TEST_DATABASE_URL: '${{ env.DATABASE_URL }}',
      NOTIFICATION_TEST_DATABASE_URL: '${{ env.DATABASE_URL }}',
      RUNTIME_POSTGRES_TEST_URL: '${{ env.RUNTIME_POSTGRES_TEST_URL }}',
      RUN_INTEGRATION_TESTS: '1',
    };
    selected.run = 'node ci/src/actions/runDatabaseIntegrationValidation.ts';
    delete selected.shell;
    snapshot = dump(document);
  }
  if (path === '.github/workflows/refresh-pr-ci-after-base-edit.yml') {
    // The post-migration fan-out now reads failed check contexts so a shared
    // CI repair reaches the old pull-request heads it fixes. Permit only the
    // read capability and token wiring that this query requires.
    const document = load(snapshot) as {
      jobs: Record<string, {
        permissions?: Record<string, unknown>;
        steps: Record<string, unknown>[];
      }>;
    };
    const fanOut = document.jobs['fan-out-base-update'];
    assert.ok(fanOut?.permissions);
    fanOut.permissions.actions = 'read';
    fanOut.permissions.checks = 'read';
    const update = fanOut.steps.find(
      (step) => step.name === 'Update every open pull request that shares a file with this push',
    );
    assert.ok(update);
    const environment = update.env as Record<string, unknown> | undefined;
    assert.ok(environment);
    environment.READ_TOKEN = '${{ github.token }}';
    snapshot = dump(document);
  }
  if (path === '.github/workflows/actions-artifact-cleanup.yml') {
    // This post-migration cleanup removes the last two shell implementations
    // from the workflow and gives the controller its dedicated runner pool.
    // Keep the original fixture immutable and permit only this exact graph
    // replacement.
    const document = load(snapshot) as {
      jobs: Record<string, {
        name?: string;
        'runs-on': unknown;
        steps: Record<string, unknown>[];
      }>;
    };
    const job = document.jobs['delete-expired-artifacts'];
    assert.ok(job);
    assert.deepEqual(job['runs-on'], ['self-hosted', 'Linux', 'ARM64']);
    assert.deepEqual(
      job.steps.map(step => step.name),
      [
        'Delete artifacts after their retention period',
        'Prune superseded debt-card XCTest caches',
      ],
    );
    document.jobs['prune-superseded-caches'] = job;
    delete document.jobs['delete-expired-artifacts'];
    job.name = 'Prune superseded XCTest caches';
    job['runs-on'] = ['self-hosted', 'Linux', 'example-trusted-control'];
    job.steps.splice(0, 2, {
      name: 'Prune superseded debt-card XCTest caches',
      run: 'node ci/src/actions/cleanupActionsStorage.ts',
      env: {
        CACHE_KEY_PREFIX: 'ios-debt-card-test-products-v1-',
        GITHUB_API_URL: '${{ github.api_url }}',
        GITHUB_REPOSITORY: '${{ github.repository }}',
        GITHUB_TOKEN: '${{ github.token }}',
      },
    });
    snapshot = dump(document);
  }
  if (path === '.github/workflows/ios-tests.yml') {
    // Lane-specific iOS evidence reuse is a deliberate post-migration
    // behavior change. Keep the frozen migration fixture immutable and patch
    // only the exact existing fields this optimization changes; the two new
    // steps remain declared through addedSteps below.
    const document = load(snapshot) as {
      jobs: Record<string, {
        outputs?: Record<string, unknown>;
        steps: Record<string, unknown>[];
      }>;
    };
    const gate = document.jobs['ios-change-gate'];
    const producer = document.jobs['build-ios-e2e-test-products'];
    const nativeProducer = document.jobs['build-ios-native-test-products'];
    const nativeConsumer = document.jobs['test-ios-execution'];
    assert.ok(gate?.outputs);
    assert.ok(producer);
    assert.ok(nativeProducer);
    assert.ok(nativeConsumer);
    // The producer now executes a typed selector during unit preflight. Its
    // dependencies are installed only after the trusted revision guard.
    const revisionGuard = nativeProducer.steps.findIndex(
      (step) => step.name === 'Verify exact native test revision',
    );
    assert.notEqual(revisionGuard, -1);
    nativeProducer.steps.splice(revisionGuard + 1, 0, {
      name: 'Install typed native producer dependencies',
      run: 'npm ci --prefix ../ci --no-audit --no-fund --ignore-scripts',
    });
    const nativeSelection = nativeProducer.steps.find(
      (step) => step.name === 'Determine native build selection',
    );
    assert.ok(nativeSelection?.env && typeof nativeSelection.env === 'object');
    (nativeSelection.env as Record<string, unknown>).IOS_AFFECTED_TESTS_WORKSPACE = '${{ github.workspace }}';
    const gateSelection = gate.steps.find((step) => step.name === 'Select native iOS tests');
    assert.ok(gateSelection?.env && typeof gateSelection.env === 'object');
    (gateSelection.env as Record<string, unknown>).IOS_AFFECTED_TESTS_WORKSPACE = '${{ github.workspace }}';
    const consumerSelection = nativeConsumer.steps.find(
      (step) => step.name === 'Determine Affected iOS Tests',
    );
    assert.ok(consumerSelection?.env && typeof consumerSelection.env === 'object');
    (consumerSelection.env as Record<string, unknown>).IOS_AFFECTED_TESTS_WORKSPACE = '${{ github.workspace }}';
    Object.assign(gate.outputs, {
      reuse_e2e_products: "${{ steps.base-update.outputs.reuse_e2e_products || 'false' }}",
      reused_e2e_run_id: "${{ steps.base-update.outputs.reused_e2e_run_id || '' }}",
      reused_e2e_run_attempt: "${{ steps.base-update.outputs.reused_e2e_run_attempt || '' }}",
      reused_e2e_head_sha: "${{ steps.base-update.outputs.reused_e2e_head_sha || '' }}",
    });
    const buildRequired = "${{ needs.ios-change-gate.outputs.reuse_e2e_products != 'true' "
      + "|| (steps.restore-reused-e2e-test-products.outputs.cache-hit != 'true' "
      + "&& steps.restore-legacy-reused-e2e-test-products.outputs.cache-hit != 'true') "
      + "|| steps.rebind-reused-e2e-test-products.outputs.rebuild_required == 'true' }}";
    for (const name of [
      'Prepare shared E2E build cache',
      'Build exact-head E2E products once',
      'Pack executable E2E products',
    ]) {
      const step: Record<string, unknown> | undefined = producer.steps.find(
        (candidate) => candidate.name === name,
      );
      assert.ok(step);
      assert.equal(step.if, undefined);
      step.if = buildRequired;
    }
    const oldHandoffKey = 'ios-e2e-test-products-v1-${{ env.ONBOARDING_E2E_COMMIT_SHA }}-${{ github.run_id }}';
    const newHandoffKey = 'ios-e2e-test-products-v2-${{ env.ONBOARDING_E2E_COMMIT_SHA }}-${{ github.run_id }}';
    let updatedHandoffKeys = 0;
    for (const job of Object.values(document.jobs)) {
      for (const step of job.steps) {
        const withBlock = step.with;
        if (typeof withBlock === 'object' && withBlock !== null
          && (withBlock as Record<string, unknown>).key === oldHandoffKey) {
          (withBlock as Record<string, unknown>).key = newHandoffKey;
          updatedHandoffKeys += 1;
        }
      }
    }
    // The four consumer jobs share one YAML anchor after parsing, so the
    // producer save, producer verification, and shared consumer key are the
    // three distinct objects this exact migration changes.
    assert.equal(updatedHandoffKeys, 3);

    const updateTransportStep = (
      job: { steps: Record<string, unknown>[] },
      name: string,
      changes: Record<string, unknown>,
    ): void => {
      const step = job.steps.find((candidate) => candidate.name === name);
      assert.ok(step);
      Object.assign(step, changes);
    };
    updateTransportStep(producer, 'Save exact-head E2E products', {
      id: 'save-e2e-test-products-cache',
      'continue-on-error': true,
    });
    updateTransportStep(producer, 'Verify exact-head E2E cache publication', {
      'continue-on-error': true,
    });
    updateTransportStep(producer, 'Upload exact-head E2E products fallback', {
      id: 'upload-e2e-test-products-fallback',
    });
    const onboardingConsumer = document.jobs['onboarding-e2e'];
    assert.ok(onboardingConsumer);
    updateTransportStep(onboardingConsumer, 'Restore exact-head E2E test products', {
      'continue-on-error': true,
      'timeout-minutes': 5,
    });
    updateTransportStep(nativeProducer, 'Save exact-head native test products', {
      id: 'save-native-test-products-cache',
      'continue-on-error': true,
    });
    updateTransportStep(nativeProducer, 'Verify exact-head native cache publication', {
      'continue-on-error': true,
    });
    updateTransportStep(nativeProducer, 'Upload exact-head native products fallback', {
      id: 'upload-native-test-products-fallback',
      if: "needs.ios-change-gate.outputs.native_handoff_required == 'true' "
        + "&& (steps.verify-native-test-products-cache.outcome != 'success' "
        + "|| steps.verify-native-test-products-cache.outputs.cache-hit != 'true')",
    });
    const restoreIndex = nativeConsumer.steps.findIndex(
      (candidate) => candidate.name === 'Restore exact-head native test products',
    );
    assert.notEqual(restoreIndex, -1);
    const restore = nativeConsumer.steps[restoreIndex];
    assert.ok(restore);
    restore['continue-on-error'] = true;
    restore['timeout-minutes'] = 5;
    nativeConsumer.steps.splice(restoreIndex + 1, 0, {
      name: 'Retry exact-head native test products restore once',
      id: 'retry-restore-native-test-products',
      uses: restore.uses,
      if: "steps.affected-tests.outputs.should_run == 'true' "
        + "&& (steps.restore-native-test-products.outcome != 'success' "
        + "|| steps.restore-native-test-products.outputs.cache-hit != 'true')",
      'continue-on-error': true,
      'timeout-minutes': 5,
      with: restore.with,
    });
    updateTransportStep(nativeConsumer, 'Download exact-head native products fallback', {
      if: "steps.affected-tests.outputs.should_run == 'true' "
        + "&& (steps.restore-native-test-products.outcome != 'success' "
        + "|| steps.restore-native-test-products.outputs.cache-hit != 'true') "
        + "&& (steps.retry-restore-native-test-products.outcome != 'success' "
        + "|| steps.retry-restore-native-test-products.outputs.cache-hit != 'true')",
    });
    snapshot = dump(document);
  }
  if (path === '.github/workflows/ios-tests.yml') {
    // A main promotion must use the checkpoint proved by the trusted develop
    // precheck, even when main predates typed CI. Keep the migration fixture
    // frozen and declare each intentional post-migration graph change here.
    const document = load(snapshot) as {
      jobs: Record<string, {
        if?: string;
        needs?: string[];
        outputs?: Record<string, unknown>;
        steps: Record<string, unknown>[];
      }>;
    };
    const jobs = document.jobs;
    const verifier = '${{ needs.ios-change-gate.outputs.verifier_sha }}';
    const verifierFallback = '${{ needs.ios-change-gate.outputs.verifier_sha || env.EXAMPLE_CI_TRUSTED_BASE_SHA }}';
    const findStep = (jobId: string, name: string): Record<string, unknown> => {
      const step = jobs[jobId]?.steps.find(candidate => candidate.name === name);
      assert.ok(step, `${jobId}: ${name}`);
      return step;
    };
    const changeRef = (jobId: string, name: string, from: string, to: string): void => {
      const step = findStep(jobId, name);
      const withValues = step.with as Record<string, unknown> | undefined;
      assert.ok(withValues);
      assert.equal(withValues.ref, from, `${jobId}: ${name} old ref`);
      withValues.ref = to;
    };
    const gate = jobs['ios-change-gate'];
    assert.ok(gate?.outputs);
    assert.equal(gate.outputs.should_run,
      "${{ steps.base-update.outputs.deferred == 'true' && 'false' || steps.detect.outputs.should_run || steps.precheck.outputs.should_run }}");
    assert.equal(gate.outputs.onboarding_required,
      "${{ steps.detect.outputs.onboarding_required || steps.precheck.outputs.onboarding_required || 'false' }}");
    gate.outputs.should_run = "${{ steps.base-update.outputs.deferred == 'true' && 'false' || steps.precheck.outputs.production_promotion == 'true' && 'true' || steps.detect.outputs.should_run || steps.precheck.outputs.should_run }}";
    gate.outputs.onboarding_required = "${{ steps.precheck.outputs.production_promotion == 'true' && 'true' || steps.detect.outputs.onboarding_required || steps.precheck.outputs.onboarding_required || 'false' }}";
    assert.equal(gate.outputs.verifier_sha, undefined);
    gate.outputs.verifier_sha = "${{ steps.precheck.outputs.verifier_sha || '' }}";
    changeRef('ios-change-gate', 'Checkout trusted iOS gate precheck',
      '${{ github.event.pull_request.base.sha || github.sha }}',
      "${{ github.event.pull_request.base.ref == 'main' && 'develop' || github.event.pull_request.base.sha || github.sha }}");

    const oldSelected = "(steps.detect.outputs.should_run || steps.precheck.outputs.should_run) == 'true'";
    const selected = "steps.base-update.outputs.deferred != 'true' && (steps.precheck.outputs.production_promotion == 'true' || "
      + oldSelected + ')';
    for (const name of [
      'Checkout typed iOS runner resolver',
      'Setup Node for the typed iOS runner resolver',
      'Install typed iOS runner resolver dependencies',
      'Resolve iOS macOS runner labels',
      'Checkout exact native test revision',
      'Setup Node for the typed planner',
      'Install typed planner dependencies',
      'Select native iOS tests',
      'Classify selected UI work',
    ]) {
      const step = findStep('ios-change-gate', name);
      const condition = String(step.if);
      assert.ok(condition.startsWith(oldSelected), name);
      const native = name === 'Checkout exact native test revision'
        || name === 'Setup Node for the typed planner'
        || name === 'Install typed planner dependencies'
        || name === 'Select native iOS tests'
        || name === 'Classify selected UI work';
      step.if = native
        ? condition.replace(oldSelected, `(${selected}) && (github.event_name != 'pull_request' || steps.detect.outputs.should_run == 'true')`)
        : condition.replace(oldSelected, selected);
    }

    const release = jobs['release-full-routing-predecessor'];
    assert.ok(release?.if);
    release.if = release.if.replace(
      "github.event.action == 'synchronize' && ",
      "github.event.action == 'synchronize' && needs.ios-change-gate.result == 'success' && ",
    );
    const releaseStep = findStep('release-full-routing-predecessor', 'Cancel retained predecessors');
    assert.equal(releaseStep.run, 'node .ci/trusted-base-update/ci/src/actions/ios/releaseRetainedPredecessors.ts');
    releaseStep.run = 'node .ci/trusted-predecessor-verifier/ci/src/actions/ios/releaseRetainedPredecessors.ts';
    for (const [job, step] of [
      ['await-retained-ios-predecessor', 'Checkout typed predecessor marker'],
      ['confirm-current-ios-pr', 'Checkout typed live tuple guard'],
      ['test-ios', 'Checkout trusted base workspace'],
      ['storekit-purchase-status', 'Checkout trusted base workspace'],
      ['onboarding-e2e-status', 'Checkout trusted base workspace'],
      ['remove-run-artifacts-after-success', 'Checkout typed artifact cleanup'],
    ]) {
      changeRef(job!, step!, '${{ env.EXAMPLE_CI_TRUSTED_BASE_SHA }}', verifierFallback);
    }
    for (const job of ['test-ios', 'onboarding-e2e-status']) {
      findStep(job, 'Checkout trusted base workspace').name = 'Checkout proven iOS verifier workspace';
    }
    const nativeStatus = findStep('test-ios', 'Verify iOS test lanes');
    assert.equal(nativeStatus.if, undefined);
    nativeStatus.if = "github.event_name != 'pull_request' || github.event.pull_request.base.ref != 'main' "
      + "|| needs.ios-change-gate.outputs.should_run != 'true' "
      + "|| needs.ios-change-gate.outputs.main_required == 'true' "
      + "|| needs.ios-change-gate.outputs.evidence_required == 'true' "
      + "|| needs.ios-change-gate.outputs.native_release_archive_required == 'true'";
    changeRef('prepare-dev-e2e-schema', 'Checkout trusted schema verifier',
      '${{ env.EXAMPLE_CI_TRUSTED_BASE_SHA }}', verifier);
    const schemaRevision = findStep('prepare-dev-e2e-schema', 'Verify trusted schema verifier revision');
    const schemaEnv = schemaRevision.env as Record<string, unknown>;
    assert.equal(schemaEnv.TRUSTED_VERIFIER_SHA, undefined);
    schemaEnv.TRUSTED_VERIFIER_SHA = verifier;
    for (const job of [
      'verify-ios-release-archive', 'build-ios-native-test-products',
      'build-ios-e2e-test-products', 'test-ios-execution',
      'onboarding-e2e', 'chat-plaid-e2e', 'income-e2e', 'budget-e2e',
    ]) {
      const guard = jobs[job]?.steps.find(step => {
        const run = String(step.run ?? '');
        return run.includes('verifyExact') || run.includes('contents/scripts/confirm-current-ios-pr.sh');
      });
      assert.ok(guard, `${job}: exact revision guard`);
      const env = guard.env as Record<string, unknown>;
      if (env.EXAMPLE_CI_GUARD_SHA === undefined) {
        env.EXAMPLE_CI_GUARD_SHA = verifier;
      } else {
        // The four E2E lanes share one parsed YAML anchor.
        assert.equal(env.EXAMPLE_CI_GUARD_SHA, verifier, job);
      }
      if (typeof guard.run === 'string' && guard.run.includes('ref=${EXAMPLE_CI_TRUSTED_BASE_SHA}')) {
        assert.match(guard.run, /trusted base \$\{EXAMPLE_CI_TRUSTED_BASE_SHA\}/);
        guard.run = guard.run
          .replace('The guard comes from the trusted base, not the exact head:',
            'The guard comes from the gate-proven verifier, not the exact head:')
          .replace('ref=${EXAMPLE_CI_TRUSTED_BASE_SHA}', 'ref=${EXAMPLE_CI_GUARD_SHA}')
          .replace('trusted base ${EXAMPLE_CI_TRUSTED_BASE_SHA}',
            'trusted verifier ${EXAMPLE_CI_GUARD_SHA}');
      }
    }
    // Typed admission now executes directly from the trusted verifier. The
    // late live-tuple check remains; only its execution source changes.
    for (const [jobId, program] of [
      ['verify-ios-release-archive', 'verifyExactReleaseArchiveRevision.ts'],
      ['build-ios-e2e-test-products', 'verifyExactIosRevision.ts'],
      ['build-ios-native-test-products', 'verifyExactIosRevision.ts'],
      ['test-ios-execution', 'verifyExactIosRevision.ts'],
    ]) {
      const name = jobId === 'verify-ios-release-archive' ? 'Verify exact Release archive revision'
        : jobId === 'build-ios-native-test-products' ? 'Verify exact native test revision'
          : jobId === 'build-ios-e2e-test-products' ? 'Verify exact E2E revision'
            : 'Verify exact iOS test revision';
      const guard = findStep(jobId!, name);
      const prefix = jobId === 'build-ios-e2e-test-products' ? '' : '../';
      const controls = jobId === 'build-ios-native-test-products' || jobId === 'test-ios-execution'
        ? 'trusted-native-controls' : 'trusted-ios-revision-guard';
      assert.equal(guard.run, `node ${prefix}ci/src/actions/ios/${program}`);
      guard.run = `node ${prefix}.ci/${controls}/ci/src/actions/ios/${program}`;
    }
    const e2eGuard = findStep('onboarding-e2e', 'Verify exact iOS test revision');
    assert.match(String(e2eGuard.run), /contents\/scripts\/confirm-current-ios-pr\.sh/);
    e2eGuard.run = 'node .ci/trusted-ios-revision-guard/ci/src/actions/ios/verifyExactIosRevision.ts';
    for (const job of ['onboarding-e2e', 'chat-plaid-e2e', 'income-e2e', 'budget-e2e']) {
      addedSteps = {
        ...addedSteps,
        [job]: [...(addedSteps[job] ?? []), {
          name: 'Checkout typed iOS revision guard',
          uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
          with: {
            ref: '${{ needs.ios-change-gate.outputs.verifier_sha || env.EXAMPLE_CI_TRUSTED_BASE_SHA }}',
            path: '.ci/trusted-ios-revision-guard',
            'persist-credentials': false,
            'fetch-depth': 1,
            'sparse-checkout': 'ci\n',
          },
        }],
      };
    }
    const cleanup = jobs['remove-run-artifacts-after-success'];
    assert.ok(cleanup?.needs);
    assert.equal(cleanup.needs.includes('ios-change-gate'), false);
    cleanup.needs.unshift('ios-change-gate');
    assert.equal(cleanup.needs.includes('test-ios'), false);
    cleanup.needs.push('test-ios');
    // A draft promotion skips the gate. Advisory cleanup must not fetch a
    // verifier from the old main base before the gate has admitted one.
    const cleanupCondition = "always() && !cancelled() && !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled')";
    assert.equal(cleanup.if, cleanupCondition);
    cleanup.if = "always() && !cancelled() && needs.ios-change-gate.result == 'success' "
      + "&& needs.ios-change-gate.outputs.verifier_sha != '' "
      + "&& !contains(needs.*.result, 'failure') && !contains(needs.*.result, 'cancelled')";
    // Exact behavior added after migration: failed-run diagnostics and typed
    // outcome IDs. Current-behavior contracts separately exercise every
    // failure-only predicate, while this parity test rejects any other drift.
    const diagnosticIds = [
      ["verify-ios-release-archive", "Compile unsigned Release archive", "compile-release-archive"],
      ["build-ios-native-test-products", "Build native iOS test products once", "build-test-products"],
      ["build-ios-native-test-products", "Run native unit preflight", "unit-preflight"],
      ["test-ios-execution", "Rebuild native test products for consumer Xcode", "rebuild-native-products"],
      ["test-ios-execution", "Summarize iOS Test Failures", "summarize-ios-test-failures"],
      ["test-ios-execution", "Export iOS Test Screenshots", "export-ios-test-screenshots"],
      ["test-ios-execution", "Validate financial independence evidence", "validate-financial-independence"],
      ["test-ios-execution", "Validate Issue 4549 onboarding-copy accessibility evidence", "validate-onboarding-copy"],
      ["test-ios-execution", "Validate Issue 3924 aggregate evidence", "validate-issue-3924"],
      ["test-ios-execution", "Validate Issue 3995 layout evidence", "validate-issue-3995"],
      ["onboarding-e2e", "Validate development FullOnboarding evidence", "validate-onboarding-lifecycle"],
    ] as const satisfies readonly (readonly [string, string, string])[];
    for (const [job, name, id] of diagnosticIds) {
      const step = findStep(job, name);
      assert.equal(step.id, undefined, `${job}: ${name} pre-migration ID`);
      step.id = id;
    }
    const diagnosticConditions = [
      ["verify-ios-release-archive", "Upload Release archive diagnostics", "always() && steps.compile-release-archive.outcome == 'failure'"],
      ["build-ios-native-test-products", "Upload native unit and StoreKit diagnostics", "always() && (steps.build-test-products.outcome == 'failure' || steps.unit-preflight.outcome == 'failure' || steps.storekit.outcome == 'failure')"],
      ["test-ios-execution", "Export iOS Test Screenshots", "always() && steps.affected-tests.outputs.should_run == 'true' && ((matrix.lane == 'native1' && github.event_name == 'workflow_dispatch' && inputs.test_scope == 'financial-independence-evidence') || startsWith(matrix.lane, 'evidence-'))"],
      ["test-ios-execution", "Retain required Wellness execution evidence", "always() && matrix.lane == 'native1' && steps.affected-tests.outputs.wellness_required == 'true' && steps.affected-tests.outputs.should_run == 'true' && steps.execute-tests.outcome == 'failure'"],
      ["test-ios-execution", "Upload iOS Test Screenshots", "always() && steps.affected-tests.outputs.should_run == 'true' && ((matrix.lane == 'native1' && github.event_name == 'workflow_dispatch' && inputs.test_scope == 'financial-independence-evidence') || startsWith(matrix.lane, 'evidence-')) && (steps.execute-tests.outcome == 'failure' || steps.summarize-ios-test-failures.outcome == 'failure' || steps.validate-financial-independence.outcome == 'failure' || steps.validate-onboarding-copy.outcome == 'failure' || steps.validate-issue-3924.outcome == 'failure' || steps.validate-issue-3995.outcome == 'failure' || steps.export-ios-test-screenshots.outcome == 'failure')"],
      ["test-ios-execution", "Upload iOS Test Diagnostics", "always() && steps.affected-tests.outputs.should_run == 'true' && (steps.rebuild-native-products.outcome == 'failure' || steps.execute-tests.outcome == 'failure' || steps.summarize-ios-test-failures.outcome == 'failure' || steps.validate-financial-independence.outcome == 'failure' || steps.validate-onboarding-copy.outcome == 'failure' || steps.validate-issue-3924.outcome == 'failure' || steps.validate-issue-3995.outcome == 'failure' || steps.export-ios-test-screenshots.outcome == 'failure')"],
      ["test-ios-execution", "Upload iOS Busy retry diagnostics", "always() && steps.affected-tests.outputs.should_run == 'true' && steps.execute-tests.outcome == 'failure'"],
      ["onboarding-e2e", "Upload raw onboarding video for non-gating review", "env.E2E_LANE == 'onboarding' && always() && (needs.ios-change-gate.outputs.production_promotion == 'true' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')) && steps.onboarding-e2e.outcome == 'failure'"],
      ["onboarding-e2e", "Upload Income E2E evidence", "env.E2E_LANE == 'income' && always() && (steps.income-e2e.outcome == 'failure' || failure() || (steps.income-e2e.outcome == 'skipped' && failure()))"],
      ["onboarding-e2e", "Upload Chat Plaid E2E evidence", "env.E2E_LANE == 'chat-plaid' && always() && (steps.chat-plaid-e2e.outcome == 'failure' || failure() || steps.validate-chat-plaid-evidence.outcome == 'failure')"],
      ["onboarding-e2e", "Upload Chat Plaid E2E diagnostics", "env.E2E_LANE == 'chat-plaid' && always() && (steps.chat-plaid-e2e.outcome == 'failure' || failure() || steps.validate-chat-plaid-evidence.outcome == 'failure' || steps.export-compact-summaries.outcome == 'failure' || (steps.chat-plaid-e2e.outcome == 'skipped' && failure()))"],
      ["onboarding-e2e", "Upload FullOnboarding E2E evidence", "env.E2E_LANE == 'onboarding' && always() && needs.ios-change-gate.outputs.onboarding_required == 'true' && (steps.onboarding-e2e.outcome == 'failure' || failure() || steps.validate-onboarding-lifecycle.outcome == 'failure')"],
      ["onboarding-e2e", "Upload onboarding E2E diagnostics", "env.E2E_LANE == 'onboarding' && always() && (steps.onboarding-e2e.outcome == 'failure' || failure() || steps.validate-onboarding-lifecycle.outcome == 'failure' || steps.export-compact-summaries.outcome == 'failure' || (steps.onboarding-e2e.outcome == 'skipped' && failure()))"],
      ["onboarding-e2e", "Upload Budget E2E evidence", "env.E2E_LANE == 'budget' && always() && needs.ios-change-gate.outputs.budget_required == 'true' && (steps.budget-e2e.outcome == 'failure' || failure() || steps.validate-ios-3996-evidence.outcome == 'failure' || steps.export-compact-summaries.outcome == 'failure')"],
      ["onboarding-e2e", "Upload Budget E2E diagnostics", "env.E2E_LANE == 'budget' && always() && (steps.budget-e2e.outcome == 'failure' || failure() || steps.validate-ios-3996-evidence.outcome == 'failure' || steps.export-compact-summaries.outcome == 'failure' || (steps.budget-e2e.outcome == 'skipped' && failure()))"],
    ] as const satisfies readonly (readonly [string, string, string])[];
    for (const [sourceJob, name, condition] of diagnosticConditions) {
      // All four E2E jobs share the same parsed YAML steps anchor.
      const step = findStep(sourceJob, name);
      assert.equal(typeof step.if, 'string', `${sourceJob}: ${name} pre-migration condition`);
      assert.notEqual(step.if, condition, `${sourceJob}: ${name} changed after migration`);
      step.if = condition;
    }
    const budgetVideo = jobs['budget-e2e-video-processing'];
    assert.ok(budgetVideo);
    assert.equal(String(budgetVideo.if).trim(), "always() && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.test_scope != 'debt-card-evidence' && needs.budget-e2e.result == 'success'");
    budgetVideo.if = "always() && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.test_scope != 'debt-card-evidence' && needs.budget-e2e.result == 'failure'";
    const rawBudgetVideo = findStep('budget-e2e-video-processing', 'Download raw Budget video');
    const rawBudgetVideoInput = rawBudgetVideo.with as Record<string, unknown>;
    assert.equal(rawBudgetVideoInput.name,
      'budget-e2e-evidence-${{ github.run_id }}-${{ github.run_attempt }}-a');
    delete rawBudgetVideoInput.name;
    rawBudgetVideoInput.pattern = 'budget-e2e-evidence-${{ github.run_id }}-${{ github.run_attempt }}-*';
    snapshot = dump(document);
  }
  if (path === '.github/workflows/pr-checks.yml') {
    const document = load(snapshot) as {
      jobs: Record<string, { name?: string; if?: string; permissions?: Record<string, string>;
        outputs?: Record<string, unknown>; steps?: Record<string, unknown>[] }>;
    };
    const previous = document.jobs['docs-change-gate'];
    assert.ok(previous);
    document.jobs[prValidationPlanning.id] = previous;
    previous.name = prValidationPlanning.name;
    delete document.jobs['docs-change-gate'];
    // On-demand admission is a deliberate post-migration permission change.
    // Only the trusted-base planner may dispatch the hosted probe.
    assert.equal(previous.permissions, undefined);
    previous.permissions = { actions: 'write', contents: 'read', 'pull-requests': 'read' };
    // Main predates typed CI. Promotion planning and its verdict pin one
    // protected develop revision; ordinary PRs still use their exact base.
    const promotionPolicy = "${{ github.event.pull_request.base.ref == 'main' "
      + '&& github.event.pull_request.head.repo.full_name == github.repository '
      + '&& steps.trusted-gate-source.outputs.commit || github.event.pull_request.base.sha }}';
    previous.outputs ??= {};
    previous.outputs.trusted_policy_sha = promotionPolicy;
    for (const name of ['Checkout base-update classifier', 'Checkout trusted base workspace']) {
      const checkout: Record<string, unknown> | undefined = previous.steps?.find(
        (candidate) => candidate.name === name,
      );
      assert.ok(checkout?.with && typeof checkout.with === 'object');
      (checkout.with as Record<string, unknown>).ref = promotionPolicy;
    }
    const preflight = document.jobs['validation-policy']?.steps?.find(
      (candidate) => candidate.name === 'Validate debt dependency preflight',
    );
    assert.ok(preflight);
    assert.equal(preflight.run,
      'node ci/src/actions/runPrValidationPolicyTests.ts\n'
      + 'node ci/src/actions/debt/runDebtProjectionPreflight.ts --event-path "$GITHUB_EVENT_PATH" --output-dir "$DEBT_PREFLIGHT_OUTPUT"');
    delete preflight.run;
    preflight.uses = './.github/actions/typed-step-runner';
    preflight.with = { entry: 'ci/src/actions/debt/runDebtDependencyPreflight.ts' };
    assert.equal(preflight.id, undefined);
    preflight.id = 'debt-preflight';
    const entrySource = readFileSync('ci/src/actions/debt/runDebtDependencyPreflight.ts', 'utf8');
    assert.match(entrySource, /runPrValidationPolicyTests\.ts/);
    assert.match(entrySource, /runDebtProjectionPreflight\.ts/);
    const fallback = document.jobs['validation-policy']?.steps?.find(
      (candidate) => candidate.name === 'Preserve debt evidence when artifact storage is unavailable',
    );
    assert.ok(fallback);
    assert.match(String(fallback.run), /sed -n '1,240p'/);
    assert.equal(fallback.shell, 'bash');
    delete fallback.run;
    delete fallback.shell;
    fallback.uses = './.github/actions/typed-step-runner';
    fallback.with = { entry: 'ci/src/actions/debt/preserveDebtEvidence.ts' };
    const evidence = document.jobs['validation-policy']?.steps?.find(
      (candidate) => candidate.name === 'Retain debt dependency evidence',
    );
    assert.ok(evidence);
    assert.equal(evidence.if, 'always()');
    evidence.if = "always() && steps.debt-preflight.outcome == 'failure'";
    // #4002 adds a required local PostgreSQL acceptance suite after the
    // frozen fixture. The legacy shell adapter is gone; its credentials now
    // belong to this generated typed step's environment contract.
    const databaseAcceptance = document.jobs['database-integration']?.steps?.find(
      (candidate) => candidate.name === 'Run changed integration tests',
    );
    assert.ok(databaseAcceptance);
    databaseAcceptance.env = {
      ...(databaseAcceptance.env as Record<string, unknown>),
      VEHICLE_LINK_TEST_DATABASE_URL: '${{ env.DATABASE_URL }}',
      REQUIRE_VEHICLE_LINK_POSTGRES_TESTS: '1',
      MORTGAGE_PLAN_TEST_DATABASE_URL: '${{ env.DATABASE_URL }}',
      REQUIRE_MORTGAGE_PLAN_POSTGRES_TESTS: '1',
    };
    // The PR planner already owns the exact changed/deleted inventory. The
    // lint lane now consumes its typed selection instead of relinting the
    // entire checkout. Pin this deliberate post-migration behavior change.
    const planner = document.jobs[prValidationPlanning.id];
    const lintJob = document.jobs.lint;
    assert.ok(planner?.outputs && lintJob?.steps);
    planner.outputs.lint_plan = '${{ steps.plan.outputs.lint_plan }}';
    // A test-only helper now gets a compiler lane even when no production
    // source changed. This is an intentional post-migration output addition.
    planner.outputs.test_only_helpers_to_typecheck = '${{ steps.plan.outputs.test_only_helpers_to_typecheck }}';
    // Process-heavy test owners may be selected without all server shards.
    // The typed planner exposes that independent lane choice to the job and verdict.
    planner.outputs.process_heavy_required = '${{ steps.plan.outputs.process_heavy_required }}';
    const processHeavyJob = document.jobs['server-process-tests'];
    assert.ok(processHeavyJob);
    (processHeavyJob as Record<string, unknown>).if =
      `needs.${prValidationPlanning.id}.outputs.process_heavy_required == 'true' || `
      + `needs.${prValidationPlanning.id}.outputs.server_test_mode == 'full'`;
    const verdictStep = document.jobs.validate?.steps?.find(
      (step) => step.name === 'Require every selected validation lane',
    );
    assert.ok(verdictStep?.env);
    (verdictStep.env as Record<string, unknown>).PROCESS_HEAVY_REQUIRED =
      `needs.${prValidationPlanning.id}.outputs.process_heavy_required`;
    const lintInstall = lintJob.steps.find(step => step.name === 'Install Dependencies');
    const lintRun = lintJob.steps.find(step => step.name === 'Lint');
    assert.ok(lintInstall && lintRun);
    assert.equal(lintInstall.if, "needs.docs-change-gate.outputs.docs_only != 'true'");
    assert.equal(lintRun.run, 'npm run lint');
    const fallbackPlan = JSON.stringify({ mode: 'full', paths: [] });
    // The typed lint plan now skips the job before it consumes a Linux runner.
    // Keep the frozen migration fixture aligned with that intentional change.
    lintJob.if = "github.event.pull_request.draft == false "
      + "&& needs.docs-change-gate.result == 'success' "
      + "&& needs.docs-change-gate.outputs.docs_only != 'true' "
      + `&& fromJSON(needs.docs-change-gate.outputs.lint_plan || '${fallbackPlan}').mode != 'none'`;
    lintInstall.if = `fromJSON(needs.docs-change-gate.outputs.lint_plan || '${fallbackPlan}').mode != 'none'`;
    lintRun.name = 'Lint selected PR code';
    const lintPlanExpression = '$' + `{{ needs.docs-change-gate.outputs.lint_plan || '${fallbackPlan}' }}`;
    lintRun.env = { PR_LINT_PLAN: lintPlanExpression };
    lintRun.run = 'node ci/src/actions/runSelectedLint.ts';
    const aggregate = document.jobs.validate?.steps?.find(
      step => step.name === 'Require every selected validation lane',
    );
    assert.ok(aggregate);
    aggregate.env = { ...(aggregate.env as Record<string, unknown>), LINT_PLAN: lintPlanExpression };
    snapshot = dump(document).replaceAll('docs-change-gate', prValidationPlanning.id)
      .replaceAll('steps.detect.outputs.', `steps.${prValidationPlanning.inventory.id}.outputs.`)
      .replaceAll('DOCS_GATE:', `${prValidationPlanning.resultEnvironment}:`);
    addedSteps = Object.fromEntries(Object.entries(addedSteps).map(([id, steps]) => [
      id === 'docs-change-gate' ? prValidationPlanning.id : id,
      JSON.parse(JSON.stringify(steps).replaceAll('needs.docs-change-gate.', `needs.${prValidationPlanning.id}.`)),
    ]));
  }
  if (path === '.github/workflows/ios-tests.yml') {
    // This later exact-head ancestry repair gives the detector exact event
    // SHAs and reuses its checkout for the native selector on pull requests.
    const document = load(snapshot) as {
      jobs: Record<string, { steps?: Array<{ name?: string; if?: string; env?: Record<string, string> }> }>;
    };
    const gate = document.jobs['ios-change-gate'];
    const detect = gate?.steps?.find(step => step.name === 'Detect iOS Changes');
    const nativeCheckout = gate?.steps?.find(step => step.name === 'Checkout exact native test revision');
    assert.ok(detect?.env && nativeCheckout?.if);
    detect.env.IOS_AFFECTED_TESTS_BASE = "${{ github.event.pull_request.base.sha || '' }}";
    detect.env.IOS_AFFECTED_TESTS_HEAD = '${{ github.event.pull_request.head.sha || github.sha }}';
    nativeCheckout.if += " && github.event_name == 'workflow_dispatch'";
    snapshot = dump(document);
  }
  if (path !== '.github/workflows/pr-checks.yml') {
    // Every generated workflow gained the per-runner npm cache after its
    // migration; the hand-written snapshot predates it.
    const document = load(snapshot) as { env?: Record<string, unknown> };
    document.env = { ...document.env, ...RUNNER_NPM_CACHE_ENV };
    snapshot = dump(document);
  }
  const before = { ...normaliseWorkflow(snapshot, { root, renames }), ...expectedChanges };
  const after = normaliseWorkflow(migratedYaml(path), { root });
  assert.deepEqual(equivalenceIssues(before, after, { addedSteps }), []);
}

test('linux-runner-heartbeat keeps its job graph through the migration', () => {
  assertEquivalent('.github/workflows/linux-runner-heartbeat.yml', {}, {}, [
    {
      before: "vars.PR_CHECK_RUNNER_LABELS || '[\"self-hosted\",\"Linux\",\"linux-remote\"]'",
      after: "vars.PR_PORTABLE_RUNNER_LABELS || '[\"self-hosted\",\"Linux\",\"example-lane\",\"linux-remote\"]'",
      occurrences: 1,
      reason: 'the portable heartbeat now requests the shared positive worker selector',
    },
    {
      before: "vars.PR_DATABASE_RUNNER_LABELS || '[\"self-hosted\",\"Linux\",\"ARM64\",\"docker-capable\",\"linux-remote\"]'",
      after: "vars.PR_DATABASE_RUNNER_LABELS || '[\"self-hosted\",\"Linux\",\"example-lane\",\"ARM64\",\"docker-capable\",\"linux-remote\"]'",
      occurrences: 1,
      reason: 'the database heartbeat now requires the positive lane identity',
    },
  ]);
});

test('xcode-cloud-build-tags keeps its job graph through the migration', () => {
  assertEquivalent('.github/workflows/xcode-cloud-build-tags.yml', {
    // The checkout step says which revision it checks out, which is the name
    // the registry declared; the job itself is unchanged.
    Checkout: 'Checkout the workflow revision',
  }, {
    reconcile: [{
      name: 'Set up Node for typed maintenance',
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': '26.5.0', 'package-manager-cache': false },
    }],
  }, [{
    before: 'node scripts/reconcile-xcode-cloud-build-tags.mjs',
    after: 'node ci/src/actions/reconcileXcodeCloudBuildTags.ts',
    occurrences: 1,
    reason: 'the reconciler now executes from its typechecked TypeScript owner',
  }]);
});

test('video-review-writer keeps its job graph through the migration', () => {
  assertEquivalent('.github/workflows/video-review-writer.yml', {
    // The job had no name at all, so GitHub showed its id; it now says what
    // it publishes.
    consume: 'Publish advisory video review findings',
  }, {}, [{
    before: 'node scripts/consume-video-review.mjs',
    after: 'node ci/src/actions/consumeVideoReview.ts',
    occurrences: 1,
    reason: 'the video review writer now executes its typechecked TypeScript owner',
  }]);
});

test('actions-artifact-cleanup keeps its job graph through the migration', () => {
  // Its shell was inline, which needs nothing on disk; the extracted scripts
  // do, so this migration adds the checkout that puts them there.
  assertEquivalent('.github/workflows/actions-artifact-cleanup.yml', {}, {
    'prune-superseded-caches': [{
      name: 'Check out the cleanup scripts',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { 'persist-credentials': false, 'fetch-depth': 1 },
    }],
  });
});

test('install-runner-cleanup-hooks keeps its job graph through the migration', () => {
  // Same as actions-artifact-cleanup: extracted scripts need a checkout that
  // the inline form did not.
  assertEquivalent('.github/workflows/install-runner-cleanup-hooks.yml', {}, {
    'reconcile-host': [{
      name: 'Check out the dispatcher scripts',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { 'persist-credentials': false, 'fetch-depth': 1 },
    }, {
      name: 'Set up Node for typed maintenance',
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': '26.5.0', 'package-manager-cache': false },
    }],
  }, [{
    before: '      - scripts/await-log-line.sh',
    after: '      - ci/src/actions/awaitLogLine.ts\n      - ci/src/ios/shared/awaitLogLine.ts',
    occurrences: 1,
    reason: 'the shared log waiter is now TypeScript and both sources trigger maintenance',
  }, {
    before: '      - scripts/confirm-runner-activation.mjs',
    after: '      - ci/src/actions/confirmRunnerActivation.ts\n'
      + '      - ci/src/actions/removeOrphanActivationMarkers.ts',
    occurrences: 1,
    reason: 'runner activation maintenance tracks the strict TypeScript actions',
  }, {
    before: '      - scripts/audit-github-actions-runner-environment.sh',
    after: '      - ci/src/actions/auditRunnerEnvironment.ts',
    occurrences: 1,
    reason: 'runner maintenance tracks the strict TypeScript audit',
  }, {
    before: '      - scripts/github-actions-job-completed-hook.sh',
    after: '      - ci/src/runnerHooks/jobCompleted.ts\n'
      + '      - ci/src/actions/installJobCompletedHook.ts\n'
      + '      - scripts/ci/install-runner-cleanup-host/install/install-completed-job-cleanup-hook.sh',
    occurrences: 1,
    reason: 'the completed-job hook, its installer and the install step trigger maintenance',
  }, {
    before: '          - host_label: ios-host-sagaris\n            platform: macos\n',
    after: '          - host_label: ios-host-sagaris\n            platform: macos\n'
      + '          - host_label: ios-host-sagent\n            platform: macos\n'
      + '          - host_label: ios-host-tg1\n            platform: macos\n',
    occurrences: 1,
    reason: 'the maintained-host registry adds the sagent Mac listeners the fleet did not reach',
  }]);
});

const addedMaintenanceNode = {
  name: 'Set up Node for typed maintenance',
  uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  with: { 'node-version': '26.5.0', 'package-manager-cache': false },
};

test('runner-activation-complete keeps its job graph through the migration', () => {
  assertEquivalent('.github/workflows/runner-activation-complete.yml', {}, {
    'activation-complete': [addedMaintenanceNode],
  }, [{
    before: 'bash scripts/await-log-line.sh',
    after: 'node ci/src/actions/awaitLogLine.ts',
    occurrences: 1,
    reason: 'activation completion uses the shared TypeScript log waiter',
  }, {
    before: 'node scripts/confirm-runner-activation.mjs',
    after: 'node ci/src/actions/confirmRunnerActivation.ts',
    occurrences: 1,
    reason: 'activation completion executes its typechecked TypeScript owner',
  }, {
    before: 'bash scripts/audit-github-actions-runner-environment.sh',
    after: 'node ci/src/actions/auditRunnerEnvironment.ts',
    occurrences: 1,
    reason: 'activation completion audits the restarted listener with TypeScript',
  }, {
    before: '"ios-host-sagaris","host-instaip"',
    after: '"ios-host-sagaris","ios-host-sagent","ios-host-tg1","host-instaip"',
    occurrences: 1,
    reason: 'activation completion admits every host in the maintained-host registry',
  }, {
    before: '          export ACTIVATION_MARKER_PATH="$marker_root/${activation_label}.completed"\n',
    after: '          export ACTIVATION_MARKER_PATH="$marker_root/${activation_label}.completed"\n'
      + '          export ACTIVATION_LOG_PATH="$activation_log"\n',
    occurrences: 1,
    reason: 'a failed activation reports its host log, which only the completion job can read',
  }]);
});

test('install-runner-cleanup-host keeps its job graph through the migration', () => {
  assertEquivalent('.github/workflows/install-runner-cleanup-host.yml', {
    // The job says what it installs rather than abbreviating it, which is the
    // name the registry declared.
    'Install cleanup hook (${{ inputs.host_label }})': 'Install runner cleanup hook (${{ inputs.host_label }})',
  }, { install: [addedMaintenanceNode] }, [{
    before: 'bash "$GITHUB_WORKSPACE/scripts/await-log-line.sh"',
    after: 'node "$GITHUB_WORKSPACE/ci/src/actions/awaitLogLine.ts"',
    occurrences: 1,
    reason: 'activation handoff uses the shared TypeScript log waiter',
  }, {
    before: 'bash scripts/audit-github-actions-runner-environment.sh',
    after: 'node ci/src/actions/auditRunnerEnvironment.ts',
    occurrences: 1,
    reason: 'audit-only maintenance audits the active listener with TypeScript',
  }, {
    before: `                /usr/bin/env 'RUNNER_TRACKING_ID=' /bin/bash "$activation_script" \\\n`,
    after: `                /usr/bin/env 'RUNNER_TRACKING_ID=' \\\n`
      + '                "EXAMPLE_ACTIVATION_LAUNCHD_LABEL=com.example.${activation_label}" \\\n'
      + '                /bin/bash "$activation_script" \\\n',
    occurrences: 1,
    reason: 'the submitted launchd job removes itself, since launchd relaunches it on every exit',
  }, {
    before: '          activation_completed_marker="$marker_root/${activation_label}.completed"\n',
    after: '          activation_completed_marker="$marker_root/${activation_label}.completed"\n'
      + '          node "$GITHUB_WORKSPACE/ci/src/actions/removeOrphanActivationMarkers.ts" \\\n'
      + '            "$marker_root" "$HOST_LABEL" "$EXPECTED_PLATFORM"\n',
    occurrences: 1,
    reason: 'maintenance removes the unread markers earlier no-activation runs left behind',
  }, {
    before: '          install -d -m 0755 "$hook_root"\n'
      + '          install -m 0755 \\\n'
      + '            "$GITHUB_WORKSPACE/scripts/github-actions-job-completed-hook.sh" \\\n'
      + '            "$hook_path"\n',
    after: '          node "$GITHUB_WORKSPACE/ci/src/actions/installJobCompletedHook.ts" "$runner_root" "$hook_root"\n',
    occurrences: 1,
    reason: 'the completed-job hook is typed and installed behind a generated launcher',
  }, {
    before: '            marker_tmp="$(mktemp "${RUNNER_TEMP:?}/example-runner-activation.XXXXXX")"\n'
      + '            trap \'rm -f -- "$marker_tmp"\' EXIT\n'
      + '            printf \'{"schema":"example.runner-activation.v1","context":"%s","state":"success"}\\n\' \\\n'
      + '              "$ACTIVATION_CONTEXT" > "$marker_tmp"\n'
      + '            chmod 0644 "$marker_tmp"\n'
      + '            if [ "$EXPECTED_PLATFORM" = linux ]; then\n'
      + '              sudo -n install -o root -g root -m 0644 "$marker_tmp" "$activation_completed_marker"\n'
      + '              rm -f "$marker_tmp"\n'
      + '            else\n'
      + '              mv "$marker_tmp" "$activation_completed_marker"\n'
      + '            fi\n'
      + '            trap - EXIT\n',
    after: '',
    occurrences: 1,
    reason: 'no job reads a marker when no activation ran, so the installer no longer writes one',
  }]);
});

test('every generated workflow on disk matches its definition', () => {
  for (const definition of definitions) {
    assert.equal(
      readFileSync(definition.config.path, 'utf8'),
      generated(definition.config.path),
      `${definition.config.path} is stale; run npm run ci:workflows`,
    );
  }
});

test('every migrated workflow has a frozen pre-migration snapshot to prove it against', () => {
  for (const definition of definitions) {
    if (TYPED_NATIVE_WORKFLOWS.has(definition.config.path)) continue;
    const snapshot = join(SNAPSHOTS, definition.config.path.replace('.github/workflows/', ''));
    assert.doesNotThrow(
      () => readFileSync(join(root, snapshot), 'utf8'),
      `${definition.config.path} has no pre-migration snapshot at ${snapshot}`,
    );
  }
});

test('terminal cleanup has one typed job and no fleet reconciliation', () => {
  const workflow = load(generated('.github/workflows/cancel-blocked-pr-ci.yml')) as {
    on: Record<string, unknown>;
    jobs: Record<string, Readonly<Record<string, unknown>>>;
  };
  assert.deepEqual(Object.keys(workflow.jobs), ['cancel-blocked-pr-ci']);
  const cleanup = workflow.jobs['cancel-blocked-pr-ci'];
  assert.ok(cleanup !== undefined);
  assert.equal(cleanup.name, 'Cancel abandoned PR work');
  assert.equal(workflow.on.schedule, undefined);
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.on.repository_dispatch, undefined);
  assert.equal(workflow.on.workflow_dispatch, undefined);
  const steps = cleanup.steps as readonly { readonly name?: string; readonly uses?: string; readonly run?: string }[];
  const setupIndex = steps.findIndex(
    step => step.uses === 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  );
  const actionIndex = steps.findIndex(step => step.run === 'node ci/src/actions/cancelTerminalPrRuns.ts');
  assert.ok(setupIndex >= 0 && setupIndex < actionIndex);
});

test('promotion-checkpoint runs its trusted typed transaction in order', () => {
  const workflow = load(generated('.github/workflows/promotion-checkpoint.yml')) as {
    on: { pull_request_target: { branches: string[]; types: string[] } };
    jobs: Record<string, { steps: {
      name: string;
      uses?: string;
      run?: string;
      with?: Record<string, unknown>;
    }[] }>;
  };
  assert.deepEqual(Object.keys(workflow.jobs), ['checkpoint']);
  assert.deepEqual(workflow.on.pull_request_target.branches, ['main']);
  const steps = workflow.jobs.checkpoint?.steps;
  assert.ok(steps);
  assert.deepEqual(steps.map((step) => step.name), [
    'Check out the checkpoint transaction',
    'Set up Node.js for the typed transaction',
    'Install typed promotion transaction dependencies',
    'Create promotion GitHub App token',
    'Create immutable checkpoint pull request',
    'Summarize promotion checkpoint',
  ]);
  assert.equal(steps[0]?.with?.['persist-credentials'], false);
  assert.equal(steps[2]?.run, 'npm ci --prefix ci --no-audit --no-fund --ignore-scripts');
  assert.equal(steps[4]?.run, 'node ci/src/actions/createPromotionCheckpoint.ts');
  assert.equal(steps[5]?.run, 'node ci/src/actions/summarizePromotionCheckpoint.ts');
});

test('refresh-pr-ci-after-base-edit delegates terminal cleanup without job fan-out', () => {
  const document = load(generated('.github/workflows/refresh-pr-ci-after-base-edit.yml')) as {
    on: { push: { branches: string[] }; pull_request_target: { types: string[] } };
    concurrency: { group: string };
    jobs: Record<string, {
      if?: string;
      'runs-on'?: string[] | string;
      'timeout-minutes'?: number;
      permissions?: Record<string, string>;
      steps?: { name?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> }[];
    }>;
  };
  assert.deepEqual(Object.keys(document.jobs).sort(), [
    'cancel-conflicted-pr-ci',
    'cancel-obsolete-ios',
    'fan-out-base-update',
    'recheck-promotion-after-evidence',
    'resume-retained-ios',
    'route-initial-control',
  ]);
  assert.deepEqual(document.on.pull_request_target.types, ['synchronize', 'edited', 'ready_for_review']);
  assert.deepEqual(document.on.push.branches, ['develop', 'main']);
  const fanOut = document.jobs['fan-out-base-update'];
  assert.ok(fanOut);
  assert.equal(fanOut.permissions?.actions, 'read');
  const conflictCleanup = document.jobs['cancel-conflicted-pr-ci'];
  assert.ok(conflictCleanup);
  assert.deepEqual(conflictCleanup.permissions, { actions: 'write', contents: 'read', 'pull-requests': 'read' });
  assert.match(conflictCleanup.if ?? '', /^always\(\) && \(needs\.fan-out-base-update\.outputs\.conflicted_pull_requests != ''/);
  const conflictStep = conflictCleanup.steps?.find((step) => step.name === 'Cancel validation of conflicted pull requests');
  assert.equal(conflictStep?.env?.CI_WORKFLOW_NAMES, 'PR Checks,Test - iOS');
  assert.match(conflictStep?.env?.CONFLICTED_PULL_REQUESTS ?? '', /needs\.cancel-obsolete-ios\.outputs\.conflicted_pull_requests/);
  assert.equal(fanOut.if, "always() && !cancelled() && (github.event_name == 'push')");
  const continuity = document.jobs['cancel-obsolete-ios'];
  assert.ok(continuity);
  for (const id of Object.keys(document.jobs)) {
    assert.match(String(document.jobs[id]?.['runs-on']), id === 'route-initial-control'
      ? /CI_HOSTED_LINUX_AVAILABLE/ : /needs\.route-initial-control\.outputs\.control_runner_labels/, id);
  }
  assert.match(continuity.if ?? '', /event_name == 'pull_request_target'/);
  assert.match(continuity.if ?? '', /event\.action == 'synchronize'/);
  assert.match(continuity.if ?? '', /head\.repo\.full_name == github\.repository/);
  assert.match(continuity.if ?? '', /event\.action == 'synchronize' \|\|/);
  assert.match(continuity.if ?? '', /event\.action == 'ready_for_review'/);
  assert.match(continuity.if ?? '', /vars\.CI_RETARGET_RECOVERY_ENABLED == 'true'/);
  assert.match(continuity.if ?? '', /event\.action == 'edited'.*draft == false/);
  assert.equal(continuity['timeout-minutes'], 10);
  assert.equal(
    continuity.steps?.find((step) => step.name === 'Cancel obsolete active iOS work')?.if,
    "steps.ci-deps.outcome == 'success' && ((github.event.action == 'synchronize' "
      + "&& github.event.pull_request.draft == false) || (github.event.action == 'edited' "
      + '&& github.event.changes.base != null))',
  );
  assert.equal(continuity.permissions?.actions, 'write');
  assert.equal(continuity.permissions?.checks, 'read');
  const updateStepName = 'Update overlapping pull requests';
  for (const job of [fanOut, continuity]) {
    const update = job.steps?.find((step) => step.name === updateStepName);
    assert.ok(update);
    assert.equal(update.env?.REPOSITORY, '${{ github.repository }}');
    assert.equal(update.env?.BASE_BRANCH, undefined);
    assert.equal(update.env?.BEFORE_SHA, undefined);
    assert.equal(update.env?.AFTER_SHA, undefined);
  }
  const continuityUpdate = continuity.steps?.find((step) => step.name === updateStepName);
  assert.equal(
    continuityUpdate?.if,
    "always() && github.event.action == 'synchronize' && steps.update-token.outcome == 'success'",
  );
  assert.equal(
    continuity.steps?.find((step) => step.name === 'Install typed planner dependencies')?.if,
    "always() && (github.event.action == 'synchronize' || (github.event.action == 'edited' "
      + "&& github.event.changes.base != null) || (github.event.action == 'ready_for_review' "
      + "&& vars.CI_RETARGET_RECOVERY_ENABLED == 'true'))",
  );
  const cancelIndex = continuity.steps?.findIndex((step) => step.name === 'Cancel obsolete active iOS work');
  const updateIndex = continuity.steps?.findIndex((step) => step.name === updateStepName);
  assert.ok(cancelIndex !== undefined && updateIndex !== undefined && cancelIndex < updateIndex);
  assert.equal(fanOut.steps?.some((step) => step.name === 'Create scoped retarget recovery token'), false);
  assert.equal(fanOut.steps?.find((step) => step.name === 'Create scoped pull-request update token')?.with?.['permission-workflows'],
    'write');
  assert.equal(continuity.steps?.some((step) => step.name === 'Install retarget recovery dependencies'), false);
  assert.equal(continuity.steps?.find((step) => step.name === 'Create scoped retarget recovery token')?.if,
    "always() && steps.ci-deps.outcome == 'success' && ((github.event.action == 'edited' "
      + "&& github.event.changes.base != null) || (github.event.action == 'ready_for_review' "
      + "&& vars.CI_RETARGET_RECOVERY_ENABLED == 'true'))");
  assert.deepEqual(
    continuity.steps?.find((step) => step.name === 'Create scoped retarget recovery token')?.with,
    fanOut.steps?.find((step) => step.name === 'Create scoped pull-request update token')?.with,
    'retarget recovery must use the installed branch-update App capabilities',
  );
  assert.equal(continuity.steps?.find((step) => step.name === 'Create scoped retarget recovery token')?.with?.['permission-pull-requests'],
    'write');
  assert.equal(continuity.steps?.find((step) => step.name === 'Create scoped retarget recovery token')?.with?.['permission-workflows'],
    'write');
  assert.equal(continuity.steps?.find((step) => step.name === 'Recover a retargeted PR integration candidate')?.if,
    "always() && steps.retarget-token.outcome == 'success'");
  assert.doesNotMatch(document.concurrency.group, /action == 'closed'|closed-\{0\}/);
});

test('pr-checks keeps its job graph through the migration', () => {
  const receiptDirectory = '${{ runner.temp }}/linux-shard-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.shard }}';
  const receiptEnv = {
    RECEIPT_DIRECTORY: receiptDirectory,
    PR_NUMBER: '${{ github.event.pull_request.number }}',
    PR_BASE_SHA: '${{ github.event.pull_request.base.sha }}',
    PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    PR_HEAD_REPOSITORY: '${{ github.event.pull_request.head.repo.full_name }}',
    SHARD: '${{ matrix.shard }}',
    RECEIPT_WORKFLOW_SHA: '${{ github.workflow_sha }}',
    RECEIPT_RUNNER_ENVIRONMENT: '${{ runner.environment }}',
  };
  assertEquivalent('.github/workflows/pr-checks.yml', {
    // The two required contexts. `lint` and `validate` are bare verbs that
    // say nothing about what failed, and neither can be a job name under the
    // readability rule; these are the names the registry already declared.
    // The branch protection on develop and main lists the old spellings, so
    // this rename lands with the protection edit, not before it.
    lint: 'Lint changed code',
    validate: 'Validate pull request changes',
    // The database lane had no name at all, so GitHub showed its job id.
    'database-integration': 'Run database integration tests',
    // "Validation policy" is a noun phrase that names a document rather than
    // the work; the registry's name says what the job does with it.
    'Validation policy': 'Evaluate PR validation policy',
    // Seven step names repeated across the lanes, each too generic to act on
    // and each already named by the registry. Four of the spellings on the
    // left are steps that carried no `name:` at all, so GitHub labelled them
    // by what they ran; that label is what the rename replaces.
    Checkout: 'Checkout the workflow revision',
    'Setup Node': 'Set up the Node.js runtime',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020': 'Set up the Node.js runtime',
    'Install Dependencies': 'Install Node.js dependencies',
    'Install dependencies': 'Install Node.js dependencies',
    'actions/setup-node': 'Set up the Node.js runtime',
    'node ci/src/actions/installNodeDependencies.ts': 'Install Node.js dependencies',
    Lint: 'Lint changed code',
    'Type check': 'Check TypeScript types',
    'npm run test:process-heavy': 'Run server process-heavy tests',
    'Run changed integration tests': 'Run selected database acceptance tests',
    [[
      'npx vitest run --config server/vitest.config.ts',
      'server/tests/*Contract.test.ts',
      'server/tests/*TypesSync.test.ts',
      'server/tests/budgetRequestTypes.test.ts',
      'server/tests/budgetCategoryEnums.test.ts',
      'server/tests/chatDataTypeRegistry.test.ts',
      'server/tests/dashboardGeneratedTypes.test.ts',
    ].join(' ')]: 'Run iOS-server contract tests',
  }, {
    // Receipt-only additions do not alter the native command or required verdict.
    'server-tests': [{
      name: 'Capture server shard execution inputs',
      id: 'capture-shard-inputs', 'continue-on-error': true,
      run: 'node ci/src/actions/recordLinuxShardReceipt.ts',
      env: { ...receiptEnv, RECEIPT_PHASE: 'prepare' },
    }, {
      name: 'Record successful server shard receipt',
      id: 'complete-shard-receipt', 'continue-on-error': true,
      if: "success() && steps.native-shard.outcome == 'success' && steps.capture-shard-inputs.outcome == 'success'",
      run: 'node ci/src/actions/recordLinuxShardReceipt.ts',
      env: { ...receiptEnv, RECEIPT_PHASE: 'complete', SHARD_OUTCOME: '${{ steps.native-shard.outcome }}' },
    }],
    'server-static': [{
      name: 'Type-check changed server test helpers',
      if: "needs.plan-pr-validation.outputs.test_only_helpers_to_typecheck != '' && needs.plan-pr-validation.outputs.test_only_helpers_to_typecheck != '[]'",
      env: { TEST_ONLY_HELPERS_JSON: '${{ needs.plan-pr-validation.outputs.test_only_helpers_to_typecheck }}' },
      run: 'node ci/src/actions/typecheckChangedTestHelpers.ts',
    }],
    // Three jobs ran shell that needed nothing on disk and so checked nothing
    // out. The extracted scripts do need a workspace, and each addition puts
    // it there from the same revision the job already ran code from: the
    // trusted base for the gate, the revision under review for the other two.
    'docs-change-gate': [{
      id: 'trusted-gate-source',
      name: 'Check out the trusted base gate scripts',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        ref: '${{ github.event.repository.default_branch }}',
        'persist-credentials': false,
        'sparse-checkout': 'scripts\nci/src\n',
      },
    }, {
      name: 'Check out missing gate adapters from the resolved trusted revision',
      if: "(hashFiles('ci/src/actions/selectPrDeletionInventory.ts') == '' || hashFiles('ci/src/actions/loadPrRuntimeManifest.ts') == '' || hashFiles('ci/src/actions/runTrustedPrPlanner.ts') == '' || hashFiles('ci/src/actions/explainCalculationAssurance.ts') == '' || hashFiles('ci/src/actions/collectPrChangeInventory.ts') == '') && steps.trusted-gate-source.outputs.commit != ''",
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        ref: '${{ steps.trusted-gate-source.outputs.commit }}',
        path: '.ci/trusted-gate-scripts',
        'persist-credentials': false,
        'sparse-checkout': 'ci\nscripts\n',
      },
    }, {
      name: 'Install missing gate adapter dependencies',
      if: "(hashFiles('ci/src/actions/selectPrDeletionInventory.ts') == '' || hashFiles('ci/src/actions/loadPrRuntimeManifest.ts') == '' || hashFiles('ci/src/actions/runTrustedPrPlanner.ts') == '' || hashFiles('ci/src/actions/explainCalculationAssurance.ts') == '' || hashFiles('ci/src/actions/collectPrChangeInventory.ts') == '') && steps.trusted-gate-source.outputs.commit != ''",
      run: 'npm ci --prefix .ci/trusted-gate-scripts/ci --no-audit --no-fund --ignore-scripts',
    }],
    'database-integration': [{
      name: 'Check out the database container scripts',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { 'persist-credentials': false, 'sparse-checkout': '.github/actions/typed-step-runner\nci/src\n' },
    }],
    // The dashboard reader regression suite was added after the migration.
    'ios-contracts': [{
      name: 'Test dashboard manual account generation',
      run: 'node --test ci/tests/dashboardManualAccountGeneration.test.ts',
    }],
    validate: [{
      name: 'Check out the typed validation verdict',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: {
        ref: '${{ needs.plan-pr-validation.outputs.trusted_policy_sha || github.event.pull_request.base.sha }}',
        'persist-credentials': false,
        'sparse-checkout': 'ci/src\n',
      },
    }, {
      name: 'Setup Node for the typed validation verdict',
      uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      with: { 'node-version': '26.5.0', 'package-manager-cache': false },
    }],
  }, [
    {
      before: '          CONTROLLER_BASE_UPDATE_WORKFLOWS: PR Checks\n          BASE_SHA: ${{ github.event.pull_request.base.sha }}',
      after: "          CONTROLLER_BASE_UPDATE_WORKFLOWS: PR Checks\n          BASE_SHA: ${{ github.event.pull_request.base.ref == 'main' && github.event.pull_request.head.repo.full_name == github.repository && steps.trusted-gate-source.outputs.commit || github.event.pull_request.base.sha }}",
      occurrences: 1,
      reason: 'the base-update classifier verifies the trusted checkout SHA, including the develop policy checkout for promotions',
    },
    {
      before: '      - name: Install dependencies\n        run: bash scripts/install-node-dependencies.sh\n      - name: Validate workflow contracts',
      after: '      - name: Install dependencies\n        run: node ci/src/actions/installWorkflowContractDependencies.ts\n      - name: Validate workflow contracts',
      occurrences: 1,
      reason: 'workflow contracts install the small CI package instead of cloning full app dependencies',
    },
    {
      before: 'run: bash scripts/install-node-dependencies.sh',
      after: 'run: node ci/src/actions/installNodeDependencies.ts',
      occurrences: 7,
      reason: 'the shared dependency cache installer is now a typed Node entry point',
    },
    {
      before: 'bash scripts/install-workflow-linters.sh >> "$GITHUB_PATH"',
      after: 'node ci/src/actions/installWorkflowLinters.ts',
      occurrences: 1,
      reason: 'checksum-pinned workflow linter installation now runs from strict TypeScript',
    },
    {
      // #5842 fixes a diagnostic-prefix collision after extraction. Preserve the
      // frozen fixture and allow only this exact, separately exercised correction.
      before: `          grep -F 'plaid_scheduler_runs.id' "$verifier_log"`,
      after: [
        '          # Match the column name, not the prefix of idx_plaid_scheduler_runs_status_expiry.',
        `          grep -Fw 'plaid_scheduler_runs.id' "$verifier_log"`,
      ].join('\n'),
      occurrences: 1,
      reason: 'the Plaid scheduler verifier must match the exact column name',
    },
    {
      before: "github.event.pull_request.head.repo.full_name == github.repository && (vars.CI_CONTROL_RUNNER_LABELS || '[\"ubuntu-24.04\"]') || '[\"ubuntu-24.04\"]'",
      after: "github.event.pull_request.head.repo.full_name == github.repository && '[\"self-hosted\",\"Linux\",\"example-trusted-control\"]' || '[\"ubuntu-24.04\"]'",
      occurrences: 4,
      reason: 'same-repository controls now use the dedicated trusted-control role',
    },
    {
      before: 'ref: ${{ github.event.repository.default_branch }}\n          persist-credentials: false\n\n      - name: Select free external capacity or hosted overflow',
      after: 'ref: ${{ github.event.pull_request.base.sha }}\n          persist-credentials: false\n\n      - name: Select free external capacity or hosted overflow',
      occurrences: 1,
      reason: 'the selector is loaded from the exact trusted base revision',
    },
    {
      before: "          PR_CHECK_RUNNER_LABELS: ${{ vars.PR_CHECK_RUNNER_LABELS || '[\"self-hosted\",\"Linux\",\"linux-remote\"]' }}",
      after: [
        '          REPOSITORY_DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}',
        "          PR_PORTABLE_RUNNER_LABELS: ${{ vars.PR_PORTABLE_RUNNER_LABELS || '[\"self-hosted\",\"Linux\",\"example-lane\",\"linux-remote\"]' }}",
      ].join('\n'),
      occurrences: 1,
      reason: 'the typed selector receives the default branch and positive portable route',
    },
    {
      before: "          PR_DATABASE_RUNNER_LABELS: ${{ vars.PR_DATABASE_RUNNER_LABELS || '[\"self-hosted\",\"Linux\",\"ARM64\",\"docker-capable\",\"linux-remote\"]' }}",
      after: "          PR_DATABASE_RUNNER_LABELS: ${{ vars.PR_DATABASE_RUNNER_LABELS || '[\"self-hosted\",\"Linux\",\"example-lane\",\"ARM64\",\"docker-capable\",\"linux-remote\"]' }}",
      occurrences: 1,
      reason: 'the database selector requires the positive lane identity',
    },
    {
      before: "          PR_CHECK_RUNNER_LABELS_FALLBACK: ${{ vars.PR_CHECK_RUNNER_LABELS_FALLBACK || '[\"ubuntu-24.04\"]' }}\n",
      after: '',
      occurrences: 1,
      reason: 'hosted routing now comes only from typed admission evidence',
    },
    {
      before: "          PR_LINUX_EXTERNAL_CAPACITY: ${{ vars.PR_LINUX_EXTERNAL_CAPACITY || '2' }}\n",
      after: '',
      occurrences: 1,
      reason: 'capacity is inferred from role-specific active work and heartbeats',
    },
    {
      before: "          CI_HOSTED_LINUX_AVAILABLE: ${{ vars.CI_HOSTED_LINUX_AVAILABLE || '1' }}",
      after: "          CI_HOSTED_LINUX_AVAILABLE: ${{ vars.CI_HOSTED_LINUX_AVAILABLE || '0' }}",
      occurrences: 1,
      reason: 'an absent hosted policy setting fails closed',
    },
    {
      before: [
        '        run: |',
        '          if [ "$CI_HOSTED_LINUX_AVAILABLE" = "0" ] && [ "$PR_HEAD_REPOSITORY" = "$GITHUB_REPOSITORY" ]; then',
        "            echo '::notice::Hosted Linux admission is unavailable; queueing validation on trusted external Linux.'",
        '            {',
        '              echo "pr_linux_runner_labels=$PR_CHECK_RUNNER_LABELS"',
        '              echo "pr_database_runner_labels=$PR_DATABASE_RUNNER_LABELS"',
        '              echo "pr_linux_overflow_labels=$PR_CHECK_RUNNER_LABELS"',
        '            } >> "$GITHUB_OUTPUT"',
        '          elif [ -f scripts/select-pr-linux-runners.mjs ]; then',
        '            node scripts/select-pr-linux-runners.mjs',
        "            if ! grep -q '^pr_linux_overflow_labels=' \"$GITHUB_OUTPUT\"; then",
        "              echo '::notice::Trusted selector predates overflow output; using hosted Linux overflow.'",
        '              echo "pr_linux_overflow_labels=$PR_CHECK_RUNNER_LABELS_FALLBACK" >> "$GITHUB_OUTPUT"',
        '            fi',
        '          else',
        "            echo '::notice::Trusted runner selector is not on develop yet; using hosted Linux for bootstrap.'",
        '            {',
        "              echo 'pr_linux_runner_labels=[\"ubuntu-24.04\"]'",
        "              echo 'pr_database_runner_labels=[\"ubuntu-24.04\"]'",
        "              echo 'pr_linux_overflow_labels=[\"ubuntu-24.04\"]'",
        '            } >> "$GITHUB_OUTPUT"',
        '          fi',
      ].join('\n'),
      after: '        run: node ci/src/actions/selectPrLinuxRunners.ts',
      occurrences: 1,
      reason: 'the activation replaces the compatibility shell with the typed selector',
    },
    {
      before: '          scripts/tests/select-pr-linux-runners.test.mjs\n',
      after: '',
      occurrences: 1,
      reason: 'the typed CI suite now owns selector behavior coverage',
    },
    {
      before: '          scripts/tests/workflow-runner-configuration.test.mjs\n          scripts/tests/dev-e2e-schema-revision-gate.test.mjs',
      after: '          scripts/tests/workflow-runner-configuration.test.mjs\n          scripts/tests/github-actions-job-completed-hook.test.mjs\n          scripts/tests/dev-e2e-schema-revision-gate.test.mjs',
      occurrences: 1,
      reason: 'the workflow contract lane now owns the completed-job hook contract',
    },
    {
      before: 'node scripts/run-targeted-server-tests.mjs',
      after: 'node ci/src/actions/runTargetedServerTests.ts',
      occurrences: 3,
      reason: 'targeted server execution now uses its typechecked TypeScript owner',
    },
  ], {
    // Post-migration behavior change: one PR keeps one concurrency group as
    // its head advances, allowing cancel-in-progress to supersede stale work.
    concurrency: {
      'cancel-in-progress': true,
      group: "pr-checks-${{ github.event.pull_request.number || github.ref }}",
    },
  });
});

test('trusted-production-onboarding-e2e keeps its job graph through the migration', () => {
  // The ref validation job was entirely inline shell, which needs nothing on
  // disk; its two checks are now scripts, so the job gains the checkout that
  // puts them there. The other two jobs already checked out.
  assertEquivalent('.github/workflows/trusted-production-onboarding-e2e.yml', {}, {
    'validate-trusted-ref': [{
      name: 'Check out the trusted validation scripts',
      uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      with: { 'fetch-depth': 1, 'persist-credentials': false },
    }],
  }, [{
    before: 'node scripts/review-onboarding-video.mjs',
    after: 'node ci/src/actions/reviewOnboardingVideo.ts',
    occurrences: 1,
    reason: 'production video review executes its typechecked TypeScript owner',
  }, {
    before: 'bash scripts/select-xcode.sh 26.6@17F113 27.0@27A266a',
    after: 'node ci/src/actions/ios/selectXcode.ts 27.0@27A266a',
    occurrences: 1,
    reason: 'Xcode selection executes its typechecked TypeScript owner, pinned to one Xcode build',
  }]);
});

test('advisory iOS artifact cleanup cannot queue ahead of the required verdict', () => {
  const workflow = load(generated('.github/workflows/ios-tests.yml')) as {
    jobs: Record<string, { needs?: string[]; 'continue-on-error'?: boolean }>;
  };
  const verdict = workflow.jobs['test-ios'];
  const cleanup = workflow.jobs['remove-run-artifacts-after-success'];
  assert.ok(verdict?.needs);
  assert.ok(cleanup?.needs);
  assert.ok(cleanup.needs.includes('test-ios'));
  assert.equal(verdict.needs.includes('remove-run-artifacts-after-success'), false);
  assert.equal(cleanup['continue-on-error'], true);
});

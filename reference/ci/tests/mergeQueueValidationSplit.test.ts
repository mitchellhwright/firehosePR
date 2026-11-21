import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { validationDepth, type ValidationDepth } from '../src/ciEvent.ts';
import {
  auxiliaryLanePaths,
  IOS_E2E_AUXILIARY_LANES,
  type IosE2eAuxiliaryLane,
} from '../src/ios/iosChangeClassification.ts';
import {
  completeIosChangeDetection,
  planIosChangeDetection,
  type GateContext,
} from '../src/ios/iosChangeGate.ts';
import { deriveNativeTestLaneStatus } from '../src/ios/nativeTestLaneStatus.ts';
import { deriveNativeExecutionPlan, type NativeExecutionInput } from '../src/nativeExecutionPlan.ts';
import {
  derivePrValidationPlan,
  planForValidationDepth,
  type PrValidationInput,
  type PrValidationPlan,
} from '../src/prValidationPlan.ts';
import { prValidationVerdict, validationLaneNames, type ValidationLane } from '../src/prValidationVerdict.ts';

/**
 * The historical PR-versus-queue split (docs/ci/merge-queue-plan.md) still
 * shapes server validation. Real-server iOS E2E must run when selected on a
 * PR because develop currently has no merge queue candidate.
 */

const runtimeManifest: unknown = JSON.parse(
  readFileSync('ci/contracts/server-test-runtimes.json', 'utf8'),
);

const source = 'server/services/example/exampleService.ts';
const sourceTest = 'server/tests/exampleService.test.ts';

/** A server source change whose import graph reaches one of 100 unit tests. */
function narrowServerChange(extraFiles: readonly string[] = []): PrValidationInput {
  return {
    changedFiles: [source, ...extraFiles],
    metadataOnly: false,
    serverSourceImpact: {
      ownedSources: [source],
      affectedUnitTests: [sourceTest],
      affectedIntegrationTests: [],
      totalUnitTests: 100,
    },
  };
}

function plan(input: PrValidationInput, depth: ValidationDepth): PrValidationPlan {
  return planForValidationDepth(derivePrValidationPlan(input, runtimeManifest), depth);
}

/** The lane results GitHub reports when every job the plan selected ran and passed. */
function resultsFor(selected: PrValidationPlan): Record<ValidationLane, string> {
  const ran: Record<ValidationLane, boolean> = {
    'plan-pr-validation': true,
    lint: true,
    'validation-policy': selected.policyRequired,
    'workflow-contracts': selected.workflowContractsRequired,
    'server-static': selected.serverStaticRequired,
    'server-process-tests': selected.processHeavyRequired || selected.serverTestMode === 'full',
    'server-tests': selected.serverTestMode === 'full',
    'targeted-server-tests': selected.serverTestMode === 'targeted',
    'ios-contracts': selected.iosContractsRequired,
    'database-integration': selected.databaseRequired,
  };
  return Object.fromEntries(validationLaneNames.map((lane) => [
    lane, ran[lane] ? 'success' : 'skipped',
  ])) as Record<ValidationLane, string>;
}

function verdictErrors(
  selected: PrValidationPlan,
  results: Record<ValidationLane, string>,
): string[] {
  return prValidationVerdict({
    results,
    docsOnly: String(selected.docsOnly),
    lintPlan: { mode: 'full', paths: [] },
    metadataOnly: String(selected.metadataOnly),
    policyRequired: String(selected.policyRequired),
    workflowContractsRequired: String(selected.workflowContractsRequired),
    serverStaticRequired: String(selected.serverStaticRequired),
    serverTestMode: selected.serverTestMode,
    processHeavyRequired: String(selected.processHeavyRequired),
    iosContractsRequired: String(selected.iosContractsRequired),
    databaseRequired: String(selected.databaseRequired),
  });
}

describe('validationDepth', () => {
  it('lightens only a pull request into the merge queue branch', () => {
    assert.equal(validationDepth('pull_request', 'develop'), 'pull-request');
    assert.equal(validationDepth('merge_group', 'develop'), 'complete');
    assert.equal(validationDepth('pull_request', 'main'), 'complete', 'promotions run everything');
    assert.equal(validationDepth('workflow_dispatch', ''), 'complete');
  });

  it('fails safe to the complete suites when the event inputs are missing', () => {
    assert.equal(validationDepth('', ''), 'complete');
    assert.equal(validationDepth('pull_request', ''), 'complete');
  });
});

describe('server validation per event', () => {
  it('runs targeted tests, static validation and lint on the pull request', () => {
    const head = plan(narrowServerChange(), 'pull-request');
    assert.equal(head.validationDepth, 'pull-request');
    assert.equal(head.serverTestMode, 'targeted');
    assert.deepEqual(head.targetedServerTests, [sourceTest]);
    assert.equal(head.serverStaticRequired, true);
    assert.equal(head.processHeavyRequired, false);
    assert.equal(head.databaseRequired, false);
  });

  it('runs the four shards, process-heavy suites and database lane on the queue candidate', () => {
    const candidate = plan(narrowServerChange(), 'complete');
    assert.equal(candidate.serverTestMode, 'full');
    assert.deepEqual(candidate.targetedServerTests, []);
    assert.equal(candidate.processHeavyRequired, true);
    assert.equal(candidate.databaseRequired, true);
  });

  it('keeps the iOS contract lane on both sides of a mixed server and iOS change', () => {
    const mixed = narrowServerChange(['ios/example-ios/UI/Cards/Budget/BudgetView.swift']);
    const head = plan(mixed, 'pull-request');
    const candidate = plan(mixed, 'complete');
    assert.equal(head.serverTestMode, 'targeted');
    assert.equal(head.iosContractsRequired, true);
    assert.equal(head.databaseRequired, false);
    assert.equal(candidate.serverTestMode, 'full');
    assert.equal(candidate.iosContractsRequired, true);
    assert.equal(candidate.databaseRequired, true);
  });

  it('falls back to the full suite on the pull request when impact is unknown', () => {
    // No import graph owns a lockfile change, so targeted selection cannot narrow it.
    const head = plan({ changedFiles: ['package-lock.json'], metadataOnly: false }, 'pull-request');
    assert.equal(head.serverTestMode, 'full');
    assert.equal(head.processHeavyRequired, true, 'the verdict requires process suites with full');
    assert.equal(head.databaseRequired, false, 'the database lane stays with the queue candidate');
  });

  it('falls back to the full suite on the pull request when verified impact is broad', () => {
    const broad = narrowServerChange();
    const head = plan({
      ...broad,
      serverSourceImpact: {
        ownedSources: [source],
        affectedUnitTests: [sourceTest],
        affectedIntegrationTests: [],
        totalUnitTests: 4,
      },
    }, 'pull-request');
    assert.equal(head.serverTestMode, 'full');
  });

  it('keeps an infrastructure-only contract targeted on the queue candidate too', () => {
    const terraform = { changedFiles: ['terraform/platform/main.tf'], metadataOnly: false };
    assert.equal(plan(terraform, 'pull-request').serverTestMode, 'targeted');
    assert.equal(plan(terraform, 'complete').serverTestMode, 'targeted');
  });

  it('keeps a process-heavy test the change selected for the queue candidate only', () => {
    const processHeavy = { changedFiles: ['server/tests/dateWindowTimezone.test.ts'], metadataOnly: false };
    assert.equal(derivePrValidationPlan(processHeavy, runtimeManifest).processHeavyRequired, true);
    assert.equal(plan(processHeavy, 'pull-request').processHeavyRequired, false);
    assert.equal(plan(processHeavy, 'complete').processHeavyRequired, true);
  });

  it('leaves the depth unset until the event is applied', () => {
    const impact = derivePrValidationPlan(narrowServerChange(), runtimeManifest);
    assert.equal(impact.validationDepth, undefined);
    assert.equal(impact.serverTestMode, 'targeted');
    assert.equal(plan(narrowServerChange(), 'complete').validationDepth, 'complete');
  });
});

describe('queue candidate server selection per impact kind', () => {
  const integrationTest = 'server/tests/dashboardCashflowEndpoints.integration.test.ts';
  const integrationOwnedSource = 'server/services/example/integrationOnlyService.ts';
  const cases: readonly {
    readonly kind: string;
    readonly input: PrValidationInput;
    readonly application: boolean;
    readonly database: boolean;
  }[] = [
    { kind: 'unit-owned source', input: narrowServerChange(), application: true, database: true },
    {
      kind: 'integration test only',
      input: { changedFiles: [integrationTest], metadataOnly: false },
      application: true,
      database: true,
    },
    {
      kind: 'source owned only by integration tests',
      input: {
        changedFiles: [integrationOwnedSource],
        metadataOnly: false,
        serverSourceImpact: {
          ownedSources: [integrationOwnedSource],
          affectedUnitTests: [],
          affectedIntegrationTests: [integrationTest],
          totalUnitTests: 100,
        },
      },
      application: true,
      database: true,
    },
    {
      kind: 'process-heavy test only',
      input: { changedFiles: ['server/tests/dateWindowTimezone.test.ts'], metadataOnly: false },
      application: true,
      database: false,
    },
    {
      kind: 'documentation only',
      input: { changedFiles: ['docs/ci/merge-queue-plan.md'], metadataOnly: false },
      application: false,
      database: false,
    },
  ];

  for (const { kind, input, application, database } of cases) {
    it(`${kind}: ${application ? 'runs' : 'never runs'} the full shards in the queue`, () => {
      const impact = derivePrValidationPlan(input, runtimeManifest);
      assert.equal(impact.applicationTestImpact, application);
      const candidate = planForValidationDepth(impact, 'complete');
      assert.equal(candidate.serverTestMode === 'full', application);
      assert.equal(candidate.processHeavyRequired, application);
      assert.equal(candidate.databaseRequired, database);
      assert.deepEqual(verdictErrors(candidate, resultsFor(candidate)), []);
      const head = planForValidationDepth(impact, 'pull-request');
      assert.equal(head.databaseRequired, false);
    });
  }
});

describe('Validate pull request changes per event', () => {
  it('passes on the pull request with the heavy lanes skipped', () => {
    const head = plan(narrowServerChange(), 'pull-request');
    const results = resultsFor(head);
    assert.equal(results['server-tests'], 'skipped');
    assert.equal(results['database-integration'], 'skipped');
    assert.deepEqual(verdictErrors(head, results), []);
  });

  it('fails the queue candidate unless the heavy lanes executed', () => {
    const candidate = plan(narrowServerChange(), 'complete');
    assert.deepEqual(verdictErrors(candidate, resultsFor(candidate)), []);
    const headResults = resultsFor(plan(narrowServerChange(), 'pull-request'));
    assert.deepEqual(verdictErrors(candidate, headResults), [
      'Selected validation lane server-process-tests ended with: skipped',
      'Selected validation lane server-tests ended with: skipped',
      'Selected validation lane database-integration ended with: skipped',
    ]);
  });
});

const fullNativeSelection: NativeExecutionInput = {
  selectionMode: 'full',
  selectionRequired: true,
  releaseArchiveRequired: true,
  onlyTestingIdentifiers: [],
  evidenceGroups: [],
  narrowPaywallRequired: false,
  forcedLanes: [],
};

describe('native iOS plan per event', () => {
  it('builds and runs the unit partition but defers the full UI suite and archive on the pull request', () => {
    const head = deriveNativeExecutionPlan({ ...fullNativeSelection, validationDepth: 'pull-request' });
    assert.equal(head.producerMode, 'unit-preflight');
    assert.equal(head.uiRequired, false);
    assert.deepEqual(head.executionLanes, []);
    assert.equal(head.releaseArchiveRequired, false);
    assert.ok(head.reasons.includes('full UI suite deferred to the merge queue candidate'));
    assert.ok(head.reasons.includes('Release archive deferred to the merge queue candidate'));
  });

  it('runs every native lane and the Release archive on the queue candidate', () => {
    const candidate = deriveNativeExecutionPlan({ ...fullNativeSelection, validationDepth: 'complete' });
    assert.equal(candidate.producerMode, 'shared-products');
    assert.deepEqual(candidate.executionLanes, ['native1', 'native2', 'native3', 'native4']);
    assert.equal(candidate.releaseArchiveRequired, true);
  });

  it('keeps affected UI selection on the pull request', () => {
    const head = deriveNativeExecutionPlan({
      ...fullNativeSelection,
      selectionMode: 'affected',
      onlyTestingIdentifiers: ['example-iosUITests/BudgetUITests/testBudgetLoads'],
      validationDepth: 'pull-request',
    });
    assert.equal(head.producerMode, 'shared-products');
    assert.deepEqual(head.executionLanes, ['native1']);
    assert.equal(head.releaseArchiveRequired, false);
  });

  it('keeps a retained predecessor lane forced on the pull request', () => {
    const head = deriveNativeExecutionPlan({
      ...fullNativeSelection, forcedLanes: ['native3'], validationDepth: 'pull-request',
    });
    assert.deepEqual(head.executionLanes, ['native3']);
  });
});

describe('Test - iOS per event', () => {
  const status = (eventName: string, native: ReturnType<typeof deriveNativeExecutionPlan>, ran: boolean) =>
    deriveNativeTestLaneStatus({
      eventName,
      testScope: '',
      dispatchRef: '',
      repository: 'example-org/example-app',
      headRepository: 'example-org/example-app',
      baseBranch: 'develop',
      baseUpdateDeferred: 'false',
      changeGateResult: 'success',
      changeGateShouldRun: 'true',
      macRunnerResolutionResult: 'success',
      nativePreparationResult: 'success',
      nativeBuildResult: 'success',
      nativeExecutionRequired: String(native.executionRequired),
      releaseArchiveRequired: String(native.releaseArchiveRequired),
      releaseArchiveResult: ran && native.releaseArchiveRequired ? 'success' : 'skipped',
      mainExecutionResult: ran && native.executionRequired ? 'success' : 'skipped',
      mainRequired: 'true',
      evidenceRequired: 'false',
    });

  it('passes the pull request whose full UI suite and archive were deferred', () => {
    const head = deriveNativeExecutionPlan({ ...fullNativeSelection, validationDepth: 'pull-request' });
    assert.equal(status('pull_request', head, false).exitCode, 0);
  });

  it('fails the queue candidate that did not run the archive and UI lanes', () => {
    const candidate = deriveNativeExecutionPlan({ ...fullNativeSelection, validationDepth: 'complete' });
    assert.equal(status('merge_group', candidate, true).exitCode, 0);
    assert.equal(status('merge_group', candidate, false).exitCode, 1);
  });
});

const gateContext: GateContext = {
  forcedIosLanesRaw: '[]',
  reuseNativeEvidenceRaw: 'false',
  changedFilesDelimiter: 'CHANGED_FILES_1_1',
};

const laneOutputKeys: Readonly<Record<IosE2eAuxiliaryLane, string>> = {
  onboarding: 'onboarding_required',
  'chat-plaid': 'chat_plaid_required',
  income: 'income_required',
  budget: 'budget_required',
};

/** The gate's outputs for one event, with the native selectors answering `onboarding`. */
function gateOutputs(
  eventName: string,
  paths: readonly string[],
  selectorOnboarding: boolean,
): ReadonlyMap<string, string> {
  const plan = planIosChangeDetection(gateContext, {
    eventName, baseRef: 'develop', changedFiles: paths.join('\n'),
    reuseNativeEvidence: 'false', forcedIosAuxiliaryRaw: '[]',
  });
  const outputs = plan.kind === 'final'
    ? plan.outputs
    : completeIosChangeDetection(gateContext, plan, {
      evidenceRequired: false, mainRequired: selectorOnboarding, onboardingRequired: selectorOnboarding,
    }, 'false');
  return new Map(outputs.map((output) => [output.key, output.value]));
}

/** One concrete path for a lane-owner pattern: `*` becomes a file name. */
function concretePath(pattern: string): string {
  return pattern.replaceAll('*', pattern.endsWith('*') ? 'Owned.swift' : 'Owned');
}

/** Every owner pattern of every real-server lane, generated from the ownership map. */
const laneOwnerCases = IOS_E2E_AUXILIARY_LANES.flatMap((lane) => auxiliaryLanePaths[lane].map((pattern) => ({
  name: `${lane} owner ${pattern}`,
  paths: [concretePath(pattern)],
})));

const representativeCases = [
  { name: 'lane-only Plaid route YAML', paths: ['server/routes/plaid.yaml'] },
  { name: 'lane-only users route', paths: ['server/routes/users.ts'] },
  { name: 'lane-only income API action', paths: ['ci/src/actions/ios/incomeE2eApi.ts'] },
  { name: 'iOS only', paths: ['ios/example-ios/UI/Onboarding/WelcomeView.swift'] },
  { name: 'iOS test helper', paths: ['ios/example-iosUITests/BudgetBaseUITestCase.swift'] },
  { name: 'server internal', paths: ['server/services/chat/tools/registry.ts'] },
  { name: 'server unowned', paths: ['server/services/income/incomeHistoryComparisonService.ts'] },
  {
    name: 'mixed iOS, route and server',
    paths: ['server/routes/plaid.yaml', 'server/services/budgetService.ts', 'ios/example-ios/UI/Chat/ChatView.swift'],
  },
  { name: 'docs only', paths: ['docs/ci/merge-queue-plan.md', 'README.md'] },
];

describe('real-server E2E lanes run on the PR even without a merge queue', () => {
  for (const { name, paths } of [...representativeCases, ...laneOwnerCases]) {
    it(name, () => {
      for (const selectorOnboarding of [false, true]) {
        const head = gateOutputs('pull_request', paths, selectorOnboarding);
        const candidate = gateOutputs('merge_group', paths, selectorOnboarding);
        for (const lane of IOS_E2E_AUXILIARY_LANES) {
          assert.equal(head.get(laneOutputKeys[lane]), candidate.get(laneOutputKeys[lane]),
            `${lane} must use the same path selection on PR and candidate`);
          if (head.get(laneOutputKeys[lane]) === 'true') {
            assert.equal(head.get('should_run'), 'true', `${lane} must run on the PR`);
          }
        }
      }
    });
  }

  it('covers every owner pattern of every lane', () => {
    const patterns = IOS_E2E_AUXILIARY_LANES.reduce((total, lane) => total + auxiliaryLanePaths[lane].length, 0);
    assert.equal(laneOwnerCases.length, patterns);
    assert.ok(patterns > 50);
  });

  it('runs the Plaid route YAML onboarding lane on the PR', () => {
    const head = gateOutputs('pull_request', ['server/routes/plaid.yaml'], false);
    assert.equal(head.get('should_run'), 'true');
    assert.equal(head.get('onboarding_required'), 'true');
    assert.equal(head.get('main_required'), 'false');
  });
});

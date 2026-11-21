import { prValidationPlanning } from '../prValidationPlanning.ts';
import { parsePrLintPlan } from '../prLintPlan.ts';
import {
  prValidationLaneReasons,
  prValidationVerdict,
  type PrValidationVerdictInput,
  type ReusedLaneEvidence,
  type ValidationLane,
} from '../prValidationVerdict.ts';
import {
  encodePrChecksLaneEvidenceLog, reusedLaneEvidence, type LaneEvidencePlan,
} from '../queueLaneEvidenceRecord.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function optionalEnvironment(name: string): string {
  return process.env[name] ?? '';
}

function results(): PrValidationVerdictInput['results'] {
  return {
    [prValidationPlanning.id]: requiredEnvironment(prValidationPlanning.resultEnvironment),
    lint: requiredEnvironment('LINT'),
    'validation-policy': requiredEnvironment('POLICY'),
    'workflow-contracts': requiredEnvironment('WORKFLOW_CONTRACTS'),
    'server-static': requiredEnvironment('SERVER_STATIC'),
    'server-process-tests': requiredEnvironment('SERVER_PROCESS_TESTS'),
    'server-tests': requiredEnvironment('SERVER_TESTS'),
    'targeted-server-tests': requiredEnvironment('TARGETED_SERVER_TESTS'),
    'ios-contracts': requiredEnvironment('IOS_CONTRACTS'),
    'database-integration': requiredEnvironment('DATABASE'),
  };
}

/** The lanes the candidate's plan job reused, keyed for the verdict; empty on a pull request. */
function reusedFromEvidence(): Partial<Record<ValidationLane, ReusedLaneEvidence>> {
  const raw = optionalEnvironment('LANE_EVIDENCE');
  if (raw.length === 0) return {};
  const reused: Partial<Record<ValidationLane, ReusedLaneEvidence>> = reusedLaneEvidence(JSON.parse(raw) as unknown);
  const declared = JSON.parse(optionalEnvironment('REUSED_LANES') || '[]') as unknown;
  const expected = JSON.stringify(Object.keys(reused).sort());
  if (!Array.isArray(declared) || JSON.stringify([...declared].sort()) !== expected) {
    throw new Error(`REUSED_LANES ${JSON.stringify(declared)} does not match the evidence record's reused lanes ${expected}`);
  }
  return reused;
}

function verdictInput(): PrValidationVerdictInput {
  return {
    results: results(),
    docsOnly: requiredEnvironment('DOCS_ONLY'),
    lintPlan: parsePrLintPlan(JSON.parse(requiredEnvironment('LINT_PLAN')) as unknown),
    metadataOnly: requiredEnvironment('METADATA_ONLY'),
    policyRequired: requiredEnvironment('POLICY_REQUIRED'),
    workflowContractsRequired: requiredEnvironment('WORKFLOW_CONTRACTS_REQUIRED'),
    serverStaticRequired: requiredEnvironment('SERVER_STATIC_REQUIRED'),
    serverTestMode: requiredEnvironment('SERVER_TEST_MODE'),
    processHeavyRequired: requiredEnvironment('PROCESS_HEAVY_REQUIRED'),
    iosContractsRequired: requiredEnvironment('IOS_CONTRACTS_REQUIRED'),
    databaseRequired: requiredEnvironment('DATABASE_REQUIRED'),
    reused: reusedFromEvidence(),
  };
}

/**
 * On a pull request, the evidence marker a later merge queue candidate reads
 * to reuse this run's lanes: the merge commit every lane checked out, the
 * plan this run discharged, and each lane's result. A candidate run prints
 * none, so reused evidence never chains through a candidate.
 */
function laneEvidenceMarker(input: PrValidationVerdictInput): string | undefined {
  if (optionalEnvironment('EVENT_NAME') !== 'pull_request') return undefined;
  const list = (name: string): string[] => {
    const value: unknown = JSON.parse(optionalEnvironment(name) || '[]');
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${name} is not a list of paths`);
    return value as string[];
  };
  const mode = input.serverTestMode;
  if (mode !== 'none' && mode !== 'targeted' && mode !== 'full') throw new Error(`Unknown server test mode: ${mode}`);
  const plan: LaneEvidencePlan = {
    serverTestMode: mode,
    targetedServerTests: list('TARGETED_SERVER_TESTS_PLAN'),
    targetedIntegrationTests: list('TARGETED_INTEGRATION_TESTS_PLAN'),
    entitlementAcceptanceRequired: optionalEnvironment('ENTITLEMENT_ACCEPTANCE_REQUIRED') === 'true',
    testOnlyHelpersToTypecheck: list('TEST_ONLY_HELPERS_PLAN'),
    processHeavyRequired: input.processHeavyRequired === 'true',
    serverStaticRequired: input.serverStaticRequired === 'true',
    workflowContractsRequired: input.workflowContractsRequired === 'true',
    iosContractsRequired: input.iosContractsRequired === 'true',
    databaseRequired: input.databaseRequired === 'true',
  };
  return encodePrChecksLaneEvidenceLog({
    schema: 'example.pr-checks-lane-evidence.v1',
    repository: requiredEnvironment('REPOSITORY'),
    prNumber: requiredEnvironment('PR_NUMBER'),
    prHeadSha: requiredEnvironment('PR_HEAD_SHA'),
    prBaseSha: requiredEnvironment('PR_BASE_SHA'),
    mergeSha: requiredEnvironment('TESTED_MERGE_SHA'),
    workflowSha: requiredEnvironment('WORKFLOW_SHA'),
    runId: Number(requiredEnvironment('RUN_ID')),
    runAttempt: Number(requiredEnvironment('RUN_ATTEMPT')),
    plan,
    results: input.results,
  });
}

try {
  const input = verdictInput();
  for (const line of prValidationLaneReasons(input)) process.stdout.write(`${line}\n`);
  const errors = prValidationVerdict(input);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  } else {
    const marker = laneEvidenceMarker(input);
    if (marker !== undefined) process.stdout.write(`${marker}\n`);
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

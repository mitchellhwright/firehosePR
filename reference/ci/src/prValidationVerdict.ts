import { prValidationPlanning } from './prValidationPlanning.ts';
import type { PrLintPlan } from './prLintPlan.ts';
import { isReusableLinuxLane } from './queueLaneEvidenceRecord.ts';
export const validationLaneNames = [
  prValidationPlanning.id,
  'lint',
  'validation-policy',
  'workflow-contracts',
  'server-static',
  'server-process-tests',
  'server-tests',
  'targeted-server-tests',
  'ios-contracts',
  'database-integration',
] as const;

export type ValidationLane = typeof validationLaneNames[number];

/** What a merge queue candidate's plan job decided about one lane it skipped. */
export interface ReusedLaneEvidence {
  readonly sourceRunId: number;
  readonly sourceRunAttempt: number;
  readonly sourceHeadSha: string;
  readonly testedMergeSha: string;
  readonly inputDigest: string;
}

export interface PrValidationVerdictInput {
  readonly results: Readonly<Record<ValidationLane, string>>;
  readonly docsOnly: string;
  readonly lintPlan: PrLintPlan;
  readonly metadataOnly: string;
  readonly policyRequired: string;
  readonly workflowContractsRequired: string;
  readonly serverStaticRequired: string;
  readonly serverTestMode: string;
  readonly processHeavyRequired: string;
  readonly iosContractsRequired: string;
  readonly databaseRequired: string;
  /**
   * Lanes the candidate's plan job marked `reused`: their job was skipped on
   * purpose and the pull request's own run is the evidence. Absent for a pull
   * request, where nothing is ever reused.
   */
  readonly reused?: Readonly<Partial<Record<ValidationLane, ReusedLaneEvidence>>>;
}

/** Mirrors the required PR check's lane contract; errors are in shell verdict order. */
export function prValidationVerdict(input: PrValidationVerdictInput): string[] {
  const errors: string[] = [];
  const reused = input.reused ?? {};
  const selection = laneSelection(input);
  const requireSuccess = (lane: ValidationLane): void => {
    const result = input.results[lane];
    if (result === 'success') return;
    if (result === 'skipped' && reused[lane] !== undefined && isReusableLinuxLane(lane)) return;
    errors.push(`Selected validation lane ${lane} ended with: ${result}`);
  };

  requireSuccess(prValidationPlanning.id);
  for (const lane of validationLaneNames.slice(1)) {
    const result = input.results[lane];
    if (result !== 'success' && result !== 'skipped') {
      errors.push(`Validation lane ${lane} ended with: ${result}`);
    }
  }
  for (const lane of Object.keys(reused) as ValidationLane[]) {
    if (!isReusableLinuxLane(lane)) {
      errors.push(`Lane ${lane} can never be reused`);
    } else if (selection[lane] !== true) {
      errors.push(`Reused lane ${lane} is not selected: ${String(selection[lane])}`);
    }
  }

  if (selection.lint === true) requireSuccess('lint');
  if (input.policyRequired === 'true') requireSuccess('validation-policy');
  if (input.workflowContractsRequired === 'true') requireSuccess('workflow-contracts');
  if (input.serverStaticRequired === 'true') requireSuccess('server-static');
  if (input.processHeavyRequired === 'true' || input.serverTestMode === 'full') {
    requireSuccess('server-process-tests');
  }
  switch (input.serverTestMode) {
    case 'full':
      requireSuccess('server-tests');
      break;
    case 'targeted':
      requireSuccess('targeted-server-tests');
      break;
    case 'none':
      break;
    default:
      errors.push(`Unknown server test mode: ${input.serverTestMode}`);
  }
  if (input.iosContractsRequired === 'true') requireSuccess('ios-contracts');
  if (input.databaseRequired === 'true') requireSuccess('database-integration');
  return errors;
}

type PlannedLane = Exclude<ValidationLane, typeof prValidationPlanning.id>;

/** For each lane after the planner: `true` when selected, otherwise why it was not. */
function laneSelection(input: PrValidationVerdictInput): Readonly<Record<PlannedLane, string | true>> {
  const flag = (name: string, value: string): string | true => value === 'true' || `${name}=${value}`;
  let lint: string | true = true;
  if (input.metadataOnly === 'true') lint = 'metadata-only change';
  else if (input.docsOnly === 'true') lint = 'docs-only change';
  else if (input.lintPlan.mode === 'none') lint = 'lint plan selects no files';
  return {
    lint,
    'validation-policy': flag('policy_required', input.policyRequired),
    'workflow-contracts': flag('workflow_contracts_required', input.workflowContractsRequired),
    'server-static': flag('server_static_required', input.serverStaticRequired),
    'server-process-tests': input.serverTestMode === 'full'
      || flag('process_heavy_required', input.processHeavyRequired),
    'server-tests': input.serverTestMode === 'full' || `server_test_mode=${input.serverTestMode}`,
    'targeted-server-tests': input.serverTestMode === 'targeted'
      || `server_test_mode=${input.serverTestMode}`,
    'ios-contracts': flag('ios_contracts_required', input.iosContractsRequired),
    'database-integration': flag('database_required', input.databaseRequired),
  };
}

/**
 * One machine-readable line per lane: `<lane>: executed (<result>)` for a
 * selected lane that ran, `<lane>: reused from run <id> attempt <n> …` for a
 * selected lane whose skipped job is covered by the pull request's evidence,
 * and `<lane>: not selected: <why>` otherwise, so a green aggregate states
 * which lanes it vouches for, and how, on every event.
 */
export function prValidationLaneReasons(input: PrValidationVerdictInput): string[] {
  const selection = laneSelection(input);
  const reused = input.reused ?? {};
  return validationLaneNames.slice(1).map((lane) => {
    const selected = selection[lane as PlannedLane];
    if (selected !== true) return `${lane}: not selected: ${selected}`;
    const evidence = reused[lane];
    if (input.results[lane] === 'skipped' && evidence !== undefined && isReusableLinuxLane(lane)) {
      return `${lane}: reused from run ${evidence.sourceRunId} attempt ${evidence.sourceRunAttempt} `
        + `head ${evidence.sourceHeadSha}, input digest ${evidence.inputDigest} `
        + `(not executed on this candidate; tested merge ${evidence.testedMergeSha})`;
    }
    return `${lane}: executed (${input.results[lane]})`;
  });
}

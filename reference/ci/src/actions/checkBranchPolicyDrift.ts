import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  baselineActivationBlockers, branchPolicyBaseline, type BranchPolicyBaseline,
} from '../branchPolicy/baseline.ts';
import {
  EXIT_CODES, driftReport, failureReport, renderSummary, scrub, type DriftReport,
} from '../branchPolicy/drift.ts';
import { InspectionError, createGithubReader } from '../branchPolicy/githubReader.ts';
import { acquireSnapshot } from '../branchPolicy/snapshot.ts';

/**
 * Reads the live branch and administration controls with a human-provisioned
 * read-only credential and compares them with the approved baseline. It
 * reports; it never changes a setting, posts a message or updates the
 * baseline.
 */

export interface MonitorInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly baseline?: BranchPolicyBaseline;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface MonitorOutcome {
  readonly report: DriftReport;
  readonly exitCode: number;
  /** Serialized report and summary, already scrubbed of credential material. */
  readonly reportJson: string;
  readonly summary: string;
}

async function inspect(input: MonitorInput, baseline: BranchPolicyBaseline, token: string): Promise<DriftReport> {
  const blockers = baselineActivationBlockers(baseline);
  if (blockers.length > 0) {
    return failureReport(baseline, {
      reason: 'baseline-not-activatable', endpoint: 'GET <none>', detail: blockers.join('; '),
    });
  }
  const repository = input.env['GITHUB_REPOSITORY'] ?? '';
  if (repository !== baseline.repository) {
    return failureReport(baseline, {
      reason: 'endpoint-not-allowed',
      endpoint: 'GET <none>',
      detail: `the baseline describes ${baseline.repository}, not the repository this run belongs to`,
    });
  }
  try {
    const reader = createGithubReader({
      apiUrl: input.env['GITHUB_API_URL'] ?? '',
      token,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    });
    const snapshot = await acquireSnapshot({ reader, repository, ...(input.now === undefined ? {} : { now: input.now }) });
    return driftReport(baseline, snapshot);
  } catch (error: unknown) {
    if (error instanceof InspectionError) return failureReport(baseline, error.failure);
    return failureReport(baseline, {
      reason: 'malformed-response',
      endpoint: 'GET <unknown>',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : 'unexpected failure',
    });
  }
}

export const SYNTHETIC_DRIFT_ADMIN = 'synthetic-drift-probe';

/**
 * The approved baseline plus one admin nobody has, so a real read reports a
 * single, clearly labelled difference. Used only to prove notifications.
 */
export function withSyntheticDrift(baseline: BranchPolicyBaseline): BranchPolicyBaseline {
  return {
    ...baseline,
    repositoryAdmins: {
      ...baseline.repositoryAdmins,
      users: [...baseline.repositoryAdmins.users, SYNTHETIC_DRIFT_ADMIN],
    },
  };
}

export async function runMonitor(input: MonitorInput): Promise<MonitorOutcome> {
  const approved = input.baseline ?? branchPolicyBaseline;
  const baseline = input.env['BRANCH_POLICY_SYNTHETIC_DRIFT'] === 'true' ? withSyntheticDrift(approved) : approved;
  const token = input.env['BRANCH_POLICY_MONITOR_TOKEN'] ?? '';
  const report = await inspect(input, baseline, token);
  const secrets = [token];
  return {
    report,
    exitCode: EXIT_CODES[report.result],
    reportJson: scrub(`${JSON.stringify(report, null, 2)}\n`, secrets),
    summary: scrub(renderSummary(report), secrets),
  };
}

export async function main(): Promise<void> {
  const outcome = await runMonitor({ env: process.env });
  const reportPath = process.env['BRANCH_POLICY_REPORT_PATH'];
  if (reportPath) writeFileSync(reportPath, outcome.reportJson);
  const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryPath) appendFileSync(summaryPath, outcome.summary);
  const outputPath = process.env['GITHUB_OUTPUT'];
  if (outputPath) appendFileSync(outputPath, `result=${outcome.report.result}\n`);
  process.stdout.write(outcome.summary);
  if (outcome.report.result === 'drift') {
    process.stdout.write('::error::Branch policy drift: live controls differ from the approved baseline. Escalate to #4085.\n');
  } else if (outcome.report.result === 'inspection-failed') {
    process.stdout.write('::error::Branch policy inspection failed: compliance is unknown. Repair read access; never grant write.\n');
  }
  process.exitCode = outcome.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const secrets = [process.env['BRANCH_POLICY_MONITOR_TOKEN'] ?? ''];
    console.error(scrub(error instanceof Error ? error.message : String(error), secrets));
    process.exitCode = EXIT_CODES['inspection-failed'];
  });
}

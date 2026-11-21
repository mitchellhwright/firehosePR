import { appendFileSync } from 'node:fs';
import { z } from 'zod';

import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { error, fail, info, notice, pass, runStepProgram } from '../../ios/shared/stepDecision.ts';
import { QUEUE_REUSE_LANES, queueReuseReport } from '../../ios/queueEvidenceReuseRecord.ts';

/**
 * "Report reused queue evidence", in each required iOS aggregate on a merge
 * queue candidate.
 *
 * A lane the candidate reused is not selected on this run, so the verdict
 * after this step reads "not selected". This step puts the reason beside it,
 * in the log and the job summary: `reused: <lane> from run <id> ... head
 * <sha>, input digest <d>`. It fails the aggregate when the gate's record is
 * malformed, calls a still-required lane reused, or reuses a real-server lane
 * while the development E2E schema was not verified for the candidate.
 */

const flag = z.enum(['true', 'false', '', 'unknown']).transform((value) => value === 'true');

const environmentSchema = z.object({
  QUEUE_EVIDENCE_REUSE: z.string().default(''),
  /** Comma-separated lanes this context's verdict covers. */
  CONTEXT_LANES: z.string().transform((value) => z.array(z.enum(QUEUE_REUSE_LANES)).min(1)
    .parse(value.split(',').map((lane) => lane.trim()).filter((lane) => lane.length > 0))),
  MAIN_REQUIRED: flag,
  STOREKIT_REQUIRED: flag,
  EVIDENCE_REQUIRED: flag,
  NATIVE_SHOULD_RUN: flag,
  ONBOARDING_REQUIRED: flag,
  CHAT_PLAID_REQUIRED: flag,
  INCOME_REQUIRED: flag,
  BUDGET_REQUIRED: flag,
  /** `needs.prepare-dev-e2e-schema.result`; only contexts covering a real-server lane pass it. */
  SCHEMA_PREPARATION_RESULT: z.string().default(''),
  GITHUB_STEP_SUMMARY: z.string().default(''),
});

runStepProgram('Report reused queue evidence', () => {
  const environment = readStepEnvironment(environmentSchema);
  const report = queueReuseReport(environment.QUEUE_EVIDENCE_REUSE, {
    native: environment.MAIN_REQUIRED || environment.STOREKIT_REQUIRED || environment.EVIDENCE_REQUIRED
      || environment.NATIVE_SHOULD_RUN,
    onboarding: environment.ONBOARDING_REQUIRED,
    'chat-plaid': environment.CHAT_PLAID_REQUIRED,
    income: environment.INCOME_REQUIRED,
    budget: environment.BUDGET_REQUIRED,
  }, environment.CONTEXT_LANES, environment.SCHEMA_PREPARATION_RESULT);
  if (report.kind === 'none') {
    return pass(info('No queue evidence reuse was planned; every selected lane runs on this candidate.'));
  }
  if (report.kind === 'invalid') return fail(error(`iOS Change Gate reuse record rejected: ${report.message}.`));
  if (report.kind === 'schema-unverified') {
    return fail(...report.lines.map(notice), error(`Reused real-server evidence refused: ${report.message}.`));
  }
  if (environment.GITHUB_STEP_SUMMARY !== '') {
    appendFileSync(environment.GITHUB_STEP_SUMMARY, [
      `### Queue candidate ${report.record.candidateSha} (#${report.record.prNumber})`, '',
      ...report.lines.map((line) => `- \`${line}\``), '',
    ].join('\n'));
  }
  return pass(...report.lines.map(notice));
});

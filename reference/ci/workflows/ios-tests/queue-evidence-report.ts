import { ciEventCondition, expr, typedStep } from '../lib/index.ts';
import type { QueueReuseLane } from '../../src/ios/queueEvidenceReuseRecord.ts';
import { iosGateOutput } from './shared.ts';

const PROGRAM = 'ci/src/actions/ios/reportQueueEvidenceReuse.ts';

/**
 * The step each required iOS aggregate runs on a merge queue candidate before
 * its verdict: it prints `reused: <lane> from run <id> ... head <sha>, input
 * digest <d>` for every lane of its context that the candidate reused, so a
 * reused lane is never shown as executed on the candidate. A verifier that
 * predates the program skips the step; its gate then planned no reuse either.
 */
export const queueEvidenceReportAt = (
  lanes: readonly QueueReuseLane[],
  checkoutPath = '',
) => {
  const program = `${checkoutPath ? `${checkoutPath}/` : ''}${PROGRAM}`;
  return typedStep({
    name: 'Report reused queue evidence',
    doc: {
      purpose: 'Names every lane this candidate reused from its pull request run, with the run, head and input digest.',
      recovery: 'a rejected record means the gate output and its reuse record disagree; rerun the candidate',
    },
    owner: 'product',
    category: 'quality',
    unit: 'step',
    if: expr(`${ciEventCondition('mergeGroup')} && hashFiles('${program}') != ''`),
    env: {
      QUEUE_EVIDENCE_REUSE: iosGateOutput('queue_evidence_reuse'),
      CONTEXT_LANES: lanes.join(','),
      MAIN_REQUIRED: iosGateOutput('main_required'),
      STOREKIT_REQUIRED: iosGateOutput('storekit_required'),
      EVIDENCE_REQUIRED: iosGateOutput('evidence_required'),
      NATIVE_SHOULD_RUN: iosGateOutput('native_should_run'),
      ONBOARDING_REQUIRED: iosGateOutput('onboarding_required'),
      CHAT_PLAID_REQUIRED: iosGateOutput('chat_plaid_required'),
      INCOME_REQUIRED: iosGateOutput('income_required'),
      BUDGET_REQUIRED: iosGateOutput('budget_required'),
      // Reused real-server evidence stands only on a schema verified for this candidate.
      ...(lanes.some((lane) => lane !== 'native')
        ? { SCHEMA_PREPARATION_RESULT: expr('needs.prepare-dev-e2e-schema.result') }
        : {}),
    },
    command: `node ${program}`,
  });
};

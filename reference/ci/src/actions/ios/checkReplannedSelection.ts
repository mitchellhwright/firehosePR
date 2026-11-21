import { join } from 'node:path';
import { z } from 'zod';

import { appendStepOutputs, type StepOutputEntry } from '../../ios/shared/githubOutputs.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { info, pass, runStepProgram } from '../../ios/shared/stepDecision.ts';
import {
  COVERED_REPLAN_OUTPUTS,
  NATIVE_SELECTION_RECORD_FILE,
  currentSelection,
  readNativeSelectionRecord,
  replanDecision,
  selectionEnvironmentSchema,
} from '../../ios/nativeSelectionRecord.ts';

/**
 * "Compare the re-planned selection with the retained run".
 *
 * Runs only when the trusted classifier reported a base update that changed
 * selection or controller code alone. The selection this gate just computed
 * with that code is compared with the record the retained run uploaded. Only
 * a covered selection replaces the gate's lane outputs; otherwise the gate's
 * own selection runs unchanged.
 */
const environmentSchema = selectionEnvironmentSchema.extend({
  RECORD_DIRECTORY: z.string().min(1),
  EXPECTED_RUN_ID: z.coerce.number().int().positive(),
  /** The attempt whose gate wrote the record; empty when the classifier could not prove it. */
  RECORD_ATTEMPT: z.union([z.literal(''), z.coerce.number().int().positive()]),
  RECORD_DETAIL: z.string(),
  SUCCESS_ATTEMPT: z.coerce.number().int().positive(),
  SUCCESSFUL_JOBS: z.string().transform(value => z.array(z.string()).parse(JSON.parse(value || '[]'))),
  EXPECTED_HEAD_SHA: z.string().regex(/^[a-f0-9]{40}$/),
});

runStepProgram('Re-planned iOS selection coverage', () => {
  const environment = readStepEnvironment(environmentSchema);
  const recordAttempt = environment.RECORD_ATTEMPT === '' ? null : environment.RECORD_ATTEMPT;
  const read = recordAttempt === null
    ? { kind: 'missing' as const, detail: environment.RECORD_DETAIL || 'record-attempt-unproven' }
    : readNativeSelectionRecord(join(environment.RECORD_DIRECTORY, NATIVE_SELECTION_RECORD_FILE), {
      runId: environment.EXPECTED_RUN_ID,
      runAttempt: recordAttempt,
      headSha: environment.EXPECTED_HEAD_SHA,
    });
  const decision = replanDecision(read, currentSelection(environment), {
    runId: environment.EXPECTED_RUN_ID,
    recordAttempt,
    successAttempt: environment.SUCCESS_ATTEMPT,
    successfulJobs: environment.SUCCESSFUL_JOBS,
  });
  const outputs: StepOutputEntry[] = [
    ['covered', String(decision.covered)],
    ['reason', decision.reason],
    ...(decision.covered ? Object.entries(COVERED_REPLAN_OUTPUTS) : []),
  ];
  appendStepOutputs(outputs);
  return pass(info(decision.log));
});

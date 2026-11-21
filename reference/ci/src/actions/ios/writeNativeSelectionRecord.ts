import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { info, pass, runStepProgram } from '../../ios/shared/stepDecision.ts';
import {
  NATIVE_SELECTION_RECORD_FILE,
  currentSelection,
  nativeSelectionRecordSchema,
  selectionEnvironmentSchema,
  selectorInputFingerprint,
} from '../../ios/nativeSelectionRecord.ts';

/**
 * "Record the native iOS selection": writes what this gate selected, before
 * any covered re-plan replaced its outputs, so a later base update can compare
 * a re-planned selection with it. A covered run records that its evidence is
 * retained from the earlier run rather than executed here.
 */
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const environmentSchema = selectionEnvironmentSchema.extend({
  RUN_ID: z.coerce.number().int().positive(),
  RUN_ATTEMPT: z.coerce.number().int().positive(),
  HEAD_SHA: sha,
  VERIFIER_SHA: sha,
  GITHUB_WORKFLOW_SHA: sha,
  NATIVE_CHANGED_FILES: z.string(),
  REPLAN_COVERED: z.enum(['true', 'false', '']),
  REPLAN_EVIDENCE_RUN_ID: z.string(),
  REPLAN_EVIDENCE_RUN_ATTEMPT: z.string(),
  OUTPUT_DIRECTORY: z.string().min(1),
});

runStepProgram('Native iOS selection record', () => {
  const environment = readStepEnvironment(environmentSchema);
  const record = nativeSelectionRecordSchema.parse({
    schema: 'example.ios-native-selection-record.v1',
    run: {
      id: environment.RUN_ID,
      attempt: environment.RUN_ATTEMPT,
      headSha: environment.HEAD_SHA,
      verifierSha: environment.VERIFIER_SHA,
      workflowSha: environment.GITHUB_WORKFLOW_SHA,
    },
    selectorInputFingerprint: selectorInputFingerprint(
      environment.VERIFIER_SHA,
      environment.NATIVE_CHANGED_FILES.split('\n').filter(path => path.length > 0),
    ),
    evidence: environment.REPLAN_COVERED === 'true'
      ? {
        kind: 'retained',
        runId: Number(environment.REPLAN_EVIDENCE_RUN_ID),
        runAttempt: Number(environment.REPLAN_EVIDENCE_RUN_ATTEMPT),
      }
      : { kind: 'executed' },
    selection: currentSelection(environment),
  });
  mkdirSync(environment.OUTPUT_DIRECTORY, { recursive: true });
  writeFileSync(
    join(environment.OUTPUT_DIRECTORY, NATIVE_SELECTION_RECORD_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return pass(info(`Recorded native iOS selection: evidence=${record.evidence.kind} `
    + `tests=${record.selection.native?.onlyTesting.length ?? 0}.`));
});

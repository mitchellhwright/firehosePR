import { optionalEnv } from '../../ios/shared/actionIo.ts';
import { runStepProgram } from '../../ios/shared/stepDecision.ts';
import { deriveSchemaVerdict } from '../../ios/devE2eSchemaVerification.ts';

/**
 * "Enforce development E2E schema verification": one verdict from the two
 * diagnostics that ran with `continue-on-error`.
 *
 * Running both before judging is the point — a push that has both an unapplied
 * migration and object drift reports both, instead of one per attempt.
 */
runStepProgram('Development E2E schema verdict', () =>
  deriveSchemaVerdict({
    revisionRequired: optionalEnv('REVISION_REQUIRED'),
    revisionOutcome: optionalEnv('REVISION_OUTCOME'),
    objectOutcome: optionalEnv('OBJECT_OUTCOME'),
  }));

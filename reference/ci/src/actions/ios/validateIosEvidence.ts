import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { annotateError, logLine, optionalEnv, requiredEnv } from '../../ios/shared/actionIo.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { evidenceValidationPlan } from '../../ios/executionPlan.ts';
import type { EvidenceValidation } from '../../ios/executionPlan.ts';

/**
 * The reviewed-evidence validators: `Validate financial independence
 * evidence` and `Validate Issue 4549 onboarding-copy accessibility evidence`.
 *
 * Both derive the screenshot directory from the lane's result bundle and run
 * a validator against the exact head; `evidenceValidationPlan` owns which
 * validator and which arguments.
 */

const repositoryRoot = resolve(process.cwd(), '..');

const validations: readonly EvidenceValidation[] = [
  'financial-independence',
  'onboarding-copy',
];

function requestedValidation(): EvidenceValidation {
  const requested = requiredEnv('IOS_EVIDENCE_VALIDATION');
  const validation = validations.find((candidate) => candidate === requested);
  if (validation === undefined) {
    throw new Error(`Unknown iOS evidence validation: ${requested}`);
  }
  return validation;
}

async function run(): Promise<number> {
  const decision = evidenceValidationPlan(requestedValidation(), {
    resultBundle: optionalEnv('IOS_TEST_RESULT_BUNDLE'),
    xcodebuildLog: optionalEnv('IOS_TEST_XCODEBUILD_LOG'),
    exactHeadSha: requiredEnv('EXACT_HEAD_SHA'),
  });
  if (!decision.ok) {
    logLine(decision.message);
    return 1;
  }

  const { plan } = decision;
  // The provenance line is appended before the validator reads the log, so the
  // evidence carries the head it was captured from and cannot be replayed.
  if (plan.provenance !== undefined) {
    appendFileSync(plan.provenance.path, `${plan.provenance.line}\n`, 'utf8');
  }

  const validated = await runCommand(
    process.execPath,
    [join(repositoryRoot, plan.validator), ...plan.arguments],
    { cwd: process.cwd() },
  );
  return validated.status;
}

run().then((status) => {
  process.exitCode = status;
}).catch((error: unknown) => {
  annotateError(
    `iOS evidence validation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});

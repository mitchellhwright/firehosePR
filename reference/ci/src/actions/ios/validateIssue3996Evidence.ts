import { mkdirSync, rmSync } from 'node:fs';
import { z } from 'zod';

import { planIssue3996Evidence } from '../../ios/debtCardEvidence.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Validates the automated debt-history acceptance evidence for issue #3996 and
 * keeps it on the runner.
 *
 * The evidence directory is rebuilt from scratch each run so a rerun can never
 * validate the previous attempt's attachments, and the whole thing is
 * persisted only after the validator has passed.
 */

const environmentSchema = z.object({
  IOS_3996_EVIDENCE_DIR: z.string().min(1, 'IOS_3996_EVIDENCE_DIR is required'),
  IOS_3996_CLEANUP_RECEIPT: z.string().min(1, 'IOS_3996_CLEANUP_RECEIPT is required'),
  IOS_3996_EVIDENCE_JSON: z.string().min(1, 'IOS_3996_EVIDENCE_JSON is required'),
  BUDGET_E2E_RESULT_BUNDLE: z.string().min(1, 'BUDGET_E2E_RESULT_BUNDLE is required'),
  BUDGET_E2E_XCODEBUILD_LOG: z.string().min(1, 'BUDGET_E2E_XCODEBUILD_LOG is required'),
  EXAMPLE_CI_EXACT_HEAD_SHA: z.string().min(1, 'EXAMPLE_CI_EXACT_HEAD_SHA is required'),
});

await runStep('Issue 3996 evidence validation', async () => {
  const environment = readStepEnvironment(environmentSchema);
  const plan = planIssue3996Evidence({
    evidenceDirectory: environment.IOS_3996_EVIDENCE_DIR,
    resultBundle: environment.BUDGET_E2E_RESULT_BUNDLE,
    xcodebuildLog: environment.BUDGET_E2E_XCODEBUILD_LOG,
    cleanupReceipt: environment.IOS_3996_CLEANUP_RECEIPT,
    evidenceJson: environment.IOS_3996_EVIDENCE_JSON,
    exactHeadSha: environment.EXAMPLE_CI_EXACT_HEAD_SHA,
  });

  rmSync(plan.evidenceDirectory, { recursive: true, force: true });
  mkdirSync(plan.attachmentsDirectory, { recursive: true });

  for (const [command, args] of [
    ['xcrun', plan.exportArguments],
    ['node', plan.validateArguments],
    ['bash', ['scripts/persist-ios-ci-evidence.sh', plan.persistLabel, ...plan.persistPaths]],
  ] as const) {
    const result = await runCommand(command, args);
    if (result.status === 0) continue;
    process.exitCode = result.status;
    return;
  }
});

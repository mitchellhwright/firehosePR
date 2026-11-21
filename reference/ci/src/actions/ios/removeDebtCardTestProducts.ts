import { rmSync } from 'node:fs';
import { z } from 'zod';

import { planDebtCardCacheRemoval } from '../../ios/debtCardEvidence.ts';
import { renderStepMessage } from '../../ios/shared/stepDecision.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Removes the debt-card XCTest product cache the evidence lane restored into
 * the workspace.
 *
 * The path comes from a step output, and the removal is recursive, so it is
 * compared against the one directory the cache may live in before anything is
 * deleted. A mismatch removes nothing and fails the step.
 */

const environmentSchema = z.object({
  CACHE_DIR: z.string().min(1, 'CACHE_DIR is required'),
  GITHUB_WORKSPACE: z.string().min(1, 'GITHUB_WORKSPACE is required'),
});

await runStep('Debt-card test product removal', () => {
  const environment = readStepEnvironment(environmentSchema);
  const plan = planDebtCardCacheRemoval(environment.GITHUB_WORKSPACE, environment.CACHE_DIR);
  if (plan.kind === 'refuse') {
    for (const message of plan.messages) process.stdout.write(`${renderStepMessage(message)}\n`);
    process.exitCode = 1;
    return;
  }
  rmSync(plan.path, { recursive: true, force: true });
});

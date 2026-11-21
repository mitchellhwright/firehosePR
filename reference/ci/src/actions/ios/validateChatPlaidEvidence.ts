import { mkdirSync } from 'node:fs';
import { z } from 'zod';

import { chatPlaidBackendEvidenceArguments } from '../../ios/chatPlaidLane.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Proves the Chat Plaid suite reached the real backend, by validating the
 * development server's own log rather than trusting a green XCTest run.
 */

const environmentSchema = z.object({
  CHAT_PLAID_E2E_EVIDENCE_DIR: z.string().min(1, 'CHAT_PLAID_E2E_EVIDENCE_DIR is required'),
  ONBOARDING_DEV_BACKEND_LOG: z.string().min(1, 'ONBOARDING_DEV_BACKEND_LOG is required'),
});

await runStep('Chat Plaid backend evidence validation', async () => {
  const environment = readStepEnvironment(environmentSchema);
  mkdirSync(environment.CHAT_PLAID_E2E_EVIDENCE_DIR, { recursive: true });
  const result = await runCommand('node', chatPlaidBackendEvidenceArguments(
    environment.ONBOARDING_DEV_BACKEND_LOG,
    environment.CHAT_PLAID_E2E_EVIDENCE_DIR,
  ));
  if (result.status !== 0) process.exitCode = result.status;
});

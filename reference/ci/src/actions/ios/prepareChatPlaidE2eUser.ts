import { z } from 'zod';

import {
  chatPlaidCleanupToken,
  chatPlaidEmail,
  chatPlaidPassword,
  chatPlaidSeedArguments,
  missingCleanupTokenMessage,
} from '../../ios/realServerE2eLanes.ts';
import { exportStepEnvBlock } from '../../ios/shared/actionIo.ts';
import { appendGithubEnvBlock, maskSecret } from '../../ios/shared/githubStepIo.ts';
import { fetchJson, queryUrl } from '../../ios/shared/httpJson.ts';
import { runCommand } from '../../ios/shared/processRunner.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Bootstraps the one identity the Chat Plaid lane signs in as, and seeds its
 * data from the lane's fixture.
 *
 * The bootstrap must return a confirmed identity with a cleanup token: without
 * the token the delete step at the end of the lane cannot prove ownership, so
 * the lane would leave a user behind on the shared development database.
 */

const environmentSchema = z.object({
  GITHUB_RUN_ID: z.string().min(1),
  GITHUB_RUN_ATTEMPT: z.string().min(1),
  ONBOARDING_DEV_BACKEND_PORT: z.string().regex(/^\d+$/, 'must be a port number'),
  TEST_OTP_SECRET: z.string().default(''),
});

/** The deadline the shell gave `curl --max-time 30`. */
const bootstrapTimeoutMs = 30_000;

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const email = chatPlaidEmail(environment.GITHUB_RUN_ID, environment.GITHUB_RUN_ATTEMPT);
  exportStepEnvBlock(
    new Map([
      ['CHAT_PLAID_E2E_EMAIL', email],
      ['CHAT_PLAID_E2E_PASSWORD', chatPlaidPassword],
    ]),
  );

  const payload = await fetchJson({
    url: queryUrl(
      `http://127.0.0.1:${environment.ONBOARDING_DEV_BACKEND_PORT}/api/auth/test/otp`,
      [
        ['email', email],
        ['password', chatPlaidPassword],
      ],
    ),
    timeoutMs: bootstrapTimeoutMs,
    ...(environment.TEST_OTP_SECRET.length > 0
      ? { headers: { 'x-test-otp-secret': environment.TEST_OTP_SECRET } }
      : {}),
  });
  const cleanupToken = chatPlaidCleanupToken(payload);
  if (cleanupToken === undefined) {
    throw new StepFailure(missingCleanupTokenMessage, 'stderr');
  }
  maskSecret(cleanupToken);
  appendGithubEnvBlock('CHAT_PLAID_E2E_CLEANUP_TOKEN', cleanupToken);

  const seeded = await runCommand(
    'npm',
    chatPlaidSeedArguments({ email, password: chatPlaidPassword }),
    { env: { ...process.env, ENV_FILE: `${process.cwd()}/.env` } },
  );
  if (seeded.status !== 0) throw new StepFailure('', 'stdout', seeded.status);
}

await runStep('Prepare fresh Chat Plaid E2E user', run);

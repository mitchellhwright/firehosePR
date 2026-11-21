import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import {
  identityNotConfirmedMessage,
  onboardingIdentities,
  onboardingIdentityConfirmed,
  onboardingIdentityExports,
} from '../../ios/realServerE2eLanes.ts';
import { exportStepEnvBlock } from '../../ios/shared/actionIo.ts';
import { appendStepOutputs } from '../../ios/shared/githubOutputs.ts';
import { maskSecret } from '../../ios/shared/githubStepIo.ts';
import { fetchJson, queryUrl } from '../../ios/shared/httpJson.ts';
import { readStepEnvironment } from '../../ios/shared/stepEnvironment.ts';
import { StepFailure } from '../../ios/shared/stepFailure.ts';
import { runStep } from '../../ios/shared/stepIo.ts';

/**
 * Creates the two synthetic identities the FullOnboarding lane signs in as:
 * one that still has to complete onboarding, and one that already has, for the
 * privacy journey.
 *
 * `cleanup_required` is published before either identity exists, so the
 * `always()` cleanup step runs even when the second bootstrap fails and leaves
 * the first user behind.
 */

const environmentSchema = z.object({
  GITHUB_RUN_ID: z.string().min(1),
  GITHUB_RUN_ATTEMPT: z.string().min(1),
  ONBOARDING_DEV_BACKEND_PORT: z.string().regex(/^\d+$/, 'must be a port number'),
  TEST_OTP_SECRET: z.string().min(1),
});

/** The deadline the shell gave `curl --max-time 60`. */
const bootstrapTimeoutMs = 60_000;

type Environment = z.infer<typeof environmentSchema>;

async function provisionUser(
  environment: Environment,
  password: string,
  email: string,
  profileComplete: boolean,
): Promise<void> {
  const payload = await fetchJson({
    url: queryUrl(
      `http://127.0.0.1:${environment.ONBOARDING_DEV_BACKEND_PORT}/api/auth/test/otp`,
      [
        ['email', email],
        ['password', password],
        ['profileComplete', String(profileComplete)],
      ],
    ),
    timeoutMs: bootstrapTimeoutMs,
    headers: { 'x-test-otp-secret': environment.TEST_OTP_SECRET },
  });
  if (!onboardingIdentityConfirmed(payload, email)) {
    throw new StepFailure(identityNotConfirmedMessage, 'stderr');
  }
}

async function run(): Promise<void> {
  const environment = readStepEnvironment(environmentSchema);
  const password = randomBytes(32).toString('hex');
  const identities = onboardingIdentities(
    environment.GITHUB_RUN_ID,
    environment.GITHUB_RUN_ATTEMPT,
  );
  maskSecret(password);
  exportStepEnvBlock(onboardingIdentityExports(identities, password));
  appendStepOutputs([['cleanup_required', 'true']]);

  await provisionUser(environment, password, identities.onboardingEmail, false);
  await provisionUser(environment, password, identities.privacyEmail, true);
}

await runStep('Provision development FullOnboarding users', run);

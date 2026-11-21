import { appendFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

import {
  bootstrapIdentityConfirmed,
  bootstrapQuery,
  cleanupEvidenceRecord,
  cleanupFailedMessage,
  cleanupRetryDelayMs,
  cleanupTargets,
  cleanupVerdict,
  deleteQuery,
  deletionVerified,
  identityNotConfirmedMessage,
  maxCleanupAttempts,
  maxCleanupRetryDelayMs,
  pendingCleanupTargets,
  type CleanupRole,
  type CleanupTarget,
} from '../../ios/developmentUserCleanup.ts';
import { warn, warningAnnotation } from '../../ios/shared/githubStepIo.ts';
import { fetchJson, HttpStatusError, queryUrl, type JsonRequest } from '../../ios/shared/httpJson.ts';

/**
 * Deletes the synthetic FullOnboarding users the onboarding lane provisioned,
 * and writes the JSONL evidence the dashboard-offline validator reads.
 *
 * The step is `continue-on-error`, so a failure here annotates and reports a
 * non-zero exit without ending the job; the lifecycle check downstream reports
 * an advisory warning if deletion remains unverified after all attempts.
 */

const environmentSchema = z.object({
  DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE: z.string().min(1),
  TEST_OTP_SECRET: z.string().min(1),
  UI_TEST_SYNTHETIC_PASSWORD: z.string().min(1),
  UI_TEST_SYNTHETIC_ONBOARDING_EMAIL: z.string().min(1),
  UI_TEST_SYNTHETIC_PRIVACY_EMAIL: z.string().min(1),
  ONBOARDING_DEV_BACKEND_PORT: z.string().regex(/^\d+$/, 'must be a port number'),
  ONBOARDING_E2E_COMMIT_SHA: z.string().min(1),
});

/** The per-request deadline the shell gave curl. */
const requestTimeoutMs = 60_000;

type Environment = z.infer<typeof environmentSchema>;

interface RequestCooldown {
  untilMs: number;
}

/** Share a 429 cooldown across both users and both endpoints. */
async function fetchForCleanup(request: JsonRequest, cooldown: RequestCooldown): Promise<unknown> {
  const remainingMs = cooldown.untilMs - Date.now();
  if (remainingMs > 0) await sleep(remainingMs);
  try {
    return await fetchJson(request);
  } catch (error: unknown) {
    if (error instanceof HttpStatusError && error.status === 429) {
      const serverDelayMs = error.retryAfterMs ?? 0;
      cooldown.untilMs = Date.now() + Math.min(
        maxCleanupRetryDelayMs,
        Math.max(5_000, serverDelayMs),
      );
    }
    throw error;
  }
}

async function bootstrapIdentity(
  environment: Environment,
  target: CleanupTarget,
  cooldown: RequestCooldown,
): Promise<boolean> {
  const url = queryUrl(
    `http://127.0.0.1:${environment.ONBOARDING_DEV_BACKEND_PORT}/api/auth/test/otp`,
    bootstrapQuery(target, environment.UI_TEST_SYNTHETIC_PASSWORD),
  );
  try {
    const payload = await fetchForCleanup({
      url,
      timeoutMs: requestTimeoutMs,
      headers: { 'x-test-otp-secret': environment.TEST_OTP_SECRET },
    }, cooldown);
    if (bootstrapIdentityConfirmed(payload, target.email)) return true;
  } catch (error: unknown) {
    warn(error instanceof Error ? error.message : String(error));
  }
  warn(identityNotConfirmedMessage);
  return false;
}

async function deleteIdentity(
  environment: Environment,
  target: CleanupTarget,
  cooldown: RequestCooldown,
): Promise<boolean> {
  const url = queryUrl(
    `http://127.0.0.1:${environment.ONBOARDING_DEV_BACKEND_PORT}/api/auth/test/user`,
    deleteQuery(target),
  );
  try {
    const payload = await fetchForCleanup({
      url,
      method: 'DELETE',
      timeoutMs: requestTimeoutMs,
      headers: { 'x-test-otp-secret': environment.TEST_OTP_SECRET },
    }, cooldown);
    return deletionVerified(payload);
  } catch (error: unknown) {
    warn(error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function cleanupAttempt(
  environment: Environment,
  targets: readonly CleanupTarget[],
  deletedRoles: Set<CleanupRole>,
  cooldown: RequestCooldown,
): Promise<boolean> {
  for (const target of pendingCleanupTargets(targets, deletedRoles)) {
    await bootstrapIdentity(environment, target, cooldown);
    const verified = await deleteIdentity(environment, target, cooldown);
    if (!verified) continue;
    deletedRoles.add(target.role);
    const record = cleanupEvidenceRecord({
      role: target.role,
      commitSha: environment.ONBOARDING_E2E_COMMIT_SHA,
    });
    appendFileSync(
      environment.DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE,
      `${record}\n`,
      'utf8',
    );
  }
  return deletedRoles.size === targets.length;
}

async function run(): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  writeFileSync(environment.DEVELOPMENT_FULL_ONBOARDING_CLEANUP_EVIDENCE, '', 'utf8');
  const targets = cleanupTargets({
    onboardingEmail: environment.UI_TEST_SYNTHETIC_ONBOARDING_EMAIL,
    privacyEmail: environment.UI_TEST_SYNTHETIC_PRIVACY_EMAIL,
  });
  const deletedRoles = new Set<CleanupRole>();
  const cooldown: RequestCooldown = { untilMs: 0 };

  for (let attempt = 1; attempt <= maxCleanupAttempts; attempt += 1) {
    const verdict = cleanupVerdict(
      attempt,
      await cleanupAttempt(environment, targets, deletedRoles, cooldown),
    );
    if (verdict === 'done') return;
    if (verdict === 'exhausted') break;
    const delayMs = cleanupRetryDelayMs(attempt, cooldown.untilMs - Date.now());
    warn(`Development FullOnboarding cleanup attempt ${attempt} failed; retrying in ${delayMs} ms`);
    await sleep(delayMs);
  }
  warningAnnotation(cleanupFailedMessage);
  process.exitCode = 1;
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  warningAnnotation(`Development FullOnboarding cleanup failed: ${message}`);
  process.exitCode = 1;
});

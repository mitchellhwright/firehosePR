/**
 * Decisions for deleting the synthetic FullOnboarding users a development E2E
 * run created, and for the evidence line each deletion leaves behind.
 *
 * Pure: the HTTP calls and the evidence file live in
 * `ci/src/actions/ios/deleteDevelopmentFullOnboardingUsers.ts`.
 */

/** A bounded three-pass cleanup survives transient backend failures. */
export const maxCleanupAttempts = 3;
export const initialCleanupRetryDelayMs = 5_000;
export const maxCleanupRetryDelayMs = 30_000;

/** Restore the former 5s/10s waits, while respecting a bounded 429 cooldown. */
export function cleanupRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  const exponential = Math.min(
    maxCleanupRetryDelayMs,
    initialCleanupRetryDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const serverDelay = retryAfterMs === undefined || !Number.isFinite(retryAfterMs)
    ? 0
    : Math.min(maxCleanupRetryDelayMs, Math.max(0, retryAfterMs));
  return Math.max(exponential, serverDelay);
}

export const identityNotConfirmedMessage =
  'development FullOnboarding cleanup identity was not confirmed';

export const cleanupFailedMessage =
  'Development FullOnboarding cleanup failed after three attempts';

export type CleanupRole = 'onboarding' | 'privacy';

export interface CleanupTarget {
  readonly role: CleanupRole;
  readonly email: string;
  /** The privacy identity is provisioned past profile setup; the onboarding one is not. */
  readonly profileComplete: boolean;
}

/** A verified deletion is final; later passes only retry identities still pending. */
export function pendingCleanupTargets(
  targets: readonly CleanupTarget[],
  deletedRoles: ReadonlySet<CleanupRole>,
): readonly CleanupTarget[] {
  return targets.filter((target) => !deletedRoles.has(target.role));
}

export function cleanupTargets(inputs: {
  readonly onboardingEmail: string;
  readonly privacyEmail: string;
}): readonly CleanupTarget[] {
  return [
    { role: 'onboarding', email: inputs.onboardingEmail, profileComplete: false },
    { role: 'privacy', email: inputs.privacyEmail, profileComplete: true },
  ];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The bootstrap must hand back the very identity the cleanup is about to delete. */
export function bootstrapIdentityConfirmed(payload: unknown, expectedEmail: string): boolean {
  return isRecord(payload) && payload.confirmed === true && payload.email === expectedEmail;
}

/** A deletion counts only when the server also re-read the account and found it gone. */
export function deletionVerified(payload: unknown): boolean {
  return isRecord(payload) && payload.deleted === true && payload.verified === true;
}

export interface UserCleanupOutcome {
  readonly role: CleanupRole;
  readonly bootstrapConfirmed: boolean;
  readonly deletionVerified: boolean;
}

/**
 * Whether an attempt cleaned up every target.
 *
 * The identity bootstrap is a precondition, not the verdict: it re-creates the
 * account so the delete has something to verify, and a delete the server
 * verified is a delete that happened whatever the bootstrap reported. The
 * shell this replaces reached the same conclusion, because `set -e` is
 * suspended inside a function called on the left of `||`.
 */
export function attemptSucceeded(outcomes: readonly UserCleanupOutcome[]): boolean {
  return outcomes.every((outcome) => outcome.deletionVerified);
}

export type CleanupVerdict = 'done' | 'retry' | 'exhausted';

/** `attempt` is 1-based, as the three-pass loop counted it. */
export function cleanupVerdict(
  attempt: number,
  succeeded: boolean,
  maxAttempts: number = maxCleanupAttempts,
): CleanupVerdict {
  if (succeeded) return 'done';
  return attempt < maxAttempts ? 'retry' : 'exhausted';
}

/**
 * One JSONL evidence line, byte-identical to the `json.dumps` the shell piped
 * into the evidence file: the validator hashes this file, so its formatting is
 * part of the artifact.
 */
export function cleanupEvidenceRecord(inputs: {
  readonly role: CleanupRole;
  readonly commitSha: string;
}): string {
  const fields: readonly (readonly [string, string | boolean])[] = [
    ['event', 'development_synthetic_user_deleted'],
    ['role', inputs.role],
    ['deleted', true],
    ['verified', true],
    ['commitSha', inputs.commitSha],
  ];
  const rendered = fields.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{${rendered.join(', ')}}`;
}

/** Query parameters for the test OTP bootstrap, in the order the shell sent them. */
export function bootstrapQuery(
  target: CleanupTarget,
  password: string,
): readonly [string, string][] {
  return [
    ['email', target.email],
    ['password', password],
    ['profileComplete', String(target.profileComplete)],
  ];
}

export function deleteQuery(target: CleanupTarget): readonly [string, string][] {
  return [['email', target.email]];
}

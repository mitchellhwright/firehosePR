import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attemptSucceeded,
  bootstrapIdentityConfirmed,
  bootstrapQuery,
  cleanupEvidenceRecord,
  cleanupRetryDelayMs,
  cleanupTargets,
  cleanupVerdict,
  deleteQuery,
  deletionVerified,
  maxCleanupAttempts,
  pendingCleanupTargets,
  type UserCleanupOutcome,
} from '../src/ios/developmentUserCleanup.ts';

const outcome = (
  role: 'onboarding' | 'privacy',
  overrides: Partial<UserCleanupOutcome> = {},
): UserCleanupOutcome => ({
  role,
  bootstrapConfirmed: true,
  deletionVerified: true,
  ...overrides,
});

describe('cleanupTargets', () => {
  it('provisions the privacy identity past profile setup and the onboarding one before it', () => {
    const targets = cleanupTargets({ onboardingEmail: 'o@x', privacyEmail: 'p@x' });
    assert.deepEqual(
      targets.map((target) => [target.role, target.email, target.profileComplete]),
      [
        ['onboarding', 'o@x', false],
        ['privacy', 'p@x', true],
      ],
    );
  });
});

describe('pendingCleanupTargets', () => {
  it('does not recreate or delete a user already verified on a prior pass', () => {
    const targets = cleanupTargets({ onboardingEmail: 'o@x', privacyEmail: 'p@x' });
    assert.deepEqual(
      pendingCleanupTargets(targets, new Set(['onboarding'])).map((target) => target.role),
      ['privacy'],
    );
    assert.deepEqual(pendingCleanupTargets(targets, new Set(['onboarding', 'privacy'])), []);
  });
});

describe('cleanupRetryDelayMs', () => {
  it('restores five and ten second waits between three attempts', () => {
    assert.equal(cleanupRetryDelayMs(1), 5_000);
    assert.equal(cleanupRetryDelayMs(2), 10_000);
  });

  it('honors a longer server cooldown without exceeding the retry bound', () => {
    assert.equal(cleanupRetryDelayMs(1, 18_000), 18_000);
    assert.equal(cleanupRetryDelayMs(1, 120_000), 30_000);
    assert.equal(cleanupRetryDelayMs(2, -1), 10_000);
    assert.equal(cleanupRetryDelayMs(2, Number.NaN), 10_000);
  });
});

describe('bootstrapIdentityConfirmed', () => {
  it('rejects a confirmation for a different account', () => {
    const payload = { confirmed: true, email: 'someone-else@test.example.local' };
    assert.equal(bootstrapIdentityConfirmed(payload, 'onboard@test.example.local'), false);
  });

  it('rejects an unconfirmed identity even when the address matches', () => {
    const payload = { confirmed: false, email: 'onboard@test.example.local' };
    assert.equal(bootstrapIdentityConfirmed(payload, 'onboard@test.example.local'), false);
  });

  it('requires a strict true rather than a truthy value', () => {
    const payload = { confirmed: 'true', email: 'onboard@test.example.local' };
    assert.equal(bootstrapIdentityConfirmed(payload, 'onboard@test.example.local'), false);
  });

  it('rejects a payload that is not an object', () => {
    assert.equal(bootstrapIdentityConfirmed(null, 'o@x'), false);
    assert.equal(bootstrapIdentityConfirmed('confirmed', 'o@x'), false);
  });

  it('accepts the matching confirmation', () => {
    const payload = { confirmed: true, email: 'onboard@test.example.local' };
    assert.equal(bootstrapIdentityConfirmed(payload, 'onboard@test.example.local'), true);
  });
});

describe('deletionVerified', () => {
  it('refuses a deletion the server did not re-read', () => {
    assert.equal(deletionVerified({ deleted: true, verified: false }), false);
  });

  it('refuses a verification without a deletion', () => {
    assert.equal(deletionVerified({ deleted: false, verified: true }), false);
  });

  it('refuses truthy stand-ins for the two flags', () => {
    assert.equal(deletionVerified({ deleted: 1, verified: 1 }), false);
  });

  it('refuses a payload that is not an object', () => {
    assert.equal(deletionVerified(undefined), false);
    assert.equal(deletionVerified([{ deleted: true, verified: true }]), false);
  });

  it('accepts a deletion the server verified', () => {
    assert.equal(deletionVerified({ deleted: true, verified: true }), true);
  });
});

describe('attemptSucceeded', () => {
  it('fails an attempt when either identity survived', () => {
    assert.equal(
      attemptSucceeded([outcome('onboarding'), outcome('privacy', { deletionVerified: false })]),
      false,
    );
  });

  it('succeeds when a delete verified even though its bootstrap did not confirm', () => {
    // Preserved from the shell: `set -e` is suspended inside a function called
    // on the left of `||`, so an unconfirmed bootstrap never ended the attempt.
    // A delete the server verified is a delete that happened.
    const outcomes = [
      outcome('onboarding', { bootstrapConfirmed: false }),
      outcome('privacy'),
    ];
    assert.equal(attemptSucceeded(outcomes), true);
  });

  it('succeeds on an empty target list rather than looping forever', () => {
    assert.equal(attemptSucceeded([]), true);
  });
});

describe('cleanupVerdict', () => {
  it('retries a transient API blip', () => {
    assert.equal(cleanupVerdict(1, false), 'retry');
    assert.equal(cleanupVerdict(2, false), 'retry');
  });

  it('reports a persistent failure only after the third attempt', () => {
    assert.equal(cleanupVerdict(3, false), 'exhausted');
  });

  it('stops as soon as an attempt succeeds, whichever attempt that is', () => {
    assert.equal(cleanupVerdict(1, true), 'done');
    assert.equal(cleanupVerdict(3, true), 'done');
  });

  it('keeps the bound at the three attempts the failure message names', () => {
    assert.equal(maxCleanupAttempts, 3);
  });
});

describe('cleanupEvidenceRecord', () => {
  it('matches the json.dumps spacing byte for byte, because the file is hashed', () => {
    assert.equal(
      cleanupEvidenceRecord({ role: 'privacy', commitSha: 'abc123' }),
      '{"event": "development_synthetic_user_deleted", "role": "privacy", ' +
        '"deleted": true, "verified": true, "commitSha": "abc123"}',
    );
  });

  it('is one line, so a record cannot forge a second JSONL entry', () => {
    const record = cleanupEvidenceRecord({ role: 'onboarding', commitSha: 'a\nb' });
    assert.equal(record.includes('\n'), false);
  });

  it('parses back to the shape the evidence validator reads', () => {
    const parsed: unknown = JSON.parse(
      cleanupEvidenceRecord({ role: 'onboarding', commitSha: 'abc123' }),
    );
    assert.deepEqual(parsed, {
      event: 'development_synthetic_user_deleted',
      role: 'onboarding',
      deleted: true,
      verified: true,
      commitSha: 'abc123',
    });
  });
});

describe('request queries', () => {
  it('sends the profile-complete flag the provisioning used, as a string', () => {
    const [target] = cleanupTargets({ onboardingEmail: 'o@x', privacyEmail: 'p@x' });
    assert.ok(target !== undefined);
    assert.deepEqual(bootstrapQuery(target, 'secret').map(([name]) => name), [
      'email',
      'password',
      'profileComplete',
    ]);
    assert.deepEqual(bootstrapQuery(target, 'secret')[2], ['profileComplete', 'false']);
  });

  it('sends only the address on the delete, never the password', () => {
    const target = { role: 'privacy' as const, email: 'p@x', profileComplete: true };
    assert.deepEqual([...deleteQuery(target)], [['email', 'p@x']]);
  });
});

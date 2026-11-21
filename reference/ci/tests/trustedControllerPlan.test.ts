import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  baseUpdateClassifierPlan,
  checkoutRevisionMatches,
  exactRevisionPlan,
} from '../src/ios/trustedControllerPlan.ts';
import { renderStepMessage } from '../src/ios/shared/stepDecision.ts';

const base = 'a'.repeat(40);
const other = 'b'.repeat(40);
const classifierPath = '/work/.ci/trusted-base-update/ci/src/ios/controllers/baseUpdateDelta.ts';

function lines(plan: { messages: readonly { level: string; text: string }[] }): string[] {
  return plan.messages.map((message) => renderStepMessage(message as never));
}

describe('checkoutRevisionMatches', () => {
  it('accepts only the exact revision', () => {
    assert.equal(checkoutRevisionMatches(base, base), true);
    assert.equal(checkoutRevisionMatches(base, other), false);
  });

  it('rejects an unreadable checkout, which resolves to the empty string', () => {
    assert.equal(checkoutRevisionMatches(base, ''), false);
  });

  it('rejects an absent expectation rather than matching an unreadable checkout', () => {
    assert.equal(checkoutRevisionMatches('', ''), false);
    assert.equal(checkoutRevisionMatches('', base), false);
  });

  it('does not accept a prefix or a differently cased SHA', () => {
    assert.equal(checkoutRevisionMatches(base, base.slice(0, 7)), false);
    assert.equal(checkoutRevisionMatches(base, base.toUpperCase()), false);
  });
});

describe('baseUpdateClassifierPlan', () => {
  it('runs the classifier it located and says where it found it', () => {
    const plan = baseUpdateClassifierPlan({
      expectedSha: base, checkedOutSha: base, classifierPath, classifierExists: true,
    });
    assert.equal(plan.run, classifierPath);
    assert.equal(plan.exitCode, 0);
    assert.deepEqual(lines(plan), [
      `::notice::Trusted base-update classifier checkout: ${base} at ${classifierPath}.`,
    ]);
  });

  it('retains full routing when the trusted base predates the classifier', () => {
    const plan = baseUpdateClassifierPlan({
      expectedSha: base, checkedOutSha: base, classifierPath, classifierExists: false,
    });
    assert.equal(plan.run, null);
    assert.equal(plan.exitCode, 0);
    assert.equal(lines(plan).length, 2);
    assert.match(lines(plan)[1] ?? '', /retaining full iOS routing\.$/);
  });

  it('refuses a checkout that is not the exact base, before looking for anything', () => {
    const plan = baseUpdateClassifierPlan({
      expectedSha: base, checkedOutSha: other, classifierPath, classifierExists: true,
    });
    assert.equal(plan.run, null);
    assert.equal(plan.exitCode, 1);
    assert.deepEqual(lines(plan), [
      `::error::Trusted base-update checkout mismatch: expected ${base}, found ${other}.`,
    ]);
  });

  it('refuses an unreadable checkout rather than reading it as a missing classifier', () => {
    const plan = baseUpdateClassifierPlan({
      expectedSha: base, checkedOutSha: '', classifierPath, classifierExists: false,
    });
    assert.equal(plan.exitCode, 1);
    assert.match(lines(plan)[0] ?? '', /^::error::Trusted base-update checkout mismatch/);
  });
});

describe('exactRevisionPlan', () => {
  it('says nothing when the checkout is the revision that was asked for', () => {
    const plan = exactRevisionPlan({ expectedSha: base, checkedOutSha: base }, 'exact head');
    assert.equal(plan.exitCode, 0);
    assert.deepEqual(lines(plan), []);
  });

  it('names both revisions and the subject when they differ', () => {
    const plan = exactRevisionPlan({ expectedSha: base, checkedOutSha: other }, 'exact head');
    assert.equal(plan.exitCode, 1);
    assert.deepEqual(lines(plan), [
      `::error::Checked out ${other}, expected exact head ${base}.`,
    ]);
  });

  it('carries the subject into the message', () => {
    const plan = exactRevisionPlan({ expectedSha: base, checkedOutSha: other }, 'trusted base');
    assert.match(lines(plan)[0] ?? '', /expected trusted base a{40}\.$/);
  });

  it('fails when the revision could not be read', () => {
    assert.equal(exactRevisionPlan({ expectedSha: base, checkedOutSha: '' }, 'exact head').exitCode, 1);
    assert.equal(exactRevisionPlan({ expectedSha: '', checkedOutSha: base }, 'exact head').exitCode, 1);
  });
});

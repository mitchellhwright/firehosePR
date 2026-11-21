import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEvidenceAttachment,
  namedEvidenceAttachments,
} from '../src/ios/evidenceAttachments.ts';

test('name matching counts malformed duplicates before validating attachment fields', () => {
  for (const expectedName of [
    'debt-debt_loaded.png',
    'issue-3932-journey-day-0-normal.png',
    'issue-3924-large_large-receipt_one_group.png',
  ]) {
    const valid = {
      suggestedHumanReadableName: expectedName,
      isAssociatedWithFailure: false,
      exportedFileName: expectedName,
    };
    const malformed = {
      suggestedHumanReadableName: expectedName,
      isAssociatedWithFailure: 'false',
    };
    const matches = namedEvidenceAttachments([valid, malformed], name => name === expectedName);
    assert.equal(matches.length, 2, expectedName);
    assert.equal(isEvidenceAttachment(matches[0]), true);
    assert.equal(isEvidenceAttachment(matches[1]), false);
  }
});

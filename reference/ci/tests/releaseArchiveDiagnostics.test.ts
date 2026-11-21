import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  releaseArchiveEvidenceLabel,
  retainReleaseArchiveDiagnostics,
} from '../src/ios/releaseArchiveDiagnostics.ts';
import { renderStepMessage } from '../src/ios/shared/stepDecision.ts';

describe('retainReleaseArchiveDiagnostics', () => {
  it('persists the log under the label the runner retention policy expects', () => {
    const retention = retainReleaseArchiveDiagnostics('/runner/_temp/xcodebuild.log', true);
    assert.deepEqual(retention, {
      kind: 'persist',
      label: releaseArchiveEvidenceLabel,
      logPath: '/runner/_temp/xcodebuild.log',
    });
  });

  it('fails when the upload failed and nothing is on disk either', () => {
    const retention = retainReleaseArchiveDiagnostics('/runner/_temp/xcodebuild.log', false);
    assert.equal(retention.kind, 'missing');
    assert.equal(
      retention.kind === 'missing' ? renderStepMessage(retention.message) : '',
      '::error::The Release archive diagnostic upload failed and no local log exists.',
    );
  });

  it('treats an unset log path as missing rather than persisting the empty path', () => {
    assert.equal(retainReleaseArchiveDiagnostics('', true).kind, 'missing');
    assert.equal(retainReleaseArchiveDiagnostics('', false).kind, 'missing');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  retainedPredecessorMarker,
  retainedPredecessorSummary,
} from '../src/ios/retainedPredecessorMarker.ts';
import { renderStepMessage } from '../src/ios/shared/stepDecision.ts';

const predecessor = { predecessorRunId: '34958669346', deferredBaseSha: 'a'.repeat(40) };

describe('retainedPredecessorMarker', () => {
  it('succeeds, so the resume handler can find the deferred run', () => {
    const decision = retainedPredecessorMarker(predecessor);
    assert.equal(decision.exitCode, 0);
  });

  it('says the rerun is automatic, as a notice', () => {
    const decision = retainedPredecessorMarker(predecessor);
    assert.deepEqual(decision.messages.map(renderStepMessage), [
      '::notice::Patch-equivalent iOS run 34958669346 is still active. ' +
        'This workflow will rerun automatically after it completes.',
    ]);
  });

  it('refuses an identity that could forge an annotation or a summary line', () => {
    for (const predecessorRunId of ['1\n::error::forged', '`id`', '$(id)', '', ' 1', '1 2']) {
      assert.throws(
        () => retainedPredecessorMarker({ ...predecessor, predecessorRunId }),
        /predecessor run id is not a bare identifier/,
        JSON.stringify(predecessorRunId),
      );
    }
    assert.throws(
      () => retainedPredecessorMarker({ ...predecessor, deferredBaseSha: 'a'.repeat(40) + '\nx' }),
      /deferred base SHA is not a bare identifier/,
    );
  });
});

describe('retainedPredecessorSummary', () => {
  it('writes one line naming the run and the base it is deferred to', () => {
    assert.equal(
      retainedPredecessorSummary(predecessor),
      `Awaiting retained iOS predecessor run \`34958669346\` at \`${'a'.repeat(40)}\`.`,
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dispatchTupleDecision,
  eventHasNoPullRequest,
  missingTupleField,
  tupleDecision,
  tupleIsCurrent,
  unreadableTupleDecision,
  type QueuedTuple,
} from '../src/ios/currentPullRequestTuple.ts';
import { renderStepMessage } from '../src/ios/shared/stepDecision.ts';

const expected: QueuedTuple = {
  prNumber: '5901',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseRef: 'develop',
};

const live = {
  state: 'open',
  draft: false,
  head: { sha: expected.headSha },
  base: { sha: expected.baseSha, ref: expected.baseRef },
};

describe('tupleIsCurrent', () => {
  it('accepts the pull request the tuple was captured from', () => {
    assert.equal(tupleIsCurrent(live, expected), true);
  });

  it('rejects a pull request that moved, closed or went back to draft', () => {
    for (const superseded of [
      { state: 'closed' },
      { state: 'merged' },
      { draft: true },
      { head: { sha: 'c'.repeat(40) } },
      { base: { sha: 'd'.repeat(40), ref: expected.baseRef } },
      { base: { sha: expected.baseSha, ref: 'main' } },
    ]) {
      assert.equal(tupleIsCurrent({ ...live, ...superseded }, expected), false, JSON.stringify(superseded));
    }
  });

  it('rejects a body that is missing the fields entirely', () => {
    assert.equal(tupleIsCurrent({}, expected), false);
    assert.equal(tupleIsCurrent({ state: 'open', draft: false }, expected), false);
    assert.equal(tupleIsCurrent({ ...live, head: null }, expected), false);
  });

  it('rejects anything that is not an object, including an array', () => {
    for (const body of [null, undefined, 'open', 42, [live]]) {
      assert.equal(tupleIsCurrent(body, expected), false, String(body));
    }
  });

  it('requires draft to be exactly false, not merely falsy', () => {
    assert.equal(tupleIsCurrent({ ...live, draft: 0 }, expected), false);
    assert.equal(tupleIsCurrent({ ...live, draft: null }, expected), false);
  });
});

describe('tupleDecision', () => {
  it('reports the tuple as current without saying anything', () => {
    const decision = tupleDecision(live, expected);
    assert.equal(decision.current, 'true');
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(decision.messages, []);
  });

  it('skips a superseded tuple rather than failing the guard', () => {
    const decision = tupleDecision({ ...live, state: 'closed' }, expected);
    assert.equal(decision.current, 'false');
    assert.equal(decision.exitCode, 0);
    assert.deepEqual(decision.messages.map(renderStepMessage), [
      `::notice::Skipping superseded iOS tuple ${expected.headSha}/${expected.baseSha} before Mac allocation.`,
    ]);
  });

  it('fails, and never reports current, when the read produced no answer', () => {
    const decision = unreadableTupleDecision('Could not reach pull request #5901.');
    assert.equal(decision.current, 'false');
    assert.equal(decision.exitCode, 1);
    assert.deepEqual(decision.messages.map(renderStepMessage), [
      '::error::Could not reach pull request #5901.',
    ]);
  });
});

describe('an event with no pull request', () => {
  it('is current by definition and never reaches the read', () => {
    assert.equal(eventHasNoPullRequest({ ...expected, prNumber: '' }), true);
    assert.equal(eventHasNoPullRequest(expected), false);
    const decision = dispatchTupleDecision();
    assert.equal(decision.current, 'true');
    assert.equal(decision.exitCode, 0);
  });
});

describe('missingTupleField', () => {
  it('accepts a complete tuple', () => {
    assert.equal(missingTupleField(expected), null);
  });

  it('names the first field the gate failed to publish', () => {
    assert.match(missingTupleField({ ...expected, headSha: '' }) ?? '', /head is required/);
    assert.match(missingTupleField({ ...expected, baseSha: '' }) ?? '', /base is required/);
    assert.match(missingTupleField({ ...expected, baseRef: '' }) ?? '', /base branch is required/);
  });

  it('reports the head before the base when both are absent', () => {
    assert.match(
      missingTupleField({ ...expected, headSha: '', baseSha: '', baseRef: '' }) ?? '',
      /head is required/,
    );
  });
});

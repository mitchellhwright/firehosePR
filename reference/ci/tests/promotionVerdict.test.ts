import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePromotionVerdict, type PromotionVerdictInput } from '../src/ios/promotionVerdict.ts';

const checkpointSha = 'a'.repeat(40);
const valid: PromotionVerdictInput = {
  eventName: 'pull_request',
  baseBranch: 'main',
  headBranch: `promotion/develop-${checkpointSha}`,
  repository: 'example-org/example-app',
  headRepository: 'example-org/example-app',
  changeGateResult: 'success',
  checkpointSha,
  proven: 'true',
  runId: '123',
};

test('accepted exact-checkpoint proof satisfies a required promotion verdict', () => {
  const decision = derivePromotionVerdict(valid);
  assert.equal(decision.exitCode, 0);
  assert.match(JSON.stringify(decision.messages), /run 123/);
});

test('missing, failed, or forged proof cannot satisfy a required promotion verdict', () => {
  for (const mutation of [
    { proven: '' },
    { proven: 'false' },
    { runId: '' },
    { runId: '0' },
    { runId: '12x' },
    { changeGateResult: 'failure' },
    { changeGateResult: 'skipped' },
    { baseBranch: 'develop' },
    { eventName: 'workflow_dispatch' },
    { headRepository: 'someone/example-app' },
    { headBranch: `promotion/develop-${'b'.repeat(40)}` },
    { checkpointSha: '' },
  ]) {
    assert.equal(derivePromotionVerdict({ ...valid, ...mutation }).exitCode, 1,
      JSON.stringify(mutation));
  }
});

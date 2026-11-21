import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeLoadedVideoReview, consumeVideoReview } from '../src/actions/consumeVideoReview.ts';
import {
  selectSuccessfulMainBuilds,
  tagNameForBuild,
} from '../src/actions/reconcileXcodeCloudBuildTags.ts';
import { normalizeReview, reviewStatus } from '../src/actions/reviewOnboardingVideo.ts';

test('Xcode Cloud reconciliation selects only successful main builds', () => {
  const builds = selectSuccessfulMainBuilds({
    included: [{ id: 'main', type: 'scmGitReferences', attributes: { canonicalName: 'refs/heads/main' } }],
    data: [
      {
        attributes: {
          number: 12,
          isPullRequestBuild: false,
          sourceCommit: { commitSha: 'a'.repeat(40) },
          executionProgress: 'COMPLETE',
          completionStatus: 'SUCCEEDED',
        },
        relationships: { sourceBranchOrTag: { data: { id: 'main' } } },
      },
      {
        attributes: {
          number: 13,
          isPullRequestBuild: false,
          sourceCommit: { commitSha: 'b'.repeat(40) },
          executionProgress: 'COMPLETE',
          completionStatus: 'FAILED',
        },
        relationships: { sourceBranchOrTag: { data: { id: 'main' } } },
      },
    ],
  });
  assert.deepEqual(builds, [{ buildNumber: 12, commitSha: 'a'.repeat(40) }]);
  assert.equal(tagNameForBuild(12), 'xcode-cloud/build-12');
});

test('video evidence consumer receives the explicit workflow environment', async () => {
  await assert.rejects(
    consumeVideoReview({ VIDEO_WRITER_OUTPUT: 'relative/outcome.json' }, {
      load: async () => { throw new Error('must not load'); },
      createApi: () => { throw new Error('must not create API'); },
    }),
    /Absolute video writer output path required/,
  );
});

test('video evidence consumer checkpoints unknown reviews without remote writes', async () => {
  let writes = 0;
  const checkpoints: unknown[] = [];
  const result = await consumeLoadedVideoReview({
    review: {
      runId: '123',
      runAttempt: '1',
      artifactId: 456,
      artifactDigest: 'sha256:abc',
      context: {},
      reviews: [{ agent: 'QA', verdict: 'unknown', findings: [] }],
    },
    api: {
      writerLogin: 'github-actions[bot]',
      getIssue: async () => { writes += 1; return {}; },
      listComments: async () => { writes += 1; return []; },
      updateLedgerComment: async () => { writes += 1; return {}; },
      postComment: async () => { writes += 1; return {}; },
    },
    persist: value => { checkpoints.push(structuredClone(value)); },
  });

  assert.equal(writes, 0);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.outcomes, [
    { agent: 'QA', action: 'triage', reason: 'unknown review evidence' },
  ]);
  assert.equal(checkpoints.length, 3);
});

test('onboarding review rejects malformed model findings as unknown', () => {
  const review = normalizeReview('QA', {
    verdict: 'needs_changes',
    findings: [{ kind: 'product_defect', severity: 'important' }],
    coverage_notes: [],
  });
  assert.equal(review.verdict, 'unknown');
  assert.equal(review.findings.length, 0);
  assert.equal(reviewStatus([review]), 'unknown');
});

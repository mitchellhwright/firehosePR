import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { budgetVideoWorkspace, selectRawVideo } from '../src/ios/budgetVideoProcessing.ts';

describe('budgetVideoWorkspace', () => {
  it('derives one directory per run attempt', () => {
    assert.deepEqual(budgetVideoWorkspace('/runner/_temp', '42', '2'), {
      runDirectory: '/runner/_temp/budget-video-42-2',
      rawDirectory: '/runner/_temp/budget-video-42-2/raw',
      compressedVideo: '/runner/_temp/budget-video-42-2/budget-e2e.compressed.mp4',
    });
  });

  it('gives each attempt of a run its own directory', () => {
    const first = budgetVideoWorkspace('/runner/_temp', '42', '1').runDirectory;
    const second = budgetVideoWorkspace('/runner/_temp', '42', '2').runDirectory;
    assert.notEqual(first, second);
  });

  it('refuses an identifier that could escape the directory it then removes', () => {
    for (const runId of ['..', '../../etc', '', '42 ', 'a42', '4/2']) {
      assert.throws(
        () => budgetVideoWorkspace('/runner/_temp', runId, '1'),
        /non-numeric run id/,
        JSON.stringify(runId),
      );
    }
    assert.throws(
      () => budgetVideoWorkspace('/runner/_temp', '42', '../1'),
      /non-numeric run attempt/,
    );
  });

  it('refuses an absent runner temporary directory', () => {
    assert.throws(() => budgetVideoWorkspace('', '42', '1'), /RUNNER_TEMP is required/);
  });
});

describe('selectRawVideo', () => {
  it('picks the raw recording out of the downloaded evidence', () => {
    assert.equal(
      selectRawVideo([
        '/raw/budget-e2e.log',
        '/raw/budget-e2e.raw.mp4',
        '/raw/screenshot.png',
      ]),
      '/raw/budget-e2e.raw.mp4',
    );
  });

  it('is deterministic when the lane uploaded more than one recording', () => {
    const candidates = ['/raw/b.raw.mp4', '/raw/a.raw.mp4'];
    assert.equal(selectRawVideo(candidates), '/raw/a.raw.mp4');
    assert.equal(selectRawVideo([...candidates].reverse()), '/raw/a.raw.mp4');
  });

  it('does not mistake a compressed or similarly named file for the recording', () => {
    assert.throws(
      () => selectRawVideo(['/raw/budget-e2e.compressed.mp4', '/raw/budget-e2e.raw.mp4.sha256']),
      /no raw recording/,
    );
  });

  it('fails loudly when the download produced nothing', () => {
    assert.throws(() => selectRawVideo([]), /no raw recording/);
  });
});

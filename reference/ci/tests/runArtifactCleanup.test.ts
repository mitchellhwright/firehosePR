import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  artifactDeletionUrl,
  artifactListingUrl,
  artifactPageSize,
  hasFurtherPage,
  isRunIdentifier,
  removableArtifacts,
  removalLine,
  removalSummary,
} from '../src/ios/runArtifactCleanup.ts';

const api = 'https://api.github.com';
const repository = 'example-org/example-app';

describe('isRunIdentifier', () => {
  it('accepts a plain run id', () => {
    assert.equal(isRunIdentifier('34958669346'), true);
  });

  it('rejects anything that could reach the URL as something other than a number', () => {
    for (const value of ['', ' 12', '12 ', '1/2', '../1', '0x10', '1e3', '-1', '${{ github.run_id }}']) {
      assert.equal(isRunIdentifier(value), false, JSON.stringify(value));
    }
  });
});

describe('removableArtifacts', () => {
  const artifact = { id: 7, name: 'ios-release-archive-results', size_in_bytes: 4096, expired: false };

  it('returns the unexpired artifacts of a page', () => {
    assert.deepEqual(removableArtifacts({ artifacts: [artifact] }), [
      { id: 7, name: 'ios-release-archive-results', sizeInBytes: 4096 },
    ]);
  });

  it('skips an artifact GitHub has already expired', () => {
    assert.deepEqual(removableArtifacts({ artifacts: [{ ...artifact, expired: true }] }), []);
  });

  it('keeps an artifact whose expiry is absent, as the jq filter did', () => {
    const { expired, ...withoutExpiry } = artifact;
    assert.equal(expired, false);
    assert.equal(removableArtifacts({ artifacts: [withoutExpiry] }).length, 1);
  });

  it('skips an entry without a usable id rather than building a made-up URL', () => {
    const listing = {
      artifacts: [
        { ...artifact, id: '7' },
        { ...artifact, id: 0 },
        { ...artifact, id: -1 },
        { ...artifact, id: 1.5 },
        { ...artifact, id: undefined },
        'not an object',
        null,
      ],
    };
    assert.deepEqual(removableArtifacts(listing), []);
  });

  it('falls back to the id when the name or size is not what it should be', () => {
    assert.deepEqual(removableArtifacts({ artifacts: [{ id: 7, name: 12, size_in_bytes: null }] }), [
      { id: 7, name: '7', sizeInBytes: 0 },
    ]);
  });

  it('returns nothing for a body that is not a listing', () => {
    for (const body of [undefined, null, [], 'artifacts', { artifacts: {} }]) {
      assert.deepEqual(removableArtifacts(body), [], String(body));
    }
  });
});

describe('paging', () => {
  it('asks for another page only while the page was full', () => {
    assert.equal(hasFurtherPage(artifactPageSize), true);
    assert.equal(hasFurtherPage(artifactPageSize - 1), false);
    assert.equal(hasFurtherPage(0), false);
  });
});

describe('urls and reporting', () => {
  it('addresses the run and the artifact', () => {
    assert.equal(
      artifactListingUrl(api, repository, '42'),
      'https://api.github.com/repos/example-org/example-app/actions/runs/42/artifacts?per_page=100',
    );
    assert.equal(
      artifactDeletionUrl(api, repository, 7),
      'https://api.github.com/repos/example-org/example-app/actions/artifacts/7',
    );
  });

  it('keeps the lines the replaced shell printed', () => {
    assert.equal(
      removalLine({ id: 7, name: 'budget-e2e-evidence', sizeInBytes: 512 }),
      'Removed budget-e2e-evidence (512 bytes)',
    );
    assert.equal(removalSummary(3, '42'), 'Removed 3 artifact(s) from run 42.');
    assert.equal(removalSummary(0, '42'), 'Removed 0 artifact(s) from run 42.');
  });
});

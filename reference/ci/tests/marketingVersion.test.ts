import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  marketingVersionExceeds, nextPromotionVersion, readAppleVersions, readMarketingVersion,
  rewriteMarketingVersion, versionFromCommitMessage,
} from '../src/promotion/marketingVersion.ts';
import { CheckpointApi } from '../src/promotion/checkpointApi.ts';
import {
  hasTrustedVersionAttestation, promotionCheckpointUser, trustedVersionAttestations, versionAttestationBody,
} from '../src/promotion/versionAttestation.ts';

const project = `${'\t\tMARKETING_VERSION = 1.5.1;\n'.repeat(16)}\t\tOTHER_VERSION = 1.5.1;\n`;

test('the real Xcode project has one consistent marketing version across every target', () => {
  const source = readFileSync(new URL('../../ios/example-ios.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  const version = readMarketingVersion(source);
  assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.equal((source.match(/MARKETING_VERSION = /gu) ?? []).length, 16);
});

test('rewrites all 16 marketing versions and no other project setting', () => {
  const next = rewriteMarketingVersion(project, '1.5.2');
  assert.equal(readMarketingVersion(next), '1.5.2');
  assert.equal((next.match(/MARKETING_VERSION = 1\.5\.2;/gu) ?? []).length, 16);
  assert.ok(next.endsWith('OTHER_VERSION = 1.5.1;\n'));
});

test('mixed or missing project settings and non-increasing versions fail closed', () => {
  assert.throws(() => readMarketingVersion(project.replace('MARKETING_VERSION = 1.5.1;', 'MARKETING_VERSION = 1.4.0;')));
  assert.throws(() => readMarketingVersion(project.replace('MARKETING_VERSION = 1.5.1;', 'OTHER_VERSION = 1.5.1;')));
  assert.throws(() => rewriteMarketingVersion(project, '1.5.1'));
});

test('Apple approved history and active version reservations choose the next unused patch', () => {
  assert.equal(nextPromotionVersion('1.5.2', [
    { platform: 'IOS', versionString: '1.5.1', appVersionState: 'READY_FOR_DISTRIBUTION' },
    { platform: 'IOS', versionString: '1.5', appVersionState: 'REPLACED_WITH_NEW_VERSION' },
  ]), '1.5.2');
  assert.equal(nextPromotionVersion('1.5.1', [
    { platform: 'IOS', versionString: '1.5.1', appVersionState: 'READY_FOR_DISTRIBUTION' },
    { platform: 'IOS', versionString: '1.5.2', appVersionState: 'PREPARE_FOR_SUBMISSION' },
    { platform: 'IOS', versionString: '1.6.0', appVersionState: 'DEVELOPER_REJECTED' },
    { platform: 'MAC_OS', versionString: '3.0.0', appVersionState: 'READY_FOR_DISTRIBUTION' },
  ]), '1.5.3');
  assert.throws(() => nextPromotionVersion('1.5.1', [{
    platform: 'IOS', versionString: '1.5.2', appVersionState: 'REJECTED',
  }]));
});

test('open checkpoint reservations prevent duplicate promotion versions', async () => {
  const sourceSha = 'a'.repeat(40);
  const attestation = versionAttestationBody({ sourceSha, commitSha: 'b'.repeat(40), version: '1.5.2' });
  const nextSource = 'c'.repeat(40);
  const currentSource = 'e'.repeat(40);
  const sourceReservation = versionAttestationBody({ sourceSha: nextSource, commitSha: 'd'.repeat(40), version: '1.5.3' });
  const fetchImpl: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/pulls')) return new Response(JSON.stringify([
      { number: 100, base: { ref: 'main' }, head: { ref: `promotion/develop-${sourceSha}` }, state: 'open' },
      { number: 101, base: { ref: 'main' }, head: { ref: 'develop' }, state: 'open' },
    ]));
    if (path.endsWith('/issues/100/comments')) return new Response(JSON.stringify([
      { body: attestation, user: promotionCheckpointUser },
      { body: versionAttestationBody({ sourceSha, commitSha: sourceSha, version: '9.9.9' }), user: { ...promotionCheckpointUser, id: 1 } },
    ]));
    if (path.endsWith('/issues/101/comments')) return new Response(JSON.stringify([
      { body: sourceReservation, user: promotionCheckpointUser },
    ]));
    if (path.endsWith(`/compare/${sourceSha}...${currentSource}`)) {
      return new Response(JSON.stringify({
        status: 'ahead', behind_by: 0, merge_base_commit: { sha: sourceSha },
      }));
    }
    if (path.endsWith(`/compare/${nextSource}...${currentSource}`)) {
      return new Response(JSON.stringify({
        status: 'diverged', behind_by: 1, merge_base_commit: { sha: 'f'.repeat(40) },
      }));
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  const api = new CheckpointApi('https://api.github.test', 'token', 'example-org/example-app', fetchImpl);
  const reservations = await api.promotionVersionReservations(currentSource);
  assert.deepEqual(reservations, ['1.5.3']);
  const approved = [{ platform: 'IOS', versionString: '1.5.1', appVersionState: 'READY_FOR_DISTRIBUTION' }];
  assert.equal(nextPromotionVersion('1.5.2', approved, reservations), '1.5.4');
  assert.equal(nextPromotionVersion('1.5.2', approved, ['1.5.2']), '1.5.3');
  assert.equal(marketingVersionExceeds('1.5.3', '1.5.2'), true);
  assert.equal(marketingVersionExceeds('1.5.2', '1.5.2'), false);
});

test('superseded checkpoint does not consume the source marketing version', async () => {
  const predecessor = 'a'.repeat(40);
  const currentSource = 'b'.repeat(40);
  const attestation = versionAttestationBody({
    sourceSha: predecessor, commitSha: 'c'.repeat(40), version: '1.5.3',
  });
  const api = new CheckpointApi('https://api.github.test', 'token', 'example-org/example-app',
    async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/pulls')) return new Response(JSON.stringify([
        { number: 6114, base: { ref: 'main' }, head: { ref: `promotion/develop-${predecessor}` } },
      ]));
      if (path.endsWith('/issues/6114/comments')) return new Response(JSON.stringify([
        { body: attestation, user: promotionCheckpointUser },
      ]));
      if (path.endsWith(`/compare/${predecessor}...${currentSource}`)) {
        return new Response(JSON.stringify({
          status: 'ahead', behind_by: 0, merge_base_commit: { sha: predecessor },
        }));
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    });
  const reservations = await api.promotionVersionReservations(currentSource);
  assert.deepEqual(reservations, []);
  assert.deepEqual(await api.promotionVersionReservations(predecessor), ['1.5.3']);
  assert.equal(nextPromotionVersion('1.5.2', [{
    platform: 'IOS', versionString: '1.5.1', appVersionState: 'READY_FOR_DISTRIBUTION',
  }], reservations), '1.5.2');
});

test('Apple version inventory pagination is bound to the same app and rejects loops', async () => {
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const current = String(url);
    requests.push(current);
    return new Response(JSON.stringify({
      data: [{ attributes: { platform: 'IOS', versionString: '1.5.1', appVersionState: 'READY_FOR_DISTRIBUTION' } }],
      links: { next: requests.length === 1 ? '/v1/apps/1234567890/appStoreVersions?page=2' : null },
    }), { status: 200 });
  };
  assert.equal((await readAppleVersions('1234567890', 'test-token', fetchImpl)).length, 2);
  assert.equal(requests.length, 2);
  await assert.rejects(readAppleVersions('1234567890', 'test-token', async () =>
    new Response(JSON.stringify({ data: [], links: { next: 'https://example.com/v1/appStoreVersions' } }), { status: 200 })));
});

test('only exact promotion version commit messages are recognized', () => {
  assert.equal(versionFromCommitMessage('chore(ios): set promotion marketing version to 1.5.2'), '1.5.2');
  assert.equal(versionFromCommitMessage('chore(ios): set promotion marketing version to 1.5.2\nextra'), null);
});

test('version attestation requires the checkpoint App actor and exact source, commit and version', () => {
  const attestation = { sourceSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), version: '1.5.2' };
  const body = versionAttestationBody(attestation);
  assert.equal(hasTrustedVersionAttestation([{ body, user: promotionCheckpointUser }], attestation), true);
  assert.equal(hasTrustedVersionAttestation([{ body, user: { ...promotionCheckpointUser, id: 1 } }], attestation), false);
  assert.equal(hasTrustedVersionAttestation([{ body, user: promotionCheckpointUser }], {
    ...attestation, commitSha: 'c'.repeat(40),
  }), false);
  assert.equal(hasTrustedVersionAttestation([{ body, user: promotionCheckpointUser }], {
    ...attestation, version: '999.0.0',
  }), false);
});

test('an App-attested source selection can be recovered after Apple inventory changes', () => {
  const sourceSha = 'a'.repeat(40);
  const committed = { sourceSha, commitSha: 'b'.repeat(40), version: '1.5.2' };
  const comments = [
    { body: versionAttestationBody(committed), user: { ...promotionCheckpointUser, id: 1 } },
    { body: versionAttestationBody(committed), user: promotionCheckpointUser },
    { body: versionAttestationBody({ ...committed, sourceSha: 'c'.repeat(40) }), user: promotionCheckpointUser },
  ];
  assert.deepEqual(trustedVersionAttestations(comments, sourceSha), [committed]);
});

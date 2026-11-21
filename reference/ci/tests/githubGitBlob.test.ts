import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { verifiedGitBlobSource } from '../src/githubGitBlob.ts';

const bytes = Buffer.from('verified workflow\n');
const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const payload = { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length };
it('verifies exact UTF-8 Git object content including line-wrapped base64', () => {
  assert.equal(verifiedGitBlobSource(payload, sha), bytes.toString());
  assert.equal(verifiedGitBlobSource({ ...payload, content: `\n${payload.content}\n` }, sha), bytes.toString());
});
it('refuses missing, oversized, mismatched and noncanonical Git object content', () => {
  for (const invalid of [undefined, null, {}, { ...payload, size: 0 }, { ...payload, size: 1024 * 1024 + 1 },
    { ...payload, encoding: 'utf8' }, { ...payload, content: payload.content + '!' },
    { ...payload, content: 'A===' }, { ...payload, content: 'AB==' },
    { ...payload, content: ' '.repeat(2 * 1024 * 1024 + 1) }]) {
    assert.equal(verifiedGitBlobSource(invalid, sha), null);
  }
  assert.equal(verifiedGitBlobSource(payload, '0'.repeat(40)), null);
  const malformed = Buffer.from([0xff]);
  const malformedSha = createHash('sha1').update(`blob 1\0`).update(malformed).digest('hex');
  assert.equal(verifiedGitBlobSource({ encoding: 'base64', content: malformed.toString('base64'), size: 1 }, malformedSha), null);
});
it('accepts a bounded large workflow without recursive base64 validation', () => {
  const source = '#'.repeat(900_000);
  const digest = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
  assert.equal(verifiedGitBlobSource({ encoding: 'base64', content: Buffer.from(source).toString('base64'), size: source.length }, digest), source);
});

import { createHash } from 'node:crypto';

/** Verify a bounded GitHub blob response against the object named by a Git tree.
 * No content, including generated workflows, is trusted solely by its API URL. */
export function verifiedGitBlobSource(value: unknown, expectedSha: string): string | null {
  if (!/^[a-f0-9]{40}$/.test(expectedSha) || value === null || typeof value !== 'object') return null;
  if (!('encoding' in value) || value.encoding !== 'base64'
    || !('content' in value) || typeof value.content !== 'string'
    || !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size)
    || value.size < 0 || value.size > 1024 * 1024 || value.content.length > 2 * 1024 * 1024) return null;
  const encoded = value.content.replace(/\s/g, '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return null;
  const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== value.size || sha !== expectedSha) return null;
  const source = bytes.toString('utf8');
  // Refuse malformed UTF-8 rather than comparing replacement characters.
  return Buffer.from(source, 'utf8').equals(bytes) ? source : null;
}

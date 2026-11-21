import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  encodeQueryComponent,
  fetchJson,
  HttpStatusError,
  queryUrl,
  retryAfterMilliseconds,
} from '../src/ios/shared/httpJson.ts';

describe('Retry-After from a throttled cleanup endpoint', () => {
  it('accepts delta seconds and HTTP dates and rejects malformed values', () => {
    assert.equal(retryAfterMilliseconds('12', 0), 12_000);
    assert.equal(retryAfterMilliseconds('Thu, 01 Jan 1970 00:00:12 GMT', 0), 12_000);
    assert.equal(retryAfterMilliseconds('not a date', 0), undefined);
    assert.equal(retryAfterMilliseconds(null, 0), undefined);
  });

  it('propagates status and cooldown without logging a password-bearing query', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('', {
      status: 429,
      headers: { 'retry-after': '12' },
    });
    try {
      await assert.rejects(
        fetchJson({ url: 'http://127.0.0.1/api/auth/test/otp?password=secret', timeoutMs: 500 }),
        (error: unknown) => {
          assert.ok(error instanceof HttpStatusError);
          assert.equal(error.status, 429);
          assert.equal(error.retryAfterMs, 12_000);
          assert.equal(error.message.includes('secret'), false);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('encodeQueryComponent', () => {
  it('spells a space %20, as curl --data-urlencode does and URLSearchParams does not', () => {
    assert.equal(encodeQueryComponent('pass word'), 'pass%20word');
  });

  it('encodes the separators that would otherwise forge another parameter', () => {
    assert.equal(encodeQueryComponent('a&b=c'), 'a%26b%3Dc');
  });

  it('encodes an email address the test endpoints key on', () => {
    assert.equal(
      encodeQueryComponent('privacy-ci-1-2@test.example.local'),
      'privacy-ci-1-2%40test.example.local',
    );
  });

  it('encodes the sub-delimiters encodeURIComponent leaves alone', () => {
    assert.equal(encodeQueryComponent("!'()*"), '%21%27%28%29%2A');
  });

  it('leaves the unreserved set untouched', () => {
    assert.equal(encodeQueryComponent("azAZ09-._~"), 'azAZ09-._~');
  });

  it('encodes a non-ASCII character as UTF-8 bytes', () => {
    assert.equal(encodeQueryComponent('é'), '%C3%A9');
  });
});

describe('queryUrl', () => {
  it('keeps the parameter order the request was built with', () => {
    const url = queryUrl('http://127.0.0.1:3000/api/auth/test/otp', [
      ['email', 'o@x'],
      ['password', 'p'],
      ['profileComplete', 'false'],
    ]);
    assert.equal(
      url,
      'http://127.0.0.1:3000/api/auth/test/otp?email=o%40x&password=p&profileComplete=false',
    );
  });

  it('encodes a value that contains a separator rather than trusting it', () => {
    const url = queryUrl('http://h/api', [['email', 'a@x&admin=1']]);
    assert.equal(url, 'http://h/api?email=a%40x%26admin%3D1');
  });

  it('emits a bare question mark for an empty parameter list', () => {
    assert.equal(queryUrl('http://h/api', []), 'http://h/api?');
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import { readStepEnvironment } from '../src/ios/shared/stepEnvironment.ts';
import {
  renderMultilineOutput,
  renderStepOutputs,
} from '../src/ios/shared/githubOutputs.ts';
import {
  createGithubReader,
  createGithubRequester,
  credentialTokens,
  GithubTransportError,
} from '../src/ios/shared/githubRest.ts';
import { error, info, notice, renderStepMessage } from '../src/ios/shared/stepDecision.ts';

const stepSchema = z.object({
  RUNNER_TEMP: z.string().min(1, 'RUNNER_TEMP is required'),
  TEST_SCOPE: z.string().default(''),
});

test('a step environment keeps its declared shape and drops everything else', () => {
  assert.deepEqual(readStepEnvironment(stepSchema, { RUNNER_TEMP: '/tmp', PATH: '/usr/bin' }), {
    RUNNER_TEMP: '/tmp',
    TEST_SCOPE: '',
  });
  // An absent optional is the default; a present empty one stays empty, which
  // is how a workflow spells "this input was not selected".
  assert.equal(readStepEnvironment(stepSchema, { RUNNER_TEMP: '/tmp', TEST_SCOPE: '' }).TEST_SCOPE, '');
  assert.equal(readStepEnvironment(stepSchema, { RUNNER_TEMP: '/tmp', TEST_SCOPE: 'e2e' }).TEST_SCOPE, 'e2e');
});

test('a missing required variable is named in the failure, not buried in a blob', () => {
  // The Actions log is the only place this is read, so the message has to say
  // which variable the step was handed nothing for.
  assert.throws(
    () => readStepEnvironment(stepSchema, { TEST_SCOPE: 'e2e' }),
    /^Error: Step environment is not usable: RUNNER_TEMP: /,
  );
  assert.throws(
    () => readStepEnvironment(stepSchema, { RUNNER_TEMP: '' }),
    /Step environment is not usable: RUNNER_TEMP: RUNNER_TEMP is required/,
  );
});

test('step outputs render one key per line in the order they were decided', () => {
  assert.equal(
    renderStepOutputs([['should_run', 'true'], ['pr_number', ''], ['expected_base_ref', 'main']]),
    'should_run=true\npr_number=\nexpected_base_ref=main\n',
  );
  assert.equal(renderStepOutputs([]), '');
});

test('a newline in a single-line output is refused instead of forging further keys', () => {
  // `$GITHUB_OUTPUT` is parsed line by line, so a value carrying a newline
  // would let whatever produced it declare outputs the step never decided.
  assert.throws(
    () => renderStepOutputs([['summary', 'first\nshould_run=true']]),
    /Step output summary contains a newline/,
  );
});

test('a multi-line output is wrapped in the delimiter form GitHub reads', () => {
  assert.equal(
    renderMultilineOutput('summary', 'Checking changed files.', 'SUMMARY'),
    'summary<<SUMMARY\nChecking changed files.\nSUMMARY\n',
  );
  assert.equal(renderMultilineOutput('summary', '', 'SUMMARY'), 'summary<<SUMMARY\n\nSUMMARY\n');
  assert.equal(
    renderMultilineOutput('summary', 'one\ntwo', 'SUMMARY'),
    'summary<<SUMMARY\none\ntwo\nSUMMARY\n',
  );
});

test('a value that contains the delimiter as a line is refused', () => {
  assert.throws(
    () => renderMultilineOutput('summary', 'before\nSUMMARY\nshould_run=true', 'SUMMARY'),
    /contains its own SUMMARY delimiter/,
  );
  // The delimiter inside a longer line cannot end the block, so it is allowed.
  assert.match(renderMultilineOutput('summary', 'SUMMARY of the run', 'SUMMARY'), /SUMMARY of the run/);
});

interface StubResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: string;
}

function stubFetch(responses: readonly StubResponse[]): {
  readonly fetchImpl: typeof fetch;
  readonly authorizations: string[];
} {
  const authorizations: string[] = [];
  let index = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    authorizations.push(headers['Authorization'] ?? '');
    const response = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (response === undefined) throw new Error('no stub response');
    return {
      status: response.status,
      json: async (): Promise<unknown> => {
        if (response.raw !== undefined) return JSON.parse(response.raw);
        return response.body;
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, authorizations };
}

test('a rate-limited event token is retried with the trusted fallback', async () => {
  for (const status of [403, 429]) {
    const warnings: string[] = [];
    const { fetchImpl, authorizations } = stubFetch([{ status }, { status: 200, body: { state: 'open' } }]);
    const read = createGithubReader({
      tokens: ['event-token', 'app-token'],
      fetchImpl,
      warn: (message) => warnings.push(message),
    });
    const response = await read('https://api.github.test/x');
    assert.deepEqual(response, { status: 200, statusLabel: '200', body: { state: 'open' } });
    assert.deepEqual(authorizations, ['Bearer event-token', 'Bearer app-token']);
    assert.deepEqual(warnings, [
      `::warning::GitHub returned HTTP ${status}; retrying metadata read with fallback token.`,
    ]);
  }
});

test('a fallback that resolves to the same credential is not tried twice', async () => {
  const { fetchImpl, authorizations } = stubFetch([{ status: 403 }]);
  const read = createGithubReader({ tokens: ['event-token', 'event-token'], fetchImpl, warn: () => {} });
  const response = await read('https://api.github.test/x');
  assert.deepEqual(authorizations, ['Bearer event-token']);
  assert.equal(response.statusLabel, '403');
  assert.equal(response.body, undefined);
});

test('a status that is not retriable is reported without spending the fallback', async () => {
  for (const status of [404, 422]) {
    const { fetchImpl, authorizations } = stubFetch([{ status }, { status: 200, body: {} }]);
    const read = createGithubReader({ tokens: ['event-token', 'app-token'], fetchImpl, warn: () => {} });
    const response = await read('https://api.github.test/x');
    assert.equal(response.statusLabel, String(status));
    assert.equal(response.body, undefined);
    assert.deepEqual(authorizations, ['Bearer event-token']);
  }
});

test('transient GitHub server errors retry a read with the same credential', async () => {
  const warnings: string[] = [];
  const delays: number[] = [];
  const { fetchImpl, authorizations } = stubFetch([
    { status: 500 }, { status: 503 }, { status: 200, body: { state: 'open' } },
  ]);
  const read = createGithubReader({
    tokens: ['event-token', 'app-token'], fetchImpl,
    warn: (message) => warnings.push(message),
    sleep: async (milliseconds) => { delays.push(milliseconds); },
  });
  assert.deepEqual(await read('https://api.github.test/x'), {
    status: 200, statusLabel: '200', body: { state: 'open' },
  });
  assert.deepEqual(authorizations, ['Bearer event-token', 'Bearer event-token', 'Bearer event-token']);
  assert.deepEqual(delays, [250, 750]);
  assert.deepEqual(warnings, [
    '::warning::GitHub returned HTTP 500; retrying read in 250ms.',
    '::warning::GitHub returned HTTP 503; retrying read in 750ms.',
  ]);
});

test('persistent server errors stop after bounded GET retries and never replay a write', async () => {
  const { fetchImpl, authorizations } = stubFetch([{ status: 500 }]);
  const request = createGithubRequester({
    tokens: ['event-token', 'app-token'], fetchImpl, warn: () => {},
    sleep: async () => {},
  });
  assert.equal((await request('GET', 'https://api.github.test/x')).statusLabel, '500');
  assert.deepEqual(authorizations, ['Bearer event-token', 'Bearer event-token', 'Bearer event-token']);
  assert.equal((await request('POST', 'https://api.github.test/x')).statusLabel, '500');
  assert.equal(authorizations.length, 4);
});

test('no usable credential reports the 000 the shell reported', async () => {
  const { fetchImpl, authorizations } = stubFetch([{ status: 200, body: {} }]);
  const read = createGithubReader({ tokens: [], fetchImpl, warn: () => {} });
  const response = await read('https://api.github.test/x');
  assert.deepEqual(response, { status: 0, statusLabel: '000', body: undefined });
  assert.deepEqual(authorizations, []);
});

test('a transport failure throws rather than being read as a rejection', async () => {
  const fetchImpl = (async () => {
    throw new TypeError('network unreachable');
  }) as unknown as typeof fetch;
  const read = createGithubReader({ tokens: ['event-token'], fetchImpl, warn: () => {} });
  await assert.rejects(() => read('https://api.github.test/x'), GithubTransportError);
});

test('an undecodable 200 body is handed on as undefined for the caller to refuse', async () => {
  const { fetchImpl } = stubFetch([{ status: 200, raw: 'not json' }]);
  const read = createGithubReader({ tokens: ['event-token'], fetchImpl, warn: () => {} });
  const response = await read('https://api.github.test/x');
  assert.deepEqual(response, { status: 200, statusLabel: '200', body: undefined });
});

test('blank credentials are dropped before any request is planned', () => {
  assert.deepEqual(credentialTokens('event', 'app'), ['event', 'app']);
  assert.deepEqual(credentialTokens('event', ''), ['event']);
  assert.deepEqual(credentialTokens('', 'app'), ['app']);
  assert.deepEqual(credentialTokens('', ''), []);
});

test('a write reaches GitHub with its own method and the same credential fallback', async () => {
  const methods: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? '');
    return { status: methods.length === 1 ? 403 : 204, json: async () => undefined } as Response;
  }) as unknown as typeof fetch;
  const request = createGithubRequester({ tokens: ['event', 'app'], fetchImpl, warn: () => {} });
  const response = await request('DELETE', 'https://api.github.test/artifacts/7');
  // 204 carries no body and is returned verbatim for the caller to judge.
  assert.deepEqual(response, { status: 204, statusLabel: '204', body: undefined });
  assert.deepEqual(methods, ['DELETE', 'DELETE']);
});

test('a read is exactly a GET through the same requester', async () => {
  const methods: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? '');
    return { status: 200, json: async () => ({ ok: true }) } as Response;
  }) as unknown as typeof fetch;
  const read = createGithubReader({ tokens: ['event'], fetchImpl, warn: () => {} });
  assert.deepEqual(await read('https://api.github.test/x'), {
    status: 200, statusLabel: '200', body: { ok: true },
  });
  assert.deepEqual(methods, ['GET']);
});

test('each message level renders as the workflow command the shell echoed', () => {
  assert.equal(renderStepMessage(info('plain')), 'plain');
  assert.equal(renderStepMessage(notice('heads up')), '::notice::heads up');
  assert.equal(renderStepMessage(error('broken')), '::error::broken');
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  jqAllElements,
  jqAnyElement,
  jqIndexPresent,
  jqJoin,
  jqLength,
  parseJqDocument,
} from '../src/ios/shared/jqSemantics.ts';
import { StepFailure } from '../src/ios/shared/stepFailure.ts';
import { appendStepOutputs, formatStepOutputs, requiredEnv } from '../src/ios/shared/stepIo.ts';
import {
  conservativeFullCheckFiles,
  fetchPullRequestChangedFiles,
} from '../src/ios/shared/pullRequestFiles.ts';

describe('jq semantics', () => {
  it('measures the containers jq measures and reads a boolean as unmeasurable', () => {
    assert.equal(jqLength(parseJqDocument('["a","b"]')), 2);
    assert.equal(jqLength(parseJqDocument('"abc"')), 3);
    assert.equal(jqLength(parseJqDocument('{"a":1,"b":2}')), 2);
    assert.equal(jqLength(parseJqDocument('null')), 0);
    assert.equal(jqLength(parseJqDocument('-7')), 7);
    assert.equal(jqLength(parseJqDocument('true')), 0);
  });

  it('reads malformed input as the failing filter it was', () => {
    assert.equal(parseJqDocument('not json'), undefined);
    assert.equal(jqLength(parseJqDocument('not json')), 0);
    assert.equal(jqIndexPresent(parseJqDocument('not json'), 'onboarding'), false);
    assert.equal(jqAllElements(parseJqDocument('not json'), () => true), false);
    assert.equal(jqAnyElement(parseJqDocument('not json'), () => true), false);
  });

  it('renders a join the way jq does, and gives up on a nested container', () => {
    assert.equal(jqJoin(['a', 'b'], ', '), 'a, b');
    assert.equal(jqJoin(['a', null, 2, true], ', '), 'a, , 2, true');
    assert.equal(jqJoin([['a']], ', '), '');
    assert.equal(jqJoin('abc', ', '), '');
  });

  it('agrees with jq that an empty array satisfies all and not any', () => {
    assert.equal(jqAllElements([], () => false), true);
    assert.equal(jqAnyElement([], () => true), false);
  });
});

describe('step outputs', () => {
  it('writes a plain value on one line and a delimited value between markers', () => {
    assert.equal(
      formatStepOutputs([
        { key: 'should_run', value: 'true' },
        { key: 'summary', value: 'one\ntwo', delimiter: 'SUMMARY' },
      ]),
      'should_run=true\nsummary<<SUMMARY\none\ntwo\nSUMMARY\n',
    );
  });

  it('keeps an empty delimited value distinguishable from an absent one', () => {
    assert.equal(
      formatStepOutputs([{ key: 'native_changed_files', value: '', delimiter: 'D' }]),
      'native_changed_files<<D\n\nD\n',
    );
  });

  it('appends to an existing file rather than replacing the step output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'example-step-io-'));
    try {
      const outputPath = join(directory, 'github-output');
      appendStepOutputs([{ key: 'first', value: '1' }], outputPath);
      appendStepOutputs([{ key: 'second', value: '2' }], outputPath);
      assert.equal(readFileSync(outputPath, 'utf8'), 'first=1\nsecond=2\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails the step for a missing required variable, as ${VAR:?} did', () => {
    const name = 'EXAMPLE_STEP_IO_ABSENT';
    delete process.env[name];
    assert.throws(
      () => requiredEnv(name),
      (error: unknown) => error instanceof StepFailure && error.stream === 'stderr',
    );
    process.env[name] = '';
    try {
      assert.throws(() => requiredEnv(name), StepFailure);
    } finally {
      delete process.env[name];
    }
  });
});

interface StubResponse {
  readonly status: number;
  readonly body: string;
}

function stubFetch(responses: readonly (StubResponse | Error)[]): {
  readonly impl: typeof fetch;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    const reply = next ?? { status: 500, body: '' };
    return new Response(reply.body, { status: reply.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function page(names: readonly string[]): StubResponse {
  return { status: 200, body: JSON.stringify(names.map((filename) => ({ filename }))) };
}

describe('fetchPullRequestChangedFiles', () => {
  const base = {
    prNumber: '42',
    repository: 'example-org/example-app',
    token: 't',
    fallbackToken: '',
  };

  it('refuses to guess without the pull request metadata it needs', async () => {
    for (const missing of [{ prNumber: '' }, { repository: '' }, { token: '' }]) {
      await assert.rejects(
        fetchPullRequestChangedFiles({ ...base, ...missing, log: () => {} }),
        (error: unknown) => error instanceof StepFailure
          && error.message === 'Missing pull request metadata for iOS change detection.',
      );
    }
  });

  it('pages until a short page and returns the inventory newline-joined', async () => {
    const names = Array.from({ length: 100 }, (_, index) => `ios/File${index}.swift`);
    const { impl, calls } = stubFetch([
      { status: 200, body: JSON.stringify({ changed_files: 101 }) },
      page(names),
      page(['ios/Last.swift']),
    ]);
    const inventory = await fetchPullRequestChangedFiles({
      ...base, fetchImpl: impl, log: () => {},
    });
    assert.equal(inventory.split('\n').length, 101);
    assert.ok(inventory.endsWith('ios/Last.swift'));
    assert.ok(calls[2]?.includes('page=2'));
  });

  it('fails closed when the inventory is shorter than the count GitHub reported', async () => {
    const { impl } = stubFetch([
      { status: 200, body: JSON.stringify({ changed_files: 3 }) },
      page(['ios/One.swift']),
    ]);
    await assert.rejects(
      fetchPullRequestChangedFiles({ ...base, fetchImpl: impl, log: () => {} }),
      (error: unknown) => error instanceof StepFailure
        && error.message === 'Pull request changed-file inventory was incomplete '
          + '(expected 3, received 1); refusing to skip iOS checks.',
    );
  });

  it('fails closed when the changed-file count is missing or not a positive integer', async () => {
    for (const body of ['{}', '{"changed_files":0}', '{"changed_files":"4"}', 'null']) {
      const { impl } = stubFetch([{ status: 200, body }]);
      await assert.rejects(
        fetchPullRequestChangedFiles({ ...base, fetchImpl: impl, log: () => {} }),
        (error: unknown) => error instanceof StepFailure
          && error.message.startsWith('Pull request changed-file metadata was empty or invalid'),
        body,
      );
    }
  });

  it('stops on a status that retrying cannot fix', async () => {
    const { impl, calls } = stubFetch([{ status: 404, body: 'Not Found' }]);
    await assert.rejects(
      fetchPullRequestChangedFiles({ ...base, fetchImpl: impl, log: () => {} }),
      (error: unknown) => error instanceof StepFailure
        && error.message.startsWith('GitHub API request failed with HTTP 404'),
    );
    assert.equal(calls.length, 1, 'a non-retryable status must not be retried');
  });

  it('moves to the fallback credential once, then selects full checks', async () => {
    const notes: string[] = [];
    const { impl, calls } = stubFetch([{ status: 403, body: 'rate limited' }]);
    const inventory = await fetchPullRequestChangedFiles({
      ...base, fallbackToken: 'fallback', fetchImpl: impl, log: (message) => notes.push(message),
    });
    assert.equal(inventory, conservativeFullCheckFiles.join('\n'));
    assert.equal(calls.length, 2, 'one attempt per credential, then the conservative answer');
    assert.ok(notes.some((note) => note.includes('retrying with fallback token')));
    assert.ok(notes.some((note) => note.includes('conservatively selecting full iOS checks')));
  });

  it('ignores a fallback credential identical to the primary one', async () => {
    const { impl, calls } = stubFetch([{ status: 403, body: 'rate limited' }]);
    await fetchPullRequestChangedFiles({
      ...base, fallbackToken: 't', fetchImpl: impl, log: () => {},
    });
    assert.equal(calls.length, 1);
  });

  it('retries a retryable status five times before selecting full checks', async () => {
    const notes: string[] = [];
    const { impl, calls } = stubFetch([{ status: 503, body: 'unavailable' }]);
    const inventory = await fetchPullRequestChangedFiles({
      ...base, fetchImpl: impl, log: (message) => notes.push(message),
    });
    assert.equal(inventory, conservativeFullCheckFiles.join('\n'));
    assert.equal(calls.length, 5);
    assert.ok(notes.some((note) => note.includes('(attempt 4/5)')));
    assert.ok(notes.some((note) => note.includes('GitHub API kept returning HTTP 503')));
  });

  it('retries an unreachable API five times before selecting full checks', async () => {
    const notes: string[] = [];
    const { impl, calls } = stubFetch([new Error('socket hang up')]);
    const inventory = await fetchPullRequestChangedFiles({
      ...base, fetchImpl: impl, log: (message) => notes.push(message),
    });
    assert.equal(inventory, conservativeFullCheckFiles.join('\n'));
    assert.equal(calls.length, 5);
    assert.ok(notes.some(
      (note) => note.includes('GitHub API stayed unreachable (socket hang up)'),
    ));
  });

  it('gives the conservative inventory one owner for every lane', () => {
    assert.equal(conservativeFullCheckFiles.length, 6);
    assert.ok(conservativeFullCheckFiles.every((path) => path.startsWith('ios/')));
  });
});

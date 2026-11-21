import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isTrue,
  isTrustedDispatchRef,
  isTrustedPullRequestSurface,
  orDefault,
  orMissing,
  renderedEnvironmentValue,
} from '../src/ios/shared/jobResults.ts';
import {
  decisionErrors,
  error,
  fail,
  info,
  pass,
  renderStepMessage,
  reportStepDecision,
} from '../src/ios/shared/stepDecision.ts';

describe('iOS status step decisions', () => {
  it('renders an error as a workflow annotation and an info line unchanged', () => {
    assert.equal(renderStepMessage(error('boom')), '::error::boom');
    const literal = '::error:: is not added twice';
    assert.equal(renderStepMessage(info(literal)), literal);
  });

  it('writes every line in order before adopting a failing exit code', () => {
    const written: string[] = [];
    const previous = process.exitCode;
    try {
      reportStepDecision(fail(info('context'), error('why')), (line) => written.push(line));
      assert.deepEqual(written, ['context', '::error::why']);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previous;
    }
  });

  it('leaves the exit code alone for a passing decision', () => {
    const previous = process.exitCode;
    try {
      process.exitCode = 0;
      reportStepDecision(pass(info('fine')), () => {});
      assert.equal(process.exitCode, 0);
    } finally {
      process.exitCode = previous;
    }
  });

  it('collects only the error texts, without the annotation prefix', () => {
    const decision = fail(info('note'), error('first'), error('second'));
    assert.deepEqual(decisionErrors(decision), ['first', 'second']);
    assert.deepEqual(decisionErrors(pass(info('note'))), []);
  });
});

describe('iOS job result helpers', () => {
  it('substitutes only for an empty value, never for a falsy-looking one', () => {
    assert.equal(orMissing(''), 'missing');
    assert.equal(orMissing('failure'), 'failure');
    assert.equal(orMissing('false'), 'false');
    assert.equal(orDefault('', 'skipped'), 'skipped');
    assert.equal(orDefault('0', 'skipped'), '0');
  });

  it('reads only the exact string "true" as true', () => {
    assert.equal(isTrue('true'), true);
    for (const value of ['True', 'TRUE', '1', 'yes', 'false', '']) {
      assert.equal(isTrue(value), false, value);
    }
  });

  it('trusts only the two protected refs, not a tag or a merge ref that names them', () => {
    assert.equal(isTrustedDispatchRef('refs/heads/develop'), true);
    assert.equal(isTrustedDispatchRef('refs/heads/main'), true);
    for (const ref of [
      'refs/heads/develop-fork',
      'refs/heads/feature/main',
      'refs/tags/main',
      'refs/pull/1/merge',
      'develop',
      '',
    ]) {
      assert.equal(isTrustedDispatchRef(ref), false, ref);
    }
  });

  it('requires both a same-repository head and a protected base', () => {
    const repository = 'example-org/example-app';
    assert.equal(
      isTrustedPullRequestSurface({
        headRepository: repository,
        repository,
        baseBranch: 'develop',
      }),
      true,
    );
    for (const surface of [
      { headRepository: 'outside/fork', repository, baseBranch: 'develop' },
      { headRepository: repository, repository, baseBranch: 'release/1.5' },
      { headRepository: '', repository, baseBranch: 'main' },
      { headRepository: repository, repository, baseBranch: '' },
    ]) {
      assert.equal(isTrustedPullRequestSurface(surface), false, JSON.stringify(surface));
    }
  });

  it('renders an absent environment value as the empty string GitHub would supply', () => {
    assert.equal(renderedEnvironmentValue.parse(undefined), '');
    assert.equal(renderedEnvironmentValue.parse('skipped'), 'skipped');
    assert.equal(renderedEnvironmentValue.safeParse(7).success, false);
  });
});

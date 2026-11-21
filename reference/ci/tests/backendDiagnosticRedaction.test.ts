import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diagnosticCopies,
  planDiagnosticCopies,
  redactDiagnosticLog,
} from '../src/ios/backendDiagnosticRedaction.ts';

test('a labelled credential loses its value and keeps its shape', () => {
  assert.equal(
    redactDiagnosticLog('{"authorization": "abc.def-123", "path": "/api/x"}'),
    '{"authorization": "[REDACTED]", "path": "/api/x"}',
  );
  assert.equal(redactDiagnosticLog('token=hunter2 next=1'), 'token=[REDACTED] next=1');
  assert.equal(redactDiagnosticLog('Password = s3cret'), 'Password = [REDACTED]');
  assert.equal(redactDiagnosticLog("cookie:'abc'"), "cookie:'[REDACTED]'");
  assert.equal(redactDiagnosticLog('SECRET : v'), 'SECRET : [REDACTED]');
});

test('every labelled credential in a line is redacted, not only the first', () => {
  assert.equal(
    redactDiagnosticLog('token=a, secret=b, password=c'),
    'token=[REDACTED], secret=[REDACTED], password=[REDACTED]',
  );
});

test('a bearer token with no label is redacted too, and its prefix kept', () => {
  assert.equal(
    redactDiagnosticLog('Authorization: Bearer eyJ0.eXAi-_~+/=abc'),
    // The labelled rule matches first and stops at the space after `Bearer`.
    'Authorization: [REDACTED] eyJ0.eXAi-_~+/=abc',
  );
  assert.equal(redactDiagnosticLog('sent bearer AbC123._~+/=-'), 'sent Bearer [REDACTED]');
  assert.equal(redactDiagnosticLog('Bearer  spaced'), 'Bearer [REDACTED]');
});

test('ordinary log text is untouched', () => {
  for (const line of [
    'GET /api/plaid/link 200 in 43ms',
    'tokenizer produced 12 items',
    'no secrets here',
    '',
  ]) {
    assert.equal(redactDiagnosticLog(line), line);
  }
});

test('a word that merely contains a key name is not a credential', () => {
  // `\b` keeps `authorizationHeader` out: only the whole word is a key.
  assert.equal(redactDiagnosticLog('subtokens=5'), 'subtokens=5');
  assert.equal(redactDiagnosticLog('passwords_table=users'), 'passwords_table=users');
});

test('multi-line content is redacted line by line and nothing is dropped', () => {
  const input = ['start', 'token: abc', 'middle', 'Bearer zzz', 'end'].join('\n');
  assert.equal(
    redactDiagnosticLog(input),
    ['start', 'token: [REDACTED]', 'middle', 'Bearer [REDACTED]', 'end'].join('\n'),
  );
});

test('only the two backend logs are copied, and only when they exist', () => {
  assert.deepEqual(diagnosticCopies.map((copy) => copy.destinationName), [
    'devserver.log', 'devserver-supervisor.log',
  ]);
  const values = {
    ONBOARDING_DEV_BACKEND_LOG: '/run/backend/devserver.log',
    ONBOARDING_DEV_BACKEND_SUPERVISOR_LOG: '/run/backend/devserver-supervisor.log',
  };
  assert.deepEqual(planDiagnosticCopies('/d', values, () => true), [
    { sourcePath: '/run/backend/devserver.log', destinationPath: '/d/devserver.log' },
    { sourcePath: '/run/backend/devserver-supervisor.log', destinationPath: '/d/devserver-supervisor.log' },
  ]);
  assert.deepEqual(
    planDiagnosticCopies('/d', values, (path) => path.endsWith('supervisor.log')),
    [{ sourcePath: '/run/backend/devserver-supervisor.log', destinationPath: '/d/devserver-supervisor.log' }],
  );
  // A lane that never started its backend has neither, and that is not a failure.
  assert.deepEqual(planDiagnosticCopies('/d', {}, () => true), []);
  assert.deepEqual(planDiagnosticCopies('/d', { ONBOARDING_DEV_BACKEND_LOG: '' }, () => true), []);
});

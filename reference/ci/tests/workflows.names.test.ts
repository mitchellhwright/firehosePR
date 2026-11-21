import assert from 'node:assert/strict';
import test from 'node:test';
import { expr } from 'gagen';
import {
  byEvent, jobLiteralName, matrixSuffixed, renderName, renderedLiterals,
  suffixed, validateName,
} from '../workflows/lib/names.ts';

test('names render to what GitHub shows and back to their literals', () => {
  assert.equal(renderName('Lint changed code'), 'Lint changed code');
  assert.equal(String(renderName(matrixSuffixed('Server tests', 'shard'))), 'Server tests (${{ matrix.shard }})');
  assert.equal(
    String(renderName(suffixed('Capture Dependabot base edit', expr('github.event.pull_request.number')))),
    'Capture Dependabot base edit (${{ github.event.pull_request.number }})',
  );
  assert.equal(
    String(renderName(byEvent({ workflow_dispatch: 'Manual - Test suite' }, 'Test suite'))),
    "${{ github.event_name == 'workflow_dispatch' && 'Manual - Test suite' || 'Test suite' }}",
  );
});

test('every literal a name can render is enumerable, with the required-check form first', () => {
  assert.deepEqual(renderedLiterals('Lint changed code'), ['Lint changed code']);
  assert.deepEqual(renderedLiterals(matrixSuffixed('Server tests', 'shard')), ['Server tests']);
  assert.deepEqual(
    renderedLiterals(byEvent({ workflow_dispatch: 'Manual - Test suite' }, 'Test suite')),
    ['Test suite', 'Manual - Test suite'],
  );
  assert.equal(jobLiteralName('Server tests (1/4)'), 'Server tests');
  assert.equal(jobLiteralName('Install runner cleanup hook (host-instaip2)'), 'Install runner cleanup hook');
  assert.equal(jobLiteralName('Lint changed code'), 'Lint changed code');
});

test('readability is enforced on every literal, not just the first', () => {
  assert.deepEqual(validateName('Lint changed code'), []);
  assert.deepEqual(validateName(matrixSuffixed('Server tests', 'shard')), []);
  assert.match(validateName('lint')[0] ?? '', /too generic/);
  assert.match(validateName('Run scripts/build.sh')[0] ?? '', /source filename/);
  assert.match(validateName('ab')[0] ?? '', />=3 characters/);
  assert.match(validateName({ literal: 'run', suffix: expr('matrix.x') })[0] ?? '', /too generic/);
  // The fallback reads fine; the dispatch form does not, and both are shown.
  assert.match(validateName(byEvent({ workflow_dispatch: 'run' }, 'Validate the changes'))[0] ?? '', /"run"/);
});

test('the required-context exemption covers the one declared literal and nothing else', () => {
  const name = byEvent({ workflow_dispatch: 'Manual - Test - iOS' }, 'Test - iOS');
  // Undeclared, the context is just another generic name.
  assert.match(validateName(name)[0] ?? '', /too generic/);
  assert.deepEqual(validateName(name, 'Test - iOS'), []);

  // A generic name that is not the declared context stays rejected, including
  // when some other literal of the same name is the one that was declared.
  assert.match(validateName('lint', 'Test - iOS')[0] ?? '', /too generic/);
  assert.match(
    validateName(byEvent({ workflow_dispatch: 'checkout' }, 'Test - iOS'), 'Test - iOS')[0] ?? '',
    /"checkout"/,
  );
  // The exemption lifts the generic clause alone; the rest of the rule holds.
  assert.match(validateName('ab', 'ab')[0] ?? '', />=3 characters/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { runEntitlementRepositoryTests } from '../src/actions/runEntitlementRepositoryTests.ts';
import { distributedDatabaseSuites, wellnessSuites } from '../src/databaseLaneSuites.ts';
import { runDatabaseIntegrationValidation } from '../src/databaseIntegrationValidation.ts';
import { runtimeDatabaseSuites } from '../src/targetedServerTests.ts';

test('entitlement acceptance fails before starting Vitest without its isolated database URL', () => {
  const previous = process.env.ENTITLEMENT_TEST_DATABASE_URL;
  delete process.env.ENTITLEMENT_TEST_DATABASE_URL;
  try {
    assert.throws(runEntitlementRepositoryTests, /ENTITLEMENT_TEST_DATABASE_URL is required/);
  } finally {
    if (previous === undefined) delete process.env.ENTITLEMENT_TEST_DATABASE_URL;
    else process.env.ENTITLEMENT_TEST_DATABASE_URL = previous;
  }
});

test('selected database suites run before entitlement acceptance', () => {
  const calls: string[] = [];
  const status = runDatabaseIntegrationValidation(
    '["server/tests/example.integration.test.ts"]', 'true',
    () => { calls.push('targeted'); return 0; },
    () => { calls.push('entitlement'); return 0; },
  );
  assert.equal(status, 0);
  assert.deepEqual(calls, ['targeted', 'entitlement']);
});

test('database suites already proved by earlier job steps are not rerun', () => {
  const previouslyVerified = [wellnessSuites[0], distributedDatabaseSuites[0], runtimeDatabaseSuites[0]];
  const freshSuite = 'server/tests/newDatabaseContract.integration.test.ts';
  const selections: string[] = [];
  const status = runDatabaseIntegrationValidation(
    JSON.stringify([...previouslyVerified, freshSuite]), 'false',
    (selection) => { selections.push(selection ?? ''); return 0; },
    () => { throw new Error('entitlement acceptance should not run'); },
  );
  assert.equal(status, 0);
  assert.deepEqual(selections, [JSON.stringify([freshSuite])]);
});

test('a fully verified targeted selection still satisfies the gate without rerunning tests', () => {
  let entitlementRuns = 0;
  const status = runDatabaseIntegrationValidation(
    JSON.stringify([distributedDatabaseSuites[0]]), 'true',
    () => { throw new Error('verified suite should not run twice'); },
    () => { entitlementRuns += 1; return 0; },
  );
  assert.equal(status, 0);
  assert.equal(entitlementRuns, 1);
});

test('entitlement acceptance runs even without targeted integration suites', () => {
  const status = runDatabaseIntegrationValidation(
    '[]', 'true',
    () => { throw new Error('targeted suite should not run'); },
    () => 7,
  );
  assert.equal(status, 7);
});

test('targeted integration suites run without entitlement acceptance when it is not selected', () => {
  const status = runDatabaseIntegrationValidation(
    '["server/tests/example.integration.test.ts"]', 'false',
    () => 0,
    () => { throw new Error('entitlement acceptance should not run'); },
  );
  assert.equal(status, 0);
});

test('a failing targeted suite stops before entitlement acceptance', () => {
  const status = runDatabaseIntegrationValidation(
    '["server/tests/example.integration.test.ts"]', 'true',
    () => 3,
    () => { throw new Error('entitlement acceptance should not run'); },
  );
  assert.equal(status, 3);
});

test('missing or malformed selection cannot turn the database lane green', () => {
  for (const [targets, entitlement] of [
    ['[]', 'false'], ['[', 'true'], ['{}', 'true'], ['[]', undefined],
  ] as const) {
    assert.throws(() => runDatabaseIntegrationValidation(
      targets, entitlement,
      () => { throw new Error('unexpected targeted run'); },
      () => { throw new Error('unexpected entitlement run'); },
    ));
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

import {
  distributedDatabaseSuites, requiredSuiteFailures, testDistributedDatabaseState,
  verifyWellnessDatabases, wellnessEventMigration, wellnessSuites,
} from '../src/databaseLaneSuites.ts';
import type { CommandResult, RunOptions } from '../src/ios/shared/processRunner.ts';
import { workflowJob } from '../src/workflowStepShell.ts';

const stepSchema = z.object({
  name: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
const jobSchema = z.object({
  'runs-on': z.string(),
  if: z.string().optional(),
  steps: z.array(stepSchema),
}).passthrough();

function databaseJob(): z.infer<typeof jobSchema> {
  return jobSchema.parse(workflowJob('pr-checks.yml', 'database-integration'));
}

function typedEntry(stepName: string): unknown {
  const step = databaseJob().steps.find((candidate) => candidate.name === stepName);
  assert.ok(step, stepName);
  assert.equal(step.uses, './.github/actions/typed-step-runner', stepName);
  return step.with?.['entry'];
}

interface Call { readonly command: string; readonly args: readonly string[]; readonly options: RunOptions }

const laneEnv = {
  DB_CONTAINER_CMD: 'sudo -n docker',
  DB_CONTAINER_NAME: 'gh-actions-pg-database-integration-7-1',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:49153/example',
  RUNNER_TEMP: '/runner/temp',
};

/** A fake process boundary: every command succeeds unless `status` says otherwise. */
function recorder(status: (call: Call) => number = () => 0) {
  const calls: Call[] = [];
  const run = async (command: string, args: readonly string[], options: RunOptions = {}): Promise<CommandResult> => {
    const call = { command, args, options };
    calls.push(call);
    return { status: status(call), stdout: '', stderr: '' };
  };
  return { calls, run };
}

function passingReport(suites: readonly string[]): { testResults: { name: string; assertionResults: { status: string }[] }[] } {
  return {
    testResults: suites.map((suite) => ({
      name: `/workspace/${suite}`, assertionResults: [{ status: 'passed' }],
    })),
  };
}

test('database acceptance uses the selected isolated Linux route and required SQL setup', () => {
  const planner = z.object({ steps: z.array(stepSchema) })
    .parse(workflowJob('pr-checks.yml', 'plan-pr-validation'));
  const selection = planner.steps.find((candidate) =>
    candidate.name === 'Select free external capacity or hosted overflow');
  assert.ok(selection);
  assert.equal(selection.run, 'node ci/src/actions/selectPrLinuxRunners.ts');
  assert.match(String(selection.env?.PR_DATABASE_RUNNER_LABELS),
    /example-lane.*ARM64.*docker-capable.*linux-remote/);
  assert.match(String(selection.env?.PR_PORTABLE_RUNNER_LABELS),
    /example-lane.*linux-remote/);
  assert.equal(selection.env?.CI_HOSTED_LINUX_AVAILABLE,
    "${{ vars.CI_HOSTED_LINUX_AVAILABLE || '0' }}");
  const database = databaseJob();
  assert.equal(database['runs-on'],
    '${{ fromJson(needs.plan-pr-validation.outputs.pr_database_runner_labels) }}');
  assert.ok(database.if?.includes("needs.plan-pr-validation.outputs.database_required == 'true'"));
  const names = database.steps.map((candidate) => candidate.name);
  assert.ok(names.includes('Start isolated PostgreSQL'));
  const migrationIndex = names.indexOf('Apply Drizzle migrations');
  const schemaIndex = names.indexOf('Verify Plaid scheduler schema');
  assert.notEqual(migrationIndex, -1, 'database lane must apply Drizzle migrations');
  assert.notEqual(schemaIndex, -1, 'database lane must verify the Plaid scheduler schema');
  assert.ok(migrationIndex < schemaIndex, 'migrations must run before schema verification');
  assert.equal(database.steps[migrationIndex]?.run, 'npm run db:migrate');
  assert.equal(typedEntry('Test distributed database state'),
    'ci/src/actions/testDistributedDatabaseState.ts');
  for (const name of [
    'appleAuthorization.postgres.integration.test.ts',
    'verificationCodeService.postgres.integration.test.ts',
    'webSession.postgres.integration.test.ts',
    'plaidSyncAttemptFencing.integration.test.ts',
    'plaidReconnectRecovery.integration.test.ts',
    'profileUpdateConfirmation.integration.test.ts',
    'spendingQuestionReadinessCache.integration.test.ts',
    'connectedAccountCoverageHomeAssets.integration.test.ts',
    'stagingQaFixturePostgres.integration.test.ts',
    'userProfileDisconnectMortgageAssignments.postgres.integration.test.ts',
    'notificationHistoryPostgres.integration.test.ts',
    'vehicleLoanAssignmentPostgres.integration.test.ts',
    'notificationReceiptsPostgres.integration.test.ts',
    'notificationPolicyPostgres.integration.test.ts',
    'notificationDeliveryPostgres.integration.test.ts',
    'notificationReportingPostgres.integration.test.ts',
    'investmentHoldingsSnapshotsPostgres.integration.test.ts',
  ]) assert.ok(distributedDatabaseSuites.some((suite) => suite.endsWith(`/${name}`)), name);
  const selected = database.steps.find(step => step.name === 'Run selected database acceptance tests');
  assert.equal(selected?.env?.VEHICLE_LINK_TEST_DATABASE_URL, '${{ env.DATABASE_URL }}');
  assert.equal(selected?.env?.REQUIRE_VEHICLE_LINK_POSTGRES_TESTS, '1');
  const plaid = readFileSync(new URL('../../server/tests/plaidSyncAttemptFencing.integration.test.ts',
    import.meta.url), 'utf8');
  assert.match(plaid, /import '\.\/plaidSnapshotRepositoryPostgresSuite';/);
  assert.match(plaid, /import '\.\/plaidTransactionWindowPostgres\.integration\.test';/);
});

test('distributed database suites run once each with their database opt-ins', async () => {
  assert.equal(new Set(distributedDatabaseSuites).size, distributedDatabaseSuites.length);
  const { calls, run } = recorder();
  const status = await testDistributedDatabaseState({
    run, env: laneEnv, read: () => JSON.stringify(passingReport(distributedDatabaseSuites)),
  });
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
  const [vitest] = calls;
  assert.ok(vitest);
  assert.equal(vitest.command, 'npx');
  assert.deepEqual(vitest.args, [
    'vitest', 'run', '--config', 'server/vitest.config.ts', ...distributedDatabaseSuites,
    '--reporter=default', '--reporter=json', `--outputFile=${join(laneEnv.RUNNER_TEMP, 'notification-results.json')}`,
  ]);
  for (const variable of [
    'VEHICLE_LINK_TEST_DATABASE_URL',
    'PLAID_SYNC_ATTEMPT_TEST_DATABASE_URL', 'STAGING_QA_FIXTURE_TEST_DATABASE_URL',
    'AUTH_CODE_TEST_DATABASE_URL', 'APPLE_AUTH_TEST_DATABASE_URL', 'NOTIFICATION_TEST_DATABASE_URL',
  ]) assert.equal(vitest.options.env?.[variable], laneEnv.DATABASE_URL, variable);
  for (const flag of [
    'REQUIRE_VEHICLE_LINK_POSTGRES_TESTS',
    'RUN_INTEGRATION_TESTS', 'REQUIRE_NOTIFICATION_POSTGRES_TESTS', 'REQUIRE_INSTALLMENT_POSTGRES_TESTS',
  ]) assert.equal(vitest.options.env?.[flag], '1', flag);
});

test('a failed Vitest run keeps its status and is not read as a report', async () => {
  const { run } = recorder(() => 3);
  const status = await testDistributedDatabaseState({
    run, env: laneEnv, read: () => { throw new Error('a failed run has no report to validate'); },
  });
  assert.equal(status, 3);
});

test('distributed database validator rejects missing, empty, skipped, and failed suites', async () => {
  const run = recorder().run;
  const attempt = (report: unknown) => testDistributedDatabaseState({
    run, env: laneEnv, read: () => JSON.stringify(report),
  });
  for (const status of ['pending', 'todo', 'skipped', 'failed']) {
    const report = passingReport(distributedDatabaseSuites);
    report.testResults[0] = { name: `/workspace/${distributedDatabaseSuites[0]}`, assertionResults: [{ status }] };
    await assert.rejects(attempt(report), /Skipped\/deferred\/failed database execution: server\/tests\/appleAuthorization/, status);
  }
  const empty = passingReport(distributedDatabaseSuites);
  empty.testResults[0] = { name: `/workspace/${distributedDatabaseSuites[0]}`, assertionResults: [] };
  await assert.rejects(attempt(empty), /Missing or empty database suite: server\/tests\/appleAuthorization/);
  const missing = passingReport(distributedDatabaseSuites.slice(1));
  await assert.rejects(attempt(missing), /Missing or empty database suite: server\/tests\/appleAuthorization/);
  await assert.rejects(attempt({ testResults: 'not a list' }));
});

for (const suite of [
  'server/tests/vehicleLoanAssignmentPostgres.integration.test.ts',
  'server/tests/investmentHoldingsSnapshotsPostgres.integration.test.ts',
] as const) {
  test(`${suite} cannot disappear or skip in an otherwise passing database report`, async () => {
    const attempt = (report: unknown) => testDistributedDatabaseState({
      run: recorder().run, env: laneEnv, read: () => JSON.stringify(report),
    });
    const skippedMessage = `Skipped/deferred/failed database execution: ${suite}`;
    for (const status of ['pending', 'todo', 'skipped', 'failed']) {
      const report = passingReport(distributedDatabaseSuites);
      const result = report.testResults.find((entry) => entry.name === `/workspace/${suite}`);
      assert.ok(result, `${suite} must be selected`);
      result.assertionResults = [{ status }];
      await assert.rejects(attempt(report), { message: skippedMessage });
    }
    const empty = passingReport(distributedDatabaseSuites);
    const result = empty.testResults.find((entry) => entry.name === `/workspace/${suite}`);
    assert.ok(result);
    result.assertionResults = [];
    const missingMessage = `Missing or empty database suite: ${suite}`;
    await assert.rejects(attempt(empty), { message: missingMessage });
    const missing = passingReport(distributedDatabaseSuites.filter((entry) => entry !== suite));
    await assert.rejects(attempt(missing), { message: missingMessage });
  });
}

test('suite failures name every offending suite, matched by repository path', () => {
  const suites = ['server/tests/a.test.ts', 'server/tests/integration/b.test.ts', 'server/tests/c.test.ts'];
  assert.deepEqual(requiredSuiteFailures({
    testResults: [
      { name: '/w/server/tests/a.test.ts', assertionResults: [{ status: 'passed' }, { status: 'skipped' }] },
      // Same basename in another directory must not satisfy the required suite.
      { name: '/w/server/tests/b.test.ts', assertionResults: [{ status: 'passed' }] },
      { name: '/w/server/tests/c.test.ts', assertionResults: [{ status: 'passed' }] },
    ],
  }, suites, 'database'), [
    'Skipped/deferred/failed database execution: server/tests/a.test.ts',
    'Missing or empty database suite: server/tests/integration/b.test.ts',
  ]);
});

test('Wellness runs isolated PostgreSQL suites and rejects skipped or empty reports', async () => {
  assert.equal(typedEntry('Verify Wellness migrations and event round trips without skips'),
    'ci/src/actions/verifyWellnessDatabases.ts');
  const { calls, run } = recorder();
  const status = await verifyWellnessDatabases({
    run, env: laneEnv, read: () => JSON.stringify(passingReport(wellnessSuites)),
  });
  assert.equal(status, 0);
  const psql = ['-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d'];
  const container = laneEnv.DB_CONTAINER_NAME;
  assert.deepEqual(calls.slice(0, 4).map(({ command, args, options }) => ({
    command, args, stdinFile: options.stdinFile,
  })), [
    { command: 'sudo', args: ['-n', 'docker', 'exec', container, 'psql', ...psql, 'example', '-c', 'CREATE DATABASE wellness_4740_test'], stdinFile: undefined },
    { command: 'sudo', args: ['-n', 'docker', 'exec', container, 'psql', ...psql, 'example', '-c', 'CREATE DATABASE wellness_events_4740_test'], stdinFile: undefined },
    { command: 'sudo', args: ['-n', 'docker', 'exec', container, 'psql', ...psql, 'wellness_events_4740_test', '-c', 'CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY)'], stdinFile: undefined },
    { command: 'sudo', args: ['-n', 'docker', 'exec', '-i', container, 'psql', ...psql, 'wellness_events_4740_test'], stdinFile: wellnessEventMigration },
  ]);
  assert.equal(wellnessEventMigration, 'server/db/migrations/0035_spending_snapshot_rebuild_obligations.sql');
  const vitest = calls[4];
  assert.ok(vitest);
  assert.deepEqual(vitest.args, [
    'vitest', 'run', '--config', 'server/vitest.config.ts', ...wellnessSuites,
    '--reporter=default', '--reporter=json', `--outputFile=${join(laneEnv.RUNNER_TEMP, 'wellness-results.json')}`,
  ]);
  const server = 'postgresql://postgres:postgres@127.0.0.1:49153';
  assert.equal(vitest.options.env?.['DATABASE_URL'], `${server}/wellness_events_4740_test`);
  assert.equal(vitest.options.env?.['WELLNESS_TEST_DATABASE_URL'], `${server}/wellness_4740_test`);
  assert.equal(vitest.options.env?.['WELLNESS_EVENT_TEST_DATABASE_URL'], `${server}/wellness_events_4740_test`);

  const insights = readFileSync(new URL('../../server/tests/exampleInsightsService.test.ts',
    import.meta.url), 'utf8');
  const roundtrip = insights.match(
    /it\.runIf\(Boolean\(process\.env\.WELLNESS_EVENT_TEST_DATABASE_URL\)\)\('reloads actual PostgreSQL event writes[\s\S]*?\n {8}\}\);/,
  );
  assert.ok(roundtrip?.[0]);
  assert.match(roundtrip[0],
    /const eventUserId = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';/i);
  assert.match(roundtrip[0], /markSpendingSnapshotMonthsDirty\(/);
  assert.match(roundtrip[0], /listDirtySpendingSnapshotMonths\(eventUserId, pool\)/);
  assert.match(roundtrip[0], /generateOrchestratedGuidance\(eventUserId,/);
  assert.doesNotMatch(roundtrip[0], /generateOrchestratedGuidance\('u1',/);

  for (const status of ['pending', 'todo', 'failed', 'empty', 'missing']) {
    const report = status === 'missing' ? { testResults: [] } : {
      testResults: wellnessSuites.map((suite) => ({
        name: `/workspace/${suite}`, assertionResults: status === 'empty' ? [] : [{ status }],
      })),
    };
    await assert.rejects(verifyWellnessDatabases({
      run: recorder().run, env: laneEnv, read: () => JSON.stringify(report),
    }), /Wellness (suite|execution)/, status);
  }
});

test('a failed Wellness SQL setup stops before any suite runs', async () => {
  const { calls, run } = recorder((call) => (call.args.at(-1) === 'CREATE DATABASE wellness_events_4740_test' ? 1 : 0));
  await assert.rejects(verifyWellnessDatabases({ run, env: laneEnv, read: () => '{}' }),
    /psql on example failed with exit 1: CREATE DATABASE wellness_events_4740_test/);
  assert.equal(calls.some((call) => call.command === 'npx'), false);
});

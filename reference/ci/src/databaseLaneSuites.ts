import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requiredEnv } from './ios/shared/githubStepIo.ts';
import type { RunProcess } from './ios/shared/processRunner.ts';
import {
  applySqlFile, createSiblingDatabase, executeSql, laneDatabase, type ExportEnv,
} from './isolatedPostgresql.ts';
import {
  runTargetedServerTests, runtimeDatabaseSuites, vitestReport, type SpawnTargetedTests,
} from './targetedServerTests.ts';

/**
 * The server suites the database lane runs against its own PostgreSQL.
 *
 * Each suite list is both what Vitest executes and what the report must show
 * ran: a database suite that silently skips (missing opt-in or database URL)
 * or collects zero tests proves nothing, so either is a failure.
 */

type ServerSuite = `server/tests/${string}.test.ts`;

/** Apple revocation, session, notification, Plaid and profile suites that only a real database can answer. */
export const distributedDatabaseSuites = [
  'server/tests/appleAuthorization.postgres.integration.test.ts',
  'server/tests/verificationCodeService.postgres.integration.test.ts',
  'server/tests/webSession.postgres.integration.test.ts',
  'server/tests/plaidSyncAttemptFencing.integration.test.ts',
  'server/tests/plaidReconnectRecovery.integration.test.ts',
  'server/tests/integration/profileUpdateConfirmation.integration.test.ts',
  'server/tests/integration/spendingQuestionReadinessCache.integration.test.ts',
  'server/tests/connectedAccountCoverageHomeAssets.integration.test.ts',
  'server/tests/stagingQaFixturePostgres.integration.test.ts',
  'server/tests/notificationHistoryPostgres.integration.test.ts',
  'server/tests/vehicleLoanAssignmentPostgres.integration.test.ts',
  'server/tests/installmentDueObservationPostgres.integration.test.ts',
  'server/tests/investmentHoldingsSnapshotsPostgres.integration.test.ts',
  'server/tests/notificationReceiptsPostgres.integration.test.ts',
  'server/tests/notificationPolicyPostgres.integration.test.ts',
  'server/tests/notificationDeliveryPostgres.integration.test.ts',
  'server/tests/notificationReportingPostgres.integration.test.ts',
  'server/tests/notificationEvaluationPostgres.integration.test.ts',
  'server/tests/userProfileDisconnectMortgageAssignments.postgres.integration.test.ts',
] as const satisfies readonly ServerSuite[];

export const wellnessSuites = [
  'server/tests/wellnessStateRepository.integration.test.ts',
  'server/tests/exampleInsightsService.test.ts',
] as const satisfies readonly ServerSuite[];

export const wellnessDatabases = {
  state: 'wellness_4740_test',
  events: 'wellness_events_4740_test',
} as const;
export const wellnessEventMigration = 'server/db/migrations/0035_spending_snapshot_rebuild_obligations.sql';

/** The private databases the conversation runtime suites connect to, and the variable naming each. */
export const runtimeDatabases = [
  { name: 'runtime_sql_qa', variable: 'RUNTIME_POSTGRES_TEST_URL' },
  { name: 'runtime_preparation_qa', variable: 'RUNTIME_PREPARATION_TEST_URL' },
  { name: 'runtime_pending_qa', variable: 'RUNTIME_PENDING_TEST_URL' },
] as const;

export interface RequiredSuites {
  /** How failures name the suites: "database" or "Wellness". */
  readonly label: string;
  readonly suites: readonly ServerSuite[];
  /** The Vitest JSON report, under `RUNNER_TEMP`. */
  readonly report: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface SuiteIo {
  readonly run: RunProcess;
  readonly read: (path: string) => string;
  readonly env: NodeJS.ProcessEnv;
}

/** Every required suite the report shows missing, empty, or with an assertion that did not pass. */
export function requiredSuiteFailures(report: unknown, suites: readonly string[], label: string): string[] {
  const results = vitestReport.parse(report).testResults ?? [];
  return suites.flatMap((suite) => {
    const assertions = results.find((result) => result.name?.endsWith(suite))?.assertionResults ?? [];
    if (assertions.length === 0) return [`Missing or empty ${label} suite: ${suite}`];
    return assertions.every((assertion) => assertion.status === 'passed')
      ? []
      : [`Skipped/deferred/failed ${label} execution: ${suite}`];
  });
}

export async function runRequiredSuites(plan: RequiredSuites, io: SuiteIo): Promise<number> {
  const resultsFile = join(requiredEnv('RUNNER_TEMP', io.env), plan.report);
  const vitest = await io.run('npx', [
    'vitest', 'run', '--config', 'server/vitest.config.ts', ...plan.suites,
    '--reporter=default', '--reporter=json', `--outputFile=${resultsFile}`,
  ], { env: { ...io.env, ...plan.env } });
  if (vitest.status !== 0) return vitest.status;
  const report = JSON.parse(io.read(resultsFile)) as unknown;
  const failures = requiredSuiteFailures(report, plan.suites, plan.label);
  if (failures.length > 0) throw new Error(failures.join('; '));
  return 0;
}

/** Applies the Wellness event migration to private databases and runs its suites without skips. */
export async function verifyWellnessDatabases(io: SuiteIo): Promise<number> {
  const lane = laneDatabase(io.env, io.run);
  const stateUrl = await createSiblingDatabase(lane, wellnessDatabases.state);
  const eventsUrl = await createSiblingDatabase(lane, wellnessDatabases.events);
  await executeSql(lane, wellnessDatabases.events, 'CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY)');
  await applySqlFile(lane, wellnessDatabases.events, wellnessEventMigration);
  return runRequiredSuites({
    label: 'Wellness',
    suites: wellnessSuites,
    report: 'wellness-results.json',
    env: {
      DATABASE_URL: eventsUrl,
      WELLNESS_TEST_DATABASE_URL: stateUrl,
      WELLNESS_EVENT_TEST_DATABASE_URL: eventsUrl,
    },
  }, io);
}

export function testDistributedDatabaseState(io: SuiteIo): Promise<number> {
  const databaseUrl = requiredEnv('DATABASE_URL', io.env);
  return runRequiredSuites({
    label: 'database',
    suites: distributedDatabaseSuites,
    report: 'notification-results.json',
    env: {
      VEHICLE_LINK_TEST_DATABASE_URL: databaseUrl,
      REQUIRE_VEHICLE_LINK_POSTGRES_TESTS: '1',
      PLAID_SYNC_ATTEMPT_TEST_DATABASE_URL: databaseUrl,
      STAGING_QA_FIXTURE_TEST_DATABASE_URL: databaseUrl,
      AUTH_CODE_TEST_DATABASE_URL: databaseUrl,
      APPLE_AUTH_TEST_DATABASE_URL: databaseUrl,
      NOTIFICATION_TEST_DATABASE_URL: databaseUrl,
      RUN_INTEGRATION_TESTS: '1',
      REQUIRE_NOTIFICATION_POSTGRES_TESTS: '1',
      REQUIRE_INSTALLMENT_POSTGRES_TESTS: '1',
    },
  }, io);
}

export type RunTargeted = (selection: string, resultsFile: string, env: NodeJS.ProcessEnv) => number;

/** The targeted-suite runner and its validation, with the runtime database URLs in its environment. */
export const runTargetedWithEnvironment: RunTargeted = (selection, resultsFile, env) => {
  const spawn: SpawnTargetedTests = (command, args, options) =>
    spawnSync(command, [...args], { ...options, env });
  return runTargetedServerTests(selection, spawn, existsSync, resultsFile);
};

export interface RuntimeIo {
  readonly run: RunProcess;
  readonly env: NodeJS.ProcessEnv;
  readonly exportEnv: ExportEnv;
  readonly runTargeted: RunTargeted;
}

/**
 * Creates each runtime database, exports its URL for the selected acceptance
 * step, and runs the runtime suites, which may not skip, against them.
 */
export async function prepareConversationRuntimeDatabases(io: RuntimeIo): Promise<number> {
  const lane = laneDatabase(io.env, io.run);
  const urls: Record<string, string> = {};
  for (const { name, variable } of runtimeDatabases) {
    const url = await createSiblingDatabase(lane, name);
    io.exportEnv({ [variable]: url });
    urls[variable] = url;
  }
  const resultsFile = join(requiredEnv('RUNNER_TEMP', io.env), 'runtime-persistence-results.json');
  return io.runTargeted(JSON.stringify(runtimeDatabaseSuites), resultsFile, { ...io.env, ...urls });
}

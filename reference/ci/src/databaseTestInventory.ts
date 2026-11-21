/**
 * Runtime routing for isolated PostgreSQL suites. The database acceptance
 * lane owns its separate execution list in databaseLaneSuites.ts. The runtime
 * JSON is generated from this inventory because the trusted planner reads
 * the PR head as data; it must never execute untrusted PR TypeScript.
 */
type DatabaseTestRegistration = {
  readonly path: `server/tests/${string}.test.ts`;
};

const databaseTests = [
  { path: 'server/tests/appleAuthorization.postgres.integration.test.ts' },
  { path: 'server/tests/plaidReconnectRecovery.integration.test.ts' },
  { path: 'server/tests/installmentDueObservationPostgres.integration.test.ts' },
  { path: 'server/tests/investmentHoldingsSnapshotsPostgres.integration.test.ts' },
  { path: 'server/tests/notificationEvaluationPostgres.integration.test.ts' },
  { path: 'server/tests/activeConditionCompleteness.integration.test.ts' },
  { path: 'server/tests/adminAuthorization.integration.test.ts' },
  { path: 'server/tests/aiCategorizationService.integration.test.ts' },
  { path: 'server/tests/aiUnlinkedAccounts.integration.test.ts' },
  { path: 'server/tests/alerts.integration.test.ts' },
  { path: 'server/tests/contributionConsistency.integration.test.ts' },
  { path: 'server/tests/conversationRuntimeSql.integration.test.ts' },
  { path: 'server/tests/creditCardAlertHistory.integration.test.ts' },
  { path: 'server/tests/dashboardCardRecommendations.integration.test.ts' },
  { path: 'server/tests/dashboardCashflowEndpoints.integration.test.ts' },
  { path: 'server/tests/dashboardCoverageItemHydration.integration.test.ts' },
  { path: 'server/tests/durableChatPendingState.integration.test.ts' },
  { path: 'server/tests/getHomeSaleEstimate.integration.test.ts' },
  { path: 'server/tests/investmentAccountDetails.integration.test.ts' },
  { path: 'server/tests/mortgagePlanConfirmation.postgres.integration.test.ts' },
  { path: 'server/tests/notificationReportingPostgres.integration.test.ts' },
  { path: 'server/tests/plaidAccountDeduplication.integration.test.ts' },
  { path: 'server/tests/plaidTransactionWindowPostgres.integration.test.ts' },
  { path: 'server/tests/profilePreparationDatabase.test.ts' },
  { path: 'server/tests/schema/creditLimits.schema.test.ts' },
  { path: 'server/tests/spendingSnapshotObligations.postgres.integration.test.ts' },
  { path: 'server/tests/typedSelectRaw.integration.test.ts' },
  { path: 'server/tests/wellnessStateRepository.integration.test.ts' },
  { path: 'server/tests/chatMessageRating.postgres.integration.test.ts' },
  { path: 'server/tests/integration/budgetCategoryDeletionPersistence.integration.test.ts' },
  { path: 'server/tests/vehicleLoanAssignmentPostgres.integration.test.ts' },
  { path: 'server/tests/webChatActionEndpoints.integration.test.ts' },
] as const satisfies readonly DatabaseTestRegistration[];

export function serverTestRuntimeManifest(): {
  readonly schema: 'example.server-test-runtimes.v1';
  readonly tests: ReadonlyArray<{ readonly path: string; readonly profile: 'isolated-postgres' }>;
} {
  return {
    schema: 'example.server-test-runtimes.v1',
    tests: databaseTests
      .map((test) => ({ path: test.path, profile: 'isolated-postgres' as const }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  };
}

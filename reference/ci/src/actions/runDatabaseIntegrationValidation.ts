import { runDatabaseIntegrationValidation } from '../databaseIntegrationValidation.ts';

try {
  process.exitCode = runDatabaseIntegrationValidation(
    process.env['TARGETED_SERVER_TESTS_JSON'],
    process.env['ENTITLEMENT_ACCEPTANCE_REQUIRED'],
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

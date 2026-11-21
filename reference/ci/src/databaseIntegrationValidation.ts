import { runEntitlementRepositoryTests } from './actions/runEntitlementRepositoryTests.ts';
import { distributedDatabaseSuites, wellnessSuites } from './databaseLaneSuites.ts';
import { parseTargetedServerTests, runTargetedServerTests, runtimeDatabaseSuites } from './targetedServerTests.ts';

/** Earlier steps in this same job require every assertion in these suites to pass. */
const alreadyVerifiedSuites: ReadonlySet<string> = new Set([
  ...wellnessSuites,
  ...distributedDatabaseSuites,
  ...runtimeDatabaseSuites,
]);

/** Runs each database obligation selected by the PR gate, in dependency order. */
export function runDatabaseIntegrationValidation(
  targetedTestsJson: string | undefined,
  entitlementRequired: string | undefined,
  runTargeted: (value: string | undefined) => number = runTargetedServerTests,
  runEntitlement: () => number = runEntitlementRepositoryTests,
): number {
  if (entitlementRequired !== 'true' && entitlementRequired !== 'false') {
    throw new Error('ENTITLEMENT_ACCEPTANCE_REQUIRED must be true or false.');
  }
  let selected: unknown;
  try {
    selected = JSON.parse(targetedTestsJson ?? '');
  } catch (error) {
    throw new Error('Targeted integration tests must be valid JSON.', { cause: error });
  }
  if (!Array.isArray(selected)) throw new Error('Targeted integration tests must be an array.');
  if (selected.length === 0 && entitlementRequired === 'false') {
    throw new Error('No database integration validation was selected.');
  }
  if (selected.length > 0) {
    const targets = parseTargetedServerTests(targetedTestsJson);
    const remaining = targets.filter((target) => !alreadyVerifiedSuites.has(target));
    if (remaining.length > 0) {
      const status = runTargeted(JSON.stringify(remaining));
      if (status !== 0) return status;
    }
  }
  return entitlementRequired === 'true' ? runEntitlement() : 0;
}

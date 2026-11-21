/** TypeScript suites selected for the Workflow contracts lane. */
type TypedWorkflowContractTest = `ci/tests/${string}.test.ts`;

export const typedWorkflowContractTests = [
  'ci/tests/chatPlaidLane.test.ts',
  'ci/tests/devE2eSchemaWorkflow.test.ts',
  'ci/tests/iosAffectedEvidenceSelection.test.ts',
  'ci/tests/retainedNativeWorkflow.test.ts',
  'ci/tests/testFlightEvidenceWorkflow.test.ts',
  'ci/tests/workflowContractInventory.test.ts',
  'ci/tests/xcodeCloudReconciliation.test.ts',
  'ci/tests/workflowRunnerRoutes.test.ts',
  'ci/tests/workflowPrValidation.test.ts',
  'ci/tests/workflowDatabaseAcceptance.test.ts',
  'ci/tests/workflowPrGate.test.ts',
  'ci/tests/iosWorkflowE2eContracts.test.ts',
  'ci/tests/workflowMetadataSourceText.test.ts',
] as const satisfies readonly TypedWorkflowContractTest[];


export const workflowContractTests: readonly TypedWorkflowContractTest[] = typedWorkflowContractTests;
export const workflowContractTestSet: ReadonlySet<string> = new Set(workflowContractTests);

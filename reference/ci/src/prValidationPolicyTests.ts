/** Suites owned by the validation-policy job, shared by execution and routing. */
export const prValidationPolicyTests = [
  'ci/tests/debtPolicyBoundary.test.ts',
] as const satisfies readonly `ci/tests/${string}.test.ts`[];

export const prValidationPolicyTestSet: ReadonlySet<string> = new Set(prValidationPolicyTests);

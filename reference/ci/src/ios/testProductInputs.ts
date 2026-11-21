/** Executable product-handoff tooling is validated by workflow contracts,
 * while a change invalidates its compiled-product evidence fingerprint. */
export const REQUIRED_NATIVE_INPUTS = [
  '.github/workflows/ios-tests.yml',
  'ci/src/ios/toolchainPolicy.ts',
  'ci/src/ios/shared/testProductToolchain.ts',
] as const;

// Retirement remains classifiable for PRs whose changed-file inventory spans
// the migration, without requiring a deleted file in evidence fingerprints.
export const RETIRED_TEST_PRODUCT_INPUTS = ['scripts/ios-test-products-toolchain.py'] as const;
const contractInputs: ReadonlySet<string> = new Set([...REQUIRED_NATIVE_INPUTS, ...RETIRED_TEST_PRODUCT_INPUTS]);

export function isTestProductContractInput(path: string): boolean {
  return contractInputs.has(path);
}

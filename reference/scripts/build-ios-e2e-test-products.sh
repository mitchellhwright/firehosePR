#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="$repo_root/ios/example-ios.xcodeproj"
source_scheme="$project/xcshareddata/xcschemes/example-ios-Onboarding.xcscheme"
ci_scheme="$project/xcshareddata/xcschemes/example-ios-E2E-CI.xcscheme"
test_plan="${IOS_E2E_TEST_PLAN:-CI-E2E}"
test_products="${IOS_E2E_TEST_PRODUCTS:-$repo_root/.example-ci/e2e-test-products/example-ios-e2e.xctestproducts}"
derived_data="${IOS_E2E_DERIVED_DATA:-$repo_root/.example-ci/e2e-derived-data}"
source_packages="${IOS_SOURCE_PACKAGES_DIR:-$repo_root/.example-ci/ios-source-packages}"
destination="${IOS_SIMULATOR_DESTINATION:-generic/platform=iOS Simulator}"

mkdir -p "$(dirname "$test_products")" "$derived_data" "$source_packages"
rm -rf "$test_products"

cleanup() {
  rm -f "$ci_scheme"
}
trap cleanup EXIT

python3 "$repo_root/scripts/prepare-ios-ci-scheme.py" "$source_scheme" "$ci_scheme"

started_at="$SECONDS"
# The derived data persists across jobs on CI runners; the guard discards it
# when the previous build in it was killed before Xcode saved its state.
node "$repo_root/ci/src/actions/ios/guardIosIncrementalBuild.ts" "$derived_data" -- \
  xcodebuild build-for-testing \
  -project "$project" \
  -scheme example-ios-E2E-CI \
  -testPlan "$test_plan" \
  -destination "$destination" \
  -derivedDataPath "$derived_data" \
  -clonedSourcePackagesDirPath "$source_packages" \
  -onlyUsePackageVersionsFromResolvedFile \
  -testProductsPath "$test_products" \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  EXCLUDED_ARCHS=x86_64

[[ -f "$test_products/Info.plist" ]] || {
  echo "::error::Shared E2E test products are missing Info.plist: $test_products"
  exit 1
}

echo "Shared exact-head E2E test products built in $((SECONDS - started_at))s: $test_products"

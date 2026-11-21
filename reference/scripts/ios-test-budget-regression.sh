#!/usr/bin/env bash
set -euo pipefail

# Runs the complete mock-backed Budget UI regression suite without expanding
# the default Test - iOS lane.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_path="${repo_root}/ios/example-ios.xcodeproj"
destination="${DESTINATION:-platform=iOS Simulator,name=iPhone 17}"
runner_temp="${RUNNER_TEMP:-/tmp}"
run_dir="${BUDGET_REGRESSION_RUN_DIR:-$(mktemp -d "${runner_temp}/budget-regression.XXXXXX")}"
result_bundle="${RESULT_BUNDLE:-${run_dir}/budget-regression.xcresult}"
derived_data="${DERIVED_DATA:-${run_dir}/DerivedData}"
source_packages="${SOURCE_PACKAGES:-${run_dir}/SourcePackages}"
package_cache="${PACKAGE_CACHE:-${run_dir}/PackageCache}"
xcodebuild_log="${XCODEBUILD_LOG:-${run_dir}/xcodebuild.log}"
parallel_workers="${PARALLEL_WORKERS:-2}"
expected_test_count="${BUDGET_REGRESSION_EXPECTED_TEST_COUNT:-69}"
only_testing_raw="${BUDGET_REGRESSION_ONLY_TESTING:-}"
only_testing_arguments=()

if [[ ! "${parallel_workers}" =~ ^[1-9][0-9]*$ ]]; then
  echo "PARALLEL_WORKERS must be a positive integer" >&2
  exit 2
fi
if [[ ! "${expected_test_count}" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUDGET_REGRESSION_EXPECTED_TEST_COUNT must be a positive integer" >&2
  exit 2
fi
if [[ -n "${only_testing_raw}" ]]; then
  while IFS= read -r test_identifier; do
    [[ -n "${test_identifier}" ]] || continue
    if [[ "${test_identifier}" != example-iosBudgetDebtUITests/* ]]; then
      echo "Invalid Budget regression test identifier: ${test_identifier}" >&2
      exit 2
    fi
    only_testing_arguments+=("-only-testing:${test_identifier}")
  done <<< "${only_testing_raw}"
  if [[ "${#only_testing_arguments[@]}" -eq 0 ]]; then
    echo "BUDGET_REGRESSION_ONLY_TESTING did not contain a test identifier" >&2
    exit 2
  fi
fi
if [[ -e "${result_bundle}" ]]; then
  echo "Result bundle already exists: ${result_bundle}" >&2
  exit 2
fi

mkdir -p \
  "${run_dir}" \
  "${derived_data}" \
  "${source_packages}" \
  "${package_cache}" \
  "$(dirname "${result_bundle}")" \
  "$(dirname "${xcodebuild_log}")"

bash "${repo_root}/scripts/prepare-ios-plaid-link.sh" "${source_packages}"

echo "Budget regression run directory: ${run_dir}"
echo "Budget regression destination: ${destination}"

run_build() {
  local arguments=(
    build-for-testing
    -project "${project_path}"
    -scheme example-ios-BudgetDebt
    -testPlan Budget-Regression
    -destination "${destination}"
    -parallel-testing-enabled YES
    -parallel-testing-worker-count "${parallel_workers}"
    -derivedDataPath "${derived_data}"
    -clonedSourcePackagesDirPath "${source_packages}"
    -packageCachePath "${package_cache}"
    -disableAutomaticPackageResolution
  )
  if [[ -n "${only_testing_raw}" ]]; then
    arguments+=("${only_testing_arguments[@]}")
  fi
  xcodebuild "${arguments[@]}" CODE_SIGNING_ALLOWED=NO
}

run_tests() {
  local arguments=(
    test-without-building
    -project "${project_path}"
    -scheme example-ios-BudgetDebt
    -testPlan Budget-Regression
    -destination "${destination}"
    -parallel-testing-enabled YES
    -parallel-testing-worker-count "${parallel_workers}"
    -resultBundlePath "${result_bundle}"
    -derivedDataPath "${derived_data}"
    -clonedSourcePackagesDirPath "${source_packages}"
    -packageCachePath "${package_cache}"
    -disableAutomaticPackageResolution
  )
  if [[ -n "${only_testing_raw}" ]]; then
    arguments+=("${only_testing_arguments[@]}")
  fi
  xcodebuild "${arguments[@]}" CODE_SIGNING_ALLOWED=NO
}

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  set +e
  run_build 2>&1 | tee "${xcodebuild_log}"
  build_status="${PIPESTATUS[0]}"
  set -e
  if [[ "${build_status}" -ne 0 ]]; then
    exit "${build_status}"
  fi
elif [[ ! -d "${derived_data}/Build/Products" ]]; then
  echo "SKIP_BUILD=1 but DerivedData has no built products: ${derived_data}" >&2
  exit 2
fi

set +e
run_tests 2>&1 | tee -a "${xcodebuild_log}"
test_status="${PIPESTATUS[0]}"
set -e

if [[ "${test_status}" -eq 0 ]]; then
  if [[ ! -d "${result_bundle}" || ! -s "${xcodebuild_log}" ]]; then
    echo "Budget regression passed without required result and log artifacts" >&2
    exit 2
  fi
  bash "${repo_root}/scripts/validate-xcresult-summary.sh" \
    "${result_bundle}" \
    "${expected_test_count}" \
    "Budget UI regression"
fi
exit "${test_status}"

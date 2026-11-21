#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner="$repo_root/scripts/ios-test-budget-e2e.sh"
destination="${IOS_SIMULATOR_DESTINATION:-${DESTINATION:?DESTINATION or IOS_SIMULATOR_DESTINATION is required}}"
test_products="${IOS_E2E_TEST_PRODUCTS:?IOS_E2E_TEST_PRODUCTS is required}"
base_email="${UI_TEST_EMAIL:?UI_TEST_EMAIL is required}"
shard="${BUDGET_E2E_SHARD:?BUDGET_E2E_SHARD must select a or b}"
root="${BUDGET_E2E_RUN_DIR:-${RUNNER_TEMP:-/tmp}/budget-e2e}"
simulator_infrastructure_pattern='NSMachErrorDomain[^[:cntrl:]]*-308|CoreSimulatorService[^[:cntrl:]]*(died|invalid|unavailable|connection)|Failed to boot simulator because the service is unavailable'

mkdir -p "$root"
root="$(cd "$root" && pwd)"
[[ "$root" != "/" ]] || {
  echo "::error::Refusing to use the filesystem root as BUDGET_E2E_RUN_DIR"
  exit 1
}

case "$shard" in
  a)
    expected=7
    selected_tests="$(cat <<'EOF'
example-iosBudgetDebtUITests/BudgetRealServerE2ETests/testTransactionFiltersAccountScopeAndMerchantTrends
example-iosBudgetDebtUITests/BudgetInsightPaginationRealServerE2ETests
example-iosBudgetDebtUITests/DebtHistoryRemovalRealServerE2ETests
example-iosBudgetDebtUITests/BudgetFixtureClientDateResolverTests
EOF
)"
    ;;
  b)
    expected=9
    selected_tests="$(cat <<'EOF'
example-iosBudgetDebtUITests/ChatProfileUpdateRealServerE2ETests
example-iosBudgetDebtUITests/BudgetRealServerE2ETests/testCategoryOverridesCustomCategoryAndRuleLifecyclePersist
example-iosBudgetDebtUITests/BudgetRealServerE2ETests/testCashSavingsCardKeepsItsExistingAccountScope
example-iosBudgetDebtUITests/BudgetRealServerE2ETests/testDashboardFinancialTruthRangesAndDrilldowns
example-iosBudgetDebtUITests/BudgetRealServerE2ETests/testBudgetRecommendationEditFiltersAndRolloverPersist
example-iosBudgetDebtUITests/BudgetRealServerE2ETests/testAccountAssignmentReviewShowsBudgetScopeAndAllLinkLanes
example-iosBudgetDebtUITests/BudgetRealServerE2ETests/testSubscriptionsAndUpcomingBillsUseRealServerData
example-iosBudgetDebtUITests/BudgetRealServerEmptyStateE2ETests
EOF
)"
    ;;
  *)
    echo "::error::BUDGET_E2E_SHARD must be a or b, received: $shard"
    exit 2
    ;;
esac

result="${BUDGET_E2E_RESULT_BUNDLE:-${RESULT_BUNDLE:-$root/budget-e2e.xcresult}}"
log="${BUDGET_E2E_XCODEBUILD_LOG:-${XCODEBUILD_LOG:-$root/budget-xcodebuild.log}}"
cleanup_receipt="${BUDGET_E2E_CLEANUP_RECEIPT:-$root/issue-3996-cleanup-receipt.json}"
raw_video="${BUDGET_E2E_RAW_VIDEO:-${RAW_VIDEO:-$root/budget-e2e.raw.mp4}}"
compressed_video="${BUDGET_E2E_COMPRESSED_VIDEO:-${COMPRESSED_VIDEO:-$root/budget-e2e.compressed.mp4}}"
record_video="${RECORD_VIDEO:-0}"
if [[ "$shard" == "b" ]]; then
  record_video=0
fi

clear_output() {
  local path="$1"
  [[ -n "$path" ]] || return 0
  case "$path" in
    "$root"/*) rm -rf -- "$path" ;;
    *)
      echo "::error::Refusing to remove Budget output outside $root: $path"
      exit 1
      ;;
  esac
}

clear_shard_output() {
  clear_output "$result"
  clear_output "$log"
  clear_output "$cleanup_receipt"
  clear_output "$raw_video"
  clear_output "$compressed_video"
}

shard_email() {
  local local_part="${base_email%@*}"
  local domain="${base_email#*@}"
  printf '%s-budget-%s@%s\n' "${local_part%%+*}" "$shard" "$domain"
}

run_shard() {
  echo "Starting Budget shard $shard with $expected tests on its dedicated runner: $destination"
  env \
    DESTINATION="$destination" \
    IOS_SIMULATOR_DESTINATION="$destination" \
    UI_TEST_EMAIL="$(shard_email)" \
    SKIP_BUILD=1 \
    TEST_PRODUCTS="$test_products" \
    TEST_PRODUCTS_PATH="$test_products" \
    IOS_TEST_PRODUCTS_PATH="$test_products" \
    BUDGET_E2E_TEST_PRODUCTS="$test_products" \
    BUDGET_E2E_TEST_PLAN="${IOS_E2E_TEST_PLAN:-CI-E2E}" \
    BUDGET_E2E_EXPECTED_TEST_COUNT="$expected" \
    BUDGET_E2E_ONLY_TESTING="$selected_tests" \
    RESULT_BUNDLE="$result" \
    XCODEBUILD_LOG="$log" \
    BUDGET_E2E_RESULT_BUNDLE="$result" \
    BUDGET_E2E_XCODEBUILD_LOG="$log" \
    BUDGET_E2E_CLEANUP_RECEIPT="$cleanup_receipt" \
    IOS_3996_CLEANUP_RECEIPT="$cleanup_receipt" \
    RECORD_VIDEO="$record_video" \
    DEFER_VIDEO_PROCESSING=1 \
    RAW_VIDEO="$raw_video" \
    COMPRESSED_VIDEO="$compressed_video" \
    "$runner"
}

clear_shard_output
status=0
run_shard || status=$?

if [[ "$status" -ne 0 ]] && [[ -f "$log" ]] \
  && grep -Eiq "$simulator_infrastructure_pattern" "$log"; then
  echo "::warning::Retrying infrastructure-failed Budget shard $shard once"
  bash "$repo_root/scripts/ensure-ios-simulator-host.sh"
  simulator_udid="${destination##*id=}"
  simulator_udid="${simulator_udid%%,*}"
  xcrun simctl shutdown "$simulator_udid" >/dev/null 2>&1 || true
  clear_shard_output
  status=0
  run_shard || status=$?
fi

if [[ "$status" -ne 0 ]]; then
  echo "::error::Budget E2E shard $shard failed on its dedicated runner"
  exit "$status"
fi

echo "Budget E2E shard $shard passed $expected tests on its dedicated runner."

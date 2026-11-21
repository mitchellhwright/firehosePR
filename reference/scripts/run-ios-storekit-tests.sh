#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 6 ]]; then
  echo "Usage: $0 <test-products> <test-plan> <destination> <result-root> <log-file> <configuration>" >&2
  exit 2
fi

test_products="$1"
test_plan="$2"
destination="$3"
result_root="$4"
log_file="$5"
configuration="$6"
xcodebuild_bin="${XCODEBUILD_BIN:-xcodebuild}"
xcresult_validator="${XCRESULT_VALIDATOR:-$(cd "$(dirname "$0")" && pwd)/validate-xcresult-summary.sh}"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/ios-xctrunner-busy-retry.sh"

tests=(
  "configured-products|configured StoreKit products|example-iosStoreKitTests/StoreKitPurchaseIntegrationTests/testConfiguredProductsLoadFromStoreKit"
  "purchase|StoreKit purchase|example-iosStoreKitTests/StoreKitPurchaseIntegrationTests/testPurchaseThroughViewModelGrantsPremiumAccess"
  "eligible-trials|eligible StoreKit trials|example-iosStoreKitTests/SubscriptionTrialDisclosureTests/testEligibleTrialsUseActualStoreKitPeriods"
  "ineligible-offers|ineligible StoreKit offers|example-iosStoreKitTests/SubscriptionTrialDisclosureTests/testIneligibleAndNonFreeOffersNeverClaimTrial"
  "renewal-cadence|StoreKit renewal cadence|example-iosStoreKitTests/SubscriptionTrialDisclosureTests/testMonthlyAndAnnualRenewalCadenceComesFromStoreKit"
  "paywall-fixture|paywall StoreKit fixture|example-iosStoreKitTests/PaywallStoreKitFixtureTests/testPaywallFixtureProductsLoadFromStoreKit"
  "preview-eligibility|preview trial eligibility|example-iosStoreKitTests/SubscriptionTrialDisclosureTests/testPreviewEligibilityAloneCannotInventTrial"
  "product-period|StoreKit product period|example-iosStoreKitTests/SubscriptionTrialDisclosureTests/testTrialDurationUsesStoreKitPeriodFormat"
)

rm -rf "$result_root"
mkdir -p "$result_root" "$(dirname "$log_file")"
: > "$log_file"

overall_status=0
for test_spec in "${tests[@]}"; do
  IFS='|' read -r slug label identifier <<< "$test_spec"
  result_bundle="$result_root/$slug.xcresult"
  test_log="$result_root/$slug.log"
  echo "=== $label ===" | tee -a "$log_file"

  set +e
  run_ios_xcodebuild_with_busy_retry "$label" "$test_log" "$xcodebuild_bin" \
    test-without-building \
    -testProductsPath "$test_products" \
    -testPlan "$test_plan" \
    -only-test-configuration "$configuration" \
    -destination "$destination" \
    -parallel-testing-enabled NO \
    "-only-testing:$identifier" \
    -resultBundlePath "$result_bundle"
  xcodebuild_status="$?"
  set -e
  cat "$test_log" >> "$log_file"

  if [[ "$xcodebuild_status" -eq 0 ]]; then
    if ! bash "$xcresult_validator" "$result_bundle" 1 "$label"; then
      overall_status=1
    fi
  else
    overall_status=1
  fi
done

exit "$overall_status"

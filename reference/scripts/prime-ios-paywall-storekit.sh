#!/usr/bin/env bash
set -euo pipefail

# Called with the upcoming xcodebuild arguments. Register the actual paywall
# configuration on that same simulator only when its selection needs it.
required=false
destination=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "-destination" ]]; then destination="$argument"; fi
  case "$argument" in
    -only-testing:example-iosUITests/SubscriptionCTACopyEvidenceUITests*) required=true ;;
  esac
  previous="$argument"
done
[[ "$required" == true ]] || exit 0
[[ -n "$destination" ]] || { echo "::error::Paywall priming requires a destination." >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
prime_dir="$(mktemp -d "${IOS_TEST_RUN_DIR:?}/paywall-storekit-prime.XXXXXX")"
preserve_failed_result() {
  local status="$?"
  local archive="${IOS_STOREKIT_PRIME_FAILURE_RESULT:-}"
  trap - EXIT
  if [[ "$status" -ne 0 && -n "$archive" && -d "$prime_dir/result.xcresult" ]]; then
    rm -rf "$archive"
    mv "$prime_dir/result.xcresult" "$archive"
  fi
  exit "$status"
}
trap preserve_failed_result EXIT
# The main CI archive includes the dedicated StoreKit target. The separate
# CI-Evidence archive intentionally does not, so never use it for priming.
xcodebuild test-without-building \
  -testProductsPath "${IOS_TEST_PRODUCTS:?}" \
  -testPlan CI \
  -only-test-configuration "CI Configuration" \
  -destination "$destination" \
  -parallel-testing-enabled NO \
  -only-testing:example-iosStoreKitTests/PaywallStoreKitFixtureTests/testPaywallFixtureProductsLoadFromStoreKit \
  -resultBundlePath "$prime_dir/result.xcresult" 2>&1 | tee "$prime_dir/xcodebuild.log"
bash "$script_dir/validate-xcresult-summary.sh" "$prime_dir/result.xcresult" 1 "Paywall StoreKit fixture priming"

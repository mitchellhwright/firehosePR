#!/usr/bin/env bash
set -euo pipefail

# Builds of the same run that share this host also share its build cache, so
# they run one at a time. The lock helper blocks in the kernel until the lock
# is free and releases it when this process exits; no polling, no owner file.
if [[ -z "${EXAMPLE_IOS_BUILD_LOCK_HELD:-}" ]]; then
  build_lock_run_id="${GITHUB_RUN_ID:-local}"
  build_lock_run_attempt="${GITHUB_RUN_ATTEMPT:-0}"
  if ! [[ "$build_lock_run_id" =~ ^[0-9]+$ && "$build_lock_run_attempt" =~ ^[0-9]+$ ]]; then
    echo "::error::The iOS build lock requires numeric run identity." >&2
    exit 2
  fi
  exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/with-file-lock.sh" \
    "/private/tmp/example-ios-build.${build_lock_run_id}.${build_lock_run_attempt}.lock" -- \
    env EXAMPLE_IOS_BUILD_LOCK_HELD=1 bash "${BASH_SOURCE[0]}" "$@"
fi

if [[ "${IOS_CI_LANE:?}" != "main" ]]; then
  echo "::error::Unsupported iOS build lane: ${IOS_CI_LANE}" >&2
  exit 2
fi

runner_temp="${RUNNER_TEMP:-/tmp}"
run_id="${GITHUB_RUN_ID:-local}"
run_attempt="${GITHUB_RUN_ATTEMPT:-0}"
test_run_dir="$(mktemp -d "$runner_temp/example-ios-tests.${run_id}.${run_attempt}.XXXXXX")"
test_products="$test_run_dir/example-ios-tests.xctestproducts"
evidence_test_products="$test_run_dir/example-ios-evidence-tests.xctestproducts"
build_log="$test_run_dir/build-xcodebuild.log"
evidence_build_log="$test_run_dir/evidence-build-xcodebuild.log"
test_plan="CI"
test_scheme="example-ios-CI"
only_testing_file="${IOS_ONLY_TESTING_FILE:-}"
selection_mode="${IOS_TEST_SELECTION_MODE:?}"
storekit_required="${STOREKIT_REQUIRED:-false}"
evidence_groups="${IOS_EVIDENCE_GROUPS:-}"

ci_scheme_dir="example-ios.xcodeproj/xcshareddata/xcschemes"
python3 ../scripts/prepare-ios-ci-scheme.py \
  "$ci_scheme_dir/example-ios.xcscheme" \
  "$ci_scheme_dir/$test_scheme.xcscheme"

only_testing_args=()
unit_only_selection=false
if [[ -n "$only_testing_file" && -s "$only_testing_file" ]]; then
  unit_only_selection=true
  while IFS= read -r test_identifier; do
    [[ -n "$test_identifier" ]] || continue
    only_testing_args+=("-only-testing:$test_identifier")
    if [[ "$test_identifier" != example-iosTests/* ]]; then
      unit_only_selection=false
    fi
  done < "$only_testing_file"
fi
if [[ "${#only_testing_args[@]}" -eq 0 ]]; then
  unit_only_selection=false
fi
if [[ "$unit_only_selection" == true && "$storekit_required" != "true" && -z "$evidence_groups" ]]; then
  test_plan="CI-Unit"
fi
if [[ "$selection_mode" == "affected" ]]; then
  only_testing_args+=(
    "-only-testing:example-iosTests/NextCardActivationResolverTests/testResolveReturnsProfileFirstWhenUnactivated"
  )
fi
if [[ "$storekit_required" == "true" ]]; then
  only_testing_args+=(
    "-only-testing:example-iosStoreKitTests/StoreKitPurchaseIntegrationTests/testConfiguredProductsLoadFromStoreKit"
    "-only-testing:example-iosStoreKitTests/StoreKitPurchaseIntegrationTests/testPurchaseThroughViewModelGrantsPremiumAccess"
  )
fi

# A filtered CI build must retain the real-product fixture loader used before
# paywall UI on each destination, including supplemental evidence devices.
# Leave unfiltered builds unfiltered; their CI plan already selects this class.
if [[ "$test_plan" == "CI" && "${#only_testing_args[@]}" -gt 0 ]]; then
  only_testing_args+=("-only-testing:example-iosStoreKitTests/SubscriptionTrialDisclosureTests")
fi

result_bundle="$test_run_dir/example-ios-tests.xcresult"
storekit_result_bundle="$test_run_dir/example-ios-storekit-results"
account_update_result_bundle="$test_run_dir/example-ios-account-update-tests.xcresult"
accessibility_result_bundle="$test_run_dir/example-ios-accessibility-tests.xcresult"
narrow_paywall_result_bundle="$test_run_dir/narrow-paywall-lane.xcresult"
xcodebuild_log="$test_run_dir/xcodebuild.log"
storekit_xcodebuild_log="$test_run_dir/storekit-xcodebuild.log"
account_update_xcodebuild_log="$test_run_dir/account-update-xcodebuild.log"
accessibility_xcodebuild_log="$test_run_dir/accessibility-xcodebuild.log"
narrow_paywall_xcodebuild_log="$test_run_dir/narrow-paywall-lane-xcodebuild.log"

{
  echo "IOS_TEST_RUN_DIR=$test_run_dir"
  echo "IOS_TEST_PRODUCTS=$test_products"
  echo "IOS_EVIDENCE_TEST_PRODUCTS=$evidence_test_products"
  echo "IOS_TEST_PLAN=$test_plan"
  echo "IOS_TEST_BUILD_XCODEBUILD_LOG=$build_log"
  echo "IOS_EVIDENCE_BUILD_XCODEBUILD_LOG=$evidence_build_log"
  echo "IOS_TEST_RESULT_BUNDLE=$result_bundle"
  echo "IOS_STOREKIT_RESULT_BUNDLE=$storekit_result_bundle"
  echo "IOS_ACCOUNT_UPDATE_RESULT_BUNDLE=$account_update_result_bundle"
  echo "IOS_ACCESSIBILITY_TEST_RESULT_BUNDLE=$accessibility_result_bundle"
  echo "IOS_NARROW_PAYWALL_RESULT_BUNDLE=$narrow_paywall_result_bundle"
  echo "IOS_TEST_XCODEBUILD_LOG=$xcodebuild_log"
  echo "IOS_STOREKIT_XCODEBUILD_LOG=$storekit_xcodebuild_log"
  echo "IOS_ACCOUNT_UPDATE_XCODEBUILD_LOG=$account_update_xcodebuild_log"
  echo "IOS_ACCESSIBILITY_XCODEBUILD_LOG=$accessibility_xcodebuild_log"
  echo "IOS_NARROW_PAYWALL_XCODEBUILD_LOG=$narrow_paywall_xcodebuild_log"
} >> "${GITHUB_ENV:?}"

trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p \
  "${IOS_CI_DERIVED_DATA:?}" \
  "${IOS_CI_SOURCE_PACKAGES:?}" \
  "${IOS_CI_PACKAGE_CACHE:?}"
bash ../scripts/prepare-ios-plaid-link.sh "$IOS_CI_SOURCE_PACKAGES"

# Both builds share the persistent derived data, which must not keep objects
# from a build that was killed before Xcode saved its incremental state.
guarded_build=(node ../ci/src/actions/ios/guardIosIncrementalBuild.ts "$IOS_CI_DERIVED_DATA" --)

# Apple's StoreKitTest header uses a deprecated StoreKit 1 type, and Swift
# upgrades Clang's header warning to an error under warnings-as-errors. Swift's
# own deprecation diagnostics are unaffected. Xcode expands $(inherited).
# shellcheck disable=SC2016
sdk_header_deprecation_flags='OTHER_SWIFT_FLAGS=$(inherited) -Xcc -Wno-deprecated-declarations'

build_arguments=(
  build-for-testing
  -project example-ios.xcodeproj
  -scheme "$test_scheme"
  -testPlan "$test_plan"
  # Compilation targets the simulator platform, not a booted device. Keep
  # concrete run-owned destinations in test-without-building invocations only.
  -destination "generic/platform=iOS Simulator"
  -parallel-testing-enabled NO
  -enableCodeCoverage NO
  -testProductsPath "$test_products"
  -derivedDataPath "$IOS_CI_DERIVED_DATA"
  -clonedSourcePackagesDirPath "$IOS_CI_SOURCE_PACKAGES"
  -packageCachePath "$IOS_CI_PACKAGE_CACHE"
  -disableAutomaticPackageResolution
  COMPILER_INDEX_STORE_ENABLE=NO
  # The project maps this onto SWIFT_TREAT_WARNINGS_AS_ERRORS for its own
  # targets only; package targets are built with -suppress-warnings, which
  # conflicts with a global SWIFT_TREAT_WARNINGS_AS_ERRORS=YES.
  EXAMPLE_CI_SWIFT_WARNINGS_AS_ERRORS=YES
  "$sdk_header_deprecation_flags"
  "ARCHS=$(uname -m)"
  ONLY_ACTIVE_ARCH=NO
)
if [[ "$selection_mode" == "affected" && "${#only_testing_args[@]}" -gt 0 && -z "$evidence_groups" ]]; then
  build_arguments+=("${only_testing_args[@]}")
fi

echo "::group::Compile iOS test products once"
build_status=0
build_started_at=$SECONDS
bash ../scripts/run-with-ios-cache-recovery.sh \
  "$build_log" -- "${guarded_build[@]}" xcodebuild "${build_arguments[@]}" \
  || build_status=$?
echo "::endgroup::"
echo "::notice::iOS test-product compilation finished in $((SECONDS - build_started_at)) seconds with status ${build_status}."
if [[ "$build_status" -ne 0 ]]; then
  exit "$build_status"
fi
if [[ ! -s "$test_products/Info.plist" ]]; then
  echo "::error::The iOS build did not create a valid test-products bundle." >&2
  exit 1
fi

# Every group using a named evidence configuration needs products built from
# CI-Evidence. The ordinary CI plan contains only CI Configuration.
evidence_plan_required="${IOS_EVIDENCE_PLAN_REQUIRED:-${IOS_NARROW_PAYWALL_REQUIRED:-false}}"
if [[ "$evidence_plan_required" != true && "$evidence_plan_required" != false ]]; then
  echo "::error::IOS_EVIDENCE_PLAN_REQUIRED must be true or false." >&2
  exit 2
fi
for evidence_group in accessibility onboarding-copy; do
  case ",$evidence_groups," in
    *,"$evidence_group",*) evidence_plan_required=true ;;
  esac
done
if [[ "$evidence_plan_required" == true ]]; then
  evidence_build_arguments=(
    build-for-testing
    -project example-ios.xcodeproj
    -scheme "$test_scheme"
    -testPlan "CI-Evidence"
    -destination "${IOS_PRIMARY_DESTINATION:?}"
    -parallel-testing-enabled NO
    -enableCodeCoverage NO
    -testProductsPath "$evidence_test_products"
    -derivedDataPath "$IOS_CI_DERIVED_DATA"
    -clonedSourcePackagesDirPath "$IOS_CI_SOURCE_PACKAGES"
    -packageCachePath "$IOS_CI_PACKAGE_CACHE"
    -disableAutomaticPackageResolution
    COMPILER_INDEX_STORE_ENABLE=NO
    EXAMPLE_CI_SWIFT_WARNINGS_AS_ERRORS=YES
    "$sdk_header_deprecation_flags"
  )

  echo "::group::Compile iOS evidence test products"
  evidence_build_status=0
  evidence_build_started_at=$SECONDS
  bash ../scripts/run-with-ios-cache-recovery.sh \
    "$evidence_build_log" -- "${guarded_build[@]}" xcodebuild "${evidence_build_arguments[@]}" \
    || evidence_build_status=$?
  echo "::endgroup::"
  echo "::notice::iOS evidence test-product compilation finished in $((SECONDS - evidence_build_started_at)) seconds with status ${evidence_build_status}."
  if [[ "$evidence_build_status" -ne 0 ]]; then
    exit "$evidence_build_status"
  fi
  if [[ ! -s "$evidence_test_products/Info.plist" ]]; then
    echo "::error::The iOS evidence build did not create a valid test-products bundle." >&2
    exit 1
  fi
fi

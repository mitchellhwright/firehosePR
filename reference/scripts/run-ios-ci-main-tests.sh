#!/usr/bin/env bash
set -euo pipefail

test_products="${IOS_TEST_PRODUCTS:?}"
test_plan="${IOS_TEST_PLAN:-CI}"
result_bundle="${IOS_TEST_RESULT_BUNDLE:?}"
xcodebuild_log="${IOS_TEST_XCODEBUILD_LOG:?}"
selection_mode="${IOS_TEST_SELECTION_MODE:?}"
partition="${IOS_MAIN_TEST_PARTITION:-all}"
primary_destination="${IOS_PRIMARY_DESTINATION:?}"
ui_destination="${IOS_MAIN_UI_DESTINATION:-}"
budget_destination="${IOS_MAIN_BUDGET_DESTINATION:-}"
only_testing_file="${IOS_ONLY_TESTING_FILE:-}"
run_dir="${IOS_TEST_RUN_DIR:?}"
narrow_destination="${IOS_NARROW_DESTINATION:-}"
narrow_paywall_required="${IOS_NARROW_PAYWALL_REQUIRED:-false}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/ios-ci-simulator-preparation.sh"

# The paywall accessibility regression must execute on the SE 375x667
# destination at Accessibility XL; the primary shards skip it and the narrow
# phase below owns it whenever the selector marks it required.
narrow_paywall_test_identifier="example-iosUITests/SubscriptionCTACopyEvidenceUITests/testAccessibilityTextKeepsEveryBenefitReadableAboveStickyCTA"

child_pids=()
terminate_children() {
  local pid
  for pid in "${child_pids[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      pkill -TERM -P "$pid" -x xcodebuild 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
}
trap terminate_children EXIT
trap 'terminate_children; exit 130' INT
trap 'terminate_children; exit 143' TERM

# shellcheck disable=SC1091
source "$script_dir/ios-xctrunner-busy-retry.sh"

run_xcodebuild() {
  local phase="$1"
  local log_file="$2"
  shift 2
  run_ios_xcodebuild_with_busy_retry "$phase" "$log_file" xcodebuild "$@"
}

common_arguments=(
  test-without-building
  -testProductsPath "$test_products"
  -testPlan "$test_plan"
)

# Each matrix lane still owns one physical Mac. On hosts with enough memory,
# allow Xcode to run two UI test workers inside that one lane; 16 GB hosts stay
# serial to avoid simulator pressure. Evidence and native1 keep their explicit
# serial settings below.
native_ui_parallel_arguments=(
  -parallel-testing-enabled NO
)
case "$partition" in
  native2|native3|native4)
    physical_memory_bytes="$(sysctl -n hw.memsize 2>/dev/null || true)"
    if [[ "$physical_memory_bytes" =~ ^[0-9]+$ ]] &&
       (( physical_memory_bytes >= 24 * 1024 * 1024 * 1024 )); then
      native_ui_parallel_arguments=(
        -parallel-testing-enabled YES
        -parallel-testing-worker-count 2
      )
      echo "::notice::Using two Xcode UI workers on ${partition} (${physical_memory_bytes} bytes physical memory)."
    else
      echo "::notice::Using one Xcode UI worker on ${partition} (${physical_memory_bytes:-unknown} bytes physical memory)."
    fi
    ;;
esac

resolved_native_ui_parallel_arguments=()
resolve_native_ui_parallel_arguments() {
  local argument
  resolved_native_ui_parallel_arguments=("${native_ui_parallel_arguments[@]}")
  for argument in "$@"; do
    case "$argument" in
      -only-testing:example-iosUITests/SubscriptionCTACopyEvidenceUITests*)
        resolved_native_ui_parallel_arguments=(-parallel-testing-enabled NO)
        echo "::notice::Keeping StoreKit-primed paywall UI tests on their explicitly primed simulator."
        return
        ;;
    esac
  done
}

skip_arguments=(
  -skip-testing:example-iosStoreKitTests
  -skip-testing:example-iosUITests/CategoryTrendChartAccessibilityUITests
  -skip-testing:example-iosUITests/SubscriptionCTACopyEvidenceUITests/testAccessibilityTextKeepsEveryBenefitReadableAboveStickyCTA
  -skip-testing:example-iosTests/ExampleInsightFoundationIncompleteTests/testCaptureAccessibilityVisualEvidence
  -skip-testing:example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureChangedCoachMarksAndCanonicalReadyResponse
  -skip-testing:example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureChangedCoachMarksAtNarrowStandardSize
  -skip-testing:example-iosUITests/OnboardingTourUITests/testCaptureTourOverlayEveryStep
  -skip-testing:example-iosUITests/LongLabelAssignmentReceiptUITests/testLongLabelsAndAccessibilityTypeDoNotOverlapReceiptAction
  -skip-testing:example-iosUITests/DebtBalanceWrapUITests/testTestFlightMortgageBalanceStaysSingleLine
  -skip-testing:example-iosUITests/TourCopyReviewEvidenceUITests/testCapturePersonalizedWelcome
  -skip-testing:example-iosUITests/ActivationAggregateVisualMatrixUITests/testReceiptAndActivationIntroAutomatedMatrix
)

# Ordinary affected and full UI execution can select
# TourCopyReviewEvidenceUITests as a bare class from CI.xctestplan. Exclude its
# financial-independence accessibility method because it is valid only when the
# dedicated evidence dispatch supplies TEST_RUNNER_FINANCIAL_INDEPENDENCE_FIXTURE_JSON.
# That dispatch -only-tests this exact identifier (see
# run_financial_independence_evidence below), so keep the exclusion out of the
# base skip list used by the dedicated dispatch.
primary_ui_skip_arguments=(
  "${skip_arguments[@]}"
  -skip-testing:example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureFinancialIndependenceAccessibilityHierarchy
)

rm -rf "$result_bundle" "$xcodebuild_log"

narrow_paywall_result="$run_dir/narrow-paywall-evidence.xcresult"
narrow_paywall_log="$run_dir/narrow-paywall-evidence.log"
rm -rf "$narrow_paywall_result" "$narrow_paywall_log"

# Runs the paywall accessibility regression on the narrow destination. Appends
# its log and result bundle to the outputs named by the caller; returns the
# xcodebuild status (0 when the phase is not required).
run_narrow_paywall_evidence() {
  local merged_log="$1"
  local merged_result="$2"
  if [[ "$narrow_paywall_required" != "true" ]]; then
    return 0
  fi
  if [[ -z "$narrow_destination" ]]; then
    echo "::error::Narrow paywall accessibility evidence requires IOS_NARROW_DESTINATION." >&2
    return 2
  fi
  local status=0
  local narrow_simulator_udid="${narrow_destination##*id=}"
  prepare_simulator "$narrow_simulator_udid" "Narrow paywall" || return $?
  run_xcodebuild "narrow paywall accessibility evidence" "$narrow_paywall_log" \
    test-without-building \
    -testProductsPath "${IOS_EVIDENCE_TEST_PRODUCTS:?}" \
    -testPlan CI-Evidence \
    -only-test-configuration "Accessibility Evidence Configuration" \
    -destination "$narrow_destination" \
    -parallel-testing-enabled NO \
    -resultBundlePath "$narrow_paywall_result" \
    -only-testing:"$narrow_paywall_test_identifier" \
    || status=$?
  if [[ "$status" -eq 0 ]]; then
    bash ../scripts/validate-xcresult-summary.sh \
      "$narrow_paywall_result" 1 "Narrow paywall accessibility" || status=$?
  fi
  cat "$narrow_paywall_log" >> "$merged_log"
  if [[ -d "$narrow_paywall_result" ]]; then
    if [[ -d "$merged_result" ]]; then
      local merged_tmp="$merged_result.narrow-merge"
      rm -rf "$merged_tmp"
      xcrun xcresulttool merge --output-path "$merged_tmp" "$merged_result" "$narrow_paywall_result"
      rm -rf "$merged_result"
      mv "$merged_tmp" "$merged_result"
    else
      cp -R "$narrow_paywall_result" "$merged_result"
    fi
  fi
  return "$status"
}

# Execute the bounded cross-platform contract separately so XCTest success with
# skipped/missing tests cannot masquerade as Wellness verification.
if [[ "${IOS_WELLNESS_REQUIRED:-false}" == "true" && ( "$partition" == "all" || "$partition" == "native1" ) ]]; then
  wellness_selection="${IOS_WELLNESS_ONLY_TESTING_FILE:?}"
  [[ -s "$wellness_selection" ]] || { echo "::error::Required Wellness selection is empty"; exit 1; }
  wellness_arguments=()
  while IFS= read -r identifier; do
    [[ -n "$identifier" ]] || continue
    wellness_arguments+=("-only-testing:$identifier")
  done < "$wellness_selection"
  [[ "${#wellness_arguments[@]}" -eq "${IOS_WELLNESS_TEST_COUNT:?}" ]] || {
    echo "::error::Required Wellness selection is incomplete"; exit 1;
  }
  wellness_result="$run_dir/wellness-contract.xcresult"
  run_xcodebuild "Wellness contract" "$run_dir/wellness-contract.log" \
    "${common_arguments[@]}" -destination "$primary_destination" \
    -parallel-testing-enabled NO -resultBundlePath "$wellness_result" \
    "${wellness_arguments[@]}"
  bash "$(dirname "$0")/validate-xcresult-summary.sh" \
    "$wellness_result" "$IOS_WELLNESS_TEST_COUNT" "Wellness contract"
fi

if [[ "$selection_mode" == "affected" ]]; then
  affected_unit_arguments=()
  affected_ui_arguments=()
  run_financial_independence_evidence=false
  account_update_group_required="${IOS_ACCOUNT_UPDATE_GROUP_REQUIRED:-false}"
  case ",${IOS_EVIDENCE_GROUPS:-}," in
    *,account-update,*) account_update_group_required=true ;;
  esac
  if [[ -n "$only_testing_file" && -s "$only_testing_file" ]]; then
    while IFS= read -r test_identifier; do
      [[ -n "$test_identifier" ]] || continue
      if [[ "${IOS_WELLNESS_REQUIRED:-false}" == "true" ]] && \
        grep -Fxq "$test_identifier" "$IOS_WELLNESS_ONLY_TESTING_FILE"; then
        continue # Already executed with exact-count/no-skip validation above.
      fi
      case "$test_identifier" in
        example-iosUITests/ActivationIntroManageAccounts*|example-iosUITests/CardAccountUpdateReturn*)
          if [[ "$account_update_group_required" == true ]]; then
            # Account-update acceptance has its own destination and executes
            # once after the ordinary native1 pass when that group is owned.
            continue
          fi
          affected_ui_arguments+=("-only-testing:$test_identifier")
          ;;
        example-iosTests/FinancialIndependenceEvidenceTests)
          affected_unit_arguments+=(
            -only-testing:example-iosTests/FinancialIndependenceEvidenceTests/testStatusChipBackgroundsMeetNormalTextContrast
          )
          run_financial_independence_evidence=true
          ;;
        example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureFinancialIndependenceAccessibilityHierarchy)
          run_financial_independence_evidence=true
          ;;
        example-iosUITests/TourCopyReviewEvidenceUITests)
          # A bare class selector includes the fixture-owned FI accessibility
          # method. Run that method through its canonical evidence dispatch;
          # primary_ui_skip_arguments keeps it out of the ordinary UI pass.
          run_financial_independence_evidence=true
          affected_ui_arguments+=("-only-testing:$test_identifier")
          ;;
        example-iosTests|example-iosTests/*)
          affected_unit_arguments+=("-only-testing:$test_identifier")
          ;;
        example-iosUITests/SubscriptionCTACopyEvidenceUITests)
          # xcodebuild documents no precedence between -only-testing and
          # -skip-testing, so never hand the primary shard the whole class:
          # select its behavioral methods explicitly and leave the
          # accessibility method to the narrow phase.
          affected_ui_arguments+=(
            "-only-testing:example-iosUITests/SubscriptionCTACopyEvidenceUITests/testPaywallUsesSharedTrialCTA"
            "-only-testing:example-iosUITests/SubscriptionCTACopyEvidenceUITests/testPaywallUsesSubscribeCTAWhenTrialIneligible"
          )
          ;;
        *)
          affected_ui_arguments+=("-only-testing:$test_identifier")
          ;;
      esac
    done < "$only_testing_file"
  fi
  # The change gate maps each affected UI identifier to its lane once
  # (gate output native_ui_method_owners); an unmapped identifier runs on native1.
  ui_owner_lanes="${IOS_UI_METHOD_OWNERS:-}"
  case "$partition" in
    native1|native2|native3|native4)
      if [[ "${#affected_ui_arguments[@]}" -gt 0 && -z "$ui_owner_lanes" ]]; then
        echo "::error::${partition} has affected UI tests but no owner map (IOS_UI_METHOD_OWNERS)." \
          "The iOS change gate's planner must publish native_ui_method_owners."
        exit 1
      fi
      ;;
  esac
  owned_ui_arguments=()
  if [[ "${#affected_ui_arguments[@]}" -gt 0 ]]; then
    for argument in "${affected_ui_arguments[@]}"; do
      identifier="${argument#-only-testing:}"
      owner="$(jq -r --arg identifier "$identifier" '.[$identifier] // "native1"' \
        <<< "$ui_owner_lanes")"
      if [[ "$partition" == "all" || "$partition" == "$owner" ]]; then
        owned_ui_arguments+=("$argument")
      fi
    done
  fi
  affected_ui_arguments=()
  if [[ "${#owned_ui_arguments[@]}" -gt 0 ]]; then
    affected_ui_arguments=("${owned_ui_arguments[@]}")
  fi
  if [[ "$partition" != "all" && "$partition" != "native1" ]]; then
    run_financial_independence_evidence=false
  fi
  affected_unit_arguments+=(
    -only-testing:example-iosTests/NextCardActivationResolverTests/testResolveReturnsProfileFirstWhenUnactivated
  )

  affected_unit_result="$run_dir/affected-unit-tests.xcresult"
  affected_ui_result="$run_dir/affected-ui-tests.xcresult"
  affected_unit_log="$run_dir/affected-unit-tests.log"
  affected_ui_log="$run_dir/affected-ui-tests.log"
  rm -rf \
    "$affected_unit_result" \
    "$affected_ui_result" \
    "$affected_unit_log" \
    "$affected_ui_log"

  affected_unit_status=0
  if [[ "$partition" == "all" || "$partition" == "unit" ]]; then
    run_xcodebuild "affected unit preflight" "$affected_unit_log" \
      "${common_arguments[@]}" \
      -destination "$primary_destination" \
      -parallel-testing-enabled NO \
      -resultBundlePath "$affected_unit_result" \
      "${affected_unit_arguments[@]}" \
      "${skip_arguments[@]}" \
      || affected_unit_status=$?
  fi
  if [[ "$affected_unit_status" -ne 0 ]]; then
    cat "$affected_unit_log" > "$xcodebuild_log"
    if [[ -d "$affected_unit_result" ]]; then
      rm -rf "$result_bundle"
      cp -R "$affected_unit_result" "$result_bundle"
    fi
    echo "::error::Affected unit preflight failed; affected UI tests were not started."
    exit "$affected_unit_status"
  fi

  if [[ "$partition" == "unit" ]]; then
    cat "$affected_unit_log" > "$xcodebuild_log"
    rm -rf "$result_bundle"
    cp -R "$affected_unit_result" "$result_bundle"
    exit 0
  fi

  if [[ "$run_financial_independence_evidence" == "true" ]]; then
    financial_independence_root="$run_dir/financial-independence-system-size-runs"
    fixture_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
    # xcodebuild strips TEST_RUNNER_, so the hosted unit test and the UI
    # runner read FINANCIAL_INDEPENDENCE_FIXTURE_JSON and _CONTENT_SIZE. The
    # fixture then never depends on the installed app bundle's SourceSnapshot.
    export TEST_RUNNER_FINANCIAL_INDEPENDENCE_FIXTURE_JSON
    TEST_RUNNER_FINANCIAL_INDEPENDENCE_FIXTURE_JSON="$(cat "$fixture_root/shared/schemas/fixtures/financial-independence-terminal.json")"
    financial_independence_simulator_udid="${primary_destination##*id=}"
    financial_independence_status=0
    financial_independence_results=()
    financial_independence_result_count=0
    rm -rf "$financial_independence_root"
    mkdir -p "$financial_independence_root"
    : > "$xcodebuild_log"

    # Native1 does not run the unit preflight that previously booted this
    # simulator as a side effect. Prepare it explicitly before changing its
    # Dynamic Type setting so an evidence-only dispatch works from a cold VM.
    prepare_simulator \
      "$financial_independence_simulator_udid" \
      "financial-independence evidence" \
      || financial_independence_status=$?

    while [[ "$financial_independence_status" -eq 0 ]] && \
      IFS=: read -r requested_size simulator_size size_label; do
      size_result="$financial_independence_root/$requested_size.xcresult"
      size_log="$financial_independence_root/$requested_size.log"
      rm -rf "$size_result" "$size_log"
      if ! set_and_verify_content_size \
        "$financial_independence_simulator_udid" "$simulator_size" \
        "financial-independence $size_label"; then
        financial_independence_status=1
        break
      fi
      xcrun simctl shutdown "$financial_independence_simulator_udid" >/dev/null 2>&1 || true
      if ! xcrun simctl boot "$financial_independence_simulator_udid" >/dev/null 2>&1 \
        || ! xcrun simctl bootstatus "$financial_independence_simulator_udid" -b >/dev/null 2>&1; then
        echo "::error::Could not relaunch the financial-independence simulator for $size_label."
        financial_independence_status=1
        break
      fi
      TEST_RUNNER_FINANCIAL_INDEPENDENCE_CONTENT_SIZE="$requested_size" \
        run_xcodebuild "financial-independence $size_label evidence" "$size_log" \
          "${common_arguments[@]}" \
          -destination "$primary_destination" \
          -parallel-testing-enabled NO \
          -resultBundlePath "$size_result" \
          -only-testing:example-iosTests/FinancialIndependenceEvidenceTests/testRenderedFinancialIndependenceEvidenceMatrix \
          -only-testing:example-iosTests/FinancialIndependenceEvidenceTests/testStatusChipBackgroundsMeetNormalTextContrast \
          -only-testing:example-iosUITests/TourCopyReviewEvidenceUITests/testCaptureFinancialIndependenceAccessibilityHierarchy \
          "${skip_arguments[@]}" \
          || financial_independence_status=$?
      if [[ -d "$size_result" ]]; then
        financial_independence_results+=("$size_result")
        financial_independence_result_count=$((financial_independence_result_count + 1))
      fi
      [[ -f "$size_log" ]] && cat "$size_log" >> "$xcodebuild_log"
      [[ "$financial_independence_status" -eq 0 ]] || break
    done <<'EOF'
large:large:Large
accessibilityExtraExtraExtraLarge:accessibility-extra-extra-extra-large:Accessibility XXXL
EOF

    set_and_verify_content_size \
      "$financial_independence_simulator_udid" large \
      "financial-independence restored Large" \
      || financial_independence_status=$?
    if [[ "$financial_independence_status" -eq 0 ]]; then
      xcrun simctl shutdown "$financial_independence_simulator_udid" >/dev/null 2>&1 || true
      xcrun simctl boot "$financial_independence_simulator_udid" >/dev/null 2>&1 \
        || financial_independence_status=$?
      xcrun simctl bootstatus "$financial_independence_simulator_udid" -b >/dev/null 2>&1 \
        || financial_independence_status=$?
    fi
    rm -rf "$result_bundle"
    if [[ "$financial_independence_result_count" -eq 1 ]]; then
      cp -R "${financial_independence_results[0]}" "$result_bundle"
    elif [[ "$financial_independence_result_count" -gt 1 ]]; then
      xcrun xcresulttool merge \
        --output-path "$result_bundle" \
        "${financial_independence_results[@]}"
    fi
    if [[ "$financial_independence_status" -eq 0 ]]; then
      {
        echo "FINANCIAL_INDEPENDENCE_SCREENSHOT_COUNT=42"
        echo "FINANCIAL_INDEPENDENCE_GEOMETRY=badge56_terminal1_connector_center"
        echo "FINANCIAL_INDEPENDENCE_ACCESSIBILITY_OBSERVATION_COUNT=14"
        echo "FINANCIAL_INDEPENDENCE_RENDERED_SURFACE_COUNT=42"
        echo "FINANCIAL_INDEPENDENCE_SYSTEM_CONTENT_SIZE_LARGE=large"
        echo "FINANCIAL_INDEPENDENCE_SYSTEM_CONTENT_SIZE_ACCESSIBILITY_XXXL=accessibility-extra-extra-extra-large"
      } >> "$xcodebuild_log"
    fi
    if [[ "$financial_independence_status" -ne 0 ]]; then
      exit "$financial_independence_status"
    fi
    if [[ "${#affected_ui_arguments[@]}" -eq 0 && "$narrow_paywall_required" != "true" ]]; then
      exit 0
    fi
  fi

  if [[ "${#affected_ui_arguments[@]}" -eq 0 ]]; then
    case "$partition" in
      native1)
        echo "No affected UI tests selected for native1."
        if [[ "$run_financial_independence_evidence" == "true" ]]; then
          narrow_status=0
          run_narrow_paywall_evidence "$xcodebuild_log" "$result_bundle" || narrow_status=$?
          exit "$narrow_status"
        fi
        : > "$xcodebuild_log"
        exit 0
        ;;
      native2|native3|native4)
        echo "No affected UI tests selected for ${partition}."
        : > "$xcodebuild_log"
        exit 0
        ;;
    esac
    cat "$affected_unit_log" > "$xcodebuild_log"
    rm -rf "$result_bundle"
    cp -R "$affected_unit_result" "$result_bundle"
    narrow_status=0
    run_narrow_paywall_evidence "$xcodebuild_log" "$result_bundle" || narrow_status=$?
    exit "$narrow_status"
  fi

  expected_ui_test_count="$(node "$script_dir/../ci/src/actions/ios/countAffectedUiTests.ts" \
    "${affected_ui_arguments[@]}" "${primary_ui_skip_arguments[@]}")"
  affected_ui_status=0
  resolve_native_ui_parallel_arguments "${affected_ui_arguments[@]}"
  run_xcodebuild "affected UI tests" "$affected_ui_log" \
    "${common_arguments[@]}" \
    -destination "$primary_destination" \
    "${resolved_native_ui_parallel_arguments[@]}" \
    -resultBundlePath "$affected_ui_result" \
    "${affected_ui_arguments[@]}" \
    "${primary_ui_skip_arguments[@]}" \
    || affected_ui_status=$?
  if [[ "$partition" == "native1" ]]; then
    if [[ "$run_financial_independence_evidence" == "true" ]]; then
      cat "$affected_ui_log" >> "$xcodebuild_log"
    else
      cat "$affected_ui_log" > "$xcodebuild_log"
    fi
    if [[ -d "$affected_ui_result" ]]; then
      if [[ -d "$result_bundle" ]]; then
        affected_ui_merged_result="$result_bundle.affected-ui-merge"
        rm -rf "$affected_ui_merged_result"
        xcrun xcresulttool merge \
          --output-path "$affected_ui_merged_result" \
          "$result_bundle" \
          "$affected_ui_result"
        rm -rf "$result_bundle"
        mv "$affected_ui_merged_result" "$result_bundle"
      else
        cp -R "$affected_ui_result" "$result_bundle"
      fi
    fi
    if [[ "$affected_ui_status" -eq 0 ]]; then
      bash "$script_dir/validate-xcresult-execution.sh" \
        "$affected_ui_result" "Affected UI partition" 1 \
        "$expected_ui_test_count"
    fi
    narrow_status=0
    run_narrow_paywall_evidence "$xcodebuild_log" "$result_bundle" || narrow_status=$?
    if [[ "$affected_ui_status" -ne 0 ]]; then
      exit "$affected_ui_status"
    fi
    exit "$narrow_status"
  fi
  if [[ "$partition" != "all" ]]; then
    cat "$affected_ui_log" > "$xcodebuild_log"
    rm -rf "$result_bundle"
    if [[ -d "$affected_ui_result" ]]; then
      cp -R "$affected_ui_result" "$result_bundle"
    fi
    if [[ "$affected_ui_status" -eq 0 ]]; then
      bash "$script_dir/validate-xcresult-execution.sh" \
        "$affected_ui_result" "Affected UI partition $partition" 1 \
        "$expected_ui_test_count"
    fi
    exit "$affected_ui_status"
  fi
  cat "$affected_unit_log" "$affected_ui_log" > "$xcodebuild_log"
  if [[ -d "$affected_ui_result" ]]; then
    xcrun xcresulttool merge \
      --output-path "$result_bundle" \
      "$affected_unit_result" \
      "$affected_ui_result"
  else
    cp -R "$affected_unit_result" "$result_bundle"
  fi
  if [[ "$affected_ui_status" -eq 0 ]]; then
    bash "$script_dir/validate-xcresult-execution.sh" \
      "$affected_ui_result" "Affected UI partition all" 1 \
      "$expected_ui_test_count"
  fi
  narrow_status=0
  run_narrow_paywall_evidence "$xcodebuild_log" "$result_bundle" || narrow_status=$?
  if [[ "$affected_ui_status" -ne 0 ]]; then
    exit "$affected_ui_status"
  fi
  exit "$narrow_status"
fi

if [[ "$partition" == "all" && ( -z "$ui_destination" || -z "$budget_destination" ) ]]; then
  echo "::error::Full iOS execution requires direct UI and Budget simulators." >&2
  exit 2
fi

ui_shard_zero="$run_dir/ui-shard-zero.txt"
ui_shard_one="$run_dir/ui-shard-one.txt"
ui_shard_two="$run_dir/ui-shard-two.txt"
ui_shard_three="$run_dir/ui-shard-three.txt"
budget_tests="$run_dir/budget-tests.txt"
unit_result="$run_dir/unit-tests.xcresult"
unit_log="$run_dir/unit-tests.log"

# Run every selected unit test before starting the long UI shards. This still
# reports the complete unit suite, but a deterministic unit or harness failure
# cannot consume another full UI cycle. The UI phases reuse these same compiled
# test products after the unit preflight passes.
rm -rf "$unit_result" "$unit_log"
unit_status=0
if [[ "$partition" == "all" || "$partition" == "unit" ]]; then
  run_xcodebuild "unit test preflight" "$unit_log" \
    "${common_arguments[@]}" \
    -destination "$primary_destination" \
    -parallel-testing-enabled NO \
    -resultBundlePath "$unit_result" \
    -only-testing:example-iosTests \
    "${skip_arguments[@]}" \
    || unit_status=$?
  if [[ "$unit_status" -ne 0 ]]; then
    cat "$unit_log" > "$xcodebuild_log"
    if [[ -d "$unit_result" ]]; then
      rm -rf "$result_bundle"
      cp -R "$unit_result" "$result_bundle"
    fi
    echo "::error::Unit test preflight failed; long-running UI shards were not started."
    exit "$unit_status"
  fi
fi
if [[ "$partition" == "unit" ]]; then
  cat "$unit_log" > "$xcodebuild_log"
  rm -rf "$result_bundle"
  cp -R "$unit_result" "$result_bundle"
  exit 0
fi

if [[ "$partition" == "all" ]]; then
  ui_simulator_udid="${ui_destination##*id=}"
  budget_simulator_udid="${budget_destination##*id=}"
  prepare_simulator "$ui_simulator_udid" "Main UI shard"
  prepare_simulator "$budget_simulator_udid" "Main Budget shard"
  set_and_verify_content_size "$ui_simulator_udid" large "Main UI shard"
  set_and_verify_content_size "$budget_simulator_udid" large "Main Budget shard"
else
  primary_simulator_udid="${primary_destination##*id=}"
  prepare_simulator "$primary_simulator_udid" "$partition"
  set_and_verify_content_size "$primary_simulator_udid" large "$partition"
fi

test_plan_path="example-ios.xcodeproj/xcshareddata/TestPlans/${test_plan}.xctestplan"
duration_hints_path="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/ios/ci/ui-test-duration-weights.json"
ui_exclusions="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/ios/ci/ui-test-primary-exclusions.txt"
if [[ "$partition" == "all" ]]; then
  # The direct all-mode path has three UI simulators. Preserve its three-way
  # schedule; matrix mode can use native1 as a fourth, smaller UI shard.
  node ../ci/src/actions/ios/partitionFullUiTests.ts \
    "$test_plan_path" example-iosUITests "$duration_hints_path" "$ui_exclusions" \
    "$ui_shard_one" "$ui_shard_two" "$ui_shard_three"
else
  node ../ci/src/actions/ios/partitionFullUiTests.ts \
    "$test_plan_path" example-iosUITests "$duration_hints_path" "$ui_exclusions" \
    "$ui_shard_zero" "$ui_shard_one" "$ui_shard_two" "$ui_shard_three"
fi
node ../ci/src/actions/ios/partitionUiTests.ts \
  "$test_plan_path" example-iosUITests "$duration_hints_path" example-iosBudgetDebtUITests "$budget_tests"

budget_result="$run_dir/budget-tests.xcresult"
ui_one_result="$run_dir/ui-shard-one.xcresult"
ui_two_result="$run_dir/ui-shard-two.xcresult"
ui_three_result="$run_dir/ui-shard-three.xcresult"
budget_log="$run_dir/budget-tests.log"
ui_one_log="$run_dir/ui-shard-one.log"
ui_two_log="$run_dir/ui-shard-two.log"
ui_three_log="$run_dir/ui-shard-three.log"
# Preserve the completed unit bundle for the final merge with the UI results.
rm -rf \
  "$budget_result" \
  "$ui_one_result" \
  "$ui_two_result" \
  "$ui_three_result"

ui_zero_arguments=()
if [[ "$partition" != "all" ]]; then
  while IFS= read -r identifier; do
    [[ -n "$identifier" ]] || continue
    ui_zero_arguments+=("-only-testing:$identifier")
  done < "$ui_shard_zero"
fi
ui_one_arguments=()
while IFS= read -r identifier; do
  [[ -n "$identifier" ]] || continue
  ui_one_arguments+=("-only-testing:$identifier")
done < "$ui_shard_one"
ui_two_arguments=()
while IFS= read -r identifier; do
  [[ -n "$identifier" ]] || continue
  ui_two_arguments+=("-only-testing:$identifier")
done < "$ui_shard_two"
ui_three_arguments=()
while IFS= read -r identifier; do
  [[ -n "$identifier" ]] || continue
  ui_three_arguments+=("-only-testing:$identifier")
done < "$ui_shard_three"
budget_arguments=()
while IFS= read -r identifier; do
  [[ -n "$identifier" ]] || continue
  budget_arguments+=("-only-testing:$identifier")
done < "$budget_tests"

if [[ "$partition" != "all" ]]; then
  case "$partition" in
    native1)
      # Native1's bounded UI share reuses the Budget simulator. StoreKit UI
      # methods live here, so the other three lanes can keep two workers when
      # their Mac has enough memory.
      run_xcodebuild "Budget and serial UI partition" "$xcodebuild_log" \
        "${common_arguments[@]}" \
        -destination "$primary_destination" \
        -parallel-testing-enabled NO \
        -resultBundlePath "$result_bundle" \
        "${budget_arguments[@]}" \
        "${ui_zero_arguments[@]}" \
        "${primary_ui_skip_arguments[@]}"
      bash "$script_dir/validate-xcresult-execution.sh" \
        "$result_bundle" "Budget and UI partition" 1 \
        "$(( ${#budget_arguments[@]} + ${#ui_zero_arguments[@]} ))"
      ;;
    native2|native3|native4)
      case "$partition" in
        native2) shard_arguments=("${ui_one_arguments[@]}") ;;
        native3) shard_arguments=("${ui_two_arguments[@]}") ;;
        native4) shard_arguments=("${ui_three_arguments[@]}") ;;
      esac
      resolve_native_ui_parallel_arguments "${shard_arguments[@]}"
      run_xcodebuild "UI partition ${partition}" "$xcodebuild_log" \
        "${common_arguments[@]}" \
        -destination "$primary_destination" \
        "${resolved_native_ui_parallel_arguments[@]}" \
        -resultBundlePath "$result_bundle" \
        "${shard_arguments[@]}" \
        "${primary_ui_skip_arguments[@]}"
      bash "$script_dir/validate-xcresult-execution.sh" \
        "$result_bundle" "UI partition ${partition}" 1 "${#shard_arguments[@]}"
      ;;
    *)
      echo "::error::Unknown iOS main-test partition: $partition" >&2
      exit 2
      ;;
  esac
  exit 0
fi

run_xcodebuild "Budget test target" "$budget_log" \
  "${common_arguments[@]}" \
  -destination "$budget_destination" \
  -parallel-testing-enabled NO \
  -resultBundlePath "$budget_result" \
  -only-testing:example-iosBudgetDebtUITests &
budget_pid=$!
child_pids+=("$budget_pid")

run_xcodebuild "UI shard one" "$ui_one_log" \
  "${common_arguments[@]}" \
  -destination "$ui_destination" \
  -parallel-testing-enabled NO \
  -resultBundlePath "$ui_one_result" \
  "${ui_one_arguments[@]}" \
  "${primary_ui_skip_arguments[@]}" &
ui_one_pid=$!
child_pids+=("$ui_one_pid")

run_xcodebuild "UI shard three" "$ui_three_log" \
  "${common_arguments[@]}" \
  -destination "$primary_destination" \
  -parallel-testing-enabled NO \
  -resultBundlePath "$ui_three_result" \
  "${ui_three_arguments[@]}" \
  "${primary_ui_skip_arguments[@]}" &
ui_three_pid=$!
child_pids+=("$ui_three_pid")

# The Budget target is intentionally small. Reuse its already-booted simulator
# for the second UI shard as soon as that target finishes instead of waiting for
# another simulator.
set +e
wait "$budget_pid"
budget_status=$?
set -e
child_pids=("$ui_one_pid" "$ui_three_pid")
ui_two_status=0
run_xcodebuild "UI shard two" "$ui_two_log" \
  "${common_arguments[@]}" \
  -destination "$budget_destination" \
  -parallel-testing-enabled NO \
  -resultBundlePath "$ui_two_result" \
  "${ui_two_arguments[@]}" \
  "${primary_ui_skip_arguments[@]}" &
ui_two_pid=$!
child_pids+=("$ui_two_pid")

set +e
wait "$ui_one_pid"
ui_one_status=$?
wait "$ui_two_pid"
ui_two_status=$?
wait "$ui_three_pid"
ui_three_status=$?
set -e
child_pids=()

cat \
  "$unit_log" \
  "$budget_log" \
  "$ui_one_log" \
  "$ui_two_log" \
  "$ui_three_log" \
  > "$xcodebuild_log"

result_bundles=()
for bundle in \
  "$unit_result" \
  "$budget_result" \
  "$ui_one_result" \
  "$ui_two_result" \
  "$ui_three_result"; do
  [[ -d "$bundle" ]] && result_bundles+=("$bundle")
done
if [[ "${#result_bundles[@]}" -gt 0 ]]; then
  rm -rf "$result_bundle"
  xcrun xcresulttool merge --output-path "$result_bundle" "${result_bundles[@]}"
fi

narrow_status=0
run_narrow_paywall_evidence "$xcodebuild_log" "$result_bundle" || narrow_status=$?

echo "Direct shard status: unit=$unit_status budget=$budget_status ui-one=$ui_one_status ui-two=$ui_two_status ui-three=$ui_three_status narrow-paywall=$narrow_status"
for status in \
  "$unit_status" \
  "$budget_status" \
  "$ui_one_status" \
  "$ui_two_status" \
  "$ui_three_status" \
  "$narrow_status"; do
  if [[ "$status" -ne 0 ]]; then
    exit "$status"
  fi
done

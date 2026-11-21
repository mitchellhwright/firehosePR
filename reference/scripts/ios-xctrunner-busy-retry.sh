#!/usr/bin/env bash

# Shared by every precompiled XCTest launcher. Callers must use
# run_ios_xcodebuild_with_busy_retry instead of invoking xcodebuild directly.
ios_busy_retry_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! declare -F run_with_timeout >/dev/null ||
   ! declare -F wait_for_simulator_boot >/dev/null; then
  # The path is resolved from this script at runtime.
  # shellcheck disable=SC1091
  source "$ios_busy_retry_script_dir/ios-ci-simulator-preparation.sh"
fi

# Exit 0 only for a Busy .xctrunner launch denial in a session that ran no
# test; ci/src/ios/xctrunnerBusy.ts owns the rule.
ios_is_xctrunner_busy_failure() {
  local status="$1"
  local destination="$2"
  local log_file="$3"
  local result_path="$4"
  node "$ios_busy_retry_script_dir/../ci/src/actions/ios/classifyXctrunnerBusyFailure.ts" \
    "$status" "$destination" "$log_file" "$result_path"
}

ios_destination_udid() {
  local destination="$1"
  local simulator_udid="${destination##*id=}"
  echo "${simulator_udid%%,*}"
}

# xcodebuild boots a shut-down destination itself, launches the .xctrunner
# before SpringBoard has finished booting (SBMainWorkspace then denies it as
# Busy), and shuts that simulator down again when the session ends, so every
# later session on it repeats the race. bootstatus -b boots the device when
# needed and returns once the boot has completed; a simulator the lane booted
# stays booted across sessions.
ios_boot_destination() {
  local phase="$1"
  local destination="$2"
  [[ "$destination" == *"platform=iOS Simulator"* && "$destination" == *"id="* ]] || return 0
  local simulator_udid
  simulator_udid="$(ios_destination_udid "$destination")"
  if ! wait_for_simulator_boot "$simulator_udid" >/dev/null; then
    echo "::error::${phase} could not finish booting simulator ${simulator_udid} before launching XCTest." >&2
    return 1
  fi
}

ios_reboot_busy_simulator() {
  local destination="$1"
  local simulator_udid
  simulator_udid="$(ios_destination_udid "$destination")"
  local inventory=""
  local shutdown_confirmed=false
  # simctl shutdown returns once the device has shut down, so one read of the
  # inventory confirms the state; a device still transitioning fails closed.
  if ! run_with_timeout 15 xcrun simctl shutdown "$simulator_udid" >/dev/null 2>&1; then
    echo "::warning::Simulator $simulator_udid did not accept the shutdown request." >&2
    return 1
  fi
  if inventory="$(run_with_timeout 15 xcrun simctl list devices -j 2>/dev/null)" \
    && jq -e --arg udid "$simulator_udid" \
      '[.devices[][] | select(.udid == $udid)] | length == 1 and .[0].state == "Shutdown"' \
      <<< "$inventory" >/dev/null; then
    shutdown_confirmed=true
  fi
  if [[ "$shutdown_confirmed" != true ]]; then
    echo "::warning::Simulator $simulator_udid never reached confirmed Shutdown state." >&2
    return 1
  fi
  if ! run_with_timeout 15 xcrun simctl boot "$simulator_udid" >/dev/null 2>&1; then
    echo "::warning::Simulator $simulator_udid failed to boot after confirmed shutdown." >&2
    return 1
  fi
  wait_for_simulator_boot "$simulator_udid"
}

ios_prime_storekit_with_busy_retry() {
  local phase="$1"
  local log_file="$2"
  local destination="$3"
  shift 3
  local status=0
  local first_failure_log="${log_file%.log}.first-launch-busy.log"
  local first_failure_result="${log_file%.log}.first-launch-failure.xcresult"
  local retry_failure_result="${log_file%.log}.retry.first-launch-failure.xcresult"
  local errexit_was_set=false
  [[ $- == *e* ]] && errexit_was_set=true
  rm -f "$log_file"
  set +e
  IOS_STOREKIT_PRIME_FAILURE_RESULT="$first_failure_result" \
    bash "$ios_busy_retry_script_dir/prime-ios-paywall-storekit.sh" "$@" 2>&1 | tee "$log_file"
  status="${PIPESTATUS[0]}"
  if [[ "$errexit_was_set" == true ]]; then set -e; else set +e; fi
  if [[ "$status" -eq 0 ]]; then
    return 0
  fi
  if ! ios_is_xctrunner_busy_failure "$status" "$destination" "$log_file" "$first_failure_result"; then
    return "$status"
  fi
  if ! ios_reboot_busy_simulator "$destination"; then
    echo "::warning::${phase} StoreKit priming simulator reboot failed; preserving the original failure." \
      | tee -a "$log_file"
    return "$status"
  fi
  rm -f "$first_failure_log"
  mv "$log_file" "$first_failure_log"
  echo "::warning::${phase} StoreKit priming hit a simulator .xctrunner Busy preflight failure; rebooted that destination and retrying priming once. First failure log: ${first_failure_log}" \
    | tee "$log_file"
  set +e
  IOS_STOREKIT_PRIME_FAILURE_RESULT="$retry_failure_result" \
    bash "$ios_busy_retry_script_dir/prime-ios-paywall-storekit.sh" "$@" 2>&1 | tee -a "$log_file"
  status="${PIPESTATUS[0]}"
  if [[ "$errexit_was_set" == true ]]; then set -e; else set +e; fi
  return "$status"
}

run_ios_xcodebuild_with_busy_retry() {
  local phase="$1"
  local log_file="$2"
  local xcodebuild_bin="$3"
  shift 3
  local status=0
  local started_at=$SECONDS
  local argument
  local destination=""
  local previous_argument=""
  local result_path=""
  local errexit_was_set=false
  [[ $- == *e* ]] && errexit_was_set=true
  for argument in "$@"; do
    case "$previous_argument" in
      -destination) destination="$argument" ;;
      -resultBundlePath) result_path="$argument" ;;
    esac
    previous_argument="$argument"
  done
  [[ -n "$destination" && -n "$result_path" ]] || {
    echo "::error::${phase} Busy recovery requires one destination and result bundle." >&2
    return 2
  }
  ios_boot_destination "$phase" "$destination" || return $?
  local prime_log="${log_file%.log}.storekit-prime.log"
  ios_prime_storekit_with_busy_retry "$phase" "$prime_log" "$destination" "$@" || return $?
  echo "::notice::Starting ${phase}; test products are already compiled."
  rm -f "$log_file"
  set +e
  "$xcodebuild_bin" "$@" 2>&1 | tee "$log_file"
  status="${PIPESTATUS[0]}"
  if [[ "$errexit_was_set" == true ]]; then set -e; else set +e; fi
  if ios_is_xctrunner_busy_failure "$status" "$destination" "$log_file" "$result_path"; then
    local first_failure_result="${result_path%.xcresult}.first-launch-failure.xcresult"
    local first_failure_log="${log_file%.log}.first-launch-busy.log"
    if ios_reboot_busy_simulator "$destination"; then
      rm -rf "$first_failure_result"
      if [[ -e "$result_path" ]]; then
        mv "$result_path" "$first_failure_result"
      fi
      rm -f "$first_failure_log"
      mv "$log_file" "$first_failure_log"
      echo "::warning::${phase} hit a simulator .xctrunner Busy preflight failure; rebooted that destination and retrying once with the existing test products. First failure log: ${first_failure_log}" \
        | tee "$log_file"
      local retry_prime_log="${log_file%.log}.post-reboot-storekit-prime.log"
      if ios_prime_storekit_with_busy_retry \
        "$phase post-reboot" "$retry_prime_log" "$destination" "$@"; then
        set +e
        "$xcodebuild_bin" "$@" 2>&1 | tee -a "$log_file"
        status="${PIPESTATUS[0]}"
        if [[ "$errexit_was_set" == true ]]; then set -e; else set +e; fi
      else
        status="$?"
        echo "::error::${phase} StoreKit re-priming failed after the simulator reboot; skipping the XCTest retry." \
          | tee -a "$log_file"
      fi
    else
      echo "::warning::${phase} simulator reboot failed; preserving the original XCTest failure." \
        | tee -a "$log_file"
    fi
  fi
  echo "::notice::${phase} finished in $((SECONDS - started_at)) seconds with status ${status}."
  return "$status"
}

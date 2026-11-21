#!/usr/bin/env bash
set -euo pipefail

# Runs the Budget regression suite against a real NODE_ENV=development API and
# its development Cloud SQL database.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_path="${repo_root}/ios/example-ios.xcodeproj"
test_plan="${BUDGET_E2E_TEST_PLAN:-Budget-E2E}"
expected_test_count="${BUDGET_E2E_EXPECTED_TEST_COUNT:-14}"
evidence_issue="${BUDGET_E2E_EVIDENCE_ISSUE:-3996}"
only_testing_raw="${BUDGET_E2E_ONLY_TESTING:-}"
only_testing_arguments=()

load_test_otp_secret() {
  if [[ -n "${TEST_OTP_SECRET:-}" ]]; then
    return
  fi

  local candidate secret_line
  for candidate in "${repo_root}/.env" "${HOME}/example-dev.env"; do
    [[ -f "${candidate}" ]] || continue
    secret_line="$(grep -E '^[[:space:]]*TEST_OTP_SECRET[[:space:]]*=' "${candidate}" | tail -n 1 || true)"
    [[ -n "${secret_line}" ]] || continue
    TEST_OTP_SECRET="${secret_line#*=}"
    TEST_OTP_SECRET="${TEST_OTP_SECRET#\"}"
    TEST_OTP_SECRET="${TEST_OTP_SECRET%\"}"
    TEST_OTP_SECRET="${TEST_OTP_SECRET#\'}"
    TEST_OTP_SECRET="${TEST_OTP_SECRET%\'}"
    export TEST_OTP_SECRET
    return
  done
}

load_test_otp_secret

if [[ -z "${TEST_OTP_SECRET:-}" ]]; then
  echo "TEST_OTP_SECRET is required for Budget E2E" >&2
  exit 2
fi

UI_TEST_API_BASE_URL="${UI_TEST_API_BASE_URL:-http://127.0.0.1:3000/api}"
UI_TEST_API_TIMEOUT="${UI_TEST_API_TIMEOUT:-180}"
if [[ ! "${UI_TEST_API_TIMEOUT}" =~ ^[1-9][0-9]*$ ]]; then
  echo "UI_TEST_API_TIMEOUT must be a positive integer" >&2
  exit 2
fi
if [[ -z "${UI_TEST_EMAIL:-}" ]]; then
  if [[ -n "${GITHUB_RUN_ID:-}" ]]; then
    UI_TEST_EMAIL="budget-e2e-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}@test.example.local"
  else
    local_run_id="$(
      node --input-type=module --eval \
        'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID());'
    )"
    UI_TEST_EMAIL="budget-e2e-local-${local_run_id}@test.example.local"
  fi
fi
UI_TEST_PASSWORD="${UI_TEST_PASSWORD:-BudgetE2E-2026-Local!}"
EXPECTED_SERVER_BUILD_SHA="${EXPECTED_SERVER_BUILD_SHA:-${EXAMPLE_BUILD_SHA:-}}"
if [[ ! "${EXPECTED_SERVER_BUILD_SHA}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "EXPECTED_SERVER_BUILD_SHA must be the exact 40-character PR head" >&2
  exit 2
fi
UI_TEST_EXPECTED_SERVER_BUILD_SHA="${EXPECTED_SERVER_BUILD_SHA}"
# Preserve the host's client calendar date before normalizing subprocess output to UTC.
UI_TEST_CLIENT_DATE="${UI_TEST_CLIENT_DATE:-$(date +%F)}"
if [[ ! "${UI_TEST_CLIENT_DATE}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "UI_TEST_CLIENT_DATE must be YYYY-MM-DD" >&2
  exit 2
fi
export TZ=UTC
export UI_TEST_API_BASE_URL UI_TEST_API_TIMEOUT UI_TEST_CLIENT_DATE UI_TEST_EMAIL UI_TEST_PASSWORD
export UI_TEST_EXPECTED_SERVER_BUILD_SHA

# xcodebuild only forwards TEST_RUNNER_ variables to the UI-test process.
for variable in \
  UI_TEST_API_BASE_URL \
  UI_TEST_API_TIMEOUT \
  UI_TEST_CLIENT_DATE \
  UI_TEST_EMAIL \
  UI_TEST_PASSWORD \
  UI_TEST_EXPECTED_SERVER_BUILD_SHA \
  TEST_OTP_SECRET; do
  if [[ -n "${!variable:-}" ]]; then
    export "TEST_RUNNER_${variable}=${!variable}"
  fi
done

destination="${DESTINATION:-platform=iOS Simulator,name=iPhone 17}"
runner_temp="${RUNNER_TEMP:-/tmp}"
run_dir="${BUDGET_E2E_RUN_DIR:-$(mktemp -d "${runner_temp}/budget-e2e.XXXXXX")}"
result_bundle="${RESULT_BUNDLE:-${run_dir}/budget-e2e.xcresult}"
derived_data="${DERIVED_DATA:-${run_dir}/DerivedData}"
source_packages="${SOURCE_PACKAGES:-${run_dir}/SourcePackages}"
package_cache="${PACKAGE_CACHE:-${run_dir}/PackageCache}"
xcodebuild_log="${XCODEBUILD_LOG:-${run_dir}/xcodebuild.log}"
test_products="${TEST_PRODUCTS:-}"
skip_build="${SKIP_BUILD:-0}"
simulator_boot_timeout_seconds="${SIMULATOR_BOOT_TIMEOUT_SECONDS:-60}"
record_video="${RECORD_VIDEO:-0}"
defer_video_processing="${DEFER_VIDEO_PROCESSING:-0}"
raw_video="${RAW_VIDEO:-${run_dir}/budget-e2e.raw.mp4}"
compressed_video="${COMPRESSED_VIDEO:-${run_dir}/budget-e2e.compressed.mp4}"
video_log="${VIDEO_LOG:-${run_dir}/budget-e2e-video.log}"
cleanup_receipt="${BUDGET_E2E_CLEANUP_RECEIPT:-${run_dir}/issue-${evidence_issue}-cleanup-receipt.json}"
freshness_receipt="${BUDGET_E2E_FRESHNESS_RECEIPT:-}"
video_pid=""
budget_cleanup_token=""
budget_user_provisioned=0
budget_auth_user_id=""

if [[ ! "${expected_test_count}" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUDGET_E2E_EXPECTED_TEST_COUNT must be a positive integer" >&2
  exit 2
fi
if [[ ! "${evidence_issue}" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUDGET_E2E_EVIDENCE_ISSUE must be a positive integer" >&2
  exit 2
fi
if [[ ! "${simulator_boot_timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  echo "SIMULATOR_BOOT_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 2
fi
if [[ "${skip_build}" != "0" && "${skip_build}" != "1" ]]; then
  echo "SKIP_BUILD must be 0 or 1" >&2
  exit 2
fi
if [[ -n "${only_testing_raw}" ]]; then
  while IFS= read -r test_identifier; do
    [[ -n "${test_identifier}" ]] || continue
    if [[ "${test_identifier}" != example-iosBudgetDebtUITests/* ]]; then
      echo "Invalid Budget E2E test identifier: ${test_identifier}" >&2
      exit 2
    fi
    only_testing_arguments+=("-only-testing:${test_identifier}")
  done <<< "${only_testing_raw}"
  if [[ "${#only_testing_arguments[@]}" -eq 0 ]]; then
    echo "BUDGET_E2E_ONLY_TESTING did not contain a test identifier" >&2
    exit 2
  fi
fi

if [[ -e "${result_bundle}" ]]; then
  echo "Result bundle already exists: ${result_bundle}" >&2
  exit 2
fi

mkdir -p \
  "${run_dir}" \
  "$(dirname "${result_bundle}")" \
  "$(dirname "${xcodebuild_log}")" \
  "$(dirname "${video_log}")" \
  "$(dirname "${cleanup_receipt}")"

if [[ "${skip_build}" != "1" ]]; then
  mkdir -p "${derived_data}" "${source_packages}" "${package_cache}"
  bash "${repo_root}/scripts/prepare-ios-plaid-link.sh" "${source_packages}"
fi

probe_backend() {
  local metadata response response_with_status auth_user_id auth_body reset_body reset_response
  local reset_response_with_status
  local attempt curl_status http_status response_preview
  local reset_curl_status reset_http_status reset_response_preview
  local curl_args=(-fsS --max-time 30 -H "Accept: application/json" -H "x-test-otp-secret: ${TEST_OTP_SECRET}")
  local auth_curl_args=(-sS --max-time 30 -H "Accept: application/json" -H "x-test-otp-secret: ${TEST_OTP_SECRET}")

  metadata="$(curl "${curl_args[@]}" "${UI_TEST_API_BASE_URL%/}/test/budget-e2e/metadata")"
  printf '%s' "${metadata}" | EXPECTED_REPOSITORY_ROOT="${repo_root}" EXPECTED_BUILD_SHA="${EXPECTED_SERVER_BUILD_SHA}" python3 -c '
import json
import os
import sys

payload = json.load(sys.stdin)
expected = {
    "ready": True,
    "nodeEnv": "development",
    "repositoryRoot": os.environ["EXPECTED_REPOSITORY_ROOT"],
}
for key, value in expected.items():
    if payload.get(key) != value:
        raise SystemExit(f"Budget server metadata mismatch for {key}: {payload.get(key)!r}")
expected_sha = os.environ.get("EXPECTED_BUILD_SHA", "")
actual_sha = payload.get("buildSha")
if expected_sha and actual_sha != expected_sha:
    raise SystemExit(
        f"Budget server build SHA mismatch: {actual_sha!r} != {expected_sha!r}"
    )
'

  echo "Checking Budget E2E backend: ${UI_TEST_API_BASE_URL%/}/auth/test/otp"
  auth_body="$(
    UI_TEST_EMAIL="${UI_TEST_EMAIL}" UI_TEST_PASSWORD="${UI_TEST_PASSWORD}" python3 -c '
import json
import os

print(json.dumps({"email": os.environ["UI_TEST_EMAIL"], "password": os.environ["UI_TEST_PASSWORD"]}))
'
  )"
  response=""
  for attempt in 1 2 3; do
    if response_with_status="$(
      curl "${auth_curl_args[@]}" \
        -H "Content-Type: application/json" \
        --data "${auth_body}" \
        --write-out $'\n%{http_code}' \
        "${UI_TEST_API_BASE_URL%/}/auth/test/otp"
    )"; then
      curl_status=0
    else
      curl_status=$?
    fi

    http_status="${response_with_status##*$'\n'}"
    response="${response_with_status%$'\n'*}"
    if [[ "${curl_status}" -eq 0 && "${http_status}" =~ ^2[0-9][0-9]$ ]]; then
      break
    fi

    response_preview="${response//$'\n'/ }"
    response_preview="${response_preview:0:1000}"
    echo "::warning::Budget E2E auth bootstrap attempt ${attempt} failed (curl=${curl_status}, HTTP=${http_status}): ${response_preview:-<empty response>}" >&2
  done

  if [[ "${curl_status}" -ne 0 || ! "${http_status}" =~ ^2[0-9][0-9]$ ]]; then
    echo "::error::Budget E2E auth bootstrap failed after 3 attempts" >&2
    return 1
  fi
  budget_user_provisioned=1
  budget_cleanup_token="$(
    printf '%s' "${response}" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
token = payload.get("cleanupToken")
if not isinstance(token, str) or not token:
    raise SystemExit("Budget E2E provisioning response is missing cleanupToken")
print(token)
'
  )"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::add-mask::${budget_cleanup_token}"
  fi
  auth_user_id="$(
    printf '%s' "${response}" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
if payload.get("confirmed") is not True or not payload.get("userId"):
    raise SystemExit(1)
print(payload["userId"])
'
  )"
  budget_auth_user_id="${auth_user_id}"
  reset_body="$(
    AUTH_USER_ID="${auth_user_id}" UI_TEST_CLIENT_DATE="${UI_TEST_CLIENT_DATE}" python3 -c '
import json
import os

print(json.dumps({
    "authUserId": os.environ["AUTH_USER_ID"],
    "clientDate": os.environ["UI_TEST_CLIENT_DATE"],
    "scenario": "baseline",
}))
'
  )"
  echo "Resetting deterministic Budget E2E fixture"
  reset_response=""
  for attempt in 1 2 3; do
    if reset_response_with_status="$(
      curl "${auth_curl_args[@]}" \
        -H "Content-Type: application/json" \
        --data "${reset_body}" \
        --write-out $'\n%{http_code}' \
        "${UI_TEST_API_BASE_URL%/}/test/budget-e2e/reset"
    )"; then
      reset_curl_status=0
    else
      reset_curl_status=$?
    fi

    reset_http_status="${reset_response_with_status##*$'\n'}"
    reset_response="${reset_response_with_status%$'\n'*}"
    if [[ "${reset_curl_status}" -eq 0 && "${reset_http_status}" =~ ^2[0-9][0-9]$ ]]; then
      break
    fi

    reset_response_preview="${reset_response//$'\n'/ }"
    reset_response_preview="${reset_response_preview:0:1000}"
    echo "::warning::Budget E2E fixture reset attempt ${attempt} failed (curl=${reset_curl_status}, HTTP=${reset_http_status}): ${reset_response_preview:-<empty response>}" >&2
  done

  if [[ "${reset_curl_status}" -ne 0 || ! "${reset_http_status}" =~ ^2[0-9][0-9]$ ]]; then
    echo "::error::Budget E2E fixture reset failed after 3 attempts" >&2
    return 1
  fi
  printf '%s' "${reset_response}" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
expected = {"ready": True, "scenario": "baseline", "accountCount": 5, "transactionCount": 71}
for key, value in expected.items():
    if payload.get(key) != value:
        raise SystemExit(f"Budget fixture probe mismatch for {key}: {payload.get(key)!r}")
'
  echo "Budget E2E backend and deterministic fixture are ready"
}

simulator_udid() {
  if [[ "${destination}" =~ (^|,)id=([^,[:space:]]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
    return
  fi

  local simulator_name="iPhone 17"
  if [[ "${destination}" =~ (^|,)name=([^,]+) ]]; then
    simulator_name="${BASH_REMATCH[2]}"
  fi
  xcrun simctl list devices available -j | python3 -c '
import json
import sys

name = sys.argv[1]
matches = [
    device.get("udid", "")
    for runtime, devices in json.load(sys.stdin).get("devices", {}).items()
    if ".iOS-" in runtime
    for device in devices
    if device.get("isAvailable") and device.get("name") == name
]
print(matches[-1] if matches else "")
' "${simulator_name}"
}

wait_for_simulator_boot() {
  local udid="$1"
  /usr/bin/perl -e '
my $seconds = shift @ARGV;
alarm $seconds;
exec @ARGV or die "exec failed: $!";
' "${simulator_boot_timeout_seconds}" \
    xcrun simctl bootstatus "${udid}" -b
}

ensure_simulator_booted() {
  local udid="$1"
  xcrun simctl boot "${udid}" >/dev/null 2>&1 || true
  if ! wait_for_simulator_boot "${udid}"; then
    echo "Simulator ${udid} did not finish booting; retrying from shutdown" >&2
    xcrun simctl shutdown "${udid}" >/dev/null 2>&1 || true
    xcrun simctl boot "${udid}"
    wait_for_simulator_boot "${udid}"
  fi
}

start_video() {
  [[ "${record_video}" == "1" ]] || return 0
  local udid="$1"
  if [[ -z "${udid}" ]]; then
    echo "::warning::Budget E2E video recording could not resolve simulator ${destination}; XCTest will continue. Diagnostics: ${video_log}" >&2
    return 0
  fi
  if ! mkdir -p "$(dirname "${raw_video}")" "$(dirname "${compressed_video}")"; then
    echo "::warning::Budget E2E video directories could not be prepared; XCTest will continue. Diagnostics: ${video_log}" >&2
    return 0
  fi
  if ! rm -f "${raw_video}" "${compressed_video}" || ! : > "${video_log}"; then
    echo "::warning::Budget E2E video files could not be prepared; XCTest will continue. Diagnostics: ${video_log}" >&2
    return 0
  fi
  xcrun simctl io "${udid}" recordVideo --codec=h264 --force "${raw_video}" >"${video_log}" 2>&1 &
  video_pid="$!"
  if ! kill -0 "${video_pid}" 2>/dev/null; then
    wait "${video_pid}" 2>/dev/null || true
    video_pid=""
    echo "::warning::Budget E2E video recording failed to start for simulator ${udid}; XCTest will continue. Diagnostics: ${video_log}" >&2
    return 0
  fi
}

wait_for_video_finalize() {
  # The recorder is waited on before this runs, so its file is final; one
  # probe decides whether it is a playable recording.
  if [[ -s "${raw_video}" ]]; then
    if command -v ffprobe >/dev/null 2>&1; then
      if ffprobe -v error -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 \
        "${raw_video}" >>"${video_log}" 2>&1; then
        return 0
      fi
    elif command -v ffmpeg >/dev/null 2>&1; then
      if ffmpeg -hide_banner -loglevel error -i "${raw_video}" \
        -map 0:v:0 -frames:v 1 -f null - >>"${video_log}" 2>&1; then
        return 0
      fi
    else
      return 0
    fi
  fi

  echo "::warning::Budget E2E video did not finalize; XCTest result is unchanged. Raw recording: ${raw_video}. Diagnostics: ${video_log}" >&2
  return 1
}

stop_video() {
  [[ -n "${video_pid}" ]] || return 0
  kill -INT "${video_pid}" 2>/dev/null || true
  wait "${video_pid}" 2>/dev/null || true
  video_pid=""
  if ! wait_for_video_finalize; then
    return 0
  fi
  if [[ "${defer_video_processing}" == "1" ]]; then
    echo "Raw Budget E2E video is ready for non-gating post-processing: ${raw_video}"
    return 0
  fi
  if command -v ffmpeg >/dev/null 2>&1; then
    if ! ffmpeg -hide_banner -loglevel error -y -i "${raw_video}" \
      -vf "scale='min(1080,iw)':-2" -c:v libx264 -preset medium -crf 28 \
      -movflags +faststart -an "${compressed_video}" >>"${video_log}" 2>&1; then
      echo "::warning::Budget E2E video compression failed; XCTest result is unchanged. Raw recording: ${raw_video}. Diagnostics: ${video_log}" >&2
      return 0
    fi
    rm -f -- "${raw_video}"
  elif [[ -s "${raw_video}" ]]; then
    if ! cp "${raw_video}" "${compressed_video}"; then
      echo "::warning::Budget E2E video copy failed; XCTest result is unchanged. Raw recording: ${raw_video}. Diagnostics: ${video_log}" >&2
      return 0
    fi
  fi
}

cleanup_response=""

request_budget_cleanup() {
  local response_with_status curl_status http_status
  local curl_args=(
    -sS
    --max-time 60
    --get
    --request DELETE
    -H "Accept: application/json"
    -H "x-test-otp-secret: ${TEST_OTP_SECRET}"
    -H "x-test-user-cleanup-token: ${budget_cleanup_token}"
    --data-urlencode "email=${UI_TEST_EMAIL}"
  )

  if response_with_status="$(
    curl "${curl_args[@]}" \
      --write-out $'\n%{http_code}' \
      "${UI_TEST_API_BASE_URL%/}/auth/test/user"
  )"; then
    curl_status=0
  else
    curl_status=$?
  fi
  http_status="${response_with_status##*$'\n'}"
  cleanup_response="${response_with_status%$'\n'*}"
  if [[ "${curl_status}" -ne 0 || ! "${http_status}" =~ ^2[0-9][0-9]$ ]]; then
    echo "::warning::Budget E2E cleanup request failed (curl=${curl_status}, HTTP=${http_status})" >&2
    return 1
  fi
}

validate_budget_cleanup_response() {
  local expected_already_absent="$1"
  printf '%s' "${cleanup_response}" | EXPECTED_ALREADY_ABSENT="${expected_already_absent}" python3 -c '
import json
import os
import sys

payload = json.load(sys.stdin)
if payload.get("deleted") is not True or payload.get("verified") is not True:
    raise SystemExit("cleanup was not deleted and verified")
expected_absent = os.environ["EXPECTED_ALREADY_ABSENT"]
if expected_absent == "true" and payload.get("alreadyAbsent") is not True:
    raise SystemExit("idempotent cleanup did not report alreadyAbsent=true")
if expected_absent == "either" and payload.get("alreadyAbsent") not in (True, False):
    raise SystemExit("first cleanup receipt has invalid alreadyAbsent")
counts = payload.get("counts")
required = {
    "authIdentities",
    "publicUsers",
    "plaidItems",
    "plaidAccounts",
    "debtCategoryOverrides",
}
if not isinstance(counts, dict) or not required.issubset(counts):
    raise SystemExit("cleanup receipt is missing required zero-row counts")
for key in required:
    if counts.get(key) != 0:
        raise SystemExit(f"cleanup receipt {key} is not zero: {counts.get(key)!r}")
'
}

cleanup_budget_user() {
  if [[ "${budget_user_provisioned}" != "1" ]]; then
    return 0
  fi
  if [[ -z "${budget_cleanup_token}" ]]; then
    echo "::error::Budget E2E user was provisioned without a cleanup token" >&2
    return 1
  fi

  local attempt first_receipt second_receipt first_succeeded=false second_succeeded=false
  for attempt in 1 2 3; do
    if request_budget_cleanup && validate_budget_cleanup_response either; then
      first_receipt="${cleanup_response}"
      first_succeeded=true
      break
    fi
    echo "::warning::Budget E2E cleanup attempt ${attempt} failed" >&2
  done
  if [[ "${first_succeeded}" != "true" ]]; then
    echo "::error::Budget E2E cleanup failed after 3 attempts" >&2
    return 1
  fi

  for attempt in 1 2 3; do
    if request_budget_cleanup && validate_budget_cleanup_response true; then
      second_receipt="${cleanup_response}"
      second_succeeded=true
      break
    fi
    echo "::warning::Budget E2E idempotency verification attempt ${attempt} failed" >&2
  done
  if [[ "${second_succeeded}" != "true" ]]; then
    echo "::error::Budget E2E cleanup idempotency verification failed" >&2
    return 1
  fi

  FIRST_RECEIPT="${first_receipt}" \
  SECOND_RECEIPT="${second_receipt}" \
  EVIDENCE_ISSUE="${evidence_issue}" \
  EXACT_HEAD_SHA="${EXPECTED_SERVER_BUILD_SHA}" \
  SYNTHETIC_EMAIL="${UI_TEST_EMAIL}" \
  CLEANUP_RECEIPT_PATH="${cleanup_receipt}" \
  python3 -c '
import hashlib
import json
import os
from datetime import datetime, timezone

receipt = {
    "issue": int(os.environ["EVIDENCE_ISSUE"]),
    "exactHeadSha": os.environ["EXACT_HEAD_SHA"],
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "syntheticEmailSha256": hashlib.sha256(
        os.environ["SYNTHETIC_EMAIL"].encode("utf-8")
    ).hexdigest(),
    "first": json.loads(os.environ["FIRST_RECEIPT"]),
    "idempotent": json.loads(os.environ["SECOND_RECEIPT"]),
}
path = os.environ["CLEANUP_RECEIPT_PATH"]
with open(path, "w", encoding="utf-8") as handle:
    json.dump(receipt, handle, indent=2, sort_keys=True)
    handle.write("\n")
'
}

capture_freshness_receipt() {
  [[ -n "${freshness_receipt}" ]] || return 0
  if [[ -z "${budget_auth_user_id}" ]]; then
    echo "Budget freshness receipt requested without a provisioned auth user" >&2
    return 1
  fi

  local response
  response="$(
    curl -fsS --max-time 30 --get \
      -H "Accept: application/json" \
      -H "x-test-otp-secret: ${TEST_OTP_SECRET}" \
      --data-urlencode "authUserId=${budget_auth_user_id}" \
      --data-urlencode "scenario=baseline" \
      --data-urlencode "clientDate=${UI_TEST_CLIENT_DATE}" \
      "${UI_TEST_API_BASE_URL%/}/test/budget-e2e/freshness-state"
  )"
  mkdir -p "$(dirname "${freshness_receipt}")"
  printf '%s' "${response}" \
    | AUTH_USER_ID="${budget_auth_user_id}" EXACT_HEAD_SHA="${EXPECTED_SERVER_BUILD_SHA}" \
      OUTPUT_PATH="${freshness_receipt}" python3 -c '
import json
import os
import sys
from datetime import datetime, timezone

payload = json.load(sys.stdin)
receipt = payload.get("receipt")
auth_user_id = os.environ["AUTH_USER_ID"]
expected_item_id = f"budget-e2e-item-{auth_user_id}"
if payload.get("ready") is not True or payload.get("syncStatus") != "syncing":
    raise SystemExit("freshness fixture is not the expected stuck syncing state")
if not isinstance(receipt, dict):
    raise SystemExit("authenticated manual retry receipt is missing")
required = {
    "authUserId": auth_user_id,
    "userId": payload.get("userId"),
    "plaidItemDbId": payload.get("plaidItemDbId"),
    "itemId": expected_item_id,
    "bypassCooldown": True,
    "reason": "manual_retry",
    "externalProviderCalled": False,
}
for key, expected in required.items():
    if receipt.get(key) != expected:
        raise SystemExit(f"freshness receipt {key} mismatch: {receipt.get(key)!r}")
evidence = {
    "issue": 3998,
    "exactHeadSha": os.environ["EXACT_HEAD_SHA"],
    "capturedAt": datetime.now(timezone.utc).isoformat(),
    "fixture": {key: value for key, value in payload.items() if key != "receipt"},
    "authenticatedSyncRequest": receipt,
}
with open(os.environ["OUTPUT_PATH"], "w", encoding="utf-8") as handle:
    json.dump(evidence, handle, indent=2, sort_keys=True)
    handle.write("\n")
'
}

finalize_budget_run() {
  local status="$?" cleanup_status=0
  trap - EXIT INT TERM
  set +e
  if ! stop_video; then
    echo "::warning::Budget E2E video cleanup failed unexpectedly; preserving the XCTest status. Diagnostics: ${video_log}" >&2
  fi
  cleanup_budget_user
  cleanup_status="$?"
  set -e

  if [[ "${status}" -eq 0 && "${cleanup_status}" -ne 0 ]]; then
    status="${cleanup_status}"
  fi
  exit "${status}"
}

run_build() {
  local arguments=(
    build-for-testing
    -project "${project_path}"
    -scheme example-ios-BudgetDebt
    -testPlan "${test_plan}"
    -destination "${destination}"
    -parallel-testing-enabled NO
    -enableCodeCoverage NO
    -derivedDataPath "${derived_data}"
    -clonedSourcePackagesDirPath "${source_packages}"
    -packageCachePath "${package_cache}"
    -disableAutomaticPackageResolution
    COMPILER_INDEX_STORE_ENABLE=NO
  )
  if [[ -n "${test_products}" ]]; then
    arguments+=( -testProductsPath "${test_products}" )
  fi
  if [[ -n "${only_testing_raw}" ]]; then
    arguments+=("${only_testing_arguments[@]}")
  fi
  xcodebuild "${arguments[@]}" CODE_SIGNING_ALLOWED=NO
}

run_tests() {
  local arguments=(
    test-without-building
    -testPlan "${test_plan}"
    -destination "${destination}"
    -parallel-testing-enabled NO
    -resultBundlePath "${result_bundle}"
  )
  if [[ -n "${test_products}" ]]; then
    arguments=(
      test-without-building
      -testProductsPath "${test_products}"
      -testPlan "${test_plan}"
      -destination "${destination}"
      -parallel-testing-enabled NO
      -resultBundlePath "${result_bundle}"
    )
  else
    arguments+=(
      -project "${project_path}"
      -scheme example-ios-BudgetDebt
      -derivedDataPath "${derived_data}"
      -clonedSourcePackagesDirPath "${source_packages}"
      -packageCachePath "${package_cache}"
      -disableAutomaticPackageResolution
    )
  fi
  if [[ -n "${only_testing_raw}" ]]; then
    arguments+=("${only_testing_arguments[@]}")
  fi
  xcodebuild "${arguments[@]}" CODE_SIGNING_ALLOWED=NO
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap finalize_budget_run EXIT
probe_backend
echo "Budget E2E run directory: ${run_dir}"
echo "Budget E2E destination: ${destination}"

if [[ "${skip_build}" != "1" ]]; then
  set +e
  run_build 2>&1 | tee "${xcodebuild_log}"
  build_status="${PIPESTATUS[0]}"
  set -e
  if [[ "${build_status}" -ne 0 ]]; then
    exit "${build_status}"
  fi
elif [[ -n "${test_products}" ]]; then
  if [[ ! -s "${test_products}/Info.plist" ]]; then
    echo "SKIP_BUILD=1 but test products are incomplete: ${test_products}" >&2
    exit 2
  fi
elif [[ ! -d "${derived_data}/Build/Products" ]]; then
  echo "SKIP_BUILD=1 but DerivedData has no built products: ${derived_data}" >&2
  exit 2
fi

test_udid="$(simulator_udid)"
if [[ -z "${test_udid}" ]]; then
  echo "Could not resolve Budget E2E simulator from ${destination}" >&2
  exit 2
fi
set +e
ensure_simulator_booted "${test_udid}" 2>&1 | tee -a "${xcodebuild_log}"
boot_status="${PIPESTATUS[0]}"
set -e
if [[ "${boot_status}" -ne 0 ]]; then
  exit "${boot_status}"
fi
start_video "${test_udid}"
set +e
run_tests 2>&1 | tee -a "${xcodebuild_log}"
test_status="${PIPESTATUS[0]}"
set -e
if ! stop_video; then
  echo "::warning::Budget E2E video cleanup failed unexpectedly; preserving the XCTest status. Diagnostics: ${video_log}" >&2
fi

if [[ "${test_status}" -eq 0 ]]; then
  if [[ ! -d "${result_bundle}" || ! -s "${xcodebuild_log}" ]]; then
    echo "Budget E2E passed without required result and log artifacts" >&2
    exit 2
  fi
  bash "${repo_root}/scripts/validate-xcresult-summary.sh" \
    "${result_bundle}" \
    "${expected_test_count}" \
    "Budget real-server E2E"
  capture_freshness_receipt
  if [[ "${record_video}" == "1" && "${defer_video_processing}" != "1" && ! -s "${compressed_video}" ]]; then
    echo "::warning::Budget E2E XCTest passed without its requested video artifact; retaining available video diagnostics at ${raw_video} and ${video_log}." >&2
  fi
fi
exit "${test_status}"

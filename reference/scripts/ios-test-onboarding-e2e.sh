#!/usr/bin/env bash
set -euo pipefail

# Run the full onboarding E2E (OnboardingFullFlowUITests.testFullOnboardingFlow)
# against a real backend. Development runs use real Plaid Sandbox and the local
# /test/otp bootstrap. Trusted post-merge/manual production runs use
# preprovisioned synthetic users against the production API and Identity
# Platform project. The CI onboarding jobs use this script.
#
# Prerequisites:
#   - Development mode: backend at the URL below (default localhost:3000/api),
#     NODE_ENV=development so /auth/test/otp is enabled.
#   - Production mode: two scoped users provisioned before this script starts.
#   - A booted iPhone simulator on the prepared stable iOS runtime.
#
# Overridable via env:
#   DESTINATION   xcodebuild -destination string
#   ITERATIONS    max test attempts (default 1 = no retry)
#   ONBOARDING_E2E_RUN_DIR
#                 parent run directory (default: unique in RUNNER_TEMP or /tmp)
#   RESULT_BUNDLE path for the .xcresult bundle
#   DERIVED_DATA / SOURCE_PACKAGES / PACKAGE_CACHE
#                 xcodebuild and SwiftPM working directories
#   SKIP_BUILD    set to 1 to consume an existing build-for-testing product
#   XCTESTRUN_PATH
#                 optional explicit .xctestrun from the shared CI compilation
#   XCODEBUILD_LOG
#                 raw xcodebuild output file for CI failure summaries
#   RECORD_VIDEO  set to 1 to record the simulator while the test runs
#   DEFER_VIDEO_PROCESSING
#                 set to 1 to preserve the raw recording and move ffmpeg/review
#                 work to the non-gating video job
#   RAW_VIDEO / COMPRESSED_VIDEO
#                 simulator recording output paths
#   VIDEO_CRF     ffmpeg CRF for compressed MP4 output (default 28)
#   VIDEO_MAX_WIDTH
#                 max compressed-video width for review evidence (default 1080)
#   VIDEO_LAUNCH_PREROLL_SECONDS
#                 seconds retained before XCTest reports the onboarding test
#                 started (default 5)
#   VIDEO_COMPLETION_POSTROLL_SECONDS
#                 up to this many seconds retained after XCTest reports the
#                 onboarding test passed (default 3). The recorder stops when
#                 xcodebuild exits and is never held open to pad the video, so
#                 the post-roll is bounded by xcodebuild's own teardown.
#   UI_TEST_API_BASE_URL
#                 points the app at a chosen backend (used by CI to target the
#                 dev backend from a production-config build)
#   TEST_OTP_SECRET
#                 shared secret for /auth/test/otp when the dev backend requires it
#   UI_TEST_PRODUCTION_E2E / UI_TEST_SYNTHETIC_ONBOARDING_EMAIL /
#   UI_TEST_SYNTHETIC_PRIVACY_EMAIL / UI_TEST_SYNTHETIC_PASSWORD
#                 guarded trusted-ref production mode and its preprovisioned users
#   ONBOARDING_PRIME_STOREKIT
#                 set to 1 only when this test is changed back to a real
#                 StoreKit purchase. The current UI test uses DEBUG-only
#                 purchase simulation; this is separate from real StoreKit coverage.

load_test_otp_secret() {
  if [[ -n "${TEST_OTP_SECRET:-}" ]]; then
    return
  fi

  local candidate secret_line
  for candidate in .env "${HOME}/example-dev.env"; do
    if [[ ! -f "${candidate}" ]]; then
      continue
    fi

    secret_line="$(grep -E '^[[:space:]]*TEST_OTP_SECRET[[:space:]]*=' "${candidate}" | tail -n 1 || true)"
    if [[ -z "${secret_line}" ]]; then
      continue
    fi

    TEST_OTP_SECRET="${secret_line#*=}"
    TEST_OTP_SECRET="${TEST_OTP_SECRET#\"}"
    TEST_OTP_SECRET="${TEST_OTP_SECRET%\"}"
    TEST_OTP_SECRET="${TEST_OTP_SECRET#\'}"
    TEST_OTP_SECRET="${TEST_OTP_SECRET%\'}"
    export TEST_OTP_SECRET
    return
  done
}

if [[ "${UI_TEST_PRODUCTION_E2E:-0}" != "1" ]]; then
  load_test_otp_secret
fi

# xcodebuild only forwards env vars prefixed with TEST_RUNNER_ into the UI
# test-runner process — that is where OnboardingFullFlowUITests reads them
# (`ProcessInfo.environment`) to build the app launch environment. Translate
# the natural names so callers don't have to know the prefix.
for _var in \
  UI_TEST_API_BASE_URL \
  UI_TEST_PRODUCTION_E2E \
  UI_TEST_SYNTHETIC_ONBOARDING_EMAIL \
  UI_TEST_SYNTHETIC_PRIVACY_EMAIL \
  UI_TEST_SYNTHETIC_PASSWORD \
  UI_TEST_DASHBOARD_OFFLINE_E2E \
  UI_TEST_EXPECTED_SERVER_BUILD_SHA \
  DASHBOARD_OFFLINE_PROXY_CONTROL_TOKEN \
  TEST_OTP_SECRET
do
  if [[ -n "${!_var:-}" ]]; then
    export "TEST_RUNNER_${_var}=${!_var}"
  fi
done

# xcodebuild exposes TEST_RUNNER_* variables to the XCTest process after
# stripping the prefix. Keep evidence recording opt-in and promotion-only.
export TEST_RUNNER_CAPTURE_VIDEO="${RECORD_VIDEO:-0}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_path="${repo_root}/ios/example-ios.xcodeproj"

destination="${DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro}"
iterations="${ITERATIONS:-1}"
runner_temp="${RUNNER_TEMP:-/tmp}"
run_dir="${ONBOARDING_E2E_RUN_DIR:-$(mktemp -d "${runner_temp}/onboarding-e2e.XXXXXX")}"
result_bundle="${RESULT_BUNDLE:-${run_dir}/onboarding-e2e.xcresult}"
derived_data="${DERIVED_DATA:-${run_dir}/DerivedData}"
source_packages="${SOURCE_PACKAGES:-${run_dir}/SourcePackages}"
package_cache="${PACKAGE_CACHE:-${run_dir}/PackageCache}"
xcodebuild_log="${XCODEBUILD_LOG:-${run_dir}/xcodebuild.log}"
skip_build="${SKIP_BUILD:-0}"
xctestrun_path="${XCTESTRUN_PATH:-}"
record_video="${RECORD_VIDEO:-0}"
defer_video_processing="${DEFER_VIDEO_PROCESSING:-0}"
raw_video="${RAW_VIDEO:-${run_dir}/onboarding-e2e.raw.mp4}"
compressed_video="${COMPRESSED_VIDEO:-${run_dir}/onboarding-e2e.compressed.mp4}"
video_crf="${VIDEO_CRF:-28}"
video_max_width="${VIDEO_MAX_WIDTH:-1080}"
video_launch_preroll_seconds="${VIDEO_LAUNCH_PREROLL_SECONDS:-5}"
video_completion_postroll_seconds="${VIDEO_COMPLETION_POSTROLL_SECONDS:-3}"
video_pid=""
video_launch_marker_pid=""
video_recording_started_at=""
recorded_test_succeeded=0
video_launch_marker="${run_dir}/onboarding-e2e.launch-epoch"
video_completion_marker="${run_dir}/onboarding-e2e.completion-epoch"
untrimmed_video="${raw_video}.untrimmed.mp4"

if [[ "${skip_build}" != "0" && "${skip_build}" != "1" ]]; then
  echo "SKIP_BUILD must be 0 or 1" >&2
  exit 2
fi
if [[ "${skip_build}" == "1" && -n "${xctestrun_path}" && ! -f "${xctestrun_path}" ]]; then
  echo "Shared onboarding .xctestrun is unavailable: ${xctestrun_path}" >&2
  exit 2
fi

validate_production_e2e_configuration() {
  local expected_api="https://www.example.invalid/api"
  local synthetic_password="${UI_TEST_SYNTHETIC_PASSWORD:-}"

  if [[ "${UI_TEST_API_BASE_URL:-}" != "${expected_api}" ]]; then
    echo "Production onboarding E2E requires UI_TEST_API_BASE_URL=${expected_api}" >&2
    return 1
  fi
  if [[ ! "${UI_TEST_SYNTHETIC_ONBOARDING_EMAIL:-}" =~ ^onboard-ci-[0-9]+-[0-9]+@test\.example\.local$ ]]; then
    echo "Production onboarding E2E requires a scoped onboarding user" >&2
    return 1
  fi
  if [[ ! "${UI_TEST_SYNTHETIC_PRIVACY_EMAIL:-}" =~ ^privacy-ci-[0-9]+-[0-9]+@test\.example\.local$ ]]; then
    echo "Production onboarding E2E requires a scoped privacy user" >&2
    return 1
  fi
  if [[ "${#synthetic_password}" -lt 32 ]]; then
    echo "Production onboarding E2E requires a per-run synthetic password" >&2
    return 1
  fi
}

test_otp_base_url() {
  local base_url="${UI_TEST_API_BASE_URL:-http://localhost:3000/api}"
  printf '%s\n' "${base_url%/}"
}

test_otp_probe_url() {
  local health_email="onboarding-e2e-health-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}@test.example.local"
  local health_password="HealthCheckPass123"
  printf '%s/auth/test/otp?email=%s&password=%s\n' \
    "$(test_otp_base_url)" \
    "${health_email}" \
    "${health_password}"
}

probe_test_otp_backend() {
  local curl_args=(-fsS --max-time 20)
  if [[ -n "${TEST_OTP_SECRET:-}" ]]; then
    curl_args+=(-H "x-test-otp-secret: ${TEST_OTP_SECRET}")
  fi

  curl \
    "${curl_args[@]}" \
    "$(test_otp_probe_url)" \
    | python3 -c 'import json,sys; data=json.load(sys.stdin); sys.exit(0 if data.get("confirmed") is True else 1)'
}

wait_for_test_otp_backend() {
  echo "Checking onboarding test backend: $(test_otp_base_url)/auth/test/otp"
  local probe_output
  # The caller starts the backend and blocks on its ready line before this
  # script runs, so one probe decides; a backend that is not up fails closed.
  if probe_output="$(probe_test_otp_backend 2>&1 >/dev/null)"; then
    echo "Onboarding test backend is reachable"
    return 0
  fi
  if [[ "${probe_output}" == *"requested URL returned error: 401"* \
    || "${probe_output}" == *"requested URL returned error: 403"* ]]
  then
    echo "Onboarding test backend rejected the readiness probe: ${probe_output}" >&2
    return 1
  fi
  echo "Onboarding test backend was not reachable before launching XCTest: ${probe_output}" >&2
  return 1
}

simulator_udid_from_destination() {
  local destination_string="$1"
  local udid=""
  local simulator_name=""

  if [[ "${destination_string}" =~ (^|,)id=([^,[:space:]]+) ]]; then
    udid="${BASH_REMATCH[2]}"
  fi

  if [[ -n "${udid}" ]]; then
    printf '%s\n' "${udid}"
    return 0
  fi

  if [[ "${destination_string}" =~ (^|,)name=([^,]+) ]]; then
    simulator_name="${BASH_REMATCH[2]}"
  fi

  if [[ -z "${simulator_name}" ]]; then
    return 1
  fi

  xcrun simctl list devices available -j | python3 -c '
import json
import sys

target_name = sys.argv[1]
devices = json.load(sys.stdin).get("devices", {})
matches = [
    device.get("udid", "")
    for runtime, runtime_devices in devices.items()
    if ".iOS-" in runtime
    for device in runtime_devices
    if device.get("isAvailable") and device.get("name") == target_name
]
print(matches[-1] if matches else "")
' "${simulator_name}"
}

resolved_xcodebuild_destination() {
  local destination_string="$1"
  local simulator_udid

  if [[ "${destination_string}" =~ (^|,)id=([^,[:space:]]+) ]]; then
    printf '%s\n' "${destination_string}"
    return 0
  fi

  simulator_udid="$(simulator_udid_from_destination "${destination_string}")"
  if [[ -z "${simulator_udid}" ]]; then
    printf '%s\n' "${destination_string}"
    return 0
  fi

  printf 'platform=iOS Simulator,id=%s\n' "${simulator_udid}"
}

wait_for_config_endpoint() {
  local api_base="${UI_TEST_API_BASE_URL:-${TEST_RUNNER_UI_TEST_API_BASE_URL:-http://localhost:3000/api}}"

  local origin="${api_base%/api}"
  if [[ "${origin}" == "${api_base}" ]]; then
    origin="${api_base%/}"
  fi

  local url="${origin}/api/config/videos"
  echo "Checking onboarding API backend: ${url}"
  if curl -fsS --max-time 60 "${url}" >/dev/null; then
    echo "Onboarding API backend is reachable"
    return 0
  fi

  echo "Onboarding API backend is not reachable: ${url}" >&2
  return 1
}

wait_for_simulator_boot() {
  local udid="$1"
  # CoreSimulator data migration can legitimately take several minutes on a
  # freshly provisioned runtime. Interrupting bootstatus restarts that work and
  # makes the lane slower, so wait for the simulator's actual terminal state.
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

prepare_recording_simulator() {
  if [[ "${record_video}" != "1" ]]; then
    return 0
  fi

  local simulator_udid
  local readiness_date
  simulator_udid="$(simulator_udid_from_destination "${destination}")"
  if [[ -z "${simulator_udid}" ]]; then
    echo "Could not determine simulator UDID from destination: ${destination}" >&2
    return 1
  fi

  # Boot the exact device that will be recorded before dependency resolution
  # and compilation. This gives system follow-ups time to settle before the
  # executable onboarding journey begins. Route through the shared helper so a
  # stalled boot is retried from shutdown rather than hanging here.
  if ! ensure_simulator_booted "${simulator_udid}"; then
    echo "::warning::Simulator ${simulator_udid} did not become ready for onboarding video capture." >&2
    return 1
  fi

  # A newly provisioned iOS 26 simulator can surface the Apple Intelligence
  # readiness follow-up during the test. Mark it as recently read before the
  # capture starts. This preference is advisory across simulator runtimes, so
  # an unsupported domain/key must not block executable onboarding evidence.
  readiness_date="$(date -u '+%Y-%m-%d %H:%M:%S +0000')"
  if ! xcrun simctl spawn "${simulator_udid}" defaults write \
    com.apple.generativeexperiences.corefollowup \
    DateOfLastAppleIntelligenceReadinessCFU \
    -date "${readiness_date}"
  then
    echo "::warning::Could not pre-seed the Apple Intelligence readiness follow-up on simulator ${simulator_udid}" >&2
  fi

  # Match Xcode Cloud's Password AutoFill setup before the app is launched.
  # Apply it only to this recording's device; other running simulators may
  # belong to unrelated tests. Like the readiness seed, support varies by OS.
  if ! xcrun simctl spawn "${simulator_udid}" defaults write \
    -g AutoFillPasswords -bool NO
  then
    echo "::warning::Could not disable Password AutoFill on recording simulator ${simulator_udid}" >&2
  fi
}

prepare_recording_simulator_best_effort() {
  if ! prepare_recording_simulator; then
    echo "::warning::Onboarding video simulator preparation failed; continuing with required XCTest." >&2
  fi
}

start_screen_recording() {
  if [[ "${record_video}" != "1" ]]; then
    return 0
  fi

  local simulator_udid
  simulator_udid="$(simulator_udid_from_destination "${destination}")"
  if [[ -z "${simulator_udid}" ]]; then
    echo "Could not determine simulator UDID from destination: ${destination}" >&2
    return 1
  fi

  mkdir -p "$(dirname "${raw_video}")" "$(dirname "${compressed_video}")"
  rm -f \
    "${raw_video}" \
    "${compressed_video}" \
    "${untrimmed_video}" \
    "${video_launch_marker}" \
    "${video_completion_marker}"

  if ! ensure_simulator_booted "${simulator_udid}"; then
    echo "::warning::Simulator ${simulator_udid} did not become ready for onboarding video capture." >&2
    return 1
  fi

  echo "Recording simulator video: ${untrimmed_video}"
  xcrun simctl io "${simulator_udid}" recordVideo --codec=h264 "${untrimmed_video}" &
  video_pid="$!"
  video_recording_started_at="$(date +%s)"

  if ! kill -0 "${video_pid}" 2>/dev/null; then
    echo "Simulator video recording failed to start" >&2
    video_pid=""
    return 1
  fi
}

configure_onboarding_video_capture() {
  if ! start_screen_recording; then
    echo "::warning::Onboarding video recording could not start; continuing with required XCTest." >&2
    return 0
  fi

  export UI_TEST_SKIP_SCREENSHOTS="${UI_TEST_SKIP_SCREENSHOTS:-1}"
  if [[ -n "${video_pid}" ]]; then
    start_onboarding_test_launch_watch
  fi
}

capture_onboarding_test_boundaries() {
  local test_started_line="Test Case '-[example_iosOnboardingUITests.OnboardingFullFlowUITests testFullOnboardingFlow]' started."
  local test_passed_prefix="Test Case '-[example_iosOnboardingUITests.OnboardingFullFlowUITests testFullOnboardingFlow]' passed ("

  if [[ ! -s "${video_launch_marker}" ]] && grep -Fq "${test_started_line}" "${xcodebuild_log}"; then
    date +%s > "${video_launch_marker}"
  fi

  # Only a passing target-test line is a safe review-video end boundary.
  # Failed or aborted attempts intentionally keep recording through cleanup so
  # their complete simulator state remains available as diagnostic evidence.
  if [[ ! -s "${video_completion_marker}" ]] && grep -Fq "${test_passed_prefix}" "${xcodebuild_log}"; then
    date +%s > "${video_completion_marker}"
  fi
}

watch_for_onboarding_test_boundaries() {
  # Blocks on the xcodebuild log for each boundary line in turn; the stop
  # function terminates this watcher, and the helper's own trap ends its tail.
  local test_started_line="Test Case '-[example_iosOnboardingUITests.OnboardingFullFlowUITests testFullOnboardingFlow]' started."
  local test_passed_prefix="Test Case '-[example_iosOnboardingUITests.OnboardingFullFlowUITests testFullOnboardingFlow]' passed ("
  local helper_pid=""
  trap '[[ -z "${helper_pid}" ]] || kill "${helper_pid}" 2>/dev/null; exit 0' TERM INT
  node "${repo_root}/ci/src/actions/awaitLogLine.ts" -F "${xcodebuild_log}" "${test_started_line}" >/dev/null &
  helper_pid="$!"
  wait "${helper_pid}" || return 0
  [[ -s "${video_launch_marker}" ]] || date +%s > "${video_launch_marker}"
  node "${repo_root}/ci/src/actions/awaitLogLine.ts" -F "${xcodebuild_log}" "${test_passed_prefix}" >/dev/null &
  helper_pid="$!"
  wait "${helper_pid}" || return 0
  [[ -s "${video_completion_marker}" ]] || date +%s > "${video_completion_marker}"
}

start_onboarding_test_launch_watch() {
  if [[ "${record_video}" != "1" ]]; then
    return 0
  fi

  watch_for_onboarding_test_boundaries &
  video_launch_marker_pid="$!"
}

stop_onboarding_test_launch_watch() {
  # Close the small race where xcodebuild exits between the watcher's final
  # poll and teardown. Normally the watcher timestamps the pass line as soon as
  # it is emitted; this scan guarantees deterministic marker creation.
  capture_onboarding_test_boundaries

  if [[ -z "${video_launch_marker_pid}" ]]; then
    return 0
  fi

  if kill -0 "${video_launch_marker_pid}" 2>/dev/null; then
    kill "${video_launch_marker_pid}" 2>/dev/null || true
  fi
  wait "${video_launch_marker_pid}" 2>/dev/null || true
  video_launch_marker_pid=""
}

finalize_raw_video() {
  if [[ ! -s "${untrimmed_video}" ]]; then
    echo "Simulator video recording was not created: ${untrimmed_video}" >&2
    return 1
  fi

  local launch_epoch=""
  local completion_epoch=""
  local trim_start_seconds=0
  local trim_duration_seconds=0
  local has_valid_launch_boundary=0
  if [[ -s "${video_launch_marker}" ]]; then
    launch_epoch="$(<"${video_launch_marker}")"
  fi
  if [[ -s "${video_completion_marker}" ]]; then
    completion_epoch="$(<"${video_completion_marker}")"
  fi

  if [[ "${video_recording_started_at}" =~ ^[0-9]+$ ]] \
    && [[ "${launch_epoch}" =~ ^[0-9]+$ ]] \
    && [[ "${video_launch_preroll_seconds}" =~ ^[0-9]+$ ]] \
    && (( launch_epoch >= video_recording_started_at ))
  then
    has_valid_launch_boundary=1
    trim_start_seconds=$((
      launch_epoch - video_recording_started_at - video_launch_preroll_seconds
    ))
    if (( trim_start_seconds < 0 )); then
      trim_start_seconds=0
    fi
  fi

  if [[ "${video_recording_started_at}" =~ ^[0-9]+$ ]] \
    && (( has_valid_launch_boundary == 1 )) \
    && [[ "${completion_epoch}" =~ ^[0-9]+$ ]] \
    && (( completion_epoch >= launch_epoch )) \
    && (( recorded_test_succeeded == 1 )) \
    && [[ "${video_completion_postroll_seconds}" =~ ^[0-9]+$ ]]
  then
    trim_duration_seconds=$((
      completion_epoch - video_recording_started_at
      + video_completion_postroll_seconds - trim_start_seconds
    ))
  fi

  if (( trim_duration_seconds > 0 )) && command -v ffmpeg >/dev/null 2>&1; then
    echo "Trimming simulator video to the executable onboarding test window (${trim_start_seconds}s start trim, up to ${video_completion_postroll_seconds}s completion post-roll)"
    if ffmpeg -y -v error \
      -ss "${trim_start_seconds}" \
      -i "${untrimmed_video}" \
      -t "${trim_duration_seconds}" \
      -map 0:v:0 \
      -c:v libx264 \
      -preset veryfast \
      -crf 18 \
      -an \
      -movflags +faststart \
      "${raw_video}"
    then
      return 0
    fi
    echo "ffmpeg test-window trim failed; preserving the complete simulator recording" >&2
    rm -f "${raw_video}"
  elif (( trim_start_seconds > 0 )) && command -v ffmpeg >/dev/null 2>&1; then
    echo "Completion marker unavailable; trimming only ${trim_start_seconds}s of pre-launch simulator idle time"
    if ffmpeg -y -v error \
      -ss "${trim_start_seconds}" \
      -i "${untrimmed_video}" \
      -map 0:v:0 \
      -c:v libx264 \
      -preset veryfast \
      -crf 18 \
      -an \
      -movflags +faststart \
      "${raw_video}"
    then
      return 0
    fi
    echo "ffmpeg pre-launch trim failed; preserving the complete simulator recording" >&2
    rm -f "${raw_video}"
  elif (( trim_start_seconds > 0 )); then
    echo "ffmpeg not found; preserving the complete simulator recording" >&2
  elif (( trim_duration_seconds > 0 )); then
    echo "ffmpeg not found; preserving the complete simulator recording" >&2
  else
    echo "Onboarding video boundary markers unavailable or invalid; preserving the complete simulator recording" >&2
  fi

  mv "${untrimmed_video}" "${raw_video}"
}

stop_screen_recording() {
  stop_onboarding_test_launch_watch

  if [[ -z "${video_pid}" ]]; then
    return 0
  fi

  if kill -0 "${video_pid}" 2>/dev/null; then
    kill -INT "${video_pid}" 2>/dev/null || true
    wait "${video_pid}" 2>/dev/null || true
  fi
  video_pid=""

  if [[ "${defer_video_processing}" == "1" ]]; then
    if [[ -s "${untrimmed_video}" ]]; then
      mv "${untrimmed_video}" "${raw_video}"
      echo "Raw onboarding video is ready for non-gating post-processing: ${raw_video}"
      return 0
    fi
    echo "Raw onboarding video was not created: ${untrimmed_video}" >&2
    return 1
  fi

  if ! finalize_raw_video; then
    return 1
  fi

  local compression_fallback_video="${raw_video}"
  if [[ -s "${untrimmed_video}" ]]; then
    compression_fallback_video="${untrimmed_video}"
  fi

  if command -v ffmpeg >/dev/null 2>&1; then
    echo "Compressing simulator video: ${compressed_video}"
    if ! ffmpeg -y -v error \
      -i "${raw_video}" \
      -vf "scale='min(${video_max_width},iw)':-2,fps=15,format=yuv420p" \
      -c:v libx264 \
      -preset veryfast \
      -crf "${video_crf}" \
      -an \
      -movflags +faststart \
      "${compressed_video}"
    then
      echo "ffmpeg compression failed; using untouched simulator recording as review artifact" >&2
      rm -f "${compressed_video}"
      cp "${compression_fallback_video}" "${compressed_video}"
    fi
  else
    echo "ffmpeg not found; using raw simulator recording as compressed video artifact" >&2
    cp "${raw_video}" "${compressed_video}"
  fi

  if [[ -s "${compressed_video}" ]]; then
    rm -f "${untrimmed_video}"
    echo "Compressed simulator video: ${compressed_video}"
  else
    echo "Compressed simulator video was not created: ${compressed_video}" >&2
    return 1
  fi
}

cleanup_screen_recording() {
  stop_screen_recording || true
}

if [[ ! -d "${project_path}" ]]; then
  echo "Xcode project not found at ${project_path}" >&2
  exit 1
fi

if [[ "${UI_TEST_PRODUCTION_E2E:-0}" == "1" ]]; then
  validate_production_e2e_configuration
fi

destination="$(resolved_xcodebuild_destination "${destination}")"

echo "Running onboarding E2E with up to ${iterations} attempt(s)"
echo "Result bundle: ${result_bundle}"
echo "DerivedData: ${derived_data}"
echo "Source packages: ${source_packages}"
echo "Package cache: ${package_cache}"
echo "xcodebuild log: ${xcodebuild_log}"
echo "Destination: ${destination}"
if [[ "${record_video}" == "1" ]]; then
  echo "Raw simulator video: ${raw_video}"
  echo "Compressed simulator video: ${compressed_video}"
fi

mkdir -p \
  "${run_dir}" \
  "${derived_data}" \
  "${source_packages}" \
  "${package_cache}" \
  "$(dirname "${result_bundle}")" \
  "$(dirname "${xcodebuild_log}")"

if ! wait_for_config_endpoint; then
  exit 1
fi
if [[ "${UI_TEST_PRODUCTION_E2E:-0}" != "1" ]] && ! wait_for_test_otp_backend; then
  exit 1
fi

prepare_recording_simulator_best_effort

if [[ "${skip_build}" != "1" ]]; then
  bash "${repo_root}/scripts/prepare-ios-plaid-link.sh" "${source_packages}"
fi

set +e
run_xcodebuild_test() {
  # Keep this single UI test on the requested destination. If xcodebuild creates
  # a cloned simulator, simctl records the idle base simulator and the QA/UX
  # review correctly fails because the app is not visible in the video.
  xcodebuild test \
    -project "${project_path}" \
    -scheme "example-ios-Onboarding" \
    -destination "${destination}" \
    -parallel-testing-enabled NO \
    -enableCodeCoverage NO \
    -only-testing:example-iosOnboardingUITests/OnboardingFullFlowUITests/testFullOnboardingFlow \
    "$@" \
    -resultBundlePath "${result_bundle}" \
    -derivedDataPath "${derived_data}" \
    -clonedSourcePackagesDirPath "${source_packages}" \
    -packageCachePath "${package_cache}" \
    -disableAutomaticPackageResolution \
    COMPILER_INDEX_STORE_ENABLE=NO
}

run_xcodebuild_prime_storekit() {
  # Register the local StoreKit Testing config under the app's bundle id by
  # running the in-process SKTestSession integration test. storekitd keeps the
  # registration, so the subsequent onboarding app launch resolves the config —
  # a StoreKit config does not otherwise reach a UI-test-launched app.
  # Load-only: registering the config is enough. Running the purchase test here
  # would leave a transaction that conflicts with the onboarding app's purchase.
  xcodebuild test-without-building \
    -project "${project_path}" \
    -scheme "example-ios-storekit" \
    -destination "${destination}" \
    -parallel-testing-enabled NO \
    -only-testing:example-iosStoreKitTests/StoreKitPurchaseIntegrationTests/testConfiguredProductsLoadFromStoreKit \
    -derivedDataPath "${derived_data}" \
    -clonedSourcePackagesDirPath "${source_packages}" \
    -packageCachePath "${package_cache}"
}

run_xcodebuild_build_for_testing() {
  local build_testing_args=(
    "-only-testing:example-iosOnboardingUITests/OnboardingFullFlowUITests/testFullOnboardingFlow"
    "-only-testing:example-iosOnboardingUITests/ChatPlaidLinkE2ETests"
  )

  if [[ "${ONBOARDING_PRIME_STOREKIT:-0}" == "1" ]]; then
    xcodebuild build-for-testing \
      -project "${project_path}" \
      -scheme "example-ios-storekit" \
      -destination "${destination}" \
      -parallel-testing-enabled NO \
      -enableCodeCoverage NO \
      -only-testing:example-iosStoreKitTests/StoreKitPurchaseIntegrationTests/testConfiguredProductsLoadFromStoreKit \
      -derivedDataPath "${derived_data}" \
      -clonedSourcePackagesDirPath "${source_packages}" \
      -packageCachePath "${package_cache}" \
      -disableAutomaticPackageResolution \
      COMPILER_INDEX_STORE_ENABLE=NO
  fi
  # Keep the prebuild scoped to the tests this script can actually run. An
  # untargeted scheme prebuild has timed out in CI before XCTest launches.
  xcodebuild build-for-testing \
    -project "${project_path}" \
    -scheme "example-ios-Onboarding" \
    -destination "${destination}" \
    -parallel-testing-enabled NO \
    -enableCodeCoverage NO \
    "${build_testing_args[@]}" \
    -derivedDataPath "${derived_data}" \
    -clonedSourcePackagesDirPath "${source_packages}" \
    -packageCachePath "${package_cache}" \
    -disableAutomaticPackageResolution \
    COMPILER_INDEX_STORE_ENABLE=NO
}

run_xcodebuild_test_without_building() {
  if [[ -z "${xctestrun_path}" ]]; then
    xctestrun_path="$(find \
      "${derived_data}/Build/Products" \
      -maxdepth 1 \
      -type f \
      -name 'example-ios-Onboarding_*.xctestrun' \
      -print \
      -quit)"
  fi
  if [[ -z "${xctestrun_path}" ]]; then
    echo "Onboarding build-for-testing did not produce an .xctestrun file" >&2
    return 1
  fi

  # Record only this phase when video is enabled. Recording during the build
  # captures minutes of simulator home-screen idle time, which makes the
  # sampled review video miss fast onboarding checkpoints. Execute the built
  # product directly so this phase cannot reload the project or resolve Swift
  # packages a second time.
  xcodebuild test-without-building \
    -xctestrun "${xctestrun_path}" \
    -destination "${destination}" \
    -parallel-testing-enabled NO \
    -only-testing:example-iosOnboardingUITests/OnboardingFullFlowUITests/testFullOnboardingFlow \
    "$@" \
    -resultBundlePath "${result_bundle}"
}

run_test_command() {
  if [[ "${record_video}" == "1" || "${skip_build}" == "1" ]]; then
    run_xcodebuild_test_without_building "$@"
  else
    run_xcodebuild_test "$@"
  fi
}

is_retryable_simulator_launch_failure() {
  [[ -f "${xcodebuild_log}" ]] &&
    grep -Eq 'Failed to launch app with identifier: (com\.examplewealth\.exampleapp|example-org\.example-iosOnboardingUITests\.xctrunner)' "${xcodebuild_log}" &&
    grep -Fq 'FBSOpenApplicationServiceErrorDomain' "${xcodebuild_log}" &&
    grep -Eq 'BSErrorCodeDescription[= ]+RequestDenied' "${xcodebuild_log}"
}

recover_onboarding_simulator_for_launch_retry() {
  local simulator_udid failed_result_bundle

  simulator_udid="$(simulator_udid_from_destination "${destination}")"
  if [[ -z "${simulator_udid}" ]]; then
    echo "::warning::Could not identify the onboarding simulator for the launch retry." >&2
    return 1
  fi

  failed_result_bundle="${result_bundle%.xcresult}.first-launch-failure.xcresult"
  if [[ -e "${result_bundle}" ]]; then
    if [[ -e "${failed_result_bundle}" ]]; then
      echo "::warning::Cannot preserve the first simulator launch failure because ${failed_result_bundle} already exists." >&2
      return 1
    fi
    mv "${result_bundle}" "${failed_result_bundle}"
    echo "Preserved first simulator launch failure: ${failed_result_bundle}"
  fi

  # Recover only the exact destination used by this job. The shared build and
  # every other simulator remain untouched, so this retry costs only a reboot
  # and one test-without-building execution.
  xcrun simctl shutdown "${simulator_udid}" >/dev/null 2>&1 || true
  xcrun simctl boot "${simulator_udid}" >/dev/null 2>&1 || true
  wait_for_simulator_boot "${simulator_udid}"
}

xcodebuild_status=0
if [[ "${skip_build}" != "1" ]]; then
  run_xcodebuild_build_for_testing 2>&1 | tee "${xcodebuild_log}"
  xcodebuild_status="${PIPESTATUS[0]}"
else
  echo "Using shared build-for-testing product: ${xctestrun_path:-${derived_data}/Build/Products}" \
    | tee "${xcodebuild_log}"
fi
if [[ "${xcodebuild_status}" -eq 0 ]]; then
  if [[ "${ONBOARDING_PRIME_STOREKIT:-0}" == "1" ]]; then
    # Only needed for a real StoreKit purchase. OnboardingFullFlowUITests
    # currently sets UI_TEST_SIMULATE_SUCCESSFUL_PURCHASE=1, so priming would
    # launch the app once before the recorded UI test and contaminate state.
    # Exercise the selected runtime instead of rejecting an entire version
    # range. Required StoreKit setup must pass its real product-loading test.
    echo "Priming StoreKit Testing config for the real onboarding purchase"
    run_xcodebuild_prime_storekit 2>&1 | tee -a "${xcodebuild_log}"
    if [[ "${PIPESTATUS[0]}" -ne 0 ]]; then
      echo "::error::StoreKit priming failed; the real onboarding purchase cannot run." >&2
      exit 1
    fi
  else
    echo "Skipping StoreKit priming; onboarding uses simulated purchase in CI"
  fi

  if ! wait_for_config_endpoint; then
    exit 1
  fi
  if [[ "${UI_TEST_PRODUCTION_E2E:-0}" != "1" ]] && ! wait_for_test_otp_backend; then
    exit 1
  fi

  if [[ "${record_video}" == "1" ]]; then
    trap cleanup_screen_recording EXIT INT TERM
    configure_onboarding_video_capture
  fi

  if [[ "${iterations}" =~ ^[0-9]+$ ]] && (( iterations > 1 )); then
    run_test_command \
      -retry-tests-on-failure \
      -test-iterations "${iterations}" \
      2>&1 | tee -a "${xcodebuild_log}"
  else
    run_test_command 2>&1 | tee -a "${xcodebuild_log}"
  fi
  xcodebuild_status="${PIPESTATUS[0]}"
  if [[ "${iterations}" == "1" ]] &&
    [[ "${xcodebuild_status}" -ne 0 ]] &&
    is_retryable_simulator_launch_failure
  then
    echo "::warning::The simulator denied the onboarding app launch; rebooting that destination and retrying once with the existing build." \
      | tee -a "${xcodebuild_log}"
    if recover_onboarding_simulator_for_launch_retry 2>&1 | tee -a "${xcodebuild_log}"; then
      run_test_command 2>&1 | tee -a "${xcodebuild_log}"
      xcodebuild_status="${PIPESTATUS[0]}"
    else
      echo "::warning::The destination simulator could not be recovered; preserving the original XCTest failure." \
        | tee -a "${xcodebuild_log}"
    fi
  fi
  if [[ "${xcodebuild_status}" -eq 0 ]]; then
    recorded_test_succeeded=1
  fi
fi
set -e

if [[ "${record_video}" == "1" ]]; then
  if ! stop_screen_recording; then
    echo "::warning::Onboarding video rendering failed; preserving the required XCTest result." >&2
  fi
  trap - EXIT INT TERM
fi
exit "${xcodebuild_status}"

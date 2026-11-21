#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_path="${repo_root}/ios/example-ios.xcodeproj"
scheme="example-ios-BudgetDebt"
test_plan="Income-E2E"
destination="${DESTINATION:-platform=iOS Simulator,name=iPhone 17}"
api_base_url="${UI_TEST_API_BASE_URL:-http://127.0.0.1:3001/api}"
db_host="${DB_HOST:-127.0.0.1}"
db_port="${DB_PORT:-5434}"
db_user="${DB_USER:-example-local-dev@example-app.iam}"
db_name="${DB_NAME:-example}"
runner_temp="${RUNNER_TEMP:-/tmp}"
run_dir="${INCOME_E2E_RUN_DIR:-$(mktemp -d "${runner_temp}/income-e2e.XXXXXX")}"
derived_data="${DERIVED_DATA:-${run_dir}/DerivedData}"
source_packages="${SOURCE_PACKAGES:-${run_dir}/SourcePackages}"
package_cache="${PACKAGE_CACHE:-${run_dir}/PackageCache}"
result_bundle="${RESULT_BUNDLE:-${run_dir}/income-e2e.xcresult}"
xcodebuild_log="${XCODEBUILD_LOG:-${run_dir}/xcodebuild.log}"
raw_video="${RAW_VIDEO:-${run_dir}/income-e2e.raw.mp4}"
video="${VIDEO_OUTPUT:-${run_dir}/income-e2e-evidence.mp4}"
video_log="${VIDEO_LOG:-${run_dir}/video.log}"
server_log="${INCOME_E2E_SERVER_LOG:-}"
provider_audit_log="${INCOME_E2E_PROVIDER_AUDIT_LOG:-}"
runtime_file="${run_dir}/runtime.json"
cleanup_runtime_file="${run_dir}/cleanup-runtime.json"
email_file="${run_dir}/email.txt"
password_file="${run_dir}/password.txt"
secret_file="${run_dir}/test-otp-secret.txt"
video_pid=""
cleanup_complete=0
skip_build="${SKIP_BUILD:-0}"
xctestrun_path="${XCTESTRUN_PATH:-}"

umask 077
mkdir -p "${run_dir}" "${derived_data}" "${source_packages}" "${package_cache}"
chmod 700 "${run_dir}"

if [[ ! "${api_base_url}" =~ ^http://127\.0\.0\.1:([0-9]{1,5})/api$ ]] ||
   (( 10#${BASH_REMATCH[1]:-0} < 1 || 10#${BASH_REMATCH[1]:-0} > 65535 )); then
  echo "Income E2E requires a loopback HTTP API URL ending in /api" >&2
  exit 2
fi
if [[ "${db_host}" != "127.0.0.1" || ! "${db_port}" =~ ^[0-9]{1,5}$ ]] ||
   (( 10#${db_port:-0} < 1 || 10#${db_port:-0} > 65535 )); then
  echo "Income E2E requires a loopback development database proxy on a valid port" >&2
  exit 2
fi
required_db_user="example-local-dev@example-app.iam"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  required_db_user="github-actions-ci@example-app.iam"
fi
if [[ "${db_user}" != "${required_db_user}" || "${db_name}" != "example" ]]; then
  echo "Income E2E requires the documented development IAM database identity" >&2
  exit 2
fi
if [[ "${skip_build}" != "0" && "${skip_build}" != "1" ]]; then
  echo "SKIP_BUILD must be 0 or 1" >&2
  exit 2
fi
if [[ "${skip_build}" == "1" && ( -z "${xctestrun_path}" || ! -r "${xctestrun_path}" ) ]]; then
  echo "SKIP_BUILD=1 requires a readable XCTESTRUN_PATH" >&2
  exit 2
fi

load_test_otp_secret() {
  local candidate secret_line
  if [[ -n "${TEST_OTP_SECRET_FILE:-}" ]]; then
    if [[ ! -f "${TEST_OTP_SECRET_FILE}" ]]; then
      echo "TEST_OTP_SECRET_FILE does not exist" >&2
      exit 2
    fi
    cp "${TEST_OTP_SECRET_FILE}" "${secret_file}"
    chmod 600 "${secret_file}"
    return
  fi
  if [[ -n "${TEST_OTP_SECRET:-}" ]]; then
    printf '%s' "${TEST_OTP_SECRET}" > "${secret_file}"
    return
  fi
  for candidate in "${repo_root}/.env" "${HOME}/example-dev.env"; do
    [[ -f "${candidate}" ]] || continue
    secret_line="$(grep -E '^[[:space:]]*TEST_OTP_SECRET[[:space:]]*=' "${candidate}" | tail -n 1 || true)"
    [[ -n "${secret_line}" ]] || continue
    secret_line="${secret_line#*=}"
    secret_line="${secret_line#\"}"
    secret_line="${secret_line%\"}"
    secret_line="${secret_line#\'}"
    secret_line="${secret_line%\'}"
    printf '%s' "${secret_line}" > "${secret_file}"
    return
  done
  : > "${secret_file}"
}

load_test_otp_secret

node --input-type=module -e '
  import { randomBytes } from "node:crypto";
  const digits = BigInt(`0x${randomBytes(12).toString("hex")}`).toString(10);
  process.stdout.write(`chat-plaid-local-${Date.now()}${digits}@test.example.local`);
' > "${email_file}"
node --input-type=module -e '
  import { randomBytes } from "node:crypto";
  process.stdout.write(`IncomeE2E-${randomBytes(24).toString("base64url")}!`);
' > "${password_file}"

simulator_udid() {
  if [[ "${destination}" =~ (^|,)id=([^,[:space:]]+) ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
    return
  fi
  local simulator_name="" simulator_os=""
  if [[ "${destination}" =~ (^|,)name=([^,]+) ]]; then
    simulator_name="${BASH_REMATCH[2]}"
  fi
  if [[ "${destination}" =~ (^|,)OS=([^,]+) ]]; then
    simulator_os="${BASH_REMATCH[2]}"
  fi
  if [[ -z "${simulator_name}" ]]; then
    echo "Income E2E DESTINATION must contain an explicit simulator id or name" >&2
    return 2
  fi
  xcrun simctl list devices available -j | python3 -c '
import json, sys
name, requested_os = sys.argv[1:]
data = json.load(sys.stdin)
matches = []
for runtime, devices in data.get("devices", {}).items():
    if ".iOS-" not in runtime:
        continue
    runtime_os = runtime.rsplit(".iOS-", 1)[1].replace("-", ".")
    for device in devices:
        if device.get("isAvailable") and device.get("name") == name:
            matches.append((tuple(int(part) for part in runtime_os.split(".")), runtime_os, device.get("udid", "")))
if requested_os not in ("", "latest"):
    matches = [match for match in matches if match[1] == requested_os]
elif matches:
    latest_version = max(match[0] for match in matches)
    matches = [match for match in matches if match[0] == latest_version]
if len(matches) != 1:
    constraint = f" at OS={requested_os}" if requested_os else " at the latest available iOS runtime"
    raise SystemExit(
        f"DESTINATION name {name!r}{constraint} resolved to {len(matches)} simulators; use an explicit id"
    )
print(matches[0][2])
' "${simulator_name}" "${simulator_os}"
}

stop_video() {
  local video_conversion_status=0
  [[ -n "${video_pid}" ]] || return 0
  kill -INT "${video_pid}" 2>/dev/null || true
  # The recorder writes its file before it exits, so wait is the wait.
  wait "${video_pid}" 2>/dev/null || true
  video_pid=""
  if [[ ! -s "${raw_video}" ]]; then
    echo "Income E2E recorder produced no nonempty raw video" >&2
    return 1
  fi
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -hide_banner -loglevel error -y -i "${raw_video}" \
      -vf "scale='min(1080,iw)':-2" -c:v libx264 -preset medium -crf 25 \
      -movflags +faststart -an "${video}" >>"${video_log}" 2>&1 \
      || video_conversion_status="$?"
  else
    cp "${raw_video}" "${video}" || video_conversion_status="$?"
  fi
  if [[ "${video_conversion_status}" -ne 0 ]]; then
    echo "Income E2E video conversion failed with status ${video_conversion_status}" >&2
    return "${video_conversion_status}"
  fi
  if [[ ! -s "${video}" ]]; then
    echo "Income E2E recorder produced no nonempty final video" >&2
    return 1
  fi
}

cleanup_fixture() {
  local cleanup_status=1
  [[ "${cleanup_complete}" == "0" && -s "${cleanup_runtime_file}" ]] || return 0
  for _ in 1 2 3; do
    if node "${repo_root}/ci/src/actions/ios/incomeE2eApi.ts" cleanup \
      --base-url "${api_base_url}" \
      --run-dir "${run_dir}" \
      --secret-file "${secret_file}"; then
      cleanup_complete=1
      return 0
    else
      cleanup_status="$?"
    fi
  done
  return "${cleanup_status}"
}

finish() {
  local status="$?" cleanup_status=0
  trap - EXIT INT TERM
  set +e
  stop_video
  cleanup_fixture
  cleanup_status="$?"
  rm -f -- "${email_file}" "${password_file}" "${runtime_file}"
  if [[ "${cleanup_status}" -eq 0 ]]; then
    rm -f -- "${secret_file}" "${cleanup_runtime_file}"
  else
    echo "Fixture cleanup failed after 3 attempts; protected recovery files retained:" >&2
    echo "  ${cleanup_runtime_file}" >&2
    echo "  ${secret_file}" >&2
  fi
  set -e
  if [[ "${status}" -eq 0 && "${cleanup_status}" -ne 0 ]]; then
    status="${cleanup_status}"
  fi
  exit "${status}"
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap finish EXIT

echo "Checking required development proxy and API readiness"
PGCONNECT_TIMEOUT=10 PGHOST="${db_host}" PGPORT="${db_port}" \
  PGUSER="${db_user}" PGDATABASE="${db_name}" \
  psql -XAt -v ON_ERROR_STOP=1 -c 'select 1' | grep -qx '1'
curl -fsS --max-time 15 "${api_base_url%/api}/health" > "${run_dir}/health.json"

auth_user_id="$(node "${repo_root}/ci/src/actions/ios/incomeE2eApi.ts" prepare \
  --base-url "${api_base_url}" \
  --run-dir "${run_dir}" \
  --email-file "${email_file}" \
  --password-file "${password_file}" \
  --secret-file "${secret_file}")"
if [[ ! "${auth_user_id}" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  echo "Provisioning returned an invalid auth UID" >&2
  exit 2
fi

sql_snapshot() {
  local output="$1"
  PGCONNECT_TIMEOUT=10 PGHOST="${db_host}" PGPORT="${db_port}" \
    PGUSER="${db_user}" PGDATABASE="${db_name}" \
    psql -XAt -v ON_ERROR_STOP=1 -c \
      "select json_build_object(
         'authUserId', u.auth_user_id,
         'profile', u.profile,
         'plaidItemCount', (select count(*) from plaid_items pi where pi.user_id = u.id),
         'plaidAccountCount', (
           select count(*) from plaid_accounts pa
           join plaid_items pi on pi.id = pa.plaid_item_id
           where pi.user_id = u.id
         )
       ) from users u where u.auth_user_id = '${auth_user_id}';" > "${output}"
  [[ -s "${output}" ]]
}

sql_snapshot "${run_dir}/api-activation-sql.json"
node --input-type=module - "${run_dir}/api-activation-sql.json" <<'NODE'
import { readFileSync } from 'node:fs';
const row = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const income = row.profile?.incomeEmployment ?? row.profile?.income_employment;
const value = (camel, snake) => income?.[camel] ?? income?.[snake];
if (!income || value('cardState', 'card_state') !== 1 || value('noCurrentIncome', 'no_current_income') !== true) {
  throw new Error('Committed SQL row did not contain activated zero-income state');
}
if (row.plaidItemCount !== 0 || row.plaidAccountCount !== 0) {
  throw new Error('Synthetic identity unexpectedly owns linked Plaid data');
}
NODE

reset_auth_user_id="$(node "${repo_root}/ci/src/actions/ios/incomeE2eApi.ts" reset \
  --base-url "${api_base_url}" \
  --run-dir "${run_dir}" \
  --secret-file "${secret_file}")"
if [[ "${reset_auth_user_id}" != "${auth_user_id}" ]]; then
  echo "Supported reset returned a different auth UID" >&2
  exit 1
fi

echo "API activation, no-store readback, committed SQL durability, and supported reset passed"
if [[ "${skip_build}" != "1" ]]; then
  bash "${repo_root}/scripts/prepare-ios-plaid-link.sh" "${source_packages}"
fi

test_secret="$(<"${secret_file}")"
ui_email="$(<"${email_file}")"
ui_password="$(<"${password_file}")"
export UI_TEST_API_BASE_URL="${api_base_url}"
export UI_TEST_EMAIL="${ui_email}"
export UI_TEST_PASSWORD="${ui_password}"
export UI_TEST_EXPECTED_AUTH_USER_ID="${auth_user_id}"
export TEST_OTP_SECRET="${test_secret}"
for variable in UI_TEST_API_BASE_URL UI_TEST_EMAIL UI_TEST_PASSWORD UI_TEST_EXPECTED_AUTH_USER_ID TEST_OTP_SECRET; do
  export "TEST_RUNNER_${variable}=${!variable}"
done

if [[ "${skip_build}" != "1" ]]; then
  xcodebuild build-for-testing \
    -project "${project_path}" \
    -scheme "${scheme}" \
    -testPlan "${test_plan}" \
    -destination "${destination}" \
    -parallel-testing-enabled NO \
    -enableCodeCoverage NO \
    -derivedDataPath "${derived_data}" \
    -clonedSourcePackagesDirPath "${source_packages}" \
    -packageCachePath "${package_cache}" \
    -disableAutomaticPackageResolution \
    COMPILER_INDEX_STORE_ENABLE=NO 2>&1 | tee "${xcodebuild_log}"
fi

test_udid="$(simulator_udid)"
if [[ -z "${test_udid}" ]]; then
  echo "Could not resolve simulator from ${destination}" >&2
  exit 2
fi
xcrun simctl boot "${test_udid}" >/dev/null 2>&1 || true
xcrun simctl bootstatus "${test_udid}" -b

: > "${video_log}"
xcrun simctl io "${test_udid}" recordVideo --codec=h264 --force "${raw_video}" \
  >"${video_log}" 2>&1 &
video_pid="$!"
kill -0 "${video_pid}"

set +e
if [[ "${skip_build}" == "1" ]]; then
  recovery_log="${run_dir}/income-e2e-infra-recovery.log"
  bash "${repo_root}/scripts/run-with-ios-cache-recovery.sh" \
    "${recovery_log}" -- xcodebuild test-without-building \
    -xctestrun "${xctestrun_path}" \
    -destination "${destination}" \
    -parallel-testing-enabled NO \
    -only-testing:example-iosBudgetDebtUITests/IncomeActivationRealServerE2ETests \
    -resultBundlePath "${result_bundle}"
  test_status="$?"
  cat "${recovery_log}" >> "${xcodebuild_log}"
else
  xcodebuild test-without-building \
    -project "${project_path}" \
    -scheme "${scheme}" \
    -testPlan "${test_plan}" \
    -destination "${destination}" \
    -parallel-testing-enabled NO \
    -resultBundlePath "${result_bundle}" \
    -derivedDataPath "${derived_data}" \
    -clonedSourcePackagesDirPath "${source_packages}" \
    -packageCachePath "${package_cache}" \
    -disableAutomaticPackageResolution 2>&1 | tee -a "${xcodebuild_log}"
  test_status="${PIPESTATUS[0]}"
fi
set +e
stop_video
video_status="$?"
set -e
if [[ "${test_status}" -ne 0 ]]; then
  exit "${test_status}"
fi
if [[ "${video_status}" -ne 0 ]]; then
  exit "${video_status}"
fi

node "${repo_root}/ci/src/actions/ios/incomeE2eApi.ts" verify-ui \
  --base-url "${api_base_url}" \
  --run-dir "${run_dir}" >/dev/null
sql_snapshot "${run_dir}/post-ui-sql.json"
node --input-type=module - "${run_dir}/post-ui-sql.json" <<'NODE'
import { readFileSync } from 'node:fs';
const row = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const income = row.profile?.incomeEmployment ?? row.profile?.income_employment;
const value = (camel, snake) => income?.[camel] ?? income?.[snake];
const employers = value('employers', 'employers');
const sources = value('additionalIncomeSources', 'additional_income_sources');
const owner = value('companyOwner', 'company_owner');
if (value('cardState', 'card_state') !== 1 || value('noCurrentIncome', 'no_current_income') !== true
    || value('workForMyself', 'work_for_myself') !== false || value('hasOtherIncome', 'has_other_income') !== false
    || (employers != null && (!Array.isArray(employers) || employers.length !== 0))
    || (sources != null && (!Array.isArray(sources) || sources.length !== 0))
    || (owner?.selfEmploymentIncome ?? owner?.self_employment_income) !== 0) {
  throw new Error('Post-UI committed SQL state did not match the zero-income contract');
}
if (row.plaidItemCount !== 0 || row.plaidAccountCount !== 0) {
  throw new Error('Post-UI state unexpectedly contains linked Plaid data');
}
NODE

if [[ -z "${server_log}" || ! -f "${server_log}" || ! -r "${server_log}" ]]; then
  echo "INCOME_E2E_SERVER_LOG must name the readable task-owned server log" >&2
  exit 2
fi
if [[ -z "${provider_audit_log}" || ! -f "${provider_audit_log}" || ! -r "${provider_audit_log}" ]]; then
  echo "INCOME_E2E_PROVIDER_AUDIT_LOG must name the readable task-owned provider boundary log" >&2
  exit 2
fi
provider_audit="$(node --input-type=module - "${provider_audit_log}" <<'NODE'
import { readFileSync } from 'node:fs';
const lines = readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean);
const requiredBoundaries = ['dns', 'fetch', 'http', 'http2', 'https', 'net', 'tls', 'undici'];
let blocked = 0;
let allowed = 0;
const coverageSessions = new Map();
const boundarySessions = new Set();
for (const line of lines) {
  const entry = JSON.parse(line);
  if (entry.event === 'external_provider_boundary_coverage') {
    if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0
        || entry.policy !== 'block' || entry.startupProbesPassed !== true
        || !Array.isArray(entry.instrumentedBoundaries)
        || requiredBoundaries.some(boundary => !entry.instrumentedBoundaries.includes(boundary))) {
      throw new Error('Provider boundary audit did not install the required instrumented blocking policy');
    }
    coverageSessions.set(entry.sessionId, (coverageSessions.get(entry.sessionId) ?? 0) + 1);
    continue;
  }
  if (entry.event !== 'external_provider_boundary' || typeof entry.provider !== 'string'
      || !['blocked', 'allowed'].includes(entry.disposition)
      || !['startup_probe', 'runtime'].includes(entry.phase)
      || typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) {
    throw new Error('Provider boundary audit contained an invalid record');
  }
  boundarySessions.add(entry.sessionId);
  if (entry.disposition === 'allowed') allowed += 1;
  else if (entry.phase === 'runtime') blocked += 1;
}
if (coverageSessions.size === 0
    || [...coverageSessions.values()].some(count => count !== 1)
    || [...boundarySessions].some(sessionId => !coverageSessions.has(sessionId))) {
  throw new Error('Provider boundary audit session coverage was missing, duplicated, or uncorrelated');
}
process.stdout.write(`${blocked} ${allowed} ${coverageSessions.size}`);
NODE
)"
read -r provider_blocked provider_allowed provider_sessions <<< "${provider_audit}"
if [[ "${provider_allowed}" != "0" ]]; then
  echo "Provider dispatches escaped an instrumented Income E2E Node boundary" >&2
  exit 1
fi

VIDEO_PATH="${video}" RESULT_PATH="${result_bundle}" INSTRUMENTED_PROVIDER_ALLOWED="${provider_allowed}" \
INSTRUMENTED_PROVIDER_BLOCKED="${provider_blocked}" PROVIDER_SESSIONS="${provider_sessions}" \
RUN_DIR="${run_dir}" AUTH_USER_ID="${auth_user_id}" python3 - <<'PY'
import json, os
from datetime import datetime, timezone
receipt = {
    "capturedAt": datetime.now(timezone.utc).isoformat(),
    "authUserId": os.environ["AUTH_USER_ID"],
    "apiActivationDurable": True,
    "supportedResetVerified": True,
    "realUIActivationPassed": True,
    "relaunchPersistencePassed": True,
    "postUISQLDurable": True,
    "linkedPlaidItemCount": 0,
    "linkedPlaidAccountCount": 0,
    "serverLogObserved": True,
    "instrumentedProviderDispatchesAllowed": int(os.environ["INSTRUMENTED_PROVIDER_ALLOWED"]),
    "instrumentedProviderAttemptsBlocked": int(os.environ["INSTRUMENTED_PROVIDER_BLOCKED"]),
    "instrumentedProviderBoundarySessions": int(os.environ["PROVIDER_SESSIONS"]),
    "providerBoundaryEvidenceScope": "enumerated Node APIs and provider hostname suffixes",
    "processWideEgressAttested": False,
    "video": os.environ["VIDEO_PATH"],
    "xcresult": os.environ["RESULT_PATH"],
}
with open(os.path.join(os.environ["RUN_DIR"], "evidence-summary.json"), "w", encoding="utf-8") as handle:
    json.dump(receipt, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY

cleanup_fixture
echo "Income E2E passed"
echo "Evidence directory: ${run_dir}"
echo "Video: ${video}"
echo "Result bundle: ${result_bundle}"

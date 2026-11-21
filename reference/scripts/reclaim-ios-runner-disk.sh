#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
runner_temp_input="${RUNNER_TEMP:-/tmp}"
# A cold-cache 2,059-test CI run retained 6,031,964 KB. The 12,000,000 KB floor
# preserves roughly 5.7 GiB of headroom without deleting persistent runner data.
minimum_free_kb="${IOS_RUNNER_MIN_FREE_KB:-12000000}"
disk_diagnostic_timeout_seconds="${IOS_RUNNER_DISK_DIAGNOSTIC_TIMEOUT_SECONDS:-20}"
legacy_reset_budget_seconds="${IOS_RUNNER_LEGACY_RESET_BUDGET_SECONDS:-180}"
home_dir_input="${HOME:-}"
legacy_reset_deadline=0

if [[ ! -d "${runner_temp_input}" ]]; then
  echo "Refusing iOS runner cleanup for unsafe RUNNER_TEMP=${runner_temp_input}" >&2
  exit 1
fi
runner_temp="$(cd "${runner_temp_input}" 2>/dev/null && pwd -P || true)"
if [[ -z "${runner_temp}" || "${runner_temp}" == "/" ]]; then
  echo "Refusing iOS runner cleanup for unsafe RUNNER_TEMP=${runner_temp_input}" >&2
  exit 1
fi
if [[ -z "${home_dir_input}" || ! -d "${home_dir_input}" ]]; then
  echo "Refusing iOS runner cleanup for unsafe HOME=${home_dir_input}" >&2
  exit 1
fi
home_dir="$(cd "${home_dir_input}" 2>/dev/null && pwd -P || true)"
if [[ -z "${home_dir}" || "${home_dir}" == "/" ]]; then
  echo "Refusing iOS runner cleanup for unsafe HOME=${home_dir_input}" >&2
  exit 1
fi
if [[ ! "${minimum_free_kb}" =~ ^[0-9]+$ ]]; then
  echo "IOS_RUNNER_MIN_FREE_KB must be a non-negative integer" >&2
  exit 1
fi
if [[ ! "${disk_diagnostic_timeout_seconds}" =~ ^[1-9][0-9]*$ ]] ||
   (( disk_diagnostic_timeout_seconds > 120 ))
then
  echo "IOS_RUNNER_DISK_DIAGNOSTIC_TIMEOUT_SECONDS must be an integer from 1 through 120" >&2
  exit 1
fi
if [[ ! "${legacy_reset_budget_seconds}" =~ ^[1-9][0-9]*$ ]] ||
   (( legacy_reset_budget_seconds > 300 ))
then
  echo "IOS_RUNNER_LEGACY_RESET_BUDGET_SECONDS must be an integer from 1 through 300" >&2
  exit 1
fi

disposable_cache_roots=(
  "${home_dir}/Library/Developer/Xcode/DerivedData"
  "${home_dir}/Library/Developer/CoreSimulator/Caches"
  "${home_dir}/Library/Caches/org.swift.swiftpm"
  "${home_dir}/Library/Caches/com.apple.dt.Xcode"
  "${home_dir}/Library/Caches/com.openai.codex"
  "${home_dir}/Library/Caches/Google"
  "${home_dir}/Library/Caches/ms-playwright"
  "${home_dir}/Library/Caches/Homebrew"
  "${home_dir}/.npm"
  # Generated workflows point npm_config_cache at this runner's own tool cache.
  "${runner_temp%/*}/_tool/npm-cache"
  "${home_dir}/.cache"
  "${home_dir}/.gradle/caches"
)

run_with_timeout() {
  local seconds="$1"
  shift
  /usr/bin/perl -e \
    '
      use POSIX qw(setpgid);

      my $seconds = shift @ARGV;
      my $pid = fork();
      die "fork failed: $!" unless defined $pid;
      if ($pid == 0) {
        if (!defined setpgid(0, 0)) {
          my $setpgid_error = "$!";
          die "setpgid failed: $setpgid_error"
            unless getpgrp(0) == $$;
        }
        exec {$ARGV[0]} @ARGV;
        warn "exec failed: $!\n";
        POSIX::_exit(127);
      }

      if (!defined setpgid($pid, $pid)) {
        my $setpgid_error = "$!";
        die "setpgid failed: $setpgid_error"
          unless getpgrp($pid) == $pid;
      }
      my $timed_out = 0;
      $SIG{ALRM} = sub {
        if ($timed_out) {
          kill "KILL", -$pid;
          exit 124;
        }
        $timed_out = 1;
        kill "TERM", -$pid;
        alarm 2;
      };

      alarm $seconds;
      my $waited;
      do {
        $waited = waitpid($pid, 0);
      } while ($waited == -1 && $!{EINTR});
      alarm 0;
      die "waitpid failed: $!" if $waited == -1;
      my $status = $?;

      if ($timed_out) {
        kill "KILL", -$pid;
        exit 124;
      }
      exit 128 + ($status & 127) if $status & 127;
      exit $status >> 8;
    ' \
    "${seconds}" "$@"
}

remove_run_directories() {
  local ios_tests_pattern="$1"
  local storekit_pattern="$2"
  local onboarding_pattern="$3"
  local additional_onboarding_pattern="${4:-__no_additional_onboarding_pattern__}"
  local release_archive_pattern="${5:-__no_release_archive_pattern__}"

  find "${runner_temp}" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    \( \
      -name "${ios_tests_pattern}" \
      -o -name "${storekit_pattern}" \
      -o -name "${onboarding_pattern}" \
      -o -name "${additional_onboarding_pattern}" \
      -o -name "${release_archive_pattern}" \
    \) \
    -prune \
    -exec rm -rf -- {} +
}

remove_orphaned_example_simulator_recorders() {
  python3 - "${home_dir}" <<'PY'
import os
import pathlib
import shlex
import signal
import subprocess
import sys
import time

home = pathlib.Path(sys.argv[1]).resolve()


def process_inventory() -> list[tuple[int, int, str]]:
    completed = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,command="],
        check=True,
        capture_output=True,
        text=True,
    )
    processes: list[tuple[int, int, str]] = []
    for line in completed.stdout.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) != 3:
            continue
        try:
            processes.append((int(fields[0]), int(fields[1]), fields[2]))
        except ValueError:
            continue
    return processes


def owned_orphan(pid: int, ppid: int, command: str) -> bool:
    if pid <= 1 or ppid != 1:
        return False
    try:
        arguments = shlex.split(command)
    except ValueError:
        return False
    if len(arguments) < 5 or not arguments[0].endswith("/simctl"):
        return False
    if arguments[1] != "io" or arguments[3] != "recordVideo":
        return False
    output_candidates = [argument for argument in arguments[4:] if argument.startswith("/")]
    for candidate in output_candidates:
        try:
            relative = pathlib.Path(candidate).relative_to(home)
        except ValueError:
            continue
        parts = relative.parts
        if (
            len(parts) >= 5
            and parts[0].startswith("actions-runner-example-app")
            and parts[1:3] == ("_work", "_temp")
            and parts[3].startswith("onboarding-e2e.")
        ):
            return True
    return False


orphaned = [process for process in process_inventory() if owned_orphan(*process)]
for pid, _, command in orphaned:
    print(f"Terminating orphaned Example simulator recorder {pid}: {command}")
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass

if orphaned:
    # These recorders are not children of this process, so there is nothing to
    # wait on; any still present after TERM is delivered is killed outright.
    inventory = {pid: (ppid, command) for pid, ppid, command in process_inventory()}
    remaining = {
        pid
        for pid, _, _ in orphaned
        if pid in inventory and owned_orphan(pid, *inventory[pid])
    }
    for pid in sorted(remaining):
        print(f"Force-terminating orphaned Example simulator recorder {pid}")
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
PY
}

remove_expired_durable_ci_evidence() {
  node "${script_dir}/../ci/src/actions/ios/pruneExpiredDurableEvidence.ts"
}

validate_compacted_durable_ci_evidence() {
  local candidate="$1"
  local archive_path="${candidate}/evidence-fallback.tar.gz"
  local checksum_path="${candidate}/evidence-fallback.tar.gz.sha256"

  if [[ ! -f "${archive_path}" || -L "${archive_path}" ||
        ! -f "${checksum_path}" || -L "${checksum_path}" ]]
  then
    return 1
  fi

  python3 - "${archive_path}" "${checksum_path}" <<'PY'
import hashlib
import pathlib
import re
import sys
import tarfile

archive_path = pathlib.Path(sys.argv[1])
checksum_path = pathlib.Path(sys.argv[2])
if archive_path.is_symlink() or checksum_path.is_symlink():
    raise ValueError("compacted evidence metadata is unsafe")
checksum_record = checksum_path.read_bytes()
match = re.fullmatch(
    rb"([0-9a-f]{64})  evidence-fallback\.tar\.gz\n",
    checksum_record,
)
if match is None:
    raise ValueError("compacted evidence checksum record is invalid")

digest = hashlib.sha256()
with archive_path.open("rb") as archive_handle:
    for chunk in iter(lambda: archive_handle.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest().encode("ascii") != match.group(1):
    raise ValueError("compacted evidence archive checksum does not match")

with tarfile.open(archive_path, mode="r:gz") as archive:
    if not archive.getmembers():
        raise ValueError("compacted evidence archive is empty")
PY
}

validate_durable_ci_evidence() {
  local candidate="$1"
  local archive_path="${candidate}/evidence-fallback.tar.gz"
  local checksum_path="${candidate}/evidence-fallback.tar.gz.sha256"

  if [[ ! -d "${candidate}" || -L "${candidate}" ]]; then
    return 1
  fi
  if [[ -e "${archive_path}" || -L "${archive_path}" ||
        -e "${checksum_path}" || -L "${checksum_path}" ]]
  then
    validate_compacted_durable_ci_evidence "${candidate}"
    return
  fi
  if [[ ! -f "${candidate}/index.jsonl" ||
        ! -f "${candidate}/sha256-manifest.txt" ]]
  then
    return 1
  fi

  python3 - "${candidate}" <<'PY'
import hashlib
import json
import pathlib
import re
import sys
import tarfile

root = pathlib.Path(sys.argv[1])
index_path = root / "index.jsonl"
manifest_path = root / "sha256-manifest.txt"
if index_path.is_symlink() or manifest_path.is_symlink():
    raise ValueError("durable evidence metadata is unsafe")

entries = []
for line in index_path.read_text(encoding="utf-8").splitlines():
    if line.strip():
        entries.append(json.loads(line))
if not entries:
    raise ValueError("durable evidence index is empty")

checksum_pattern = re.compile(r"[0-9a-f]{64}")
stored_paths = set()
manifest_records = []
manifest_record_set = set()
for entry in entries:
    original_path = entry.get("originalPath")
    stored_path = entry.get("storedPath")
    checksum = entry.get("sha256")
    size = entry.get("size")
    kind = entry.get("kind")
    if (
        not isinstance(original_path, str)
        or not original_path
        or any(ord(character) < 32 or ord(character) == 127 for character in original_path)
    ):
        raise ValueError("durable evidence originalPath is missing or unsafe")
    if not isinstance(stored_path, str):
        raise ValueError("durable evidence storedPath is missing")
    relative_path = pathlib.PurePosixPath(stored_path)
    if (
        relative_path.is_absolute()
        or not relative_path.parts
        or relative_path.parts[0] != "files"
        or ".." in relative_path.parts
    ):
        raise ValueError("durable evidence storedPath is unsafe")
    if stored_path in stored_paths:
        raise ValueError("durable evidence storedPath is duplicated")
    stored_paths.add(stored_path)
    evidence_path = root.joinpath(*relative_path.parts)
    if not evidence_path.is_file() or evidence_path.is_symlink():
        raise ValueError("durable evidence payload is missing or unsafe")
    if type(size) is not int or size < 0 or evidence_path.stat().st_size != size:
        raise ValueError("durable evidence payload size does not match")
    if not isinstance(checksum, str) or not checksum_pattern.fullmatch(checksum):
        raise ValueError("durable evidence checksum is invalid")
    if kind not in {"file", "directory-tar", "directory-tar-gzip"}:
        raise ValueError("durable evidence payload kind is unknown")
    digest = hashlib.sha256()
    with evidence_path.open("rb") as evidence_handle:
        for chunk in iter(lambda: evidence_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != checksum:
        raise ValueError("durable evidence payload checksum does not match")
    if kind in {"directory-tar", "directory-tar-gzip"}:
        with tarfile.open(evidence_path, mode="r:*") as archive:
            if archive.next() is None:
                raise ValueError("durable evidence archive is empty")
    manifest_record = (
        f"{checksum}  {size}  {kind}  {original_path}\n".encode("utf-8")
    )
    if manifest_record in manifest_record_set:
        raise ValueError("durable evidence manifest record is duplicated")
    manifest_record_set.add(manifest_record)
    manifest_records.append(manifest_record)

expected_manifest = b"".join(sorted(manifest_records))
if manifest_path.read_bytes() != expected_manifest:
    raise ValueError("durable evidence manifest does not match index")
PY
}

read_durable_ci_evidence_head_sha() {
  local candidate="$1"
  local expected_repository="$2"
  local expected_run_id="$3"

  python3 - \
    "${candidate}/provenance.json" \
    "${expected_repository}" \
    "${expected_run_id}" <<'PY'
import json
import re
import sys

provenance_path, expected_repository, expected_run_id = sys.argv[1:]
with open(provenance_path, encoding="utf-8") as provenance_handle:
    provenance = json.load(provenance_handle)
head_sha = provenance.get("headSha")
repository = provenance.get("repository")
run_id = provenance.get("runId")
pull_request_number = provenance.get("pullRequestNumber")
if repository != expected_repository:
    raise ValueError("durable evidence repository does not match")
if str(run_id) != expected_run_id:
    raise ValueError("durable evidence run ID does not match")
if not isinstance(head_sha, str) or re.fullmatch(r"[0-9a-f]{40}", head_sha) is None:
    raise ValueError("durable evidence exact head is invalid")
if pull_request_number is not None and (
    not isinstance(pull_request_number, int) or pull_request_number <= 0
):
    raise ValueError("durable evidence pull request number is invalid")
print(f"{head_sha}\t{pull_request_number or ''}")
PY
}

backfill_durable_ci_evidence_provenance() {
  local candidate="$1"
  local run_id="$2"
  local provenance_cache="$3"
  local repository="${GITHUB_REPOSITORY:-}"
  local api_url="${GITHUB_API_URL:-}"
  local actions_token="${EXAMPLE_ACTIONS_READ_TOKEN:-}"
  local cached
  local response
  local resolved
  local head_sha
  local pull_request_number
  local temporary_provenance

  cached="$(awk -F '\t' -v run_id="${run_id}" '$1 == run_id { print $2 "\t" $3; exit }' "${provenance_cache}")"
  if [[ -n "${cached}" ]]; then
    IFS=$'\t' read -r head_sha pull_request_number <<< "${cached}"
  else
    if [[ ! "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
       [[ ! "${api_url}" =~ ^https://[^[:space:]]+$ ]] ||
       [[ -z "${actions_token}" ]] ||
       ! command -v curl >/dev/null 2>&1
    then
      echo "Cannot backfill durable evidence provenance for run ${run_id} without authenticated Actions read access" >&2
      return 1
    fi
    if ! response="$(
      curl -fsSL \
        -H "Authorization: Bearer ${actions_token}" \
        -H 'Accept: application/vnd.github+json' \
        "${api_url}/repos/${repository}/actions/runs/${run_id}"
    )"; then
      echo "Could not read Actions provenance for run ${run_id}" >&2
      return 1
    fi
    if ! resolved="$(
      printf '%s' "${response}" |
        python3 -c '
import json
import re
import sys

expected_repository, expected_run_id = sys.argv[1:]
payload = json.load(sys.stdin)
head_sha = payload.get("head_sha")
repository = payload.get("repository", {}).get("full_name")
run_id = payload.get("id")
pull_requests = payload.get("pull_requests")
if repository != expected_repository or str(run_id) != expected_run_id:
    raise ValueError("Actions run provenance does not match the requested run")
if not isinstance(head_sha, str) or re.fullmatch(r"[0-9a-f]{40}", head_sha) is None:
    raise ValueError("Actions run exact head is invalid")
pull_request_number = ""
if isinstance(pull_requests, list) and pull_requests:
    number = pull_requests[0].get("number")
    if isinstance(number, int) and number > 0:
        pull_request_number = str(number)
print(f"{head_sha}\t{pull_request_number}")
' "${repository}" "${run_id}"
    )"; then
      echo "Could not validate Actions provenance for run ${run_id}" >&2
      return 1
    fi
    IFS=$'\t' read -r head_sha pull_request_number <<< "${resolved}"
    printf '%s\t%s\t%s\n' "${run_id}" "${head_sha}" "${pull_request_number}" >> "${provenance_cache}"
  fi

  if ! temporary_provenance="$(
    mktemp "${runner_temp}/example-ci-evidence-provenance-${run_id}.XXXXXX"
  )"; then
    echo "Could not stage durable evidence provenance for run ${run_id}" >&2
    return 1
  fi
  if ! python3 - \
    "${temporary_provenance}" \
    "${repository}" \
    "${head_sha}" \
    "${pull_request_number}" \
    "${run_id}" <<'PY'
import json
import sys

output_path, repository, head_sha, pull_request_number, run_id = sys.argv[1:]
payload = {
    "repository": repository,
    "headSha": head_sha,
    "pullRequestNumber": int(pull_request_number) if pull_request_number else None,
    "runId": int(run_id),
    "source": "actions-run-api-backfill",
}
with open(output_path, "w", encoding="utf-8") as output_handle:
    json.dump(payload, output_handle, separators=(",", ":"), sort_keys=True)
    output_handle.write("\n")
PY
  then
    rm -f -- "${temporary_provenance}"
    echo "Could not write durable evidence provenance for run ${run_id}" >&2
    return 1
  fi
  if ! chmod 600 "${temporary_provenance}"; then
    rm -f -- "${temporary_provenance}"
    echo "Could not secure durable evidence provenance for run ${run_id}" >&2
    return 1
  fi
  if [[ ! -d "${candidate}" || -L "${candidate}" ]]; then
    rm -f -- "${temporary_provenance}"
    echo "Durable evidence candidate disappeared during provenance backfill; preserving remaining evidence" >&2
    return 1
  fi
  if ! mv "${temporary_provenance}" "${candidate}/provenance.json"; then
    rm -f -- "${temporary_provenance}"
    echo "Could not install durable evidence provenance for run ${run_id}" >&2
    return 1
  fi
  printf '%s\t%s\n' "${head_sha}" "${pull_request_number}"
}

resolve_durable_ci_evidence_head_sha() {
  local candidate="$1"
  local run_id="$2"
  local provenance_cache="$3"
  local repository="${GITHUB_REPOSITORY:-local}"

  if [[ -f "${candidate}/provenance.json" ]]; then
    read_durable_ci_evidence_head_sha "${candidate}" "${repository}" "${run_id}"
    return
  fi
  backfill_durable_ci_evidence_provenance "${candidate}" "${run_id}" "${provenance_cache}"
}

prune_superseded_durable_ci_evidence() {
  local evidence_root_input="${EXAMPLE_CI_EVIDENCE_ROOT:-${home_dir}/.example-ci-evidence}"
  local evidence_root
  local inventory
  local sorted_inventory
  local all_latest_inventory
  local latest_inventory
  local superseded_inventory
  local provenance_cache
  local -a inventory_files
  local candidate
  local candidate_name
  local candidate_head_sha
  local candidate_pull_request_number
  local candidate_retention_scope
  local candidate_lane
  local candidate_slug
  local candidate_run_id
  local candidate_attempt
  local candidate_size_kb
  local resolved

  if [[ "${IOS_RUNNER_PRUNE_SUPERSEDED_EVIDENCE:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    echo "Skipping superseded CI evidence pruning without explicit workflow authorization" >&2
    return
  fi
  if ! command -v python3 >/dev/null 2>&1 ||
     ! command -v tar >/dev/null 2>&1 ||
     ! command -v shasum >/dev/null 2>&1 ||
     ! command -v awk >/dev/null 2>&1
  then
    echo "Superseded CI evidence pruning requires python3, tar, and shasum" >&2
    return 1
  fi

  while [[ "${evidence_root_input}" != "/" && "${evidence_root_input}" == */ ]]; do
    evidence_root_input="${evidence_root_input%/}"
  done
  case "${evidence_root_input}" in
    /*) ;;
    *)
      echo "Refusing a non-absolute durable CI evidence root ${evidence_root_input}" >&2
      return 1
      ;;
  esac
  case "${evidence_root_input##*/}" in
    .example-ci-evidence|example-ci-evidence) ;;
    *)
      echo "Refusing a non-dedicated durable CI evidence root ${evidence_root_input}" >&2
      return 1
      ;;
  esac
  if [[ ! -e "${evidence_root_input}" ]]; then
    return
  fi
  if [[ -L "${evidence_root_input}" || ! -d "${evidence_root_input}" ]]; then
    echo "Refusing an unsafe durable CI evidence root ${evidence_root_input}" >&2
    return 1
  fi

  evidence_root="$(cd "${evidence_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${evidence_root}" || "${evidence_root}" == "/" ]]; then
    echo "Refusing an unsafe canonical durable CI evidence root ${evidence_root_input}" >&2
    return 1
  fi
  case "${evidence_root##*/}" in
    .example-ci-evidence|example-ci-evidence) ;;
    *)
      echo "Refusing a non-dedicated canonical CI evidence root ${evidence_root}" >&2
      return 1
      ;;
  esac

  inventory="$(mktemp "${runner_temp}/example-ci-evidence-inventory.XXXXXX")"
  sorted_inventory="$(mktemp "${runner_temp}/example-ci-evidence-sorted.XXXXXX")"
  all_latest_inventory="$(mktemp "${runner_temp}/example-ci-evidence-all-latest.XXXXXX")"
  latest_inventory="$(mktemp "${runner_temp}/example-ci-evidence-latest.XXXXXX")"
  superseded_inventory="$(mktemp "${runner_temp}/example-ci-evidence-superseded.XXXXXX")"
  provenance_cache="$(mktemp "${runner_temp}/example-ci-evidence-provenance.XXXXXX")"
  inventory_files=(
    "${inventory}"
    "${sorted_inventory}"
    "${all_latest_inventory}"
    "${latest_inventory}"
    "${superseded_inventory}"
    "${provenance_cache}"
  )

  while IFS= read -r -d '' candidate; do
    candidate_name="${candidate##*/}"
    if [[ ! "${candidate_name}" =~ ^run-([0-9]+)-attempt-([0-9]+)-([a-z0-9]+([a-z0-9-]*[a-z0-9])?)\.[A-Za-z0-9]+$ ]]; then
      continue
    fi
    candidate_run_id="${BASH_REMATCH[1]}"
    candidate_attempt="${BASH_REMATCH[2]}"
    candidate_slug="${BASH_REMATCH[3]}"
    if ! resolved="$(
      resolve_durable_ci_evidence_head_sha \
        "${candidate}" \
        "${candidate_run_id}" \
        "${provenance_cache}"
    )"; then
      rm -f -- "${inventory_files[@]}"
      echo "Could not resolve exact-head provenance for durable CI evidence ${candidate}; preserving all durable CI evidence and continuing authorized cleanup" >&2
      return 0
    fi
    IFS=$'\t' read -r candidate_head_sha candidate_pull_request_number <<< "${resolved}"
    candidate_pull_request_number="${candidate_pull_request_number:-0}"
    candidate_lane="${candidate_slug%-screenshots}"
    candidate_lane="${candidate_lane%-diagnostics}"
    candidate_lane="${candidate_lane:-${candidate_slug}}"
    if (( candidate_pull_request_number > 0 )); then
      candidate_retention_scope="pull-request-${candidate_pull_request_number}-${candidate_lane}"
    else
      candidate_retention_scope="exact-head-${candidate_head_sha}-${candidate_lane}"
    fi
    candidate_size_kb="$(du -sk "${candidate}" | awk '{print $1}')"
    if [[ ! "${candidate_size_kb}" =~ ^[0-9]+$ ]]; then
      rm -f -- "${inventory_files[@]}"
      echo "Could not measure durable CI evidence ${candidate}" >&2
      return 1
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${candidate_retention_scope}" \
      "${candidate_head_sha}" \
      "${candidate_pull_request_number}" \
      "${candidate_slug}" \
      "${candidate_run_id}" \
      "${candidate_attempt}" \
      "${candidate_size_kb}" \
      "${candidate}" \
      >> "${inventory}"
  done < <(
    find "${evidence_root}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -name 'run-*-attempt-*' \
      -print0
  )

  LC_ALL=C sort -t $'\t' -k1,1 -k5,5nr -k6,6nr \
    "${inventory}" \
    > "${sorted_inventory}"
  awk -F '\t' '
    {
      key = $1
      run = $5
      attempt = $6
      if (!(key in latest_run)) {
        latest_run[key] = run
        latest_attempt[key] = attempt
      }
      if (run == latest_run[key] && attempt == latest_attempt[key]) {
        print > latest
      } else {
        print > superseded
      }
    }
  ' \
    latest="${all_latest_inventory}" \
    superseded="${superseded_inventory}" \
    "${sorted_inventory}"
  awk -F '\t' '
    FILENAME == ARGV[1] {
      groups[$1] = 1
      next
    }
    ($1 in groups)
  ' \
    "${superseded_inventory}" \
    "${all_latest_inventory}" \
    > "${latest_inventory}"

  while IFS=$'\t' read -r candidate_retention_scope candidate_head_sha candidate_pull_request_number candidate_slug candidate_run_id candidate_attempt candidate_size_kb candidate; do
    if [[ -z "${candidate}" ]]; then
      continue
    fi
    if ! validate_durable_ci_evidence "${candidate}"; then
      rm -f -- "${inventory_files[@]}"
      echo "Refusing to prune ${candidate_slug} evidence for head ${candidate_head_sha} because newest run ${candidate_run_id} attempt ${candidate_attempt} failed validation" >&2
      return 1
    fi
  done < "${latest_inventory}"

  LC_ALL=C sort -t $'\t' -k5,5n -k6,6n \
    "${superseded_inventory}" \
    -o "${superseded_inventory}"
  while IFS=$'\t' read -r candidate_retention_scope candidate_head_sha candidate_pull_request_number candidate_slug candidate_run_id candidate_attempt candidate_size_kb candidate; do
    available_kb="$(available_disk_kb)"
    if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
      rm -f -- "${inventory_files[@]}"
      echo "Unable to determine free disk space during evidence pruning" >&2
      return 1
    fi
    if (( available_kb >= minimum_free_kb )); then
      break
    fi
    if [[ "${candidate_run_id}" == "${GITHUB_RUN_ID}" &&
          "${candidate_attempt}" == "${GITHUB_RUN_ATTEMPT}" ]]
    then
      continue
    fi
    if [[ ! -d "${candidate}" || -L "${candidate}" ||
          "$(cd "${candidate}" 2>/dev/null && pwd -P || true)" != "${candidate}" ]]
    then
      rm -f -- "${inventory_files[@]}"
      echo "Refusing unsafe superseded durable CI evidence ${candidate}" >&2
      return 1
    fi

    echo "Removing superseded ${candidate_slug} evidence for head ${candidate_head_sha} from run ${candidate_run_id} attempt ${candidate_attempt} (${candidate_size_kb} KB)"
    rm -rf -- "${candidate}"
  done < "${superseded_inventory}"

  rm -f -- "${inventory_files[@]}"
}

prune_merged_pull_request_durable_ci_evidence() {
  local evidence_root_input="${EXAMPLE_CI_EVIDENCE_ROOT:-${home_dir}/.example-ci-evidence}"
  local repository="${GITHUB_REPOSITORY:-}"
  local api_url="${GITHUB_API_URL:-}"
  local actions_token="${EXAMPLE_ACTIONS_READ_TOKEN:-}"
  local evidence_root
  local candidate
  local candidate_name
  local candidate_canonical
  local candidate_run_id
  local candidate_attempt
  local candidate_head_sha
  local candidate_pull_request_number
  local response
  local resolved
  local cached
  local disposition
  local pull_request_head_sha
  local status_cache

  if [[ "${IOS_RUNNER_PRUNE_MERGED_PR_EVIDENCE:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    echo "Skipping merged pull request evidence pruning without explicit workflow authorization" >&2
    return
  fi
  if [[ ! "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
     [[ ! "${api_url}" =~ ^https://[^[:space:]]+$ ]] ||
     [[ -z "${actions_token}" ]] ||
     ! command -v curl >/dev/null 2>&1 ||
     ! command -v python3 >/dev/null 2>&1
  then
    echo "Merged pull request evidence pruning requires authenticated Actions read access" >&2
    return 1
  fi

  while [[ "${evidence_root_input}" != "/" && "${evidence_root_input}" == */ ]]; do
    evidence_root_input="${evidence_root_input%/}"
  done
  case "${evidence_root_input}" in
    /*) ;;
    *)
      echo "Refusing a non-absolute durable CI evidence root ${evidence_root_input}" >&2
      return 1
      ;;
  esac
  case "${evidence_root_input##*/}" in
    .example-ci-evidence|example-ci-evidence) ;;
    *)
      echo "Refusing a non-dedicated durable CI evidence root ${evidence_root_input}" >&2
      return 1
      ;;
  esac
  if [[ ! -e "${evidence_root_input}" ]]; then
    return
  fi
  if [[ -L "${evidence_root_input}" || ! -d "${evidence_root_input}" ]]; then
    echo "Refusing an unsafe durable CI evidence root ${evidence_root_input}" >&2
    return 1
  fi
  evidence_root="$(cd "${evidence_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${evidence_root}" || "${evidence_root}" == "/" ||
        "${evidence_root}" != "${evidence_root_input}" ]]
  then
    echo "Refusing an unsafe canonical durable CI evidence root ${evidence_root_input}" >&2
    return 1
  fi

  status_cache="$(mktemp "${runner_temp}/example-merged-pr-status.XXXXXX")"
  echo "Pruning validated fallback evidence for already merged pull request heads"
  while IFS= read -r -d '' candidate; do
    candidate_name="${candidate##*/}"
    if [[ ! "${candidate_name}" =~ ^run-([0-9]+)-attempt-([0-9]+)-([a-z0-9]+([a-z0-9-]*[a-z0-9])?)\.[A-Za-z0-9]+$ ]]; then
      continue
    fi
    candidate_run_id="${BASH_REMATCH[1]}"
    candidate_attempt="${BASH_REMATCH[2]}"
    if [[ "${candidate_run_id}" == "${GITHUB_RUN_ID}" &&
          "${candidate_attempt}" == "${GITHUB_RUN_ATTEMPT}" ]]
    then
      continue
    fi
    if ! validate_durable_ci_evidence "${candidate}"; then
      echo "Preserving invalid durable CI evidence ${candidate}" >&2
      continue
    fi
    if ! resolved="$(
      read_durable_ci_evidence_head_sha \
        "${candidate}" \
        "${repository}" \
        "${candidate_run_id}"
    )"; then
      echo "Preserving durable CI evidence with invalid provenance ${candidate}" >&2
      continue
    fi
    IFS=$'\t' read -r candidate_head_sha candidate_pull_request_number <<< "${resolved}"
    if [[ ! "${candidate_pull_request_number:-}" =~ ^[1-9][0-9]*$ ]]; then
      continue
    fi

    cached="$(
      awk -F '\t' \
        -v pull_request_number="${candidate_pull_request_number}" \
        '$1 == pull_request_number { print $2 "\t" $3; exit }' \
        "${status_cache}"
    )"
    if [[ -n "${cached}" ]]; then
      IFS=$'\t' read -r disposition pull_request_head_sha <<< "${cached}"
    else
      if ! response="$(
        curl -fsSL \
          -H "Authorization: Bearer ${actions_token}" \
          -H 'Accept: application/vnd.github+json' \
          "${api_url}/repos/${repository}/pulls/${candidate_pull_request_number}"
      )"; then
        echo "Could not read pull request ${candidate_pull_request_number}; preserving its evidence" >&2
        continue
      fi
      if ! resolved="$(
        printf '%s' "${response}" |
          python3 -c '
import json
import re
import sys

expected_repository, expected_number = sys.argv[1:]
payload = json.load(sys.stdin)
number = payload.get("number")
repository = payload.get("base", {}).get("repo", {}).get("full_name")
head_sha = payload.get("head", {}).get("sha")
if str(number) != expected_number or repository != expected_repository:
    raise ValueError("pull request identity does not match")
if not isinstance(head_sha, str) or re.fullmatch(r"[0-9a-f]{40}", head_sha) is None:
    raise ValueError("pull request head is invalid")
merged = payload.get("state") == "closed" and isinstance(payload.get("merged_at"), str)
disposition = "merged" if merged else "retain"
print(f"{disposition}\t{head_sha}")
' "${repository}" "${candidate_pull_request_number}"
      )"; then
        echo "Could not validate pull request ${candidate_pull_request_number}; preserving its evidence" >&2
        continue
      fi
      IFS=$'\t' read -r disposition pull_request_head_sha <<< "${resolved}"
      printf '%s\t%s\t%s\n' \
        "${candidate_pull_request_number}" \
        "${disposition}" \
        "${pull_request_head_sha}" \
        >> "${status_cache}"
    fi
    if [[ "${disposition}" != "merged" ||
          "${candidate_head_sha}" != "${pull_request_head_sha}" ]]
    then
      continue
    fi
    candidate_canonical="$(cd "${candidate}" 2>/dev/null && pwd -P || true)"
    if [[ -L "${candidate}" || ! -d "${candidate}" ||
          "${candidate_canonical}" != "${candidate}" ]]
    then
      echo "Preserving unsafe durable CI evidence ${candidate}" >&2
      continue
    fi

    echo "Removing validated evidence for merged pull request ${candidate_pull_request_number} exact head ${candidate_head_sha}"
    rm -rf -- "${candidate}"
    available_kb="$(available_disk_kb)"
    if [[ "${available_kb}" =~ ^[0-9]+$ ]] &&
       (( available_kb >= minimum_free_kb ))
    then
      break
    fi
  done < <(
    find "${evidence_root}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -name 'run-*-attempt-*' \
      -print0
  )
  rm -f -- "${status_cache}"
}

compact_recent_durable_ci_evidence() {
  local evidence_root_input="${EXAMPLE_CI_EVIDENCE_ROOT:-${home_dir}/.example-ci-evidence}"
  local evidence_root
  local candidate
  local candidate_size_kb
  local candidate_name
  local archive_path
  local checksum_path
  local temporary_archive
  local temporary_checksum
  local actual_checksum
  local compacted_size_kb

  if [[ "${IOS_RUNNER_COMPACT_DURABLE_EVIDENCE:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    echo "Skipping durable CI evidence compaction without explicit workflow authorization" >&2
    return
  fi
  if ! command -v tar >/dev/null 2>&1 ||
     ! command -v shasum >/dev/null 2>&1
  then
    echo "Durable CI evidence compaction requires tar and shasum" >&2
    return 1
  fi

  while [[ "${evidence_root_input}" != "/" && "${evidence_root_input}" == */ ]]; do
    evidence_root_input="${evidence_root_input%/}"
  done
  case "${evidence_root_input}" in
    /*) ;;
    *)
      echo "Refusing a non-absolute durable CI evidence root ${evidence_root_input}" >&2
      return 1
      ;;
  esac
  case "${evidence_root_input##*/}" in
    .example-ci-evidence|example-ci-evidence) ;;
    *)
      echo "Refusing a non-dedicated durable CI evidence root ${evidence_root_input}" >&2
      return 1
      ;;
  esac
  if [[ ! -e "${evidence_root_input}" ]]; then
    return
  fi
  if [[ -L "${evidence_root_input}" || ! -d "${evidence_root_input}" ]]; then
    echo "Refusing an unsafe durable CI evidence root ${evidence_root_input}" >&2
    return 1
  fi

  evidence_root="$(cd "${evidence_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${evidence_root}" || "${evidence_root}" == "/" ]]; then
    echo "Refusing an unsafe canonical durable CI evidence root ${evidence_root_input}" >&2
    return 1
  fi
  case "${evidence_root##*/}" in
    .example-ci-evidence|example-ci-evidence) ;;
    *)
      echo "Refusing a non-dedicated canonical CI evidence root ${evidence_root}" >&2
      return 1
      ;;
  esac

  echo "Compacting recent durable CI evidence until ${minimum_free_kb} KB is available"
  while IFS=$'\t' read -r candidate_size_kb candidate; do
    available_kb="$(available_disk_kb)"
    if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
      echo "Unable to determine free disk space during evidence compaction" >&2
      return 1
    fi
    if (( available_kb >= minimum_free_kb )); then
      break
    fi
    if [[ -z "${candidate}" || ! -d "${candidate}" || -L "${candidate}" ]]; then
      continue
    fi
    if [[ "$(cd "${candidate}" 2>/dev/null && pwd -P || true)" != "${candidate}" ]]; then
      echo "Refusing non-canonical durable CI evidence directory ${candidate}" >&2
      return 1
    fi

    candidate_name="${candidate##*/}"
    archive_path="${candidate}/evidence-fallback.tar.gz"
    checksum_path="${candidate}/evidence-fallback.tar.gz.sha256"
    temporary_archive="${evidence_root}/.${candidate_name}.compact.${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}.$$.tar.gz"
    temporary_checksum="${temporary_archive}.sha256"

    if [[ ! -f "${archive_path}" ]]; then
      if ! validate_durable_ci_evidence "${candidate}"; then
        echo "Refusing to compact invalid durable CI evidence ${candidate_name}" >&2
        return 1
      fi
      echo "Compacting ${candidate_name} (${candidate_size_kb} KB)"
      rm -f -- "${temporary_archive}" "${temporary_checksum}"
      if ! tar -czf "${temporary_archive}" -C "${evidence_root}" "${candidate_name}"; then
        rm -f -- "${temporary_archive}" "${temporary_checksum}"
        echo "Could not stage compacted durable CI evidence ${candidate_name}; preserving it and continuing authorized cleanup" >&2
        break
      fi
      if ! tar -tzf "${temporary_archive}" >/dev/null; then
        rm -f -- "${temporary_archive}" "${temporary_checksum}"
        echo "Staged durable CI evidence is unreadable for ${candidate_name}; preserving the original and continuing authorized cleanup" >&2
        break
      fi
      actual_checksum="$(shasum -a 256 "${temporary_archive}" | awk '{print $1}')"
      printf '%s  evidence-fallback.tar.gz\n' "${actual_checksum}" > "${temporary_checksum}"
      chmod 600 "${temporary_archive}" "${temporary_checksum}"
      mv "${temporary_archive}" "${archive_path}"
      mv "${temporary_checksum}" "${checksum_path}"
    fi

    if ! validate_compacted_durable_ci_evidence "${candidate}"; then
      echo "Refusing to remove uncompressed evidence after validation failed for ${candidate_name}" >&2
      return 1
    fi

    find "${candidate}" \
      -mindepth 1 \
      -maxdepth 1 \
      ! -name 'evidence-fallback.tar.gz' \
      ! -name 'evidence-fallback.tar.gz.sha256' \
      ! -name 'provenance.json' \
      -exec rm -rf -- {} +
    chmod 600 "${archive_path}" "${checksum_path}"
    compacted_size_kb="$(du -sk "${candidate}" | awk '{print $1}')"
    echo "Compacted ${candidate_name} from ${candidate_size_kb} KB to ${compacted_size_kb} KB"
  done < <(
    find "${evidence_root}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -name 'run-*-attempt-*' \
      -exec du -sk {} + 2>/dev/null |
      sort -nr
  )
}

clear_disposable_cache_contents() {
  local directory

  for directory in "${disposable_cache_roots[@]}"; do
    if [[ -L "${directory}" ]]; then
      echo "Refusing to clear symlinked disposable cache ${directory}" >&2
      return 1
    fi
    if [[ ! -d "${directory}" ]]; then
      continue
    fi

    echo "Clearing disposable cache ${directory}"
    if ! find "${directory}" \
      -mindepth 1 \
      -maxdepth 1 \
      -exec rm -rf -- {} +
    then
      echo "Disposable cache changed while clearing ${directory}; final capacity check will decide" >&2
    fi
  done
}

remove_expired_actions_runner_diagnostics() {
  local retention_hours="${IOS_RUNNER_DIAGNOSTIC_RETENTION_HOURS:-72}"
  local runner_work_root="${runner_temp%/*}"
  local runner_root
  local diagnostic_root_input
  local diagnostic_root

  if [[ "${IOS_RUNNER_RECLAIM_RUNNER_DIAGNOSTICS:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    return
  fi
  if [[ ! "${retention_hours}" =~ ^[1-9][0-9]*$ ]] ||
     (( retention_hours > 720 ))
  then
    echo "IOS_RUNNER_DIAGNOSTIC_RETENTION_HOURS must be an integer from 1 through 720" >&2
    return 1
  fi
  if [[ "${runner_temp##*/}" != "_temp" ||
        "${runner_work_root##*/}" != "_work" ]]
  then
    echo "Skipping runner diagnostic cleanup for unrecognized RUNNER_TEMP=${runner_temp}" >&2
    return
  fi

  runner_root="${runner_work_root%/*}"
  diagnostic_root_input="${runner_root}/_diag"
  if [[ ! -e "${diagnostic_root_input}" ]]; then
    return
  fi
  if [[ -L "${diagnostic_root_input}" || ! -d "${diagnostic_root_input}" ]]; then
    echo "Refusing to clear unsafe Actions runner diagnostic root ${diagnostic_root_input}" >&2
    return 1
  fi
  diagnostic_root="$(cd "${diagnostic_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ "${diagnostic_root}" != "${diagnostic_root_input}" ]]; then
    echo "Refusing non-canonical Actions runner diagnostic root ${diagnostic_root_input}" >&2
    return 1
  fi

  echo "Pruning Actions runner diagnostics older than ${retention_hours} hours from ${diagnostic_root}"
  if ! find "${diagnostic_root}" \
    -mindepth 1 \
    -maxdepth 1 \
    -type f \
    \( \
      -name 'Runner_????????-??????-utc.log' \
      -o -name 'Worker_????????-??????-utc.log' \
    \) \
    -mmin "+$((retention_hours * 60))" \
    -exec rm -f -- {} +
  then
    echo "Actions runner diagnostics changed while pruning; final capacity check will decide" >&2
  fi
}

remove_expired_actions_gcloud_tool_cache() {
  local runner_work_root="$1"
  local active_arch="$2"
  local retention_days="${IOS_RUNNER_GCLOUD_TOOL_RETENTION_DAYS:-7}"
  local gcloud_root="${runner_work_root}/_tool/gcloud"
  local gcloud_root_canonical
  local candidate
  local candidate_name
  local candidate_canonical
  local candidate_arch_root
  local candidate_arch_canonical
  local candidate_version_file
  local candidate_complete_marker
  local candidate_binary
  local recorded_version

  if [[ "${IOS_RUNNER_RECLAIM_GCLOUD_TOOL_CACHE:-}" != "1" ]]; then
    return
  fi
  if [[ ! "${retention_days}" =~ ^[1-9][0-9]*$ ]] ||
     (( retention_days > 30 ))
  then
    echo "IOS_RUNNER_GCLOUD_TOOL_RETENTION_DAYS must be an integer from 1 through 30" >&2
    return 1
  fi
  if [[ ! -e "${gcloud_root}" ]]; then
    return
  fi
  if [[ -L "${gcloud_root}" || ! -d "${gcloud_root}" ]]; then
    echo "Preserving unsafe Actions gcloud tool root" >&2
    return 1
  fi
  gcloud_root_canonical="$(cd "${gcloud_root}" 2>/dev/null && pwd -P || true)"
  if [[ "${gcloud_root_canonical}" != "${gcloud_root}" ]]; then
    echo "Preserving non-canonical Actions gcloud tool root" >&2
    return 1
  fi

  while IFS= read -r -d '' candidate; do
    candidate_name="${candidate##*/}"
    if [[ ! "${candidate_name}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      continue
    fi
    candidate_arch_root="${candidate}/${active_arch}"
    candidate_version_file="${candidate_arch_root}/VERSION"
    candidate_complete_marker="${candidate}/${active_arch}.complete"
    candidate_binary="${candidate_arch_root}/bin/gcloud"
    if [[ -L "${candidate}" || ! -d "${candidate}" ||
          -L "${candidate_arch_root}" || ! -d "${candidate_arch_root}" ||
          -L "${candidate_arch_root}/bin" || ! -d "${candidate_arch_root}/bin" ||
          -L "${candidate_binary}" || ! -x "${candidate_binary}" ||
          -L "${candidate_version_file}" || ! -f "${candidate_version_file}" ||
          -L "${candidate_complete_marker}" || ! -f "${candidate_complete_marker}" ]]
    then
      echo "Preserving incomplete inactive gcloud tool cache ${candidate_name}" >&2
      continue
    fi
    candidate_canonical="$(cd "${candidate}" 2>/dev/null && pwd -P || true)"
    candidate_arch_canonical="$(cd "${candidate_arch_root}" 2>/dev/null && pwd -P || true)"
    if [[ "${candidate_canonical}" != "${candidate}" ||
          "${candidate_arch_canonical}" != "${candidate_arch_root}" ]]
    then
      echo "Preserving non-canonical inactive gcloud tool cache ${candidate_name}" >&2
      continue
    fi
    recorded_version="$(tr -d '\r\n' < "${candidate_version_file}")"
    if [[ "${recorded_version}" != "${candidate_name}" ]]; then
      echo "Preserving gcloud tool cache ${candidate_name} with mismatched VERSION marker" >&2
      continue
    fi
    if pgrep -f "${candidate}/" >/dev/null 2>&1; then
      echo "Preserving inactive gcloud tool cache ${candidate_name} while a process owns it" >&2
      continue
    fi

    echo "Removing inactive gcloud tool cache ${candidate_name}"
    rm -rf -- "${candidate}"
  done < <(
    find "${gcloud_root}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -mtime +"${retention_days}" \
      -print0
  )
}

remove_expired_actions_runner_tooling() {
  local retention_days="${IOS_RUNNER_ACTIONS_TOOLING_RETENTION_DAYS:-7}"
  local update_retention_minutes="${IOS_RUNNER_ACTIONS_UPDATE_RETENTION_MINUTES:-360}"
  local configured_runner_root_input="${EXAMPLE_ACTIONS_RUNNER_ROOT:-}"
  local active_node_version="${IOS_RUNNER_ACTIVE_NODE_TOOL_VERSION:-}"
  local active_node_arch="${IOS_RUNNER_ACTIVE_NODE_TOOL_ARCH:-}"
  local runner_work_root="${runner_temp%/*}"
  local inferred_runner_root="${runner_work_root%/*}"
  local workspace_input="${RUNNER_WORKSPACE:-}"
  local expected_workspace_name="${EXAMPLE_ACTIONS_RUNNER_WORKSPACE_NAME:-}"
  local workspace
  local configured_runner_root
  local active_bin_link
  local active_externals_link
  local active_bin_target
  local active_externals_target
  local active_runner_version
  local active_externals_version
  local candidate
  local candidate_name
  local candidate_version
  local candidate_externals
  local candidate_archive
  local candidate_canonical
  local candidate_externals_canonical
  local update_root
  local update_canonical
  local update_version
  local node_root
  local node_root_canonical
  local active_node_root
  local node_candidate
  local node_candidate_name
  local node_candidate_canonical
  local node_arch_root
  local node_arch_canonical

  if [[ "${IOS_RUNNER_RECLAIM_ACTIONS_TOOLING:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    return
  fi
  if [[ ! "${retention_days}" =~ ^[1-9][0-9]*$ ]] ||
     (( retention_days > 30 ))
  then
    echo "IOS_RUNNER_ACTIONS_TOOLING_RETENTION_DAYS must be an integer from 1 through 30" >&2
    return 1
  fi
  if [[ ! "${update_retention_minutes}" =~ ^[1-9][0-9]*$ ]] ||
     (( update_retention_minutes > 10080 ))
  then
    echo "IOS_RUNNER_ACTIONS_UPDATE_RETENTION_MINUTES must be an integer from 1 through 10080" >&2
    return 1
  fi
  if [[ ! "${active_node_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "IOS_RUNNER_ACTIVE_NODE_TOOL_VERSION must be an exact semantic version" >&2
    return 1
  fi
  case "${active_node_arch}" in
    arm64|x64) ;;
    *)
      echo "IOS_RUNNER_ACTIVE_NODE_TOOL_ARCH must be arm64 or x64" >&2
      return 1
      ;;
  esac
  if [[ ! "${expected_workspace_name}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ||
        "${expected_workspace_name}" == "." ||
        "${expected_workspace_name}" == ".." ]]
  then
    echo "EXAMPLE_ACTIONS_RUNNER_WORKSPACE_NAME must be a safe workspace directory name" >&2
    return 1
  fi
  if [[ "${runner_temp##*/}" != "_temp" ||
        "${runner_work_root##*/}" != "_work" ]]
  then
    echo "Refusing Actions runner tooling cleanup for unrecognized RUNNER_TEMP=${runner_temp}" >&2
    return 1
  fi
  if [[ -z "${configured_runner_root_input}" ||
        "${configured_runner_root_input}" != /* ||
        -L "${configured_runner_root_input}" ||
        ! -d "${configured_runner_root_input}" ]]
  then
    echo "Refusing unsafe configured Actions runner root ${configured_runner_root_input}" >&2
    return 1
  fi

  configured_runner_root="$(cd "${configured_runner_root_input}" 2>/dev/null && pwd -P || true)"
  inferred_runner_root="$(cd "${inferred_runner_root}" 2>/dev/null && pwd -P || true)"
  runner_work_root="$(cd "${runner_work_root}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${configured_runner_root}" ||
        "${configured_runner_root}" == "/" ||
        "${configured_runner_root}" != "${inferred_runner_root}" ||
        "${runner_work_root}" != "${configured_runner_root}/_work" ]]
  then
    echo "Refusing Actions runner tooling cleanup outside the current runner root" >&2
    return 1
  fi
  if [[ -z "${workspace_input}" ||
        -L "${workspace_input}" ||
        ! -d "${workspace_input}" ]]
  then
    echo "Refusing unsafe RUNNER_WORKSPACE=${workspace_input}" >&2
    return 1
  fi
  workspace="$(cd "${workspace_input}" 2>/dev/null && pwd -P || true)"
  if [[ "${workspace}" != "${runner_work_root}/${expected_workspace_name}" ]]; then
    echo "Refusing Actions runner tooling cleanup for mismatched RUNNER_WORKSPACE=${workspace_input}" >&2
    return 1
  fi
  if ! command -v pgrep >/dev/null 2>&1; then
    echo "Preserving Actions runner tooling because pgrep is unavailable" >&2
    return
  fi

  active_bin_link="${configured_runner_root}/bin"
  active_externals_link="${configured_runner_root}/externals"
  if [[ ! -L "${active_bin_link}" || ! -L "${active_externals_link}" ]]; then
    echo "Refusing Actions runner tooling cleanup without active runner symlinks" >&2
    return 1
  fi
  active_bin_target="$(cd "${active_bin_link}" 2>/dev/null && pwd -P || true)"
  active_externals_target="$(cd "${active_externals_link}" 2>/dev/null && pwd -P || true)"
  if [[ "${active_bin_target}" != "${configured_runner_root}"/bin.* ||
        "${active_externals_target}" != "${configured_runner_root}"/externals.* ]]
  then
    echo "Refusing Actions runner tooling cleanup for out-of-root active targets" >&2
    return 1
  fi
  active_runner_version="${active_bin_target##*/bin.}"
  active_externals_version="${active_externals_target##*/externals.}"
  if [[ ! "${active_runner_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ||
        "${active_runner_version}" != "${active_externals_version}" ||
        ! -x "${active_bin_target}/Runner.Listener" ||
        ! -x "${active_bin_target}/Runner.Worker" ||
        ! -x "${active_externals_target}/node24/bin/node" ]]
  then
    echo "Refusing Actions runner tooling cleanup for invalid active runner markers" >&2
    return 1
  fi

  while IFS= read -r -d '' candidate; do
    candidate_name="${candidate##*/}"
    if [[ ! "${candidate_name}" =~ ^bin\.([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
      continue
    fi
    candidate_version="${BASH_REMATCH[1]}"
    if [[ "${candidate_version}" == "${active_runner_version}" ]]; then
      continue
    fi
    candidate_externals="${configured_runner_root}/externals.${candidate_version}"
    candidate_archive="${configured_runner_root}/actions-runner-osx-arm64-${candidate_version}.tar.gz"
    if [[ -L "${candidate}" || ! -d "${candidate}" ||
          -L "${candidate_externals}" || ! -d "${candidate_externals}" ||
          -L "${candidate_archive}" || ! -f "${candidate_archive}" ||
          ! -x "${candidate}/Runner.Listener" ||
          ! -x "${candidate}/Runner.Worker" ||
          ! -x "${candidate_externals}/node24/bin/node" ]]
    then
      echo "Preserving incomplete inactive Actions runner ${candidate_version}" >&2
      continue
    fi
    candidate_canonical="$(cd "${candidate}" 2>/dev/null && pwd -P || true)"
    candidate_externals_canonical="$(cd "${candidate_externals}" 2>/dev/null && pwd -P || true)"
    if [[ "${candidate_canonical}" != "${candidate}" ||
          "${candidate_externals_canonical}" != "${candidate_externals}" ]]
    then
      echo "Preserving non-canonical inactive Actions runner ${candidate_version}" >&2
      continue
    fi
    if [[ -z "$(find "${candidate_externals}" -maxdepth 0 -type d -mtime +"${retention_days}" -print -quit)" ||
          -z "$(find "${candidate_archive}" -maxdepth 0 -type f -mtime +"${retention_days}" -print -quit)" ]]
    then
      echo "Preserving recent inactive Actions runner ${candidate_version}" >&2
      continue
    fi
    if pgrep -f "${candidate}/" >/dev/null 2>&1 ||
       pgrep -f "${candidate_externals}/" >/dev/null 2>&1
    then
      echo "Preserving inactive Actions runner ${candidate_version} while a process owns it" >&2
      continue
    fi

    echo "Removing inactive Actions runner ${candidate_version}"
    rm -rf -- "${candidate}" "${candidate_externals}"
    rm -f -- "${candidate_archive}"
  done < <(
    find "${configured_runner_root}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -name 'bin.*' \
      -mtime +"${retention_days}" \
      -print0
  )

  update_root="${runner_work_root}/_update"
  if [[ -e "${update_root}" ]]; then
    if [[ -L "${update_root}" || ! -d "${update_root}" ]]; then
      echo "Preserving unsafe Actions runner update staging" >&2
    else
      update_canonical="$(cd "${update_root}" 2>/dev/null && pwd -P || true)"
      if [[ "${update_canonical}" != "${update_root}" ||
            ! -x "${update_root}/bin/Runner.Listener" ||
            -L "${update_root}/bin/Runner.Listener" ||
            ! -x "${update_root}/run.sh" ||
            -L "${update_root}/run.sh" ||
            ! -x "${update_root}/externals/node24/bin/node" ||
            -z "$(find "${update_root}" -maxdepth 0 -type d -mmin +"${update_retention_minutes}" -print -quit)" ]]
      then
        echo "Preserving unproven or recent Actions runner update staging" >&2
      elif pgrep -f "${update_root}/" >/dev/null 2>&1 ||
           pgrep -f "${runner_work_root}/_update.sh" >/dev/null 2>&1
      then
        echo "Preserving completed Actions runner update staging while a process owns it" >&2
      else
        update_version="$(run_with_timeout 10 "${update_root}/bin/Runner.Listener" --version 2>/dev/null || true)"
        if [[ "${update_version}" == "${active_runner_version}" ]]; then
          echo "Removing completed Actions runner ${update_version} update staging"
          rm -rf -- "${update_root}"
        else
          echo "Preserving Actions runner update staging with mismatched version" >&2
        fi
      fi
    fi
  fi

  # The iOS matrix never invokes gcloud. On the explicitly authorized runner,
  # reclaim only aged setup-gcloud cache entries whose completion, version,
  # path, architecture, and process-ownership checks all pass.
  remove_expired_actions_gcloud_tool_cache \
    "${runner_work_root}" \
    "${active_node_arch}"

  node_root="${runner_work_root}/_tool/node"
  if [[ ! -e "${node_root}" ]]; then
    return
  fi
  if [[ -L "${node_root}" || ! -d "${node_root}" ]]; then
    echo "Preserving unsafe Actions Node tool root" >&2
    return 1
  fi
  node_root_canonical="$(cd "${node_root}" 2>/dev/null && pwd -P || true)"
  if [[ "${node_root_canonical}" != "${node_root}" ]]; then
    echo "Preserving non-canonical Actions Node tool root" >&2
    return 1
  fi
  active_node_root="${node_root}/${active_node_version}"
  if [[ -L "${active_node_root}" ||
        ! -x "${active_node_root}/${active_node_arch}/bin/node" ||
        ! -f "${active_node_root}/${active_node_arch}.complete" ||
        -L "${active_node_root}/${active_node_arch}.complete" ]]
  then
    echo "Preserving Actions Node tool caches without valid active-version markers" >&2
    return
  fi

  while IFS= read -r -d '' node_candidate; do
    node_candidate_name="${node_candidate##*/}"
    if [[ ! "${node_candidate_name}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ||
          "${node_candidate_name}" == "${active_node_version}" ]]
    then
      continue
    fi
    node_arch_root="${node_candidate}/${active_node_arch}"
    if [[ -L "${node_candidate}" || ! -d "${node_candidate}" ||
          -L "${node_arch_root}" || ! -d "${node_arch_root}" ||
          ! -x "${node_arch_root}/bin/node" ||
          ! -f "${node_candidate}/${active_node_arch}.complete" ||
          -L "${node_candidate}/${active_node_arch}.complete" ]]
    then
      echo "Preserving incomplete inactive Node tool cache ${node_candidate_name}" >&2
      continue
    fi
    node_candidate_canonical="$(cd "${node_candidate}" 2>/dev/null && pwd -P || true)"
    node_arch_canonical="$(cd "${node_arch_root}" 2>/dev/null && pwd -P || true)"
    if [[ "${node_candidate_canonical}" != "${node_candidate}" ||
          "${node_arch_canonical}" != "${node_arch_root}" ]]
    then
      echo "Preserving non-canonical inactive Node tool cache ${node_candidate_name}" >&2
      continue
    fi
    if pgrep -f "${node_candidate}/" >/dev/null 2>&1; then
      echo "Preserving inactive Node tool cache ${node_candidate_name} while a process owns it" >&2
      continue
    fi

    echo "Removing inactive Node tool cache ${node_candidate_name}"
    rm -rf -- "${node_candidate}"
  done < <(
    find "${node_root}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -mtime +"${retention_days}" \
      -print0
  )
}

clear_ci_xcode_archive_contents() {
  local archive_root_input="${home_dir}/Library/Developer/Xcode/Archives"
  local archive_root

  if [[ "${IOS_RUNNER_RECLAIM_XCODE_ARCHIVES:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    echo "Skipping Xcode archive cleanup without dedicated runner authorization" >&2
    return
  fi
  if [[ -L "${archive_root_input}" ]]; then
    echo "Refusing to clear symlinked Xcode archive root ${archive_root_input}" >&2
    return 1
  fi
  if [[ ! -d "${archive_root_input}" ]]; then
    return
  fi

  archive_root="$(cd "${archive_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${archive_root}" || "${archive_root}" != "${archive_root_input}" ]]; then
    echo "Refusing to clear non-canonical Xcode archive root ${archive_root_input}" >&2
    return 1
  fi

  echo "Clearing CI Xcode archives ${archive_root}"
  if ! find "${archive_root}" \
    -mindepth 1 \
    -maxdepth 1 \
    -exec rm -rf -- {} +
  then
    echo "Xcode archives changed while clearing; final capacity check will decide" >&2
  fi
}

clear_ci_xcode_device_support_contents() {
  local device_support_root_input="${home_dir}/Library/Developer/Xcode/iOS DeviceSupport"
  local device_support_root

  if [[ "${IOS_RUNNER_RECLAIM_XCODE_DEVICE_SUPPORT:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    echo "Skipping Xcode device support cleanup without dedicated runner authorization" >&2
    return
  fi
  if [[ -L "${device_support_root_input}" ]]; then
    echo "Refusing to clear symlinked Xcode device support root ${device_support_root_input}" >&2
    return 1
  fi
  if [[ ! -d "${device_support_root_input}" ]]; then
    return
  fi

  device_support_root="$(cd "${device_support_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${device_support_root}" || "${device_support_root}" != "${device_support_root_input}" ]]; then
    echo "Refusing to clear non-canonical Xcode device support root ${device_support_root_input}" >&2
    return 1
  fi

  echo "Clearing CI Xcode device support ${device_support_root}"
  if ! find "${device_support_root}" \
    -mindepth 1 \
    -maxdepth 1 \
    -exec rm -rf -- {} +
  then
    echo "Xcode device support changed while clearing; final capacity check will decide" >&2
  fi
}

remove_stale_xctest_device_clones() {
  local xctest_root_input="${home_dir}/Library/Developer/XCTestDevices"
  local xctest_root
  local candidate
  local candidate_name

  if [[ "${IOS_RUNNER_RECLAIM_XCTEST_DEVICES:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    echo "Skipping XCTest device cleanup without dedicated runner authorization" >&2
    return
  fi
  if [[ -L "${xctest_root_input}" ]]; then
    echo "Refusing to clear symlinked XCTest device root ${xctest_root_input}" >&2
    return 1
  fi
  if [[ ! -d "${xctest_root_input}" ]]; then
    return
  fi

  xctest_root="$(cd "${xctest_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${xctest_root}" || "${xctest_root}" != "${xctest_root_input}" ]]; then
    echo "Refusing to clear non-canonical XCTest device root ${xctest_root_input}" >&2
    return 1
  fi

  while IFS= read -r -d '' candidate; do
    candidate_name="${candidate##*/}"
    if [[ ! "${candidate_name}" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]; then
      continue
    fi
    if [[ ! -d "${candidate}" || -L "${candidate}" ]]; then
      continue
    fi

    echo "Removing stale XCTest device clone ${candidate_name}"
    rm -rf -- "${candidate}"
  done < <(
    find "${xctest_root}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -mmin +1440 \
      -print0
  )
}

is_proven_example_derived_data_root() {
  local derived_data_root="$1"
  local info_plist="${derived_data_root}/info.plist"
  local build_root="${derived_data_root}/Build"
  local products_root="${build_root}/Products"

  if [[ -L "${derived_data_root}" || ! -d "${derived_data_root}" ||
        -L "${info_plist}" || ! -f "${info_plist}" ||
        -L "${build_root}" || ! -d "${build_root}" ||
        -L "${products_root}" || ! -d "${products_root}" ]]
  then
    return 1
  fi

  python3 - "${info_plist}" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as plist_handle:
    payload = plistlib.load(plist_handle)
workspace_path = payload.get("WorkspacePath")
if not isinstance(workspace_path, str):
    raise SystemExit(1)
normalized_path = workspace_path.replace("\\", "/")
if not normalized_path.endswith("/ios/example-ios.xcodeproj"):
    raise SystemExit(1)
PY
}

is_proven_example_xcresult_bundle() {
  local result_bundle="$1"
  local info_plist="${result_bundle}/Info.plist"
  local data_root="${result_bundle}/Data"
  local data_record
  local reference_record
  local result_bundle_canonical

  if [[ -L "${result_bundle}" || ! -d "${result_bundle}" ||
        -L "${data_root}" || ! -d "${data_root}" ]]
  then
    return 1
  fi
  result_bundle_canonical="$(cd "${result_bundle}" 2>/dev/null && pwd -P || true)"
  if [[ "${result_bundle_canonical}" != "${result_bundle}" ]]; then
    return 1
  fi
  if [[ ! -e "${info_plist}" ]]; then
    data_record="$(
      find "${data_root}" \
        -mindepth 1 \
        -maxdepth 1 \
        -type f \
        -size +0c \
        -name 'data.[0-9]*~*' \
        -print \
        -quit
    )"
    reference_record="$(
      find "${data_root}" \
        -mindepth 1 \
        -maxdepth 1 \
        -type f \
        -size +0c \
        -name 'refs.[0-9]*~*' \
        -print \
        -quit
    )"
    if [[ -n "${data_record}" && -n "${reference_record}" ]]; then
      return 0
    fi
    return 1
  fi
  if [[ -L "${info_plist}" || ! -f "${info_plist}" ]]; then
    return 1
  fi

  python3 - "${info_plist}" <<'PY'
import plistlib
import sys

try:
    with open(sys.argv[1], "rb") as plist_handle:
        payload = plistlib.load(plist_handle)
except (OSError, ValueError, plistlib.InvalidFileException):
    raise SystemExit(1)

root_id = payload.get("rootId")
storage = payload.get("storage")
version = payload.get("version")
if not isinstance(root_id, dict) or not isinstance(root_id.get("hash"), str):
    raise SystemExit(1)
if not root_id["hash"]:
    raise SystemExit(1)
if not isinstance(storage, dict) or storage.get("backend") not in {
    "fileBacked",
    "fileBacked2",
}:
    raise SystemExit(1)
if not isinstance(version, dict) or not isinstance(version.get("major"), int):
    raise SystemExit(1)
PY
}

is_proven_example_screenshot_manifest() {
  local manifest="$1"

  if [[ -L "${manifest}" || ! -f "${manifest}" ]]; then
    return 1
  fi

  python3 - "${manifest}" <<'PY'
import json
import os
import sys

manifest_path = sys.argv[1]
try:
    with open(manifest_path, encoding="utf-8") as manifest_handle:
        payload = json.load(manifest_handle)
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit(1)

if not isinstance(payload, list):
    raise SystemExit(1)
manifest_root = os.path.dirname(manifest_path)
for test_result in payload:
    if not isinstance(test_result, dict):
        continue
    attachments = test_result.get("attachments")
    if not isinstance(attachments, list):
        continue
    for attachment in attachments:
        if not isinstance(attachment, dict):
            continue
        exported_name = attachment.get("exportedFileName")
        if not isinstance(exported_name, str) or not exported_name:
            continue
        if os.path.basename(exported_name) != exported_name:
            continue
        exported_path = os.path.join(manifest_root, exported_name)
        if not os.path.islink(exported_path) and os.path.isfile(exported_path):
            raise SystemExit(0)
raise SystemExit(1)
PY
}

is_proven_example_test_evidence_root() {
  local candidate="$1"
  local proof

  while IFS= read -r -d '' proof; do
    if is_proven_example_xcresult_bundle "${proof}"; then
      return 0
    fi
  done < <(
    find "${candidate}" \
      -maxdepth 4 \
      -type d \
      -name '*.xcresult' \
      -print0
  )

  while IFS= read -r -d '' proof; do
    if is_proven_example_screenshot_manifest "${proof}"; then
      return 0
    fi
  done < <(
    find "${candidate}" \
      -mindepth 1 \
      -maxdepth 4 \
      -type f \
      -name 'manifest.json' \
      -print0
  )

  return 1
}

remove_expired_local_ios_test_evidence() {
  local artifact_root="$1"
  local retention_hours="${IOS_RUNNER_LOCAL_IOS_EVIDENCE_RETENTION_HOURS:-6}"
  local candidate
  local candidate_name
  local candidate_canonical
  local candidate_inventory
  local cleanup_failed=0
  local cutoff_reference
  local recent_descendant

  if [[ ! "${retention_hours}" =~ ^[1-9][0-9]*$ ]] ||
     (( retention_hours > 168 ))
  then
    echo "IOS_RUNNER_LOCAL_IOS_EVIDENCE_RETENTION_HOURS must be an integer from 1 through 168" >&2
    return 1
  fi

  cutoff_reference="$(mktemp "${runner_temp}/example-local-ios-evidence-cutoff.XXXXXX")"
  candidate_inventory="$(mktemp "${runner_temp}/example-local-ios-evidence-inventory.XXXXXX")"
  if ! python3 - "${cutoff_reference}" "${retention_hours}" <<'PY'
import os
import sys
import time

reference_path, retention_hours = sys.argv[1:]
cutoff = time.time() - int(retention_hours) * 60 * 60
os.utime(reference_path, (cutoff, cutoff), follow_symlinks=False)
PY
  then
    rm -f -- "${cutoff_reference}" "${candidate_inventory}"
    echo "Could not establish the local iOS evidence retention cutoff" >&2
    return 1
  fi
  if ! find "${artifact_root}" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    \( \
      -name 'example-*' \
      -o -name 'codex-[0-9]*-attempt[0-9]*' \
      -o -name 'codex-[0-9]*-run[0-9]*' \
    \) \
    ! -newer "${cutoff_reference}" \
    -print0 > "${candidate_inventory}"
  then
    rm -f -- "${cutoff_reference}" "${candidate_inventory}"
    echo "Could not inventory expired local iOS evidence" >&2
    return 1
  fi

  echo "Pruning generated local iOS evidence older than ${retention_hours} hours from ${artifact_root}"
  while IFS= read -r -d '' candidate; do
    candidate_name="${candidate##*/}"
    if [[ ! "${candidate_name}" =~ ^example-[A-Za-z0-9][A-Za-z0-9._-]*$ ]] &&
       [[ ! "${candidate_name}" =~ ^codex-[0-9]+-(attempt[0-9]+|run[0-9]+)$ ]]
    then
      continue
    fi
    if [[ -L "${candidate}" || ! -d "${candidate}" ]]; then
      continue
    fi
    candidate_canonical="$(cd "${candidate}" 2>/dev/null && pwd -P || true)"
    if [[ "${candidate_canonical}" != "${candidate}" ]]; then
      echo "Preserving non-canonical local iOS evidence ${candidate}" >&2
      continue
    fi
    if ! recent_descendant="$(
      find "${candidate}" \
        -mindepth 1 \
        -newer "${cutoff_reference}" \
        -print \
        -quit
    )"; then
      echo "Could not measure local iOS evidence contents for ${candidate}" >&2
      cleanup_failed=1
      break
    fi
    if [[ -n "${recent_descendant}" ]]; then
      echo "Preserving recently updated local iOS evidence ${candidate}"
      continue
    fi
    if [[ "${candidate_name}" =~ ^codex- ]]; then
      if ! is_proven_example_xcresult_bundle \
        "${candidate}/example-ios-tests.xcresult"
      then
        continue
      fi
    elif ! is_proven_example_test_evidence_root "${candidate}"; then
      continue
    fi

    echo "Removing expired generated local iOS evidence ${candidate}"
    if ! rm -rf -- "${candidate}"; then
      echo "Could not remove expired generated local iOS evidence ${candidate}" >&2
      cleanup_failed=1
      break
    fi
  done < "${candidate_inventory}"
  rm -f -- "${cutoff_reference}" "${candidate_inventory}"
  if (( cleanup_failed != 0 )); then
    return 1
  fi
}

remove_expired_example_tool_staging() {
  local artifact_root="$1"
  local retention_hours="${IOS_RUNNER_LOCAL_TOOL_STAGING_RETENTION_HOURS:-6}"
  local cutoff_reference
  local candidate
  local candidate_name
  local candidate_canonical
  local recent_descendant
  local node_binary
  local fastlane_gemspec
  local fastlane_bundle

  if [[ ! "${retention_hours}" =~ ^[1-9][0-9]*$ ]] ||
     (( retention_hours > 168 ))
  then
    echo "IOS_RUNNER_LOCAL_TOOL_STAGING_RETENTION_HOURS must be an integer from 1 through 168" >&2
    return 1
  fi
  cutoff_reference="$(mktemp "${runner_temp}/example-tool-staging-cutoff.XXXXXX")"
  if ! python3 - "${cutoff_reference}" "${retention_hours}" <<'PY'
import os
import sys
import time

reference_path, retention_hours = sys.argv[1:]
cutoff = time.time() - int(retention_hours) * 60 * 60
os.utime(reference_path, (cutoff, cutoff), follow_symlinks=False)
PY
  then
    rm -f -- "${cutoff_reference}"
    echo "Could not establish the Example tool staging retention cutoff" >&2
    return 1
  fi

  echo "Pruning generated Example tool staging older than ${retention_hours} hours from ${artifact_root}"
  while IFS= read -r -d '' candidate; do
    candidate_name="${candidate##*/}"
    case "${candidate_name}" in
      example-github-runner|example-ios-beta-bundle) ;;
      *) continue ;;
    esac
    if [[ -L "${candidate}" || ! -d "${candidate}" ]]; then
      continue
    fi
    candidate_canonical="$(cd "${candidate}" 2>/dev/null && pwd -P || true)"
    if [[ "${candidate_canonical}" != "${candidate}" ]]; then
      continue
    fi
    if ! recent_descendant="$(
      find "${candidate}" \
        -mindepth 1 \
        -newer "${cutoff_reference}" \
        -print \
        -quit
    )"; then
      rm -f -- "${cutoff_reference}"
      echo "Could not measure Example tool staging contents for ${candidate}" >&2
      return 1
    fi
    if [[ -n "${recent_descendant}" ]]; then
      echo "Preserving recently updated Example tool staging ${candidate}"
      continue
    fi

    case "${candidate_name}" in
      example-github-runner)
        node_binary="${candidate}/runner/externals/node20/bin/node"
        if [[ -L "${candidate}/runner" ||
              -L "${candidate}/runner/externals" ||
              -L "${candidate}/runner/externals/node20" ||
              -L "${candidate}/runner/externals/node20/bin" ||
              -L "${node_binary}" ||
              ! -f "${node_binary}" ||
              ! -s "${node_binary}" ||
              ! -x "${node_binary}" ]]
        then
          continue
        fi
        ;;
      example-ios-beta-bundle)
        fastlane_gemspec="$(
          find "${candidate}/ruby" \
            -mindepth 3 \
            -maxdepth 3 \
            -type f \
            -name 'fastlane-[0-9]*.gemspec' \
            -print \
            -quit 2>/dev/null
        )"
        fastlane_bundle="$(
          find "${candidate}/ruby" \
            -mindepth 3 \
            -maxdepth 3 \
            -type d \
            -name 'fastlane-[0-9]*' \
            -print \
            -quit 2>/dev/null
        )"
        if [[ -z "${fastlane_gemspec}" || -L "${fastlane_gemspec}" ||
              -z "${fastlane_bundle}" || -L "${fastlane_bundle}" ]]
        then
          continue
        fi
        ;;
    esac

    echo "Removing expired generated Example tool staging ${candidate}"
    rm -rf -- "${candidate}"
  done < <(
    find "${artifact_root}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      \( \
        -name 'example-github-runner' \
        -o -name 'example-ios-beta-bundle' \
      \) \
      ! -newer "${cutoff_reference}" \
      -print0
  )
  rm -f -- "${cutoff_reference}"
}

remove_expired_local_ios_generated_artifacts() {
  local artifact_root_input="${EXAMPLE_LOCAL_IOS_ARTIFACT_ROOT:-}"
  local retention_days="${IOS_RUNNER_LOCAL_IOS_ARTIFACT_RETENTION_DAYS:-2}"
  local runner_work_root="${runner_temp%/*}"
  local artifact_root
  local candidate
  local candidate_name
  local candidate_canonical
  local candidate_inventory
  local cleanup_failed=0
  local cutoff_reference
  local recent_descendant
  local workspace_state
  local test_products
  local test_products_info
  local generated_artifact_proven=0

  if [[ "${IOS_RUNNER_RECLAIM_LOCAL_IOS_ARTIFACTS:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    return
  fi
  if [[ ! "${retention_days}" =~ ^[1-9][0-9]*$ ]] ||
     (( retention_days > 30 ))
  then
    echo "IOS_RUNNER_LOCAL_IOS_ARTIFACT_RETENTION_DAYS must be an integer from 1 through 30" >&2
    return 1
  fi
  if [[ "${runner_temp##*/}" != "_temp" ||
        "${runner_work_root##*/}" != "_work" ]]
  then
    echo "Skipping local iOS artifact cleanup for unrecognized RUNNER_TEMP=${runner_temp}" >&2
    return
  fi

  while [[ "${artifact_root_input}" != "/" && "${artifact_root_input}" == */ ]]; do
    artifact_root_input="${artifact_root_input%/}"
  done
  case "${artifact_root_input}" in
    /*) ;;
    *)
      echo "Refusing non-absolute local iOS artifact root ${artifact_root_input}" >&2
      return 1
      ;;
  esac
  case "${artifact_root_input##*/}" in
    tmp|example-local-ios-artifacts) ;;
    *)
      echo "Refusing non-dedicated local iOS artifact root ${artifact_root_input}" >&2
      return 1
      ;;
  esac
  if [[ ! -e "${artifact_root_input}" ]]; then
    return
  fi
  if [[ -L "${artifact_root_input}" || ! -d "${artifact_root_input}" ]]; then
    echo "Refusing unsafe local iOS artifact root ${artifact_root_input}" >&2
    return 1
  fi
  artifact_root="$(cd "${artifact_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${artifact_root}" || "${artifact_root}" == "/" ||
        "${artifact_root}" != "${artifact_root_input}" ]]
  then
    echo "Refusing non-canonical local iOS artifact root ${artifact_root_input}" >&2
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Local iOS artifact cleanup requires python3" >&2
    return 1
  fi

  cutoff_reference="$(mktemp "${runner_temp}/example-local-ios-cutoff.XXXXXX")"
  candidate_inventory="$(mktemp "${runner_temp}/example-local-ios-inventory.XXXXXX")"
  if ! python3 - "${cutoff_reference}" "${retention_days}" <<'PY'
import os
import sys
import time

reference_path, retention_days = sys.argv[1:]
cutoff = time.time() - int(retention_days) * 24 * 60 * 60
os.utime(reference_path, (cutoff, cutoff), follow_symlinks=False)
PY
  then
    rm -f -- "${cutoff_reference}" "${candidate_inventory}"
    echo "Could not establish the local iOS artifact retention cutoff" >&2
    return 1
  fi
  if ! find "${artifact_root}" \
    -mindepth 1 \
    -maxdepth 1 \
    -type d \
    \( \
      -name 'example-*' \
      -o -name 'budget-*' \
      -o -name 'pr[0-9]*-local.*' \
    \) \
    ! -newer "${cutoff_reference}" \
    -print0 > "${candidate_inventory}"
  then
    rm -f -- "${cutoff_reference}" "${candidate_inventory}"
    echo "Could not inventory expired local iOS artifacts" >&2
    return 1
  fi

  echo "Pruning generated local iOS artifacts older than ${retention_days} days from ${artifact_root}"
  while IFS= read -r -d '' candidate; do
    candidate_name="${candidate##*/}"
    if [[ ! "${candidate_name}" =~ ^example-[A-Za-z0-9][A-Za-z0-9._-]*$ ]] &&
       [[ ! "${candidate_name}" =~ ^budget-[A-Za-z0-9][A-Za-z0-9._-]*$ ]] &&
       [[ ! "${candidate_name}" =~ ^pr[0-9]+-local\.[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
    then
      continue
    fi
    if [[ -L "${candidate}" || ! -d "${candidate}" ]]; then
      continue
    fi
    candidate_canonical="$(cd "${candidate}" 2>/dev/null && pwd -P || true)"
    if [[ "${candidate_canonical}" != "${candidate}" ]]; then
      echo "Preserving non-canonical local iOS artifact ${candidate}" >&2
      continue
    fi
    workspace_state="${candidate}/SourcePackages/workspace-state.json"
    if [[ -L "${candidate}/SourcePackages" ||
          -L "${workspace_state}" ||
          ! -f "${workspace_state}" ]]
    then
      continue
    fi

    generated_artifact_proven=0
    while IFS= read -r -d '' test_products; do
      test_products_info="${test_products}/Info.plist"
      if [[ ! -L "${test_products}" &&
            ! -L "${test_products_info}" &&
            -f "${test_products_info}" ]]
      then
        generated_artifact_proven=1
        break
      fi
    done < <(
      find "${candidate}" \
        -mindepth 1 \
        -maxdepth 1 \
        -type d \
        -name 'example-ios*.xctestproducts' \
        -print0
    )
    if (( generated_artifact_proven == 0 )) &&
       { is_proven_example_derived_data_root "${candidate}" ||
         is_proven_example_derived_data_root "${candidate}/DerivedData"; }
    then
      generated_artifact_proven=1
    fi
    if (( generated_artifact_proven == 0 )); then
      continue
    fi

    if ! recent_descendant="$(
      find "${candidate}" \
        -mindepth 1 \
        -newer "${cutoff_reference}" \
        -print \
        -quit
    )"; then
      echo "Could not measure local iOS artifact contents for ${candidate}" >&2
      cleanup_failed=1
      break
    fi
    if [[ -n "${recent_descendant}" ]]; then
      echo "Preserving recently updated local iOS artifact ${candidate}"
      continue
    fi

    echo "Removing expired generated local iOS artifact ${candidate}"
    if ! rm -rf -- "${candidate}"; then
      echo "Could not remove expired generated local iOS artifact ${candidate}" >&2
      cleanup_failed=1
      break
    fi
  done < "${candidate_inventory}"
  rm -f -- "${cutoff_reference}" "${candidate_inventory}"
  if (( cleanup_failed != 0 )); then
    return 1
  fi
  remove_expired_example_tool_staging "${artifact_root}"
  remove_expired_local_ios_test_evidence "${artifact_root}"
}

remove_expired_xcodebuildmcp_example_artifacts() {
  local workspace_name="${IOS_RUNNER_XCODEBUILDMCP_EXAMPLE_WORKSPACE_NAME:-}"
  local retention_days="${IOS_RUNNER_XCODEBUILDMCP_RETENTION_DAYS:-14}"
  local workspaces_root_input="${home_dir}/Library/Developer/XcodeBuildMCP/workspaces"
  local workspaces_root
  local candidate
  local candidate_canonical
  local derived_data
  local result_bundles
  local derived_data_proof
  local result_bundle_proof
  local cutoff_reference
  local recent_descendant

  if [[ "${IOS_RUNNER_RECLAIM_XCODEBUILDMCP_EXAMPLE_ARTIFACTS:-}" != "1" ]] ||
     [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] ||
     [[ ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    return
  fi
  if [[ ! "${retention_days}" =~ ^[1-9][0-9]*$ ]] ||
     (( retention_days > 90 ))
  then
    echo "IOS_RUNNER_XCODEBUILDMCP_RETENTION_DAYS must be an integer from 1 through 90" >&2
    return 1
  fi
  if [[ ! "${workspace_name}" =~ ^example-app-[0-9a-f]{12}$ ]]; then
    echo "Refusing invalid XcodeBuildMCP Example workspace identity ${workspace_name}" >&2
    return 1
  fi
  if [[ ! -e "${workspaces_root_input}" ]]; then
    return
  fi
  if [[ -L "${workspaces_root_input}" || ! -d "${workspaces_root_input}" ]]; then
    echo "Refusing unsafe XcodeBuildMCP workspace root ${workspaces_root_input}" >&2
    return 1
  fi
  workspaces_root="$(cd "${workspaces_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ "${workspaces_root}" != "${workspaces_root_input}" ]]; then
    echo "Refusing non-canonical XcodeBuildMCP workspace root ${workspaces_root_input}" >&2
    return 1
  fi

  candidate="${workspaces_root}/${workspace_name}"
  if [[ ! -e "${candidate}" ]]; then
    return
  fi
  if [[ -L "${candidate}" || ! -d "${candidate}" ]]; then
    echo "Refusing unsafe XcodeBuildMCP Example workspace ${candidate}" >&2
    return 1
  fi
  candidate_canonical="$(cd "${candidate}" 2>/dev/null && pwd -P || true)"
  if [[ "${candidate_canonical%/*}" != "${workspaces_root}" ||
        "${candidate_canonical##*/}" != "${workspace_name}" ]]
  then
    echo "Refusing non-canonical XcodeBuildMCP Example workspace ${candidate}" >&2
    return 1
  fi

  derived_data="${candidate}/DerivedData"
  result_bundles="${candidate}/result-bundles"
  if [[ -L "${derived_data}" || ! -d "${derived_data}" ||
        -L "${result_bundles}" || ! -d "${result_bundles}" ]]
  then
    echo "Preserving unproven XcodeBuildMCP Example workspace ${candidate}" >&2
    return
  fi
  derived_data_proof="$(
    find "${derived_data}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -name 'example-ios-*' \
      -print \
      -quit
  )"
  result_bundle_proof="$(
    find "${result_bundles}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -name 'test_sim_*.xcresult' \
      -print \
      -quit
  )"
  if [[ -z "${derived_data_proof}" || -z "${result_bundle_proof}" ]]; then
    echo "Preserving unproven XcodeBuildMCP Example workspace ${candidate}" >&2
    return
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "XcodeBuildMCP Example artifact cleanup requires python3" >&2
    return 1
  fi

  cutoff_reference="$(mktemp "${runner_temp}/example-xcodebuildmcp-cutoff.XXXXXX")"
  if ! python3 - "${cutoff_reference}" "${retention_days}" <<'PY'
import os
import sys
import time

reference_path, retention_days = sys.argv[1:]
cutoff = time.time() - int(retention_days) * 24 * 60 * 60
os.utime(reference_path, (cutoff, cutoff), follow_symlinks=False)
PY
  then
    rm -f -- "${cutoff_reference}"
    echo "Could not establish the XcodeBuildMCP retention cutoff" >&2
    return 1
  fi
  if ! recent_descendant="$(
    find "${candidate}" \
      -mindepth 1 \
      -newer "${cutoff_reference}" \
      -print \
      -quit
  )"; then
    rm -f -- "${cutoff_reference}"
    echo "Could not measure XcodeBuildMCP Example workspace contents" >&2
    return 1
  fi
  rm -f -- "${cutoff_reference}"
  if [[ -n "${recent_descendant}" ]]; then
    echo "Preserving recently updated XcodeBuildMCP Example workspace ${workspace_name}"
    return
  fi

  echo "Removing expired generated XcodeBuildMCP workspace ${workspace_name}"
  rm -rf -- "${candidate}"
}

simulator_cleanup_is_authorized() {
  [[ "${IOS_RUNNER_RECLAIM_CI_SIMULATORS:-}" == "1" ]] &&
    [[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] &&
    [[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] &&
    command -v xcrun >/dev/null 2>&1 &&
    command -v python3 >/dev/null 2>&1 &&
    [[ -x /usr/bin/perl ]]
}

delete_example_ci_candidate() {
  local candidate="$1"
  local description="$2"
  local delete_attempt

  run_with_timeout 15 xcrun simctl shutdown "${candidate}" </dev/null >/dev/null 2>&1 || true
  for delete_attempt in 1 2; do
    if run_with_timeout 30 xcrun simctl delete "${candidate}" </dev/null >/dev/null 2>&1; then
      return 0
    fi
    echo "Simulator delete attempt ${delete_attempt}/2 failed for ${candidate}" >&2
  done

  echo "Could not delete ${description} ${candidate}" >&2
  return 1
}

remove_unavailable_simulators() {
  if ! simulator_cleanup_is_authorized; then
    return
  fi

  echo "Removing unavailable CoreSimulator devices"
  if ! run_with_timeout 60 xcrun simctl delete unavailable </dev/null >/dev/null 2>&1; then
    echo "Could not delete unavailable simulators; final capacity check will decide" >&2
  fi
}

remove_orphaned_core_simulator_logs() {
  local logs_root_input="${home_dir}/Library/Logs/CoreSimulator"
  local logs_root
  local devices_json
  local candidates
  local candidate
  local candidate_name
  local canonical_candidate
  local -a orphaned_log_directories=()
  local -a removal_batch=()

  if [[ "${IOS_RUNNER_RECLAIM_CI_SIMULATORS:-}" != "1" ]] ||
     ! simulator_cleanup_is_authorized
  then
    return
  fi
  if [[ ! -e "${logs_root_input}" ]]; then
    return
  fi
  if [[ -L "${logs_root_input}" || ! -d "${logs_root_input}" ]]; then
    echo "Refusing to clear unsafe CoreSimulator log root ${logs_root_input}" >&2
    return 1
  fi

  logs_root="$(cd "${logs_root_input}" 2>/dev/null && pwd -P || true)"
  if [[ "${logs_root}" != "${logs_root_input}" ]]; then
    echo "Refusing non-canonical CoreSimulator log root ${logs_root_input}" >&2
    return 1
  fi
  if ! devices_json="$(run_with_timeout 30 xcrun simctl list devices -j)"; then
    echo "Could not list simulators before orphaned log cleanup; preserving all logs" >&2
    return
  fi
  if ! candidates="$(
    printf '%s' "${devices_json}" |
      python3 -c '
import json
import os
import re
import sys

payload = json.load(sys.stdin)
devices_by_runtime = payload.get("devices")
if not isinstance(devices_by_runtime, dict):
    raise ValueError("simulator inventory has no devices map")

uuid_pattern = re.compile(
    r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
    r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
)
live_udids = set()
for devices in devices_by_runtime.values():
    if not isinstance(devices, list):
        raise ValueError("simulator runtime has no device list")
    for device in devices:
        if not isinstance(device, dict):
            continue
        udid = device.get("udid")
        if isinstance(udid, str) and uuid_pattern.fullmatch(udid):
            live_udids.add(udid.casefold())

logs_root = sys.argv[1]
with os.scandir(logs_root) as entries:
    for entry in entries:
        if (
            uuid_pattern.fullmatch(entry.name)
            and entry.name.casefold() not in live_udids
            and entry.is_dir(follow_symlinks=False)
        ):
            print(os.path.join(logs_root, entry.name))
' "${logs_root}"
  )"; then
    echo "Could not parse simulator inventory before orphaned log cleanup; preserving all logs" >&2
    return
  fi

  while IFS= read -r candidate; do
    if [[ -z "${candidate}" ]]; then
      continue
    fi
    candidate_name="${candidate##*/}"
    if [[ ! "${candidate_name}" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] ||
       [[ -L "${candidate}" || ! -d "${candidate}" ]]
    then
      continue
    fi
    canonical_candidate="$(cd "${candidate}" 2>/dev/null && pwd -P || true)"
    if [[ "${canonical_candidate%/*}" != "${logs_root}" ||
          "${canonical_candidate##*/}" != "${candidate_name}" ]]
    then
      echo "Refusing non-canonical orphaned CoreSimulator log directory ${candidate}" >&2
      return 1
    fi
    orphaned_log_directories+=("${candidate}")
  done <<< "${candidates}"

  if (( ${#orphaned_log_directories[@]} == 0 )); then
    echo "Matched 0 orphaned CoreSimulator log directories"
    return
  fi

  echo "Removing ${#orphaned_log_directories[@]} orphaned CoreSimulator log directories"
  for candidate in "${orphaned_log_directories[@]}"; do
    removal_batch+=("${candidate}")
    if (( ${#removal_batch[@]} == 100 )); then
      rm -rf -- "${removal_batch[@]}"
      removal_batch=()
    fi
  done
  if (( ${#removal_batch[@]} > 0 )); then
    rm -rf -- "${removal_batch[@]}"
  fi
  echo "iOS runner disk after orphaned CoreSimulator log cleanup:"
  df -h "${runner_temp}"
}

remove_stale_example_ci_simulators() {
  local devices_json
  local candidates
  local candidate
  local candidate_size
  local candidate_name
  local current_narrow_name=""
  local current_storekit_name=""
  local current_onboarding_name=""
  local current_backend_evidence_name=""
  local current_main_name=""
  local current_main_narrow_name=""
  local current_main_wide_name=""
  local current_main_ui_name=""
  local current_main_budget_name=""
  local current_evidence_name=""
  local current_evidence_narrow_name=""
  local actions_read_token="${EXAMPLE_ACTIONS_READ_TOKEN:-}"
  local repository="${GITHUB_REPOSITORY:-}"
  local api_url="${GITHUB_API_URL:-https://api.github.com}"
  local current_runner_name="${RUNNER_NAME:-}"
  local candidate_run_id
  local last_candidate_run_id=""
  local last_candidate_run_removable=0
  local jobs_http_code
  local jobs_payload
  local jobs_payload_file
  local jobs_validation
  local run_http_code
  local run_payload
  local run_payload_file
  local run_status
  local matched_count=0
  local matched_bytes=0
  local removed_count=0

  if [[ "${IOS_RUNNER_RECLAIM_CI_SIMULATORS:-}" != "1" ]]; then
    echo "Skipping stale Example simulator cleanup because explicit workflow authorization is disabled" >&2
    return
  fi
  if [[ ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ||
        ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]
  then
    echo "Skipping stale Example simulator cleanup without numeric GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT" >&2
    return
  fi
  if ! command -v xcrun >/dev/null 2>&1 ||
     ! command -v python3 >/dev/null 2>&1 ||
     ! command -v curl >/dev/null 2>&1 ||
     [[ ! -x /usr/bin/perl ]]
  then
    echo "Skipping stale Example simulator cleanup because xcrun, python3, or perl is unavailable" >&2
    return
  fi
  if [[ -z "${actions_read_token}" ||
        ! "${api_url}" =~ ^https://[^[:space:]]+$ ||
        ! "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
  then
    echo "Skipping stale Example simulator cleanup without authenticated Actions run-state access" >&2
    return
  fi
  if ! devices_json="$(run_with_timeout 30 xcrun simctl list devices -j)"; then
    echo "Could not list simulators during low-disk cleanup; final capacity check will decide" >&2
    return
  fi

  current_narrow_name="Example CI Narrow ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_storekit_name="Example CI StoreKit ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_onboarding_name="Example CI Onboarding ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_backend_evidence_name="Example CI Backend Evidence ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_main_name="Example CI Main ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_main_narrow_name="Example CI Main Narrow ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_main_wide_name="Example CI Main Wide ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_main_ui_name="Example CI Main UI ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_main_budget_name="Example CI Main Budget ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_evidence_name="Example CI Evidence ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  current_evidence_narrow_name="Example CI Evidence Narrow ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"

  if ! candidates="$(
    printf '%s' "${devices_json}" |
      python3 -c '
import json
import re
import sys

payload = json.load(sys.stdin)
devices_by_runtime = payload.get("devices")
if not isinstance(devices_by_runtime, dict):
    raise ValueError("simulator inventory has no devices map")

current_device_names = set(sys.argv[1:])
ci_name_pattern = re.compile(
  r"Example CI (?:Narrow|StoreKit|Onboarding|Backend Evidence|"
  r"Main(?: Narrow| Wide| UI| Budget)?|Evidence(?: Narrow)?) "
  r"(?P<run_id>[0-9]+)-[0-9]+"
)
uuid_pattern = re.compile(
    r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
    r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
)
for devices in devices_by_runtime.values():
    if not isinstance(devices, list):
        continue
    for device in devices:
        if not isinstance(device, dict):
            continue
        name = device.get("name")
        udid = device.get("udid")
        data_path_size = device.get("dataPathSize", 0)
        name_match = ci_name_pattern.fullmatch(name) if isinstance(name, str) else None
        is_prior_ci_device = (
            name_match is not None
            and name not in current_device_names
        )
        if (
            is_prior_ci_device
            and isinstance(udid, str)
            and uuid_pattern.fullmatch(udid)
        ):
            if not isinstance(data_path_size, int) or data_path_size < 0:
                data_path_size = 0
            candidate_run_id = name_match.group("run_id")
            print(f"{candidate_run_id}\t{udid}\t{data_path_size}\t{name}")
' "${current_narrow_name}" "${current_storekit_name}" "${current_onboarding_name}" "${current_backend_evidence_name}" "${current_main_name}" "${current_main_narrow_name}" "${current_main_wide_name}" "${current_main_ui_name}" "${current_main_budget_name}" "${current_evidence_name}" "${current_evidence_narrow_name}" | sort -n
  )"; then
    echo "Could not parse simulator inventory during low-disk cleanup; final capacity check will decide" >&2
    return
  fi

  if ! run_payload_file="$(mktemp "${runner_temp}/example-actions-run-state.XXXXXX")"; then
    echo "Could not create Actions run-state response file; preserving all Example CI simulators" >&2
    return
  fi
  if ! jobs_payload_file="$(mktemp "${runner_temp}/example-actions-job-state.XXXXXX")"; then
    echo "Could not create Actions job-state response file; preserving all Example CI simulators" >&2
    rm -f -- "${run_payload_file}"
    return
  fi

  while IFS=$'\t' read -r candidate_run_id candidate candidate_size candidate_name; do
    if [[ ! "${candidate_run_id}" =~ ^[0-9]+$ ]]; then
      continue
    fi
    if [[ ! "${candidate}" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]; then
      continue
    fi

    if [[ "${candidate_run_id}" != "${last_candidate_run_id}" ]]; then
      last_candidate_run_id="${candidate_run_id}"
      last_candidate_run_removable=0
      : > "${run_payload_file}"
      if run_http_code="$(curl --silent --show-error \
        --max-time 30 \
        --output "${run_payload_file}" \
        --write-out '%{http_code}' \
        -H "Authorization: Bearer ${actions_read_token}" \
        -H 'Accept: application/vnd.github+json' \
        -H 'X-GitHub-Api-Version: 2022-11-28' \
        "${api_url}/repos/${repository}/actions/runs/${candidate_run_id}")"
      then
        case "${run_http_code}" in
          200)
            run_payload="$(cat "${run_payload_file}")"
            if run_status="$(printf '%s' "${run_payload}" | python3 -c '
import json
import sys

payload = json.load(sys.stdin)
status = payload.get("status")
print(status if isinstance(status, str) else "")
')"; then
              if [[ "${run_status}" == "completed" ]]; then
                last_candidate_run_removable=1
              elif [[ ! "${run_status}" =~ ^(queued|in_progress|pending|requested|waiting)$ ]]; then
                echo "Actions run ${candidate_run_id} returned unknown status ${run_status:-<empty>}; preserving its simulator(s)" >&2
              elif [[ -z "${current_runner_name}" || "${current_runner_name}" == *$'\n'* ]]; then
                echo "Could not identify the current Actions runner; preserving simulator(s) for active run ${candidate_run_id}" >&2
              else
                : > "${jobs_payload_file}"
                if jobs_http_code="$(curl --silent --show-error \
                  --max-time 30 \
                  --output "${jobs_payload_file}" \
                  --write-out '%{http_code}' \
                  -H "Authorization: Bearer ${actions_read_token}" \
                  -H 'Accept: application/vnd.github+json' \
                  -H 'X-GitHub-Api-Version: 2022-11-28' \
                  "${api_url}/repos/${repository}/actions/runs/${candidate_run_id}/jobs?filter=latest&per_page=100&page=1")"
                then
                  if [[ "${jobs_http_code}" == "200" ]]; then
                    jobs_payload="$(cat "${jobs_payload_file}")"
                    if jobs_validation="$(printf '%s' "${jobs_payload}" | python3 -c '
import json
import sys

runner_name = sys.argv[1]
payload = json.load(sys.stdin)
jobs = payload.get("jobs")
total_count = payload.get("total_count")
if (
    not isinstance(jobs, list)
    or isinstance(total_count, bool)
    or not isinstance(total_count, int)
    or total_count < 0
    or total_count != len(jobs)
):
    raise ValueError("Actions job listing is incomplete")

for job in jobs:
    if not isinstance(job, dict):
        raise ValueError("Actions job listing contains an invalid job")
    status = job.get("status")
    runner = job.get("runner_name")
    if not isinstance(status, str) or (runner is not None and not isinstance(runner, str)):
        raise ValueError("Actions job listing contains invalid liveness fields")
    if status == "in_progress" and not isinstance(runner, str):
        raise ValueError("An in-progress Actions job has no runner identity")

owned = any(
    job.get("status") == "in_progress"
    and job.get("runner_name") == runner_name
    for job in jobs
)
print("owned" if owned else "unowned")
' "${current_runner_name}")"
                    then
                      if [[ "${jobs_validation}" == "unowned" ]]; then
                        last_candidate_run_removable=1
                        echo "Actions run ${candidate_run_id} has no in-progress job on ${current_runner_name}; reclaiming its Example-owned simulator(s)"
                      fi
                    else
                      echo "Could not validate Actions jobs for run ${candidate_run_id}; preserving its simulator(s)" >&2
                    fi
                  else
                    echo "Actions jobs for run ${candidate_run_id} returned HTTP ${jobs_http_code}; preserving its simulator(s)" >&2
                  fi
                else
                  echo "Could not verify Actions jobs for run ${candidate_run_id}; preserving its simulator(s)" >&2
                fi
              fi
            else
              echo "Could not validate Actions run ${candidate_run_id}; preserving its simulator(s)" >&2
            fi
            ;;
          404)
            # Candidate names passed the strict Example CI ownership grammar
            # above. With authenticated read access to this repository, an
            # authoritative missing run means the per-run simulator is orphaned.
            last_candidate_run_removable=1
            echo "Actions run ${candidate_run_id} does not exist; reclaiming its Example-owned simulator(s)"
            ;;
          *)
            echo "Actions run ${candidate_run_id} lookup returned HTTP ${run_http_code}; preserving its simulator(s)" >&2
            ;;
        esac
      else
        echo "Could not verify Actions run ${candidate_run_id}; preserving its simulator(s)" >&2
      fi
    fi
    if (( last_candidate_run_removable == 0 )); then
      echo "Preserving simulator ${candidate_name}; owning Actions run ${candidate_run_id} is active or unverified"
      continue
    fi

    matched_count=$((matched_count + 1))
    if [[ "${candidate_size}" =~ ^[0-9]+$ ]]; then
      matched_bytes=$((matched_bytes + candidate_size))
    fi
    echo "Removing stale Example-owned simulator ${candidate_name} ${candidate}"
    if delete_example_ci_candidate "${candidate}" "stale Example-owned simulator"; then
      removed_count=$((removed_count + 1))
    fi
  done <<< "${candidates}"

  rm -f -- "${run_payload_file}" "${jobs_payload_file}"

  echo "Matched ${matched_count} stale Example-owned simulator(s), ${matched_bytes} reported bytes"
  echo "iOS runner disk after stale Example simulator cleanup:"
  df -h "${runner_temp}"
}

remove_unreachable_example_warm_simulators() {
  local primary_runtime="${IOS_RUNNER_PRIMARY_RUNTIME_IDENTIFIER:-}"
  local current_names_json="${IOS_RUNNER_CURRENT_WARM_TEMPLATE_NAMES_JSON:-}"
  local devices_json
  local candidates
  local candidate_runtime
  local candidate
  local candidate_size
  local candidate_name
  local process_inspection_status
  local matched_count=0
  local matched_bytes=0
  local removed_count=0

  if [[ "${IOS_RUNNER_RECLAIM_CI_SIMULATORS:-}" != "1" ]] ||
     ! simulator_cleanup_is_authorized
  then
    return
  fi
  if [[ ! "${primary_runtime}" =~ ^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9]+(-[0-9]+)*$ ]]; then
    echo "Skipping unreachable Example warm simulator cleanup without a valid primary runtime" >&2
    return
  fi
  if [[ -z "${current_names_json}" ]] &&
     ! current_names_json="$(
       python3 "${script_dir}/provision-ios-ci-simulator.py" \
         --print-current-warm-template-names-json
     )"
  then
    echo "Preserving Example warm simulators because current template identity could not be proven" >&2
    return
  fi
  if ! command -v pgrep >/dev/null 2>&1; then
    echo "Skipping unreachable Example warm simulator cleanup because pgrep is unavailable" >&2
    return
  fi
  if pgrep -x xcodebuild >/dev/null 2>&1; then
    echo "Preserving unreachable Example warm simulators while an iOS test or provisioning process is active"
    return
  else
    process_inspection_status=$?
    if (( process_inspection_status != 1 )); then
      echo "Preserving unreachable Example warm simulators because process inspection failed" >&2
      return
    fi
  fi
  if pgrep -x xctest >/dev/null 2>&1; then
    echo "Preserving unreachable Example warm simulators while an iOS test or provisioning process is active"
    return
  else
    process_inspection_status=$?
    if (( process_inspection_status != 1 )); then
      echo "Preserving unreachable Example warm simulators because process inspection failed" >&2
      return
    fi
  fi
  if pgrep -f '[t]obi-iosUITests-Runner|[t]obi-iosTests-Runner|[p]rovision-ios-ci-simulator.py' >/dev/null 2>&1; then
    echo "Preserving unreachable Example warm simulators while an iOS test or provisioning process is active"
    return
  else
    process_inspection_status=$?
    if (( process_inspection_status != 1 )); then
      echo "Preserving unreachable Example warm simulators because process inspection failed" >&2
      return
    fi
  fi
  if ! devices_json="$(run_with_timeout 30 xcrun simctl list devices -j)"; then
    echo "Could not list simulators before unreachable Example warm cleanup; preserving every template" >&2
    return
  fi
  if ! candidates="$(
    printf '%s' "${devices_json}" |
      python3 -c '
import json
import re
import sys

payload = json.load(sys.stdin)
devices_by_runtime = payload.get("devices")
if not isinstance(devices_by_runtime, dict):
    raise ValueError("simulator inventory has no devices map")

runtime_pattern = re.compile(
    r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-([0-9]+(?:-[0-9]+)*)"
)


def runtime_version(runtime):
    if not isinstance(runtime, str):
        return None
    match = runtime_pattern.fullmatch(runtime)
    if match is None:
        return None
    return tuple(int(component) for component in match.group(1).split("-"))


name_pattern = re.compile(r"Example CI Warm (?:Standard|Narrow|Wide) [0-9a-f]{12}")
primary_runtime = sys.argv[1]
current_names = json.loads(sys.argv[2])
if (
    not isinstance(current_names, list)
    or not current_names
    or any(not isinstance(name, str) or not name_pattern.fullmatch(name) for name in current_names)
):
    raise ValueError("current warm template inventory is invalid")
current_names = set(current_names)
primary_version = runtime_version(primary_runtime)
if primary_version is None:
    raise ValueError("primary runtime has no comparable version")
uuid_pattern = re.compile(
    r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
    r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
)
for runtime, devices in devices_by_runtime.items():
    candidate_version = runtime_version(runtime)
    if (
        candidate_version is None
        or candidate_version > primary_version
        or not isinstance(devices, list)
    ):
        continue
    for device in devices:
        if not isinstance(device, dict):
            continue
        name = device.get("name")
        udid = device.get("udid")
        if (
            not isinstance(name, str)
            or not name_pattern.fullmatch(name)
            or not isinstance(udid, str)
            or not uuid_pattern.fullmatch(udid)
            or device.get("isAvailable") is not True
            or device.get("state") != "Shutdown"
        ):
            continue
        if candidate_version == primary_version and name in current_names:
            continue
        size = device.get("dataPathSize", 0)
        if not isinstance(size, int) or size < 0:
            size = 0
        print(f"{runtime}\t{udid}\t{size}\t{name}")
' "${primary_runtime}" "${current_names_json}"
  )"; then
    echo "Could not parse simulator inventory before unreachable Example warm cleanup; preserving every template" >&2
    return
  fi

  while IFS=$'\t' read -r candidate_runtime candidate candidate_size candidate_name; do
    if [[ -z "${candidate}" ]]; then
      continue
    fi
    matched_count=$((matched_count + 1))
    if [[ "${candidate_size}" =~ ^[0-9]+$ ]]; then
      matched_bytes=$((matched_bytes + candidate_size))
    fi
    echo "Removing unreachable Example warm simulator ${candidate_name} ${candidate} from ${candidate_runtime}"
    if python3 "${script_dir}/provision-ios-ci-simulator.py" \
      --delete-warm-template \
      "${candidate_runtime}" \
      "${candidate}" \
      "${candidate_name}"
    then
      removed_count=$((removed_count + 1))
    fi
  done <<< "${candidates}"

  echo "Matched ${matched_count} unreachable Example warm simulator(s), ${matched_bytes} reported bytes"
  echo "iOS runner disk after unreachable Example warm simulator cleanup:"
  df -h "${runner_temp}"
}

reset_exact_legacy_example_simulator() {
  local legacy_name="$1"
  local legacy_runtime="$2"
  local legacy_udid="$3"
  local devices_json
  local legacy_candidate
  local legacy_size
  local legacy_state
  local command_timeout

  if (( legacy_reset_deadline <= SECONDS )); then
    echo "Legacy simulator reset budget is exhausted; final capacity check will decide" >&2
    return
  fi

  if [[ -z "${legacy_udid}" && -z "${legacy_name}" && -z "${legacy_runtime}" ]]; then
    return
  fi
  if ! simulator_cleanup_is_authorized; then
    echo "Skipping legacy Example simulator reset without authorized numeric workflow identity" >&2
    return
  fi
  if [[ ! "${legacy_udid}" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]] ||
     [[ -z "${legacy_name}" ]] ||
     [[ ! "${legacy_runtime}" =~ ^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+$ ]]
  then
    echo "Skipping invalid legacy Example simulator identity" >&2
    return
  fi
  case "${legacy_name}" in
    "Example CI Narrow ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"|\
    "Example CI StoreKit ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"|\
    "Example CI Onboarding ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"|\
    "Example CI Main ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"|\
    "Example CI Main Narrow ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"|\
    "Example CI Main Wide ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"|\
    "Example CI Evidence ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"|\
    "Example CI Evidence Narrow ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}")
      echo "Refusing to reset a current-run Example simulator" >&2
      return
      ;;
  esac
  command_timeout=$((legacy_reset_deadline - SECONDS))
  if (( command_timeout <= 0 )); then
    echo "Legacy simulator reset budget is exhausted before inventory; final capacity check will decide" >&2
    return
  fi
  if (( command_timeout > 30 )); then
    command_timeout=30
  fi
  if ! devices_json="$(run_with_timeout "${command_timeout}" xcrun simctl list devices -j)"; then
    echo "Could not list simulators for exact legacy reset; final capacity check will decide" >&2
    return
  fi
  if ! legacy_candidate="$(
    printf '%s' "${devices_json}" |
      python3 -c '
import json
import sys

payload = json.load(sys.stdin)
devices_by_runtime = payload.get("devices")
if not isinstance(devices_by_runtime, dict):
    raise ValueError("simulator inventory has no devices map")

runtime, expected_name, expected_udid = sys.argv[1:]
devices = devices_by_runtime.get(runtime, [])
if not isinstance(devices, list):
    raise ValueError("legacy simulator runtime has no device list")
for device in devices:
    if not isinstance(device, dict):
        continue
    if (
        device.get("name") == expected_name
        and device.get("udid") == expected_udid
        and device.get("isAvailable") is True
        and device.get("state") in {"Booted", "Shutdown"}
    ):
        size = device.get("dataPathSize", 0)
        if not isinstance(size, int) or size < 0:
            size = 0
        state = device.get("state")
        print(f"{expected_udid}\t{size}\t{state}")
        break
' "${legacy_runtime}" "${legacy_name}" "${legacy_udid}"
  )"; then
    echo "Could not parse simulator inventory for exact legacy reset; final capacity check will decide" >&2
    return
  fi
  if [[ -z "${legacy_candidate}" ]]; then
    echo "Exact legacy Example simulator is not present; preserving all other simulators"
    return
  fi

  IFS=$'\t' read -r legacy_candidate legacy_size legacy_state <<< "${legacy_candidate}"
  if [[ "${legacy_candidate}" != "${legacy_udid}" ]]; then
    echo "Refusing mismatched legacy Example simulator candidate" >&2
    return
  fi
  if [[ "${legacy_state}" == "Booted" ]]; then
    if [[ "${IOS_RUNNER_SHUTDOWN_BOOTED_LEGACY_SIMULATORS:-}" != "1" ]]; then
      echo "Preserving booted legacy Example simulator ${legacy_candidate} without explicit shutdown authorization" >&2
      return
    fi
    if ! command -v pgrep >/dev/null 2>&1; then
      echo "Preserving booted legacy Example simulator ${legacy_candidate} because pgrep is unavailable" >&2
      return
    fi
    if pgrep -x xcodebuild >/dev/null 2>&1 ||
       pgrep -x xctest >/dev/null 2>&1 ||
       pgrep -f '[t]obi-iosUITests-Runner|[t]obi-iosTests-Runner' >/dev/null 2>&1
    then
      echo "Preserving booted legacy Example simulator ${legacy_candidate} while an Xcode test process is active" >&2
      return
    fi

    echo "Shutting down exact legacy Example simulator ${legacy_name} ${legacy_candidate}"
    command_timeout=$((legacy_reset_deadline - SECONDS))
    if (( command_timeout <= 0 )); then
      echo "Legacy simulator reset budget is exhausted before shutdown; final capacity check will decide" >&2
      return
    fi
    if (( command_timeout > 30 )); then
      command_timeout=30
    fi
    if ! run_with_timeout "${command_timeout}" xcrun simctl shutdown "${legacy_candidate}" </dev/null >/dev/null 2>&1; then
      echo "Could not shut down exact legacy Example simulator ${legacy_candidate}; final capacity check will decide" >&2
      return
    fi
  elif [[ "${legacy_state}" != "Shutdown" ]]; then
    echo "Preserving exact legacy Example simulator ${legacy_candidate} in unexpected state ${legacy_state}" >&2
    return
  fi

  echo "Resetting exact legacy Example simulator ${legacy_name} ${legacy_candidate} (${legacy_size} reported bytes)"
  local erase_attempt
  local reset_succeeded=0
  for erase_attempt in 1 2 3; do
    command_timeout=$((legacy_reset_deadline - SECONDS))
    if (( command_timeout <= 0 )); then
      echo "Legacy simulator reset budget is exhausted during erase retries; final capacity check will decide" >&2
      break
    fi
    if (( command_timeout > 90 )); then
      command_timeout=90
    fi
    if run_with_timeout "${command_timeout}" xcrun simctl erase "${legacy_candidate}" </dev/null >/dev/null 2>&1; then
      reset_succeeded=1
      break
    fi
    echo "::warning::Exact legacy Example simulator reset failed on attempt ${erase_attempt}/3 for ${legacy_candidate}" >&2
  done
  if (( reset_succeeded == 0 )); then
    echo "Could not reset exact legacy Example simulator ${legacy_candidate}; final capacity check will decide" >&2
    return
  fi

  echo "iOS runner disk after exact legacy simulator reset:"
  df -h "${runner_temp}"
}

legacy_reset_floor_is_met() {
  local measured_free_kb

  measured_free_kb="$(available_disk_kb)"
  [[ "${measured_free_kb}" =~ ^[0-9]+$ ]] &&
    (( measured_free_kb >= minimum_free_kb ))
}

reset_additional_exact_legacy_example_simulators() {
  local manifest="${IOS_RUNNER_RECLAIM_ADDITIONAL_LEGACY_SIMULATORS_JSON:-}"
  local entries
  local legacy_name
  local legacy_runtime
  local legacy_udid

  if [[ -z "${manifest}" || "${manifest}" == "[]" ]]; then
    return
  fi
  if ! simulator_cleanup_is_authorized; then
    echo "Skipping additional exact legacy simulator reset without authorized numeric workflow identity" >&2
    return
  fi
  if ! entries="$(
    printf '%s' "${manifest}" |
      python3 -c '
import json
import re
import sys

payload = json.load(sys.stdin)
if not isinstance(payload, list) or not 1 <= len(payload) <= 10:
    raise ValueError("manifest must contain from one through ten identities")

name_pattern = re.compile(r"iPhone [A-Za-z0-9][A-Za-z0-9 .+()-]{0,63}")
runtime_pattern = re.compile(r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]+")
uuid_pattern = re.compile(
    r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
    r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
)
seen_udids = set()
validated = []
for entry in payload:
    if not isinstance(entry, dict) or set(entry) != {"name", "runtime", "udid"}:
        raise ValueError("manifest entry has unexpected fields")
    name = entry.get("name")
    runtime = entry.get("runtime")
    udid = entry.get("udid")
    if (
        not isinstance(name, str)
        or not name_pattern.fullmatch(name)
        or not isinstance(runtime, str)
        or not runtime_pattern.fullmatch(runtime)
        or not isinstance(udid, str)
        or not uuid_pattern.fullmatch(udid)
        or udid.casefold() in seen_udids
    ):
        raise ValueError("manifest entry has an invalid or duplicate identity")
    seen_udids.add(udid.casefold())
    validated.append((name, runtime, udid))

for identity in validated:
    print("\t".join(identity))
'
  )"; then
    echo "Could not validate additional exact legacy simulator manifest; preserving every additional simulator" >&2
    return
  fi

  while IFS=$'\t' read -r legacy_name legacy_runtime legacy_udid; do
    if [[ -z "${legacy_udid}" ]]; then
      continue
    fi
    reset_exact_legacy_example_simulator \
      "${legacy_name}" \
      "${legacy_runtime}" \
      "${legacy_udid}"
    if legacy_reset_floor_is_met; then
      return
    fi
  done <<< "${entries}"
}

reset_legacy_example_shared_simulator() {
  legacy_reset_deadline=$((SECONDS + legacy_reset_budget_seconds))
  reset_exact_legacy_example_simulator \
    "${IOS_RUNNER_RECLAIM_LEGACY_SIMULATOR_NAME:-}" \
    "${IOS_RUNNER_RECLAIM_LEGACY_SIMULATOR_RUNTIME:-}" \
    "${IOS_RUNNER_RECLAIM_LEGACY_SIMULATOR_UDID:-}"
  if legacy_reset_floor_is_met; then
    return
  fi
  reset_exact_legacy_example_simulator \
    "${IOS_RUNNER_RECLAIM_SECONDARY_LEGACY_SIMULATOR_NAME:-}" \
    "${IOS_RUNNER_RECLAIM_SECONDARY_LEGACY_SIMULATOR_RUNTIME:-}" \
    "${IOS_RUNNER_RECLAIM_SECONDARY_LEGACY_SIMULATOR_UDID:-}"
  if legacy_reset_floor_is_met; then
    return
  fi
  reset_additional_exact_legacy_example_simulators
}

remove_current_example_ci_simulator() {
  local candidate="${IOS_RUNNER_CURRENT_SIMULATOR_UDID:-}"
  local purpose="${IOS_RUNNER_CURRENT_SIMULATOR_PURPOSE:-}"
  local expected_name
  local devices_json
  local validated_candidate

  if ! simulator_cleanup_is_authorized; then
    echo "Current simulator cleanup requires explicit authorization and numeric workflow identity" >&2
    return 1
  fi
  if [[ ! "${candidate}" =~ ^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$ ]]; then
    echo "Current simulator cleanup requires a valid Example simulator UUID and purpose" >&2
    return 1
  fi
  case "${purpose}" in
    "StoreKit"|"Onboarding"|"Backend Evidence"|\
    "Main"|"Main Narrow"|"Main Wide"|"Main UI"|"Main Budget"|\
    "Evidence"|"Evidence Narrow")
      ;;
    *)
      echo "Current simulator cleanup requires a valid Example simulator UUID and purpose" >&2
      return 1
      ;;
  esac
  expected_name="Example CI ${purpose} ${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  if ! devices_json="$(run_with_timeout 30 xcrun simctl list devices -j)"; then
    echo "Could not list simulators for current Example simulator cleanup" >&2
    return 1
  fi
  if ! validated_candidate="$(
    printf '%s' "${devices_json}" |
      python3 -c '
import json
import sys

payload = json.load(sys.stdin)
devices_by_runtime = payload.get("devices")
if not isinstance(devices_by_runtime, dict):
    raise ValueError("simulator inventory has no devices map")

expected_name, expected_udid = sys.argv[1:]
for devices in devices_by_runtime.values():
    if not isinstance(devices, list):
        continue
    for device in devices:
        if not isinstance(device, dict):
            continue
        if device.get("name") == expected_name and device.get("udid") == expected_udid:
            print(expected_udid)
            raise SystemExit(0)
' "${expected_name}" "${candidate}"
  )"; then
    echo "Could not validate current Example simulator inventory" >&2
    return 1
  fi
  if [[ -z "${validated_candidate}" ]]; then
    echo "Current Example simulator ${expected_name} is already absent"
    remove_unavailable_simulators
    return
  fi
  if [[ "${validated_candidate}" != "${candidate}" ]]; then
    echo "Refusing mismatched current Example simulator candidate" >&2
    return 1
  fi

  echo "Removing current Example CI simulator ${expected_name} ${candidate}"
  if ! delete_example_ci_candidate "${candidate}" "current Example CI simulator"; then
    return 1
  fi
  remove_unavailable_simulators
}

remove_stale_example_system_temp_directories() {
  local system_temp_input="${TMPDIR:-}"
  local system_temp
  local candidate
  local candidate_name

  if [[ -z "${system_temp_input}" || ! -d "${system_temp_input}" ]]; then
    return
  fi
  system_temp="$(cd "${system_temp_input}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${system_temp}" || "${system_temp}" == "/" ]]; then
    echo "Skipping unsafe system temp cleanup root ${system_temp_input}" >&2
    return
  fi

  while IFS= read -r -d '' candidate; do
    candidate_name="${candidate##*/}"
    if [[ ! "${candidate_name}" =~ ^budget-[0-9]+\.[A-Za-z0-9]+$ ]] &&
       [[ ! "${candidate_name}" =~ ^pr[0-9]+-local\.[A-Za-z0-9]+$ ]]
    then
      continue
    fi
    if [[ ! -d "${candidate}" || -L "${candidate}" ]]; then
      continue
    fi

    echo "Removing stale Example system temp artifact ${candidate}"
    rm -rf -- "${candidate}"
  done < <(
    find "${system_temp}" \
      -mindepth 1 \
      -maxdepth 1 \
      -type d \
      -mmin +1440 \
      -print0
  )
}

available_disk_kb() {
  df -Pk "${runner_temp}" | awk 'NR == 2 { print $4 }'
}

report_known_disk_usage() {
  local runner_work_root
  local candidate
  local usage_output
  local -a existing_roots=()
  local -a candidates=(
    "${runner_temp}"
    "${RUNNER_WORKSPACE:-}"
    "${home_dir}/Library/Developer/CoreSimulator/Devices"
    "${home_dir}/Library/Developer/XCTestDevices"
    "${EXAMPLE_CI_EVIDENCE_ROOT:-${home_dir}/.example-ci-evidence}"
    "${disposable_cache_roots[@]}"
  )

  runner_work_root="$(cd "${runner_temp}/.." 2>/dev/null && pwd -P || true)"
  candidates+=("${runner_work_root}")

  for candidate in "${candidates[@]}"; do
    if [[ -n "${candidate}" && -d "${candidate}" ]]; then
      existing_roots+=("${candidate}")
    fi
  done

  echo "Known runner disk usage (KB):"
  if (( ${#existing_roots[@]} == 0 )); then
    echo "No known runner cache roots are present."
    return
  fi
  if ! usage_output="$(
    run_with_timeout "${disk_diagnostic_timeout_seconds}" \
      du -sk "${existing_roots[@]}" 2>/dev/null
  )"; then
    echo "Known disk usage diagnostic did not finish within ${disk_diagnostic_timeout_seconds}s; continuing capacity enforcement" >&2
    return
  fi
  printf '%s\n' "${usage_output}" | sort -nr || true
}

report_child_disk_usage() {
  local heading="$1"
  local parent_input="$2"
  local name_pattern="${3:-*}"
  local parent
  local child
  local usage_output
  local -a children=()

  if [[ -z "${parent_input}" || ! -d "${parent_input}" ]]; then
    return
  fi
  parent="$(cd "${parent_input}" 2>/dev/null && pwd -P || true)"
  if [[ -z "${parent}" || "${parent}" == "/" ]]; then
    echo "Skipping unsafe diagnostic root ${parent_input}" >&2
    return
  fi

  while IFS= read -r -d '' child; do
    children+=("${child}")
  done < <(
    find "${parent}" \
      -mindepth 1 \
      -maxdepth 1 \
      ! -type l \
      -name "${name_pattern}" \
      -print0
  )

  echo "${heading} (KB):"
  if (( ${#children[@]} == 0 )); then
    echo "No matching diagnostic roots are present."
    return
  fi
  if ! usage_output="$(
    run_with_timeout "${disk_diagnostic_timeout_seconds}" \
      du -sk "${children[@]}" 2>/dev/null
  )"; then
    echo "${heading} diagnostic did not finish within ${disk_diagnostic_timeout_seconds}s; continuing capacity enforcement" >&2
    return
  fi
  printf '%s\n' "${usage_output}" | sort -nr | head -n 40 || true
}

report_remaining_disk_usage() {
  report_child_disk_usage \
    "Remaining Xcode disk usage" \
    "${home_dir}/Library/Developer/Xcode"
  report_child_disk_usage \
    "Remaining CoreSimulator disk usage" \
    "${home_dir}/Library/Developer/CoreSimulator"
  report_child_disk_usage \
    "Remaining XCTest device usage" \
    "${home_dir}/Library/Developer/XCTestDevices"
  report_child_disk_usage \
    "Remaining user cache disk usage" \
    "${home_dir}/Library/Caches"
  report_child_disk_usage \
    "Remaining hidden home disk usage" \
    "${home_dir}" \
    '.*'
  report_child_disk_usage \
    "Remaining system temp disk usage" \
    "${TMPDIR:-}"
}

case "${mode}" in
  preflight)
    echo "iOS runner disk before cleanup:"
    df -h "${runner_temp}"

    remove_orphaned_example_simulator_recorders
    remove_expired_durable_ci_evidence

    # GitHub dispatches one job at a time to each registered self-hosted runner,
    # and RUNNER_TEMP belongs to that runner. No current run directory exists
    # when this preflight step runs, so every match is prior-job residue.
    remove_run_directories \
      'example-ios-tests.*' \
      'example-storekit.*' \
      'onboarding-e2e.*' \
      '__no_additional_onboarding_pattern__' \
      'example-ios-release-archive.*'

    # Canceled jobs cannot execute their final cleanup. Prove the owning Actions
    # run is completed, then reclaim its exact run-scoped devices before making
    # a capacity decision. Active and unverifiable runs are always preserved.
    remove_stale_example_ci_simulators

    available_kb="$(available_disk_kb)"
    if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
      echo "Unable to determine free disk space for ${runner_temp}" >&2
      exit 1
    fi

    echo "iOS runner disk after per-run cleanup:"
    df -h "${runner_temp}"
    if (( available_kb < minimum_free_kb )); then
      # Warm templates are keyed by Xcode, runtime, and device class. Remove
      # only stopped Example templates that the selected Xcode can no longer clone.
      remove_unreachable_example_warm_simulators
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after unreachable warm simulator cleanup" >&2
        exit 1
      fi
    fi
    if (( available_kb < minimum_free_kb )); then
      report_known_disk_usage
      clear_disposable_cache_contents
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after cache cleanup" >&2
        exit 1
      fi

      echo "iOS runner disk after disposable cache cleanup:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      remove_expired_actions_runner_diagnostics
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after runner diagnostic cleanup" >&2
        exit 1
      fi

      echo "iOS runner disk after Actions runner diagnostic cleanup:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # The dedicated Actions runner can retain complete superseded binaries,
      # completed update staging, and tool-cache versions that this workflow no
      # longer selects. Remove only old marker-proven inactive versions.
      remove_expired_actions_runner_tooling
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after Actions runner tooling cleanup" >&2
        exit 1
      fi

      echo "iOS runner disk after inactive Actions runner tooling cleanup:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # Job summaries retain the manifest for every fallback. Keep the newest
      # validated runner copy per PR and evidence category, while scoping
      # non-PR evidence to its exact head, until the measured floor is restored.
      prune_superseded_durable_ci_evidence
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after superseded evidence pruning" >&2
        exit 1
      fi

      echo "iOS runner disk after superseded evidence pruning:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # Failed GitHub artifact uploads are retained locally. Preserve their
      # checksum-verifiable contents while preventing uncompressed bundles from
      # starving later CI lanes on the same self-hosted runner.
      compact_recent_durable_ci_evidence
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after evidence compaction" >&2
        exit 1
      fi

      echo "iOS runner disk after durable evidence compaction:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # A merged PR's final exact-head evidence has already completed its gate.
      # Reclaim only checksum-valid fallback copies after the GitHub API proves
      # the PR merged at that same tested head; open and current work survives.
      prune_merged_pull_request_durable_ci_evidence
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after merged PR evidence pruning" >&2
        exit 1
      fi

      echo "iOS runner disk after merged PR evidence pruning:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # Xcode creates UUID-scoped clones for parallel XCTest workers. Abandoned
      # clones are runner-generated data, but recent clones stay untouched in
      # case another host process still owns them.
      remove_stale_xctest_device_clones
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after XCTest device cleanup" >&2
        exit 1
      fi

      echo "iOS runner disk after stale XCTest device cleanup:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # Local verification roots contain generated SwiftPM and .xctestproducts
      # output. Reclaim only old, marker-proven Example roots on an authorized runner.
      remove_expired_local_ios_generated_artifacts
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after local iOS artifact cleanup" >&2
        exit 1
      fi

      echo "iOS runner disk after generated local iOS artifact cleanup:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # XcodeBuildMCP retains generated DerivedData and result bundles outside
      # Xcode's standard cache root. Reclaim only the exact runner-configured
      # Example workspace after both artifact-shape and retention checks pass.
      remove_expired_xcodebuildmcp_example_artifacts
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after XcodeBuildMCP cleanup" >&2
        exit 1
      fi

      echo "iOS runner disk after XcodeBuildMCP cleanup:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # Xcode's test clones become unavailable after their owning test process
      # exits. Removing that state is narrower than erasing any available device.
      remove_unavailable_simulators
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after unavailable simulator cleanup" >&2
        exit 1
      fi
    fi
    if (( available_kb < minimum_free_kb )); then
      # simctl can leave UUID-scoped log directories after their devices are
      # deleted. Compare against a fresh inventory and preserve every live
      # device, non-UUID entry, and symlink before reclaiming only those logs.
      remove_orphaned_core_simulator_logs
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after orphaned simulator log cleanup" >&2
        exit 1
      fi
    fi
    if (( available_kb < minimum_free_kb )); then
      # One historical runner reused a generic simulator before per-run ownership
      # existed. The workflow supplies its exact name, runtime, and UUID only on
      # that runner; every mismatch preserves the device.
      reset_legacy_example_shared_simulator
      # RUNNER_TEMP and HOME are on the same APFS container on the self-hosted Mac.
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after exact legacy simulator reset" >&2
        exit 1
      fi
    fi
    # Installed runtimes belong to the prepared image and may be shared by
    # later lanes. Reclaim owned test data, never a runtime prerequisite.
    if (( available_kb < minimum_free_kb )); then
      remove_stale_example_system_temp_directories
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after stale Example temp cleanup" >&2
        exit 1
      fi

      echo "iOS runner disk after stale Example temp cleanup:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # The dedicated CI account does not produce release archives. Clear this
      # Xcode-generated output only after narrower cache and simulator cleanup
      # has failed to restore the measured test headroom.
      clear_ci_xcode_archive_contents
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after Xcode archive cleanup" >&2
        exit 1
      fi

      echo "iOS runner disk after Xcode archive cleanup:"
      df -h "${runner_temp}"
    fi
    if (( available_kb < minimum_free_kb )); then
      # Physical-device symbol support is generated by Xcode and is not needed
      # by these simulator-only jobs. The dedicated runner authorization keeps
      # this cleanup away from developer machines and Xcode user data.
      clear_ci_xcode_device_support_contents
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after Xcode device support cleanup" >&2
        exit 1
      fi

      echo "iOS runner disk after Xcode device support cleanup:"
      df -h "${runner_temp}"
    fi
    # Deleted simulator storage is reclaimed by the time simctl returns; a
    # host still below the minimum is reported and fails closed, never waited on.
    if (( available_kb < minimum_free_kb )); then
      report_known_disk_usage
      report_remaining_disk_usage
      available_kb="$(available_disk_kb)"
      if [[ ! "${available_kb}" =~ ^[0-9]+$ ]]; then
        echo "Unable to determine free disk space after final diagnostics" >&2
        exit 1
      fi
      echo "iOS runner has ${available_kb} KB free after final capacity recheck"
    fi
    if (( available_kb < minimum_free_kb )); then
      echo "iOS runner has ${available_kb} KB free; ${minimum_free_kb} KB is required" >&2
      exit 1
    fi
    ;;
  current)
    run_id="${GITHUB_RUN_ID:-}"
    run_attempt="${GITHUB_RUN_ATTEMPT:-}"
    if [[ ! "${run_id}" =~ ^[0-9]+$ || ! "${run_attempt}" =~ ^[0-9]+$ ]]; then
      echo "Current-run cleanup requires numeric GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT" >&2
      exit 1
    fi

    # Every execution lane uses a task-owned mktemp suffix.
    remove_run_directories \
      "example-ios-tests.${run_id}.${run_attempt}.*" \
      "example-storekit.${run_id}.${run_attempt}.*" \
      "onboarding-e2e.${run_id}.${run_attempt}" \
      "onboarding-e2e.*.${run_id}.${run_attempt}.*" \
      "example-ios-release-archive.${run_id}.${run_attempt}.*"
    ;;
  simulator)
    if ! remove_current_example_ci_simulator; then
      echo "::warning::Current Example CI simulator cleanup did not complete; the next runner preflight will retry owned stale simulators" >&2
    fi
    ;;
  *)
    echo "Usage: $0 <preflight|current|simulator>" >&2
    exit 2
    ;;
esac

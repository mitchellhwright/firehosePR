#!/usr/bin/env bash

set -euo pipefail
umask 077

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <evidence-name> <file-or-directory> [...]" >&2
  exit 64
fi

evidence_name="$1"
shift

if [ -z "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "::error::GITHUB_STEP_SUMMARY is required for the evidence fallback."
  exit 1
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ] &&
   [ "${RUNNER_ENVIRONMENT:-}" != "self-hosted" ]; then
  echo "::error::The evidence fallback can retain durable CI evidence only on a self-hosted Actions runner." >&2
  exit 1
fi

exact_head_sha="${EXAMPLE_CI_EXACT_HEAD_SHA:-${GITHUB_SHA:-}}"
pull_request_number="${EXAMPLE_CI_PR_NUMBER:-}"
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  if [[ ! "$exact_head_sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "::error::EXAMPLE_CI_EXACT_HEAD_SHA must identify the exact 40-character commit head."
    exit 1
  fi
  if [[ -n "$pull_request_number" && ! "$pull_request_number" =~ ^[0-9]+$ ]]; then
    echo "::error::EXAMPLE_CI_PR_NUMBER must be empty or numeric."
    exit 1
  fi
elif [ -z "$exact_head_sha" ]; then
  exact_head_sha="local"
fi

declare -a evidence_paths=("$@")
declare -a summary_files=()
has_evidence_content=0

for evidence_path in "${evidence_paths[@]}"; do
  if [[ "$evidence_path" == *$'\n'* ]]; then
    echo "::error::CI evidence paths must not contain newlines."
    exit 1
  fi
  if [ -f "$evidence_path" ]; then
    has_evidence_content=1
    if [[ "$evidence_path" == *-summary.json ]]; then
      python3 -m json.tool "$evidence_path" >/dev/null
      summary_files+=("$evidence_path")
    fi
  elif [ -d "$evidence_path" ]; then
    if [ "$evidence_path" = "/" ]; then
      echo "::error::Refusing to retain the filesystem root as CI evidence."
      exit 1
    fi
    if [ -n "$(find "$evidence_path" -mindepth 1 -print -quit)" ]; then
      has_evidence_content=1
    fi
  else
    echo "::error::Required CI evidence path is missing: $evidence_path"
    exit 1
  fi
done

if [ "$has_evidence_content" -ne 1 ]; then
  echo "::error::No CI evidence content was found for $evidence_name."
  exit 1
fi

retention_days="${EXAMPLE_CI_EVIDENCE_RETENTION_DAYS:-3}"
if [[ ! "$retention_days" =~ ^[1-9][0-9]*$ ]] || [ "$retention_days" -gt 30 ]; then
  echo "::error::EXAMPLE_CI_EVIDENCE_RETENTION_DAYS must be an integer from 1 through 30."
  exit 1
fi

if [ -n "${EXAMPLE_CI_EVIDENCE_ROOT:-}" ]; then
  durable_root_input="$EXAMPLE_CI_EVIDENCE_ROOT"
elif [ -n "${HOME:-}" ]; then
  durable_root_input="$HOME/.example-ci-evidence"
else
  echo "::error::HOME or EXAMPLE_CI_EVIDENCE_ROOT is required for durable CI evidence."
  exit 1
fi
while [ "$durable_root_input" != "/" ] && [[ "$durable_root_input" == */ ]]; do
  durable_root_input="${durable_root_input%/}"
done

case "$durable_root_input" in
  /*) ;;
  *)
    echo "::error::The durable CI evidence root must be an absolute path."
    exit 1
    ;;
esac
case "${durable_root_input##*/}" in
  .example-ci-evidence|example-ci-evidence) ;;
  *)
    echo "::error::The durable CI evidence root must be a dedicated example-ci-evidence directory."
    exit 1
    ;;
esac
if [ -L "$durable_root_input" ]; then
  echo "::error::Refusing a symlinked durable CI evidence root: $durable_root_input"
  exit 1
fi
mkdir -p "$durable_root_input"
durable_root="$(cd "$durable_root_input" 2>/dev/null && pwd -P || true)"
if [ -z "$durable_root" ] || [ "$durable_root" = "/" ]; then
  echo "::error::Refusing an unsafe durable CI evidence root: $durable_root_input"
  exit 1
fi
case "${durable_root##*/}" in
  .example-ci-evidence|example-ci-evidence) ;;
  *)
    echo "::error::The canonical durable CI evidence root is not a dedicated directory."
    exit 1
    ;;
esac
chmod 700 "$durable_root"

find "$durable_root" \
  -mindepth 1 \
  -maxdepth 1 \
  -type d \
  -name 'run-*-attempt-*' \
  -mtime +"$retention_days" \
  -exec rm -rf {} +

evidence_slug="$(
  printf '%s' "$evidence_name" |
    LC_ALL=C tr '[:upper:]' '[:lower:]' |
    LC_ALL=C tr -cs 'a-z0-9' '-' |
    sed -e 's/^-//' -e 's/-$//' |
    cut -c 1-48
)"
if [ -z "$evidence_slug" ]; then
  evidence_slug="evidence"
fi
run_id="${GITHUB_RUN_ID:-local}"
run_attempt="${GITHUB_RUN_ATTEMPT:-local}"
if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
  run_id="local"
fi
if [[ ! "$run_attempt" =~ ^[0-9]+$ ]]; then
  run_attempt="local"
fi

manifest_unsorted="$(mktemp "${RUNNER_TEMP:-/tmp}/example-ci-evidence-manifest.XXXXXX")"
manifest="$(mktemp "${RUNNER_TEMP:-/tmp}/example-ci-evidence-manifest-sorted.XXXXXX")"
summary_record="$(mktemp "${RUNNER_TEMP:-/tmp}/example-ci-evidence-summary.XXXXXX")"
durable_dir="$(mktemp -d \
  "$durable_root/run-${run_id}-attempt-${run_attempt}-${evidence_slug}.XXXXXX")"
durable_copy_complete=0

cleanup_on_exit() {
  status="$?"
  trap - EXIT
  rm -f "$manifest_unsorted" "$manifest" "$summary_record"
  if [ "$status" -ne 0 ] &&
     [ "$durable_copy_complete" -ne 1 ] &&
     [ -n "$durable_dir" ]; then
    rm -rf "$durable_dir"
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

file_size() {
  local evidence_file="$1"
  local size=''

  if size="$(stat -f '%z' -- "$evidence_file" 2>/dev/null)" &&
     [[ "$size" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$size"
    return 0
  fi
  if size="$(stat -c '%s' -- "$evidence_file" 2>/dev/null)" &&
     [[ "$size" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$size"
    return 0
  fi

  echo "::error::Could not determine the CI evidence file size: $evidence_file" >&2
  return 1
}

mkdir -p "$durable_dir/files"
durable_index="$durable_dir/index.jsonl"
touch "$durable_index"
python3 - \
  "$durable_dir/provenance.json" \
  "${GITHUB_REPOSITORY:-local}" \
  "$exact_head_sha" \
  "$pull_request_number" \
  "${GITHUB_RUN_ID:-local}" \
  "${GITHUB_RUN_ATTEMPT:-local}" \
  "${GITHUB_WORKFLOW:-local}" \
  "${GITHUB_JOB:-local}" \
  "$evidence_name" <<'PY'
import json
import sys

(
    output_path,
    repository,
    head_sha,
    pull_request_number,
    run_id,
    run_attempt,
    workflow,
    job,
    evidence_name,
) = sys.argv[1:]
payload = {
    "repository": repository,
    "headSha": head_sha,
    "pullRequestNumber": int(pull_request_number) if pull_request_number else None,
    "runId": int(run_id) if run_id.isdigit() else run_id,
    "runAttempt": int(run_attempt) if run_attempt.isdigit() else run_attempt,
    "workflow": workflow,
    "job": job,
    "evidenceName": evidence_name,
}
with open(output_path, "w", encoding="utf-8") as output_handle:
    json.dump(payload, output_handle, separators=(",", ":"), sort_keys=True)
    output_handle.write("\n")
PY
chmod 600 "$durable_dir/provenance.json"

evidence_index=0
for evidence_path in "${evidence_paths[@]}"; do
  evidence_index=$((evidence_index + 1))
  display_path="${evidence_path#"${RUNNER_TEMP:-/tmp}"/}"

  if [ -f "$evidence_path" ]; then
    kind="file"
    stored_path="files/$(printf '%06d' "$evidence_index")"
    checksum="$(shasum -a 256 "$evidence_path" | awk '{print $1}')"
    cp "$evidence_path" "$durable_dir/$stored_path"
    chmod 600 "$durable_dir/$stored_path"
    stored_checksum="$(shasum -a 256 "$durable_dir/$stored_path" | awk '{print $1}')"
    if [ "$stored_checksum" != "$checksum" ]; then
      echo "::error::Durable CI evidence checksum mismatch for $display_path"
      exit 1
    fi
  else
    kind="directory-tar-gzip"
    stored_path="files/$(printf '%06d' "$evidence_index").tar.gz"
    evidence_parent="$(dirname "$evidence_path")"
    evidence_basename="$(basename "$evidence_path")"
    tar -czf "$durable_dir/$stored_path" \
      -C "$evidence_parent" \
      "./$evidence_basename"
    chmod 600 "$durable_dir/$stored_path"
    tar -tzf "$durable_dir/$stored_path" >/dev/null
    checksum="$(shasum -a 256 "$durable_dir/$stored_path" | awk '{print $1}')"
  fi

  size="$(file_size "$durable_dir/$stored_path")"
  printf '%s  %s  %s  %s\n' \
    "$checksum" "$size" "$kind" "$display_path" \
    >> "$manifest_unsorted"
  python3 - \
    "$display_path" \
    "$stored_path" \
    "$kind" \
    "$checksum" \
    "$size" \
    >> "$durable_index" <<'PY'
import json
import sys

original_path, stored_path, kind, checksum, size = sys.argv[1:]
print(json.dumps({
    "originalPath": original_path,
    "storedPath": stored_path,
    "kind": kind,
    "sha256": checksum,
    "size": int(size),
}, separators=(",", ":")))
PY
done

LC_ALL=C sort "$manifest_unsorted" > "$manifest"
manifest_checksum="$(shasum -a 256 "$manifest" | awk '{print $1}')"
manifest_lines="$(wc -l < "$manifest" | tr -d ' ')"
cp "$manifest" "$durable_dir/sha256-manifest.txt"
chmod 600 "$durable_index" "$durable_dir/sha256-manifest.txt"
durable_copy_complete=1

{
  printf '### CI evidence fallback: %s\n\n' "$evidence_name"
  echo 'GitHub artifact storage rejected the upload. The required evidence was validated and copied to durable storage on the self-hosted runner.'
  printf "\n- Run: \`%s\` attempt \`%s\`\n" "${GITHUB_RUN_ID:-local}" "${GITHUB_RUN_ATTEMPT:-local}"
  printf -- "- Exact head: \`%s\`\n" "$exact_head_sha"
  printf -- "- Evidence items: \`%s\`\n" "$manifest_lines"
  printf -- "- Manifest SHA-256: \`%s\`\n" "$manifest_checksum"
  printf -- "- Durable runner copy: \`%s\`\n" "$durable_dir"
  printf -- "- Local prune threshold: \`%s\` days\n" "$retention_days"

  if [ -n "${summary_files[*]-}" ]; then
    for summary_file in "${summary_files[@]}"; do
      printf '\n#### %s\n\n```json\n' "$(basename "$summary_file")"
      python3 - "$summary_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as summary_handle:
    summary = json.load(summary_handle)
fields = (
    "result",
    "totalTestCount",
    "passedTests",
    "failedTests",
    "skippedTests",
    "startTime",
    "finishTime",
)
print(json.dumps(
    {field: summary.get(field) for field in fields if field in summary},
    indent=2,
))
PY
      echo '```'
    done
  fi

  echo
  echo '<details><summary>SHA-256 manifest</summary>'
  echo
  echo '```text'
  head -200 "$manifest"
  if [ "$manifest_lines" -gt 200 ]; then
    printf '... %s additional items omitted; use the manifest checksum above for the complete set.\n' "$((manifest_lines - 200))"
  fi
  echo '```'
  echo '</details>'
} > "$summary_record"

if ! cat "$summary_record" >> "$GITHUB_STEP_SUMMARY"; then
  echo "::error::Failed to append the durable CI evidence record to the job summary."
  exit 1
fi

echo "::warning::GitHub artifact storage rejected '$evidence_name'; retained the evidence on the self-hosted runner."
printf 'Evidence fallback manifest: items=%s sha256=%s\n' "$manifest_lines" "$manifest_checksum"
printf 'Durable evidence directory: %s\n' "$durable_dir"
head -200 "$manifest"

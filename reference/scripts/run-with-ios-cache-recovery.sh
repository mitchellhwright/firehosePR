#!/usr/bin/env bash
set -euo pipefail

log_path="${1:-}"
shift || true
if [[ -z "$log_path" || "${1:-}" != "--" ]]; then
  echo "usage: $0 <log-path> -- <command> [args...]" >&2
  exit 2
fi
shift
if [[ "$#" -eq 0 ]]; then
  echo "usage: $0 <log-path> -- <command> [args...]" >&2
  exit 2
fi
: "${IOS_CI_CACHE_LANE:?IOS_CI_CACHE_LANE is required}"

mkdir -p "$(dirname "$log_path")"
: > "$log_path"

run_command() {
  local status=0
  set +e
  "$@" 2>&1 | tee -a "$log_path"
  status="${PIPESTATUS[0]}"
  set -e
  return "$status"
}

remove_retry_outputs() {
  local expect_path=0
  local argument=""
  local output_path=""

  for argument in "$@"; do
    if [[ "$expect_path" -eq 1 ]]; then
      output_path="$argument"
      expect_path=0
    elif [[ "$argument" == "-resultBundlePath" || "$argument" == "-archivePath" ]]; then
      expect_path=1
      continue
    elif [[ "$argument" == -resultBundlePath=* ]]; then
      output_path="${argument#-resultBundlePath=}"
    elif [[ "$argument" == -archivePath=* ]]; then
      output_path="${argument#-archivePath=}"
    else
      continue
    fi

    if [[ -n "$output_path" && "$output_path" != "/" ]]; then
      rm -rf -- "$output_path"
    fi
    output_path=""
  done
}

status=0
run_command "$@" || status=$?
if [[ "$status" -eq 0 ]]; then
  exit 0
fi

classifier="$(dirname "${BASH_SOURCE[0]}")/../ci/src/actions/ios/classifyIosBuildRecovery.ts"
recovery_kind="$(node "$classifier" "$log_path")" || exit "$status"
if [[ -z "$recovery_kind" ]]; then
  exit "$status"
fi

echo "::warning::Retrying once after a recognized ${recovery_kind} signature."
case "$recovery_kind" in
  "cache corruption")
    bash "$(dirname "${BASH_SOURCE[0]}")/manage-ios-build-cache.sh" \
      wipe-current "$IOS_CI_CACHE_LANE"
    # Cache recovery removes SourcePackages along with DerivedData. Recreate the
    # preloaded Plaid artifact before retrying commands that intentionally keep
    # automatic package resolution disabled.
    if [[ -n "${IOS_CI_SOURCE_PACKAGES:-}" ]]; then
      bash "$(dirname "${BASH_SOURCE[0]}")/prepare-ios-plaid-link.sh" \
        "$IOS_CI_SOURCE_PACKAGES"
    fi
    ;;
  "CoreSimulator infrastructure")
    bash "$(dirname "${BASH_SOURCE[0]}")/ensure-ios-simulator-host.sh"
    ;;
esac
remove_retry_outputs "$@"
run_command "$@"

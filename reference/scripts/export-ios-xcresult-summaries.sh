#!/usr/bin/env bash

set -uo pipefail

if (( $# == 0 || $# % 3 != 0 )); then
  echo "Usage: $0 <lane-name> <result-bundle> <summary-path> [...]" >&2
  exit 64
fi

export_failed=0

while [ "$#" -gt 0 ]; do
  lane_name="$1"
  result_bundle="$2"
  summary_path="$3"
  shift 3

  if [ -z "$result_bundle" ] || [ ! -d "$result_bundle" ]; then
    continue
  fi

  summary_dir="$(dirname "$summary_path")"
  if ! mkdir -p "$summary_dir"; then
    echo "::error::Failed to prepare the $lane_name XCTest summary directory."
    export_failed=1
    continue
  fi

  if ! temporary_summary="$(mktemp "${summary_path}.tmp.XXXXXX")"; then
    echo "::error::Failed to create a temporary $lane_name XCTest summary."
    export_failed=1
    continue
  fi

  if ! xcrun xcresulttool get test-results summary \
    --path "$result_bundle" \
    --format json \
    > "$temporary_summary"
  then
    rm -f "$temporary_summary"
    echo "::error::Failed to export $lane_name XCTest summary."
    export_failed=1
    continue
  fi

  if ! python3 -m json.tool "$temporary_summary" >/dev/null; then
    rm -f "$temporary_summary"
    echo "::error::The exported $lane_name XCTest summary is not valid JSON."
    export_failed=1
    continue
  fi

  if ! mv "$temporary_summary" "$summary_path"; then
    rm -f "$temporary_summary"
    echo "::error::Failed to publish the $lane_name XCTest summary."
    export_failed=1
  fi
done

exit "$export_failed"

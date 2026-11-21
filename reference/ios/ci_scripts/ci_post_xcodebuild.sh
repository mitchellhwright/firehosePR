#!/usr/bin/env bash
set -euo pipefail

if [[ "${CI_XCODEBUILD_ACTION:-}" != "archive" ]]; then
  echo "Skipping required-reason API validation for ${CI_XCODEBUILD_ACTION:-unknown} action"
  exit 0
fi

if [[ -z "${CI_ARCHIVE_PATH:-}" ]]; then
  echo "CI_ARCHIVE_PATH is required for Xcode Cloud archive validation" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "${script_dir}/validate-required-reason-apis.sh" "${CI_ARCHIVE_PATH}"

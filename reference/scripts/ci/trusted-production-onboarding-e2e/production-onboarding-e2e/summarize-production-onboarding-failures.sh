#!/usr/bin/env bash
set -euo pipefail
python3 scripts/summarize-ios-test-failures.py \
  "$ONBOARDING_E2E_RESULT_BUNDLE" \
  --xcodebuild-log "$ONBOARDING_E2E_XCODEBUILD_LOG"

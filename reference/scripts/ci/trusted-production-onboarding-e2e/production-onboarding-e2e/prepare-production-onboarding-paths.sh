#!/usr/bin/env bash
set -euo pipefail
run_dir="$(mktemp -d \
  "${RUNNER_TEMP:?}/production-onboarding-e2e.${GITHUB_RUN_ID:?}.${GITHUB_RUN_ATTEMPT:?}.XXXXXX")"
xctestrun="$(find "$IOS_E2E_TEST_PRODUCTS" -type f -name '*.xctestrun' -print -quit)"
test -n "$xctestrun"
{
  echo "ONBOARDING_E2E_RUN_DIR=$run_dir"
  echo "ONBOARDING_E2E_RESULT_BUNDLE=$run_dir/onboarding-e2e.xcresult"
  echo "ONBOARDING_E2E_XCODEBUILD_LOG=$run_dir/xcodebuild.log"
  echo "XCTESTRUN_PATH=$xctestrun"
} >> "$GITHUB_ENV"

#!/usr/bin/env bash
set -euo pipefail
if [ -s "$ONBOARDING_E2E_RUN_DIR/onboarding-e2e.raw.mp4" ]; then
  echo "available=true" >> "$GITHUB_OUTPUT"
fi

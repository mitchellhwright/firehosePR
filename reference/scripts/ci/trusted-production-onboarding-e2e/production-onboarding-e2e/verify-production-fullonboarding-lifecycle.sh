#!/usr/bin/env bash
set -euo pipefail
for outcome in \
  "$PROVISION_OUTCOME" \
  "$ONBOARDING_OUTCOME" \
  "$REVISION_OUTCOME" \
  "$CLEANUP_OUTCOME"; do
  if [ "$outcome" != "success" ]; then
    echo "::error::Production FullOnboarding lifecycle outcome was $outcome."
    exit 1
  fi
done

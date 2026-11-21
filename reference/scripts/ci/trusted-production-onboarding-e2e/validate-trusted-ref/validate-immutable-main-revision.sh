#!/usr/bin/env bash
set -euo pipefail
if [ "$EVENT_NAME" != "workflow_dispatch" ]; then
  echo "::error::Unsupported production onboarding E2E event: $EVENT_NAME. Deploy reports reach this workflow through production-deploy-dispatch.yml."
  exit 1
fi
if [ "$REF" != "refs/heads/main" ]; then
  echo "::error::Production onboarding E2E accepts only refs/heads/main."
  exit 1
fi
if ! [[ "$EVENT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Production onboarding E2E requires an immutable commit SHA."
  exit 1
fi
if [ "$REQUESTED_SHA" != "$EVENT_SHA" ]; then
  echo "::error::Production execution requires exact_sha ${REQUESTED_SHA:-unknown} to match the main revision ${EVENT_SHA}; main has moved on, so this run is superseded."
  exit 1
fi
echo "exact_sha=$EVENT_SHA" >> "$GITHUB_OUTPUT"

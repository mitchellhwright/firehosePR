#!/usr/bin/env bash
set -euo pipefail
response="$(
  curl \
    --fail \
    --silent \
    --show-error \
    --max-time 10 \
    --header 'Cache-Control: no-cache' \
    "${PRODUCTION_HEALTH_URL}?expected=${EXACT_SHA}&phase=post-e2e"
)"
deployed_sha="$(
  printf '%s' "$response" | python3 -c '
import json
import sys

print(json.load(sys.stdin).get("buildSha") or "")
'
)"
if [ "$deployed_sha" != "$EXACT_SHA" ]; then
  echo "::error::Production changed during onboarding E2E: expected ${EXACT_SHA}, found ${deployed_sha:-unknown}."
  exit 1
fi
echo "Production remained on ${EXACT_SHA} through onboarding E2E."

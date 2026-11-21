#!/usr/bin/env bash
set -euo pipefail
response="$(curl --fail --silent --show-error --max-time 10 \
  --header 'Cache-Control: no-cache' \
  "${PRODUCTION_HEALTH_URL}?expected=${EXACT_SHA}&phase=preflight")"
deployed_sha="$(printf '%s' "$response" | python3 -c '
import json
import sys
print(json.load(sys.stdin).get("buildSha") or "")
')"
if [ "$deployed_sha" != "$EXACT_SHA" ]; then
  echo "::error::Production E2E requires an already-deployed exact main revision. Requested ${EXACT_SHA}; serving ${deployed_sha:-unknown}. No macOS runner was allocated."
  exit 1
fi
echo "Production revision ${EXACT_SHA} is deployed; macOS execution may proceed."

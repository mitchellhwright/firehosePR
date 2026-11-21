#!/usr/bin/env bash
set -euo pipefail
activation_label="example-runner-environment-${HOST_LABEL}-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
hook_root="${HOME}/.local/libexec/example-actions-runner/${RUNNER_NAME}"
token_file="$hook_root/${activation_label}.token"
token_claim_dir="${token_file}.claim"
if ! mkdir "$token_claim_dir" 2>/dev/null; then
  echo 'Detached activation atomically owns the bounded token.'
  exit 0
fi
trap 'rmdir "$token_claim_dir" 2>/dev/null || true; rm -f -- "$token_file"' EXIT
rm -f -- "$token_file"
for attempt in 1 2 3; do
  if gh api --method DELETE /installation/token; then
    exit 0
  fi
  if [ "$attempt" -eq 3 ]; then
    echo "::error::Failed to revoke the unhanded activation token after 3 attempts."
    exit 1
  fi
done

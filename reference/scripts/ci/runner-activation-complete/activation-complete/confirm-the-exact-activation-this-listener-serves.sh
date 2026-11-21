#!/usr/bin/env bash
set -euo pipefail
if ! [[ "$HOST_LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "::error::Unsafe durable host label: $HOST_LABEL"
  exit 1
fi
if ! [[ "$ACTIVATION_CONTEXT" =~ ^runner-environment/"$HOST_LABEL"/([0-9]+)/([0-9]+)$ ]]; then
  echo "::error::Activation context $ACTIVATION_CONTEXT does not name this host's run and attempt."
  exit 1
fi
run_id="${BASH_REMATCH[1]}"
run_attempt="${BASH_REMATCH[2]}"
case "$EXPECTED_PLATFORM:$(uname -s)" in
  macos:Darwin|linux:Linux) ;;
  *)
    echo "::error::Expected $EXPECTED_PLATFORM runner, got $(uname -s)."
    exit 1
    ;;
esac
runner_slug="$(printf '%s' "${RUNNER_NAME:?}" | tr -c 'A-Za-z0-9._-' '-')"
activation_label="example-runner-environment-${HOST_LABEL}-${run_id}-${run_attempt}"
if [ "$EXPECTED_PLATFORM" = linux ]; then
  marker_root="/usr/local/libexec/example-actions-runner/${runner_slug}"
else
  marker_root="${HOME}/.local/libexec/example-actions-runner/${RUNNER_NAME}"
fi
activation_log="$marker_root/${activation_label}.log"
export ACTIVATION_MARKER_PATH="$marker_root/${activation_label}.completed"
export ACTIVATION_LOG_PATH="$activation_log"
cleanup_marker() {
  if [ "$EXPECTED_PLATFORM" = linux ]; then
    sudo -n rm -f -- "$ACTIVATION_MARKER_PATH" \
      "$marker_root/${activation_label}.accepted" \
      "$marker_root/${activation_label}.revoked"
  else
    rm -f -- "$ACTIVATION_MARKER_PATH" \
      "$marker_root/${activation_label}.accepted" \
      "$marker_root/${activation_label}.revoked"
  fi
}
trap cleanup_marker EXIT
if [ ! -f "$activation_log" ]; then
  echo "::error::No activation log at $activation_log; this host never started activation $ACTIVATION_CONTEXT."
  exit 1
fi
# The detached process dispatched this job before finishing its
# cleanup; its exit line is the point after which the marker is final.
node ci/src/actions/awaitLogLine.ts "$activation_log" 'Activation process exiting with status' >/dev/null
node ci/src/actions/confirmRunnerActivation.ts

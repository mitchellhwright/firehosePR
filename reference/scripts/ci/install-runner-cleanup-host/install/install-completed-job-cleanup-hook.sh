#!/usr/bin/env bash
set -euo pipefail

actual_platform="$(uname -s)"
case "$EXPECTED_PLATFORM:$actual_platform" in
  macos:Darwin|linux:Linux) ;;
  *)
    echo "::error::Expected $EXPECTED_PLATFORM runner, got $actual_platform."
    exit 1
    ;;
esac

if [ "$EXPECTED_PLATFORM" = macos ]; then
  bash scripts/provision-github-macos-runner-tools.sh
fi

runner_temp="$(cd "${RUNNER_TEMP:?}" && pwd -P)"
runner_work_root="$(dirname "$runner_temp")"
runner_root="$(cd "$runner_work_root/.." && pwd -P)"
runner_workdir="$(basename "$runner_work_root")"
activation_required=false
if [ "$EXPECTED_PLATFORM" = macos ]; then
  expected_path='/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  if ! grep -Fqx "$expected_path" "$runner_root/.path" 2>/dev/null; then
    activation_required=true
  fi
  printf '%s\n' \
    "$expected_path" \
    > "$runner_root/.path"
fi
hook_root="${HOME}/.local/libexec/example-actions-runner/${RUNNER_NAME:?}"
hook_path="$hook_root/job-completed.sh"
activation_script="$hook_root/activate-runner-environment.sh"
# The serving worker is this step's ancestor, and macOS pgrep excludes
# the caller's ancestors by default (pgrep(1): "-a: include process
# ancestors"), so it never found the worker on the Macs; a process
# listing has no such rule on either platform.
serving_worker_pids="$(ps -axo pid=,args= | awk -v root="$runner_root" '
  index($2, root "/bin") == 1 && substr($2, length(root) + 2) ~ /^bin[^\/]*\/Runner\.Worker$/ { print $1 }')"
if ! [[ "$serving_worker_pids" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::Expected exactly one serving Runner.Worker, found: ${serving_worker_pids:-none}."
  exit 1
fi

if [ "${ACTIONS_RUNNER_HOOK_JOB_COMPLETED:-}" != "$hook_path" ]; then
  activation_required=true
fi
if [ "${EXAMPLE_ACTIONS_RUNNER_ROOT:-}" != "$runner_root" ] ||
   [ "${EXAMPLE_ACTIONS_RUNNER_WORKDIR:-}" != "$runner_workdir" ]; then
  activation_required=true
fi
printf 'activation_required=%s\n' "$activation_required" >> "$GITHUB_OUTPUT"

node "$GITHUB_WORKSPACE/ci/src/actions/installJobCompletedHook.ts" "$runner_root" "$hook_root"
install -m 0755 \
  "$GITHUB_WORKSPACE/scripts/activate-github-actions-runner-environment.sh" \
  "$activation_script"

env_file="$runner_root/.env"
env_tmp="$(mktemp "$runner_root/.env.cleanup.XXXXXX")"
if [ -f "$env_file" ]; then
  awk '
    !/^EXAMPLE_ACTIONS_RUNNER_ROOT=/ &&
    !/^EXAMPLE_ACTIONS_RUNNER_WORKDIR=/ &&
    !/^ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/
  ' "$env_file" > "$env_tmp"
fi
{
  printf 'EXAMPLE_ACTIONS_RUNNER_ROOT=%s\n' "$runner_root"
  printf 'EXAMPLE_ACTIONS_RUNNER_WORKDIR=%s\n' "$runner_workdir"
  printf 'ACTIONS_RUNNER_HOOK_JOB_COMPLETED=%s\n' "$hook_path"
} >> "$env_tmp"
chmod 0600 "$env_tmp"
mv "$env_tmp" "$env_file"

if ! [[ "$HOST_LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "::error::Unsafe durable host label: $HOST_LABEL"
  exit 1
fi
echo "Installed $hook_path for $RUNNER_NAME."
runner_slug="$(printf '%s' "${RUNNER_NAME:?}" | tr -c 'A-Za-z0-9._-' '-')"
activation_label="example-runner-environment-${HOST_LABEL}-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
if [ "$EXPECTED_PLATFORM" = macos ]; then
  marker_root="$hook_root"
  install -d -m 0755 "$marker_root"
else
  marker_root="/usr/local/libexec/example-actions-runner/${runner_slug}"
  sudo -n install -d -o root -g root -m 0755 "$marker_root"
fi
# One log per activation: the handoff wait below and the completion
# job's exit-line wait read a log from its start, so a shared log
# would satisfy them with an earlier activation's lines.
activation_log="$marker_root/${activation_label}.log"
activation_completed_marker="$marker_root/${activation_label}.completed"
node "$GITHUB_WORKSPACE/ci/src/actions/removeOrphanActivationMarkers.ts" \
  "$marker_root" "$HOST_LABEL" "$EXPECTED_PLATFORM"
if [ "$activation_required" = true ]; then
  completion_token_file="$hook_root/${activation_label}.token"
  token_accepted_marker="$marker_root/${activation_label}.accepted"
  token_revoked_marker="$marker_root/${activation_label}.revoked"
  if [ "$EXPECTED_PLATFORM" = macos ]; then
    rm -f "$completion_token_file" "$token_accepted_marker" \
      "$token_revoked_marker" "$activation_completed_marker"
    : > "$activation_log"
  else
    sudo -n install -o root -g root -m 0755 \
      "$GITHUB_WORKSPACE/scripts/activate-github-actions-runner-environment.sh" \
      "$marker_root/activate-runner-environment.sh"
    rm -f "$completion_token_file"
    sudo -n rm -f -- "$token_accepted_marker" "$token_revoked_marker" \
      "$activation_completed_marker"
    sudo -n install -o root -g root -m 0644 /dev/null "$activation_log"
  fi
  umask 077
  printf '%s' "${GITHUB_TOKEN_VALUE:?}" > "$completion_token_file"
  if [ "$EXPECTED_PLATFORM" = macos ]; then
    launchctl submit -l "com.example.${activation_label}" -- \
      /usr/bin/env 'RUNNER_TRACKING_ID=' \
      "EXAMPLE_ACTIVATION_LAUNCHD_LABEL=com.example.${activation_label}" \
      /bin/bash "$activation_script" \
      "$runner_root" "$EXPECTED_PLATFORM" "$activation_log" "$serving_worker_pids" \
      "$completion_token_file" "$GITHUB_API_URL" "$GITHUB_REPOSITORY" \
      "$GITHUB_SHA" "$ACTIVATION_CONTEXT" 0 \
      "$token_accepted_marker" "$token_revoked_marker" "$activation_completed_marker"
  else
    # The activation script runs as root here (via sudo systemd-run),
    # so its log and marker writes stay under this root-owned
    # directory. A prior runner job cannot replace their temporary
    # paths with symlinks before a privileged redirect follows them.
    # systemd-run waits for a oneshot unit's start job by default,
    # and that job only completes when the script exits, which
    # waits for this very worker to exit: --no-block returns as
    # soon as the unit is queued.
    sudo -n systemd-run \
      --no-block \
      --unit "$activation_label" \
      --collect \
      --property Type=oneshot \
      /usr/bin/env 'RUNNER_TRACKING_ID=' /bin/bash \
      "$marker_root/activate-runner-environment.sh" \
      "$runner_root" "$EXPECTED_PLATFORM" "$activation_log" "$serving_worker_pids" \
      "$completion_token_file" "$GITHUB_API_URL" "$GITHUB_REPOSITORY" \
      "$GITHUB_SHA" "$ACTIVATION_CONTEXT" 0 \
      "$token_accepted_marker" "$token_revoked_marker" "$activation_completed_marker"
  fi
  # The detached process logs the handoff verdict (acceptance, or its
  # exit); block on that line instead of polling for the marker.
  node "$GITHUB_WORKSPACE/ci/src/actions/awaitLogLine.ts" "$activation_log" \
    'Accepted activation token handoff|Activation process exiting' >/dev/null
  if [ ! -f "$token_accepted_marker" ]; then
    rm -f "$completion_token_file"
    echo "::error::Out-of-band activation did not accept the local handoff for $RUNNER_NAME."
    exit 1
  fi
  echo 'token_handed_off=true' >> "$GITHUB_OUTPUT"
  echo "Scheduled out-of-band environment activation for $RUNNER_NAME."
else
  echo "The active listener already has the installed cleanup hook."
fi

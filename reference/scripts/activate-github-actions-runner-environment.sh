#!/usr/bin/env bash
set -euo pipefail

runner_root="${1:?runner root is required}"
platform="${2:?platform is required}"
log_path="${3:?log path is required}"
serving_worker_pid="${4:?serving worker pid is required}"
completion_token_file="${5:?completion token file is required}"
github_api_url="${6:?GitHub API URL is required}"
github_repository="${7:?GitHub repository is required}"
completion_sha="${8:?completion SHA is required}"
completion_context="${9:?completion context is required}"
worker_wait_seconds="${10:-0}"
token_accepted_marker="${11:?token accepted marker is required}"
token_revoked_marker="${12:?token revoked marker is required}"
activation_completed_marker="${13:?activation completed marker is required}"

exec >> "$log_path" 2>&1
printf '[%s] activating persisted runner environment for %s\n' "$(date -u +%FT%TZ)" "$runner_root"

# `launchctl submit` keeps its job alive, so launchd relaunches this script
# every ten seconds after it exits until the job is removed. Removal stops
# this process too, so it is the last thing every exit path does.
launchd_label="${EXAMPLE_ACTIVATION_LAUNCHD_LABEL:-}"
release_launchd_job() {
  if [ -n "$launchd_label" ]; then
    "${EXAMPLE_RUNNER_LAUNCHCTL_BIN:-/bin/launchctl}" remove "$launchd_label" || true
  fi
}
trap release_launchd_job EXIT

[ -d "$runner_root" ] || {
  printf 'Runner root does not exist: %s\n' "$runner_root"
  exit 1
}
case "$serving_worker_pid" in
  *[!0-9]*|'')
    printf 'Unsafe serving worker pid: %s\n' "$serving_worker_pid"
    exit 1
    ;;
esac
case "$github_api_url" in
  https://api.github.com|https://github.[A-Za-z0-9.-]*/api/v3) ;;
  *)
    printf 'Unsafe GitHub API URL: %s\n' "$github_api_url"
    exit 1
    ;;
esac
if ! [[ "$github_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  printf 'Unsafe GitHub repository: %s\n' "$github_repository"
  exit 1
fi
if ! [[ "$completion_sha" =~ ^[a-f0-9]{40}$ ]]; then
  printf 'Unsafe completion SHA: %s\n' "$completion_sha"
  exit 1
fi
if ! [[ "$completion_context" =~ ^runner-environment/[A-Za-z0-9._/-]+$ ]]; then
  printf 'Unsafe completion context: %s\n' "$completion_context"
  exit 1
fi
token_claim_dir="${completion_token_file}.claim"
if ! mkdir "$token_claim_dir" 2>/dev/null; then
  printf 'Activation token cleanup already owns the bounded credential.\n'
  exit 0
fi
[ -f "$completion_token_file" ] || {
  rmdir "$token_claim_dir"
  printf 'Completion token file does not exist: %s\n' "$completion_token_file"
  exit 1
}
completion_token="$(cat "$completion_token_file")"
rm -f "$completion_token_file"
[ -n "$completion_token" ] || {
  rmdir "$token_claim_dir"
  printf 'Completion token is empty.\n'
  exit 1
}
pgrep_bin="${EXAMPLE_RUNNER_PGREP_BIN:-/usr/bin/pgrep}"
ps_bin="${EXAMPLE_RUNNER_PS_BIN:-/bin/ps}"
sleep_bin="${EXAMPLE_RUNNER_SLEEP_BIN:-/bin/sleep}"
curl_bin="${EXAMPLE_RUNNER_CURL_BIN:-/usr/bin/curl}"
worker_pattern="${runner_root}/bin[^/]*/Runner.Worker"
worker_wait_limit="${EXAMPLE_RUNNER_ACTIVATION_WAIT_SECONDS:-600}"
activation_signal_published=false
activation_token_revoked=false
activation_succeeded=false
service_unloaded=false
service_stopped=false
service_path=''
service_value=''
# The completion job runs on this host's restarted listener, so nothing may
# wait for it from another runner: a repository_dispatch event queues it the
# moment the marker below is final. The payload only routes the event; the
# job trusts the root-owned marker on this host, not the payload.
publish_activation_signal() {
  local state="$1" host_label body
  host_label="${completion_context#runner-environment/}"
  host_label="${host_label%%/*}"
  body="$(printf '{"event_type":"example-runner-activated","client_payload":{"context":"%s","host_label":"%s","platform":"%s","state":"%s","sha":"%s"}}' \
    "$completion_context" "$host_label" "$platform" "$state" "$completion_sha")"
  for _ in 1 2 3; do
    if "$curl_bin" --fail --silent --show-error \
      --request POST \
      --header 'Accept: application/vnd.github+json' \
      --header "Authorization: Bearer $completion_token" \
      --header 'X-GitHub-Api-Version: 2022-11-28' \
      --header 'Content-Type: application/json' \
      --data "$body" \
      "$github_api_url/repos/$github_repository/dispatches" \
      >/dev/null; then
      activation_signal_published=true
      return 0
    fi
  done
  return 1
}
revoke_activation_token() {
  for _ in 1 2 3; do
    if "$curl_bin" --fail --silent --show-error \
      --request DELETE \
      --header 'Accept: application/vnd.github+json' \
      --header "Authorization: Bearer $completion_token" \
      --header 'X-GitHub-Api-Version: 2022-11-28' \
      "$github_api_url/installation/token" \
      >/dev/null; then
      marker_tmp="${token_revoked_marker}.tmp.$$"
      printf 'revoked\n' > "$marker_tmp"
      chmod 0600 "$marker_tmp"
      mv "$marker_tmp" "$token_revoked_marker"
      activation_token_revoked=true
      completion_token=''
      return 0
    fi
  done
  return 1
}
publish_activation_marker() {
  local state="$1"
  local marker_tmp="${activation_completed_marker}.tmp.$$"
  printf '{"schema":"example.runner-activation.v1","context":"%s","state":"%s"}\n' \
    "$completion_context" "$state" > "$marker_tmp"
  chmod 0644 "$marker_tmp"
  mv "$marker_tmp" "$activation_completed_marker"
}
activation_cleanup() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  if [ "$service_unloaded" = true ]; then
    printf 'Restoring runner service after incomplete activation: %s\n' "$service_path"
    "${launchctl_bin:-/bin/launchctl}" load -w "$service_path" || true
  fi
  if [ "$service_stopped" = true ]; then
    printf 'Restoring runner service after incomplete activation: %s\n' "$service_value"
    "${systemctl_bin:-/usr/bin/systemctl}" start "$service_value" || true
  fi
  local state=failure
  if [ "$exit_code" -eq 0 ] && [ "$activation_succeeded" = true ]; then state=success; fi
  # The dispatch needs the scoped token, so it precedes revocation; the
  # completion job it queues blocks on this log's exit line before reading
  # the marker, which is therefore final only after every step below.
  if [ "$activation_signal_published" != true ] && ! publish_activation_signal "$state"; then
    printf 'Failed to publish the detached activation completion signal after three attempts.\n'
    exit_code=1
    state=failure
  fi
  if [ "$activation_token_revoked" != true ] && ! revoke_activation_token; then
    printf 'Failed to revoke the scoped activation token after three attempts.\n'
    exit_code=1
    state=failure
  fi
  rmdir "$token_claim_dir" || exit_code=1
  publish_activation_marker "$state" || exit_code=1
  printf 'Activation process exiting with status %s\n' "$exit_code"
  release_launchd_job
  exit "$exit_code"
}
trap activation_cleanup EXIT
trap 'exit 1' HUP INT TERM

# The atomic claim above transfers token ownership before publishing
# acceptance. Cleanup cannot revoke the token after this process owns it.
temporary_accepted_marker="${token_accepted_marker}.tmp.$$"
printf '%s\n' "$$" > "$temporary_accepted_marker"
chmod 0600 "$temporary_accepted_marker"
mv "$temporary_accepted_marker" "$token_accepted_marker"
printf 'Accepted activation token handoff (pid %s)\n' "$$"

# From this point onward the scoped token has been accepted by this detached
# process. Validate remaining inputs under the cleanup trap so every exit path
# revokes that token.
case "$worker_wait_limit" in
  *[!0-9]*|'')
    printf 'Unsafe activation wait: %s\n' "$worker_wait_limit"
    exit 1
    ;;
esac
case "$worker_wait_seconds" in
  *[!0-9]*|'')
    printf 'Unsafe activation elapsed time: %s\n' "$worker_wait_seconds"
    exit 1
    ;;
esac

while true; do
  while true; do
    serving_worker_command="$($ps_bin -p "$serving_worker_pid" -o command= 2>/dev/null || true)"
    active_workers="$($pgrep_bin -f "$worker_pattern" 2>/dev/null || true)"
    if [[ "$serving_worker_command" != "$runner_root"/bin*/Runner.Worker* ]] &&
       [ -z "$active_workers" ]; then
      break
    fi
    if [ "$worker_wait_seconds" -ge "$worker_wait_limit" ]; then
      printf 'Runner remained busy for %s seconds; leaving its service online without activation.\n' "$worker_wait_limit"
      exit 1
    fi
    "$sleep_bin" 1
    worker_wait_seconds=$((worker_wait_seconds + 1))
  done

  # Runner.Worker exits before the listener has necessarily finished publishing
  # JobCompleted. Wait briefly and restart the idle-window check if this listener
  # legitimately claims replacement work.
  "$sleep_bin" 2
  worker_wait_seconds=$((worker_wait_seconds + 2))
  if "$pgrep_bin" -f "$worker_pattern" >/dev/null 2>&1; then
    printf 'Runner claimed replacement work during activation handoff; waiting for the next idle window.\n'
    continue
  fi

  [ -f "$runner_root/.service" ] || {
    printf 'Runner service identity is missing under %s.\n' "$runner_root"
    printf 'The listener is not installed as a service, so it cannot be restarted. On the host, stop it and run: cd %s && ./svc.sh install && ./svc.sh start\n' "$runner_root"
    exit 1
  }
  service_value="$(cat "$runner_root/.service")"
  [ -n "$service_value" ] || {
    printf 'Runner service identity is empty under %s.\n' "$runner_root"
    exit 1
  }

  case "$platform" in
    macos)
      launchctl_bin="${EXAMPLE_RUNNER_LAUNCHCTL_BIN:-/bin/launchctl}"
      case "$service_value" in
        /*)
          service_path="$service_value"
          ;;
        *.plist)
          service_path="$HOME/Library/LaunchAgents/$service_value"
          ;;
        *)
          service_path="$HOME/Library/LaunchAgents/${service_value}.plist"
          ;;
      esac
      [ -f "$service_path" ] || {
        printf 'Runner service plist does not exist: %s\n' "$service_path"
        exit 1
      }
      ;;
    linux)
      systemctl_bin="${EXAMPLE_RUNNER_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
      if ! [[ "$service_value" =~ ^actions\.runner\.[A-Za-z0-9_.@-]+\.service$ ]]; then
        printf 'Unsafe Linux runner service identity: %s\n' "$service_value"
        exit 1
      fi
      service_working_directory="$(
        "$systemctl_bin" show --property=WorkingDirectory --value "$service_value"
      )"
      if [ "$service_working_directory" != "$runner_root" ]; then
        printf 'Linux runner service %s does not point to runner root %s.\n' \
          "$service_value" "$runner_root"
        exit 1
      fi
      service_exec_start="$(
        "$systemctl_bin" show --property=ExecStart --value "$service_value"
      )"
      if [[ "$service_exec_start" != *"$runner_root/runsvc.sh"* ]]; then
        printf "Linux runner service %s does not execute this runner's runsvc.sh.\n" \
          "$service_value"
        exit 1
      fi
      ;;
    *)
      printf 'Unsupported runner platform: %s\n' "$platform"
      exit 1
      ;;
  esac

  # This is the last point at which GitHub could still assign this listener a
  # new job before it stops accepting work below. Re-check immediately next
  # to that intervention so the remaining gap is only the file reads and case
  # resolution just above, not also the loop and settle wait before them.
  if "$pgrep_bin" -f "$worker_pattern" >/dev/null 2>&1; then
    printf 'Runner claimed replacement work immediately before service intervention; waiting for the next idle window.\n'
    continue
  fi
  break
done

case "$platform" in
  macos)
    # The transient launchd job is independent of the runner LaunchAgent. The
    # installer worker has exited, so unloading closes admission without
    # interrupting the job that requested this activation.
    service_unloaded=true
    "$launchctl_bin" unload "$service_path"
    listener_pattern="${runner_root}/bin[^/]*/Runner.Listener"
    listener_wait_seconds=0
    while "$pgrep_bin" -f "$listener_pattern" >/dev/null 2>&1; do
      if [ "$listener_wait_seconds" -ge 60 ]; then
        printf 'Runner listener did not drain within 60 seconds under %s.\n' "$runner_root"
        exit 1
      fi
      "$sleep_bin" 1
      listener_wait_seconds=$((listener_wait_seconds + 1))
    done

    # GitHub may retain the prior broker session briefly after the listener
    # exits. Do not expose a replacement listener to that stale session.
    "$sleep_bin" 5
    "$launchctl_bin" load -w "$service_path"
    service_unloaded=false
    ;;
  linux)
    # The installer worker has exited before this stop. Restart the idle
    # listener so its next worker inherits the new .env.
    service_stopped=true
    "$systemctl_bin" stop "$service_value"
    "$sleep_bin" 5
    "$systemctl_bin" start "$service_value"
    service_stopped=false
    ;;
esac

activation_succeeded=true

printf '[%s] runner environment activation completed for %s\n' "$(date -u +%FT%TZ)" "$runner_root"

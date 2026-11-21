#!/usr/bin/env bash

set -euo pipefail

# One health check at a time per host. The lock helper blocks in the kernel
# until the lock is free and releases it when this process exits.
if [[ -z "${EXAMPLE_IOS_SIMULATOR_HEALTH_LOCK_HELD:-}" ]]; then
  exec bash "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/with-file-lock.sh" \
    "${EXAMPLE_IOS_SIMULATOR_HEALTH_LOCK:-/private/tmp/example-ios-simulator-host-health.lock}" -- \
    env EXAMPLE_IOS_SIMULATOR_HEALTH_LOCK_HELD=1 bash "${BASH_SOURCE[0]}" "$@"
fi

run_with_timeout() {
  local seconds="$1"
  shift
  /usr/bin/perl -e 'my $seconds = shift @ARGV; alarm $seconds; exec @ARGV or die "exec failed: $!";' \
    "$seconds" "$@"
}

if run_with_timeout 15 xcrun simctl list devices >/dev/null 2>&1; then
  echo "CoreSimulator host is healthy; preserving active simulators."
  exit 0
fi

echo "::warning::CoreSimulator health check failed; restarting the unavailable host service."
if ! run_with_timeout 15 xcrun simctl shutdown all 2>/dev/null; then
  echo "::warning::CoreSimulator shutdown did not finish within 15 seconds."
fi
pkill -TERM -f "simctl shutdown all" 2>/dev/null || true
killall -9 com.apple.CoreSimulator.CoreSimulatorService 2>/dev/null || true
killall -9 Simulator 2>/dev/null || true
# launchd relaunches CoreSimulatorService on the next request, and that
# request blocks until the service answers, so nothing waits here.
run_with_timeout 30 xcrun simctl delete unavailable 2>/dev/null || true

if ! run_with_timeout 30 xcrun simctl list devices >/dev/null 2>&1; then
  echo "::error::CoreSimulator did not recover after its host service was restarted."
  exit 1
fi

echo "CoreSimulator host recovered successfully."

#!/usr/bin/env bash


run_with_timeout() {
  local simulator_setup_script_dir
  simulator_setup_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node "$simulator_setup_script_dir/../ci/src/actions/ios/runSetupCommand.ts" "$@"
}

# Compatibility bootstraps only; all simulator setup behavior has one typed owner.
run_ios_simulator_setup() {
  local simulator_setup_script_dir
  simulator_setup_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node "$simulator_setup_script_dir/../ci/src/actions/ios/prepareSimulator.ts" "$@"
}

wait_for_simulator_boot() { run_ios_simulator_setup boot "$@"; }
apply_simulator_defaults() { run_ios_simulator_setup defaults "$@"; }
prepare_simulator() { run_ios_simulator_setup prepare "$@"; }
verify_content_size() { run_ios_simulator_setup verify-content-size "$@"; }
set_and_verify_content_size() { run_ios_simulator_setup content-size "$@"; }

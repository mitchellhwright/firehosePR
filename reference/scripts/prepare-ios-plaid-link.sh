#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "${1//[[:space:]]/}" ]]; then
  echo "Usage: $0 <SourcePackages directory>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_packages="$1"
package_path="${repo_root}/ios/Packages/PlaidLink"
manifest="${package_path}/Package.swift"
artifact_path="${source_packages}/artifacts/plaidlink/LinkKit/LinkKit.xcframework"
device_binary="${artifact_path}/ios-arm64/LinkKit.framework/LinkKit"
simulator_binary="${artifact_path}/ios-arm64_x86_64-simulator/LinkKit.framework/LinkKit"
# Records which manifest pin produced the artifact and what the artifact was.
pin_stamp="${source_packages}/artifacts/plaidlink/.example-linkkit-pin"

manifest_pin="$(sed -n -E 's/^[[:space:]]*(url|checksum):[[:space:]]*"([^"]+)".*/\1=\2/p' "$manifest")"
url_count="$(grep -c '^url=' <<<"$manifest_pin" || true)"
checksum_count="$(grep -c '^checksum=' <<<"$manifest_pin" || true)"
if [[ "$url_count" -ne 1 || "$checksum_count" -ne 1 ]]; then
  echo "Expected exactly one LinkKit url and checksum in ${manifest}; found:" >&2
  echo "${manifest_pin:-nothing}" >&2
  exit 1
fi

artifact_is_ready() {
  [[ -f "${artifact_path}/Info.plist" ]] &&
    [[ -f "$device_binary" ]] &&
    [[ -f "$simulator_binary" ]]
}

expected_stamp() {
  printf '%s\n' "$manifest_pin"
  printf 'device=%s\n' "$(shasum -a 256 "$device_binary" | awk '{print $1}')"
  printf 'simulator=%s\n' "$(shasum -a 256 "$simulator_binary" | awk '{print $1}')"
}

# SourcePackages is a persistent runner cache shared across branches, so an
# artifact is reused only when this manifest pin resolved it and nothing has
# replaced it since. Anything else goes back through SwiftPM, which downloads
# the pinned archive again and verifies its checksum.
if artifact_is_ready && [[ -f "$pin_stamp" && "$(cat "$pin_stamp")" == "$(expected_stamp)" ]]; then
  echo "Plaid Link binary artifact is already prepared for the manifest pin."
  exit 0
fi
if artifact_is_ready; then
  echo "Cached Plaid Link binary artifact is not stamped for the manifest pin; re-resolving."
fi

mkdir -p "${source_packages}"
rm -f "$pin_stamp"
swift package resolve \
  --package-path "${package_path}" \
  --scratch-path "${source_packages}" \
  --disable-keychain \
  --disable-netrc

if ! artifact_is_ready; then
  echo "Plaid Link binary artifact was not materialized at ${artifact_path}" >&2
  exit 1
fi

plutil -lint "${artifact_path}/Info.plist" >/dev/null
expected_stamp >"$pin_stamp"
echo "Plaid Link binary artifact is ready."

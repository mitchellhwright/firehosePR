#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "Error: $*" >&2
  exit 1
}

verify_only=false
case "${1:-}" in
  '') ;;
  --verify-only) verify_only=true ;;
  *) fail "usage: $0 [--verify-only]" ;;
esac

[[ "$(uname -s)" == "Darwin" ]] || fail "macOS is required."

verify_proxy() {
  local proxy_path="$1"
  local version
  version="$("${proxy_path}" --version 2>&1)" ||
    fail "cloud-sql-proxy could not report its version."
  [[ "${version}" =~ ^cloud-sql-proxy[[:space:]]+version[[:space:]]+2\. ]] ||
    fail "cloud-sql-proxy v2 is required; found '${version}'."
}

if proxy_path="$(command -v cloud-sql-proxy 2>/dev/null)"; then
  verify_proxy "${proxy_path}"
  echo "Verified ${proxy_path}."
  exit 0
fi

[[ "${verify_only}" == false ]] ||
  fail "cloud-sql-proxy v2 is missing from the persistent runner PATH."

homebrew=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [[ -x "${candidate}" ]]; then
    homebrew="${candidate}"
    break
  fi
done
[[ -n "${homebrew}" ]] || fail "Homebrew is required to provision cloud-sql-proxy v2."

HOMEBREW_NO_AUTO_UPDATE=1 "${homebrew}" install cloud-sql-proxy
proxy_path="$(${homebrew} --prefix)/bin/cloud-sql-proxy"
[[ -x "${proxy_path}" ]] || fail "Homebrew did not install cloud-sql-proxy on the persistent PATH."
verify_proxy "${proxy_path}"
echo "Provisioned ${proxy_path}."

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ios_root="${repo_root}/ios"

if [[ ! -d "${ios_root}" ]]; then
  echo "iOS folder not found at ${ios_root}"
  exit 1
fi

cd "${ios_root}"
bundle install

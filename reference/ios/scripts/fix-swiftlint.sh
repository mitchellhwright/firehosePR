#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

(
  cd "$IOS_DIR"
  swiftlint --fix --config .swiftlint.yml
  swiftlint lint --config .swiftlint.yml
)

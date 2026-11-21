#!/usr/bin/env bash
set -euo pipefail
test "$(git rev-parse HEAD)" = "$EXACT_SHA"

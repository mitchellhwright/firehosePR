#!/usr/bin/env bash
set -euo pipefail
PRODUCTION_E2E_PASSWORD="$(openssl rand -hex 32)" \
  npx tsx server/scripts/production-e2e-users.ts delete

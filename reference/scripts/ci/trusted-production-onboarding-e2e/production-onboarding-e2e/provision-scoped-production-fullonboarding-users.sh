#!/usr/bin/env bash
set -euo pipefail
password="$(openssl rand -hex 32)"
echo "::add-mask::$password"
{
  echo "PRODUCTION_E2E_PASSWORD=$password"
  echo "UI_TEST_SYNTHETIC_ONBOARDING_EMAIL=onboard-ci-${PRODUCTION_E2E_RUN_ID}@test.example.local"
  echo "UI_TEST_SYNTHETIC_PRIVACY_EMAIL=privacy-ci-${PRODUCTION_E2E_RUN_ID}@test.example.local"
  echo "UI_TEST_SYNTHETIC_PASSWORD=$password"
} >> "$GITHUB_ENV"
echo "cleanup_required=true" >> "$GITHUB_OUTPUT"
PRODUCTION_E2E_PASSWORD="$password" \
  npx tsx server/scripts/production-e2e-users.ts provision

#!/bin/bash
set -euo pipefail

echo "=== ci_post_clone.sh START ==="
echo "CI_BUILD_NUMBER=${CI_BUILD_NUMBER:-unset}"
echo "CI_PRIMARY_REPOSITORY_PATH=${CI_PRIMARY_REPOSITORY_PATH:-unset}"

# Xcode Cloud manages the build number via its workflow settings.
# The export step stamps buildNumber from the workflow config,
# overriding whatever agvtool sets. This script updates the
# project file to match, keeping local and CI versions in sync.
if [ -n "${CI_BUILD_NUMBER:-}" ]; then
    cd "$CI_PRIMARY_REPOSITORY_PATH/ios"
    echo "Current version before update:"
    agvtool what-version
    agvtool new-version -all "$CI_BUILD_NUMBER"
    echo "Updated version to $CI_BUILD_NUMBER:"
    agvtool what-version
else
    echo "ERROR: CI_BUILD_NUMBER is not set — aborting to prevent stale build number"
    exit 1
fi

# Use production config for integration tests in CI.
# Debug builds load Config-Development.plist which points to localhost.
# Copy production config over dev so all integration tests hit the
# production server, Identity Platform tenant, and Cloud SQL database.
DEV_PLIST="$CI_PRIMARY_REPOSITORY_PATH/ios/example-ios/Config/Config-Development.plist"
PROD_PLIST="$CI_PRIMARY_REPOSITORY_PATH/ios/example-ios/Config/Config-Production.plist"
if [ -f "$PROD_PLIST" ] && [ -f "$DEV_PLIST" ]; then
    cp "$PROD_PLIST" "$DEV_PLIST"
    echo "Copied production config over dev config for CI integration tests"
fi

echo "=== ci_post_clone.sh END ==="

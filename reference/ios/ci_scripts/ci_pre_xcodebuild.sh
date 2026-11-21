#!/bin/bash
set -euo pipefail

mode="${1:-all}"
case "$mode" in
    all|simulator-defaults-only) ;;
    *)
        echo "Usage: $0 [all|simulator-defaults-only]" >&2
        exit 2
        ;;
esac

echo "=== ci_pre_xcodebuild.sh START ==="
echo "CI_XCODEBUILD_ACTION=${CI_XCODEBUILD_ACTION:-local}"

# Fallback in case the scheme still points at the full
# TestPlan.xctestplan: rewrite to CI-Unit.xctestplan (smallest safe
# plan, stays under the 120-min ceiling). ASC's "Specific Test Plans"
# selection overrides this via -testPlan when configured.

# Xcode Cloud's test-without-building workers restore test products and relocate
# ci_scripts to the repository root, but do not receive the source checkout.
# Source validation and scheme changes belong to the preceding build phase.
if [ "${CI_XCODEBUILD_ACTION:-}" = "test-without-building" ]; then
    echo "Using prebuilt test products; source checks and scheme setup ran during build-for-testing"
else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    SCHEME_PATH="$REPO_ROOT/ios/example-ios.xcodeproj/xcshareddata/xcschemes/example-ios.xcscheme"
    CI_TEST_PLAN="container:example-ios.xcodeproj/xcshareddata/TestPlans/CI-Unit.xctestplan"

    if [ "$mode" = "all" ]; then
        "$REPO_ROOT/ios/scripts/check-release-diagnostics-foundation.sh"

        if [ -f "$SCHEME_PATH" ]; then
            sed -i '' \
                "s|container:example-iosTests/TestPlan.xctestplan|$CI_TEST_PLAN|g" \
                "$SCHEME_PATH"
            echo "Scheme default rewritten to CI-Unit.xctestplan"
        else
            echo "WARNING: Scheme file not found at $SCHEME_PATH"
        fi
    fi
fi

# Disable Password AutoFill only on simulators provisioned for this run. A CI
# job must never mutate unrelated devices owned by another parallel lane.
simulator_udids="${IOS_CI_SIMULATOR_UDIDS:-}"
if [ -n "$simulator_udids" ]; then
    while IFS= read -r udid; do
        [ -n "$udid" ] || continue
        xcrun simctl spawn "$udid" defaults write -g AutoFillPasswords -bool NO 2>/dev/null || true
    done < <(printf '%s\n' "$simulator_udids" | tr ', ' '\n\n')
    echo "Password AutoFill disabled on run-owned simulators"
elif [ "${CI_XCODE_CLOUD:-}" = "TRUE" ]; then
    # Xcode Cloud workers are isolated to one build, so every available
    # simulator belongs to this build. GitHub runners must use the explicit
    # run-owned list above because multiple lanes can share a physical host.
    while IFS= read -r udid; do
        [ -n "$udid" ] || continue
        xcrun simctl spawn "$udid" defaults write -g AutoFillPasswords -bool NO 2>/dev/null || true
    done < <(
        xcrun simctl list devices -j 2>/dev/null |
            python3 -c 'import json, sys
for devices in json.load(sys.stdin).get("devices", {}).values():
    for device in devices:
        if device.get("isAvailable", False):
            print(device["udid"])' 2>/dev/null || true
    )
    echo "Password AutoFill disabled on available Xcode Cloud simulators"
else
    echo "No run-owned simulator UDIDs were supplied; simulator defaults are unchanged"
fi

echo "=== ci_pre_xcodebuild.sh END ==="

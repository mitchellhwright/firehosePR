#!/bin/bash
# Copy source Swift files, the Xcode project, test plans, and shared schema
# fixtures into the example-iosTests bundle at build time.
#
# Source-analysis tests read Swift files off disk to assert on copy,
# layout, and cross-file invariants. On Xcode Cloud the simulator test
# process cannot see /Volumes/workspace/repository/ (host sandbox) and
# /tmp is redirected per-simulator, so the repo root is unreachable.
# Bundling the tree into the test target's Resources puts it inside
# the sandbox where FileManager can always read it.
#
# Usage (Xcode build phase, example-iosTests target):
#   "${SRCROOT}/scripts/bundle_test_source_snapshot.sh"

set -euo pipefail

# TARGET_BUILD_DIR + CONTENTS_FOLDER_PATH is the canonical "write into my
# own bundle" path. For hosted tests (TEST_HOST set), Xcode reroutes
# TARGET_BUILD_DIR into the host app's PlugIns so the xctest lives inside
# the app — which is where Bundle(for:).resourceURL points at runtime.
# Xcode Cloud can execute either the hosted PlugIns bundle or the standalone
# .xctest product from test-without-building, so this script writes both below.
if [ -n "${TARGET_BUILD_DIR:-}" ] && [ -n "${CONTENTS_FOLDER_PATH:-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
    REPOSITORY_ROOT="$(cd "$IOS_DIR/.." && pwd)"
    APP_SOURCE_DIR="$IOS_DIR/example-ios"
    UI_TEST_SOURCE_DIR="$IOS_DIR/example-iosUITests"
    PROJECT_FILE="$IOS_DIR/example-ios.xcodeproj/project.pbxproj"
    TEST_PLAN_SOURCE_DIR="$IOS_DIR/example-ios.xcodeproj/xcshareddata/TestPlans"
    SHARED_SCHEMA_FIXTURES_DIR="$REPOSITORY_ROOT/shared/schemas/fixtures"
    PRIMARY_DEST_DIR="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/SourceSnapshot"
else
    echo "[SourceSnapshot] Not running inside Xcode build phase — skipping"
    exit 0
fi

echo "[SourceSnapshot] App source: $APP_SOURCE_DIR"
echo "[SourceSnapshot] UI test source: $UI_TEST_SOURCE_DIR"
echo "[SourceSnapshot] Xcode project: $PROJECT_FILE"
echo "[SourceSnapshot] Test plans: $TEST_PLAN_SOURCE_DIR"
echo "[SourceSnapshot] Shared schema fixtures: $SHARED_SCHEMA_FIXTURES_DIR"
DEST_DIRS=("$PRIMARY_DEST_DIR")

# Xcode Cloud's build-for-testing phase creates the hosted test bundle under
# the app's PlugIns directory, but test-without-building may execute the
# standalone .xctest product. Keep both copies in sync so source-inspection
# tests never fall back to the inaccessible /Volumes/workspace/repository path.
if [ -n "${BUILT_PRODUCTS_DIR:-}" ] && [ -n "${FULL_PRODUCT_NAME:-}" ]; then
    STANDALONE_DEST_DIR="$BUILT_PRODUCTS_DIR/$FULL_PRODUCT_NAME/SourceSnapshot"
    if [ "$STANDALONE_DEST_DIR" != "$PRIMARY_DEST_DIR" ]; then
        DEST_DIRS+=("$STANDALONE_DEST_DIR")
    fi
fi

echo "[SourceSnapshot] Destinations:"
for dest in "${DEST_DIRS[@]}"; do
    echo "[SourceSnapshot]   $dest"
done

if [ ! -d "$APP_SOURCE_DIR" ]; then
    echo "[SourceSnapshot] ERROR: $APP_SOURCE_DIR not found"
    exit 1
fi

if [ ! -d "$UI_TEST_SOURCE_DIR" ]; then
    echo "[SourceSnapshot] ERROR: $UI_TEST_SOURCE_DIR not found"
    exit 1
fi

if [ ! -f "$PROJECT_FILE" ]; then
    echo "[SourceSnapshot] ERROR: $PROJECT_FILE not found"
    exit 1
fi

if [ ! -d "$TEST_PLAN_SOURCE_DIR" ]; then
    echo "[SourceSnapshot] ERROR: $TEST_PLAN_SOURCE_DIR not found"
    exit 1
fi

if [ ! -d "$SHARED_SCHEMA_FIXTURES_DIR" ]; then
    echo "[SourceSnapshot] ERROR: $SHARED_SCHEMA_FIXTURES_DIR not found"
    exit 1
fi

for dest in "${DEST_DIRS[@]}"; do
    mkdir -p "$dest"

    # --delete prunes stale copies when files are removed or renamed,
    # so tests that enumerate the tree don't see ghosts.
    rsync -a --delete \
        --include='*/' \
        --include='*.swift' \
        --exclude='*' \
        "$APP_SOURCE_DIR/" "$dest/example-ios/"

    rsync -a --delete \
        --include='*/' \
        --include='*.swift' \
        --exclude='*' \
        "$UI_TEST_SOURCE_DIR/" "$dest/example-iosUITests/"

    mkdir -p "$dest/example-ios.xcodeproj/xcshareddata/TestPlans"
    rsync -a \
        "$PROJECT_FILE" \
        "$dest/example-ios.xcodeproj/project.pbxproj"

    rsync -a --delete \
        --include='*.xctestplan' \
        --exclude='*' \
        "$TEST_PLAN_SOURCE_DIR/" \
        "$dest/example-ios.xcodeproj/xcshareddata/TestPlans/"

    mkdir -p "$dest/shared/schemas/fixtures"
    rsync -a --delete \
        --include='*/' \
        --include='*.json' \
        --exclude='*' \
        "$SHARED_SCHEMA_FIXTURES_DIR/" \
        "$dest/shared/schemas/fixtures/"

    file_count=$(find "$dest" -name "*.swift" -type f 2>/dev/null | wc -l | tr -d ' ')
    plan_count=$(find "$dest" -name "*.xctestplan" -type f 2>/dev/null | wc -l | tr -d ' ')
    fixture_count=$(find "$dest/shared/schemas/fixtures" -name "*.json" -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "[SourceSnapshot] Bundled $file_count Swift files, the Xcode project, $plan_count test plans, and $fixture_count shared fixtures into $dest"
done

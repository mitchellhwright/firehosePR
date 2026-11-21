#!/bin/bash
# Copy server/docs into the app bundle at build time for local RAG
# Add this as a Run Script Build Phase in Xcode (before "Copy Bundle Resources")
#
# Usage in Xcode Build Phase:
#   "${SRCROOT}/scripts/bundle_server_docs.sh"

set -e

# Use Xcode build variables if available, otherwise fall back to script-relative paths
if [ -n "$BUILT_PRODUCTS_DIR" ] && [ -n "$UNLOCALIZED_RESOURCES_FOLDER_PATH" ]; then
    # Running from Xcode build phase
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    SERVER_DOCS="$PROJECT_ROOT/server/docs"
    DEST_DIR="$BUILT_PRODUCTS_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/ServerDocs"
else
    # Running standalone (for testing)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    SERVER_DOCS="$PROJECT_ROOT/server/docs"
    DEST_DIR="$PROJECT_ROOT/ios/example-ios/Resources/ServerDocs"
    echo "[BundleDocs] Running standalone (not in Xcode build phase)"
fi

echo "[BundleDocs] Source: $SERVER_DOCS"
echo "[BundleDocs] Destination: $DEST_DIR"

# Bail out gracefully if server/docs doesn't exist
if [ ! -d "$SERVER_DOCS" ]; then
    echo "[BundleDocs] Warning: $SERVER_DOCS not found, skipping"
    exit 0
fi

# Clean previous copy to avoid stale files
rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"

# Internal docs to skip (architecture/dev docs not useful for RAG)
SKIP_PATTERN="CHAT_ARCHITECTURE.md|TYPE_ARCHITECTURE.md|LEVEL_DATA_SOURCES.md"

# Copy markdown files
find "$SERVER_DOCS" -name "*.md" -type f | while read -r file; do
    filename=$(basename "$file")
    
    # Skip internal architecture docs
    if echo "$filename" | grep -qE "$SKIP_PATTERN"; then
        echo "[BundleDocs] Skipping internal: $filename"
        continue
    fi
    
    rel_path="${file#$SERVER_DOCS/}"
    dest_file="$DEST_DIR/$rel_path"
    mkdir -p "$(dirname "$dest_file")"
    cp "$file" "$dest_file"
done

# Copy docx files
find "$SERVER_DOCS" -name "*.docx" -type f | while read -r file; do
    rel_path="${file#$SERVER_DOCS/}"
    dest_file="$DEST_DIR/$rel_path"
    mkdir -p "$(dirname "$dest_file")"
    cp "$file" "$dest_file"
done

# Count files
total_files=$(find "$DEST_DIR" -type f \( -name "*.md" -o -name "*.docx" \) 2>/dev/null | wc -l | tr -d ' ')
echo "[BundleDocs] Copied $total_files documentation files to app bundle"

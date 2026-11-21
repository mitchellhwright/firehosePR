#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIAGNOSTICS_FILE="$IOS_ROOT/example-ios/Utils/Logger.swift"
PROBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/example-release-diagnostics.XXXXXX")"
PROBE_BINARY="$PROBE_DIR/release-diagnostics-probe"
DEBUG_PROBE_BINARY="$PROBE_DIR/debug-diagnostics-probe"
PROBE_STRINGS="$PROBE_DIR/release-diagnostics-probe.strings"
SENTINEL="private-payload-pr4142-release-regression"

cleanup() {
    rm -rf -- "$PROBE_DIR"
}
trap cleanup EXIT

# These probes execute on the build Mac, even when Xcode Cloud supplies an iOS
# SDKROOT. Select the host SDK explicitly for both compiler invocations.
HOST_SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"

cat > "$PROBE_DIR/main.swift" <<'SWIFT'
import Foundation

private var argumentEvaluations = 0

AppDiagnostics.debug({
    argumentEvaluations += 1
    return "private-payload-pr4142-release-regression"
}())
Logger.shared.error({
    argumentEvaluations += 1
    return "private-payload-pr4142-release-regression"
}())
logError({
    argumentEvaluations += 1
    return "private-payload-pr4142-release-regression"
}())

FileHandle.standardOutput.write(Data("releaseArgumentEvaluations=\(argumentEvaluations)\n".utf8))
SWIFT

xcrun --sdk macosx swiftc \
    -sdk "$HOST_SDK_PATH" \
    -O \
    -whole-module-optimization \
    -module-cache-path "$PROBE_DIR/module-cache" \
    "$DIAGNOSTICS_FILE" \
    "$PROBE_DIR/main.swift" \
    -o "$PROBE_BINARY"

PROBE_OUTPUT="$("$PROBE_BINARY")"
if [ "$PROBE_OUTPUT" != "releaseArgumentEvaluations=0" ]; then
    echo "error: Release diagnostics evaluated an arbitrary debug argument: $PROBE_OUTPUT" >&2
    exit 1
fi

xcrun --sdk macosx swiftc \
    -sdk "$HOST_SDK_PATH" \
    -DDEBUG \
    -module-cache-path "$PROBE_DIR/debug-module-cache" \
    "$DIAGNOSTICS_FILE" \
    "$PROBE_DIR/main.swift" \
    -o "$DEBUG_PROBE_BINARY"

cat > "$PROBE_DIR/Config-Development.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>App</key>
    <dict>
        <key>EnableLogging</key>
        <false/>
    </dict>
</dict>
</plist>
PLIST

DEBUG_PROBE_OUTPUT="$("$DEBUG_PROBE_BINARY")"
if [ "$DEBUG_PROBE_OUTPUT" != "releaseArgumentEvaluations=0" ]; then
    echo "error: disabled Debug diagnostics evaluated an arbitrary argument: $DEBUG_PROBE_OUTPUT" >&2
    exit 1
fi

strings "$PROBE_BINARY" > "$PROBE_STRINGS"
if grep -Fq "$SENTINEL" "$PROBE_STRINGS"; then
    echo "error: Release diagnostics embedded the private sentinel in the optimized artifact" >&2
    exit 1
fi

if ! grep -Fq 'privacy: .private(mask: .hash)' "$DIAGNOSTICS_FILE"; then
    echo "error: dynamic diagnostic values must use OSLog private hash masking" >&2
    exit 1
fi

if grep -Eq 'correlation=.*privacy: \.public' "$DIAGNOSTICS_FILE"; then
    echo "error: correlation values must not be logged with public privacy" >&2
    exit 1
fi

if grep -Eq '(^|[^[:alnum:]_])((Swift\.)?(print|debugPrint)|NSLog)[[:space:]]*\(' "$DIAGNOSTICS_FILE"; then
    echo "error: the diagnostics boundary must not use print/debugPrint/NSLog" >&2
    exit 1
fi

echo "Release diagnostics foundation guard passed."

#!/bin/bash

# SwiftLint Build Phase Script
# Add this as a "Run Script" build phase in Xcode
# 
# To add:
# 1. Select your project in Xcode
# 2. Select your target
# 3. Go to "Build Phases"
# 4. Click "+" and select "New Run Script Phase"
# 5. Paste the contents of this script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check for SwiftLint in common locations
if which swiftlint > /dev/null; then
    (
        cd "$IOS_DIR"
        swiftlint lint --config .swiftlint.yml
    )
elif [ -f "/opt/homebrew/bin/swiftlint" ]; then
    (
        cd "$IOS_DIR"
        /opt/homebrew/bin/swiftlint lint --config .swiftlint.yml
    )
elif [ -f "/usr/local/bin/swiftlint" ]; then
    (
        cd "$IOS_DIR"
        /usr/local/bin/swiftlint lint --config .swiftlint.yml
    )
else
    echo "warning: SwiftLint not installed. Install with: brew install swiftlint"
    echo "warning: Type mismatches between server and app may go undetected!"
fi

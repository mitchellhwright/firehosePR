#!/usr/bin/env bash
set -euo pipefail
command -v ffmpeg >/dev/null 2>&1 || {
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends ffmpeg
}
raw_video="$(find "$ONBOARDING_VIDEO_RUN_DIR/raw" -type f -name '*.raw.mp4' -print -quit)"
xcode_log="$(find "$ONBOARDING_VIDEO_RUN_DIR/raw" -type f -name '*xcodebuild*.log' -print -quit)"
test -n "$raw_video"
echo "ONBOARDING_E2E_XCODEBUILD_LOG=$xcode_log" >> "$GITHUB_ENV"
bash scripts/process-ios-e2e-video.sh \
  "$raw_video" \
  "$ONBOARDING_E2E_COMPRESSED_VIDEO"

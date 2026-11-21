#!/usr/bin/env bash
set -euo pipefail

raw_video="${1:?raw video path is required}"
output_video="${2:?output video path is required}"

[[ -s "$raw_video" ]] || {
  echo "::error::Raw E2E video is missing or empty: $raw_video"
  exit 1
}

mkdir -p "$(dirname "$output_video")"
ffmpeg -hide_banner -loglevel warning -y \
  -i "$raw_video" \
  -vf "scale='min(1080,iw)':-2" \
  -c:v libx264 \
  -preset veryfast \
  -crf 28 \
  -movflags +faststart \
  "$output_video"

[[ -s "$output_video" ]] || {
  echo "::error::Compressed E2E video is missing or empty: $output_video"
  exit 1
}

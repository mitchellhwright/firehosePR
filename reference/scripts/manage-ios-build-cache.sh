#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
lane="${2:-${IOS_CI_CACHE_LANE:-}}"
case "$mode" in
  prepare|prune|wipe-current) ;;
  *)
    echo "usage: $0 <prepare|prune|wipe-current> <lane>" >&2
    exit 2
    ;;
esac
if [[ ! "$lane" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "iOS cache lane must contain only lowercase letters, numbers, and hyphens" >&2
  exit 2
fi

home_input="${HOME:-}"
if [[ -z "$home_input" || ! -d "$home_input" ]]; then
  echo "Refusing iOS cache management for unsafe HOME=${home_input}" >&2
  exit 1
fi
home_dir="$(cd "$home_input" && pwd -P)"
cache_root_input="${IOS_CI_BUILD_CACHE_ROOT:-${home_dir}/.example-ios-build-cache}"
case "$cache_root_input" in
  /*/.example-ios-build-cache) ;;
  *)
    echo "Refusing non-dedicated iOS build cache root: $cache_root_input" >&2
    exit 1
    ;;
esac
if [[ -L "$cache_root_input" ]]; then
  echo "Refusing symlinked iOS build cache root: $cache_root_input" >&2
  exit 1
fi
mkdir -p "$cache_root_input"
cache_root="$(cd "$cache_root_input" && pwd -P)"
if [[ "${cache_root##*/}" != ".example-ios-build-cache" ]]; then
  echo "Refusing non-canonical iOS build cache root: $cache_root_input" >&2
  exit 1
fi

max_kb="${IOS_CI_BUILD_CACHE_MAX_KB:-30000000}"
if [[ ! "$max_kb" =~ ^[1-9][0-9]*$ ]]; then
  echo "IOS_CI_BUILD_CACHE_MAX_KB must be a positive integer" >&2
  exit 2
fi
cache_namespace="${IOS_CI_CACHE_NAMESPACE:-}"
if [[ -n "$cache_namespace" ]]; then
  if [[ ! "$cache_namespace" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "IOS_CI_CACHE_NAMESPACE must be a lowercase slug containing only letters, numbers, and single hyphens" >&2
    exit 2
  fi
  runner_slug="$cache_namespace"
else
  runner_slug="$(printf '%s' "${RUNNER_NAME:-local}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  runner_slug="${runner_slug#-}"
  runner_slug="${runner_slug%-}"
  if [[ -z "$runner_slug" ]]; then
    echo "Could not derive a safe iOS cache runner name" >&2
    exit 1
  fi
fi
lane_root="$cache_root/$runner_slug/$lane"

assert_current_entry() {
  local entry_input="${IOS_CI_BUILD_CACHE_ENTRY:-}"
  if [[ -z "$entry_input" || ! -d "$entry_input" || -L "$entry_input" ]]; then
    echo "Current iOS build cache entry is missing or unsafe" >&2
    return 1
  fi
  local entry
  entry="$(cd "$entry_input" && pwd -P)"
  case "$entry" in
    "$lane_root"/*) ;;
    *)
      echo "Current iOS build cache entry is outside lane root: $entry" >&2
      return 1
      ;;
  esac
  if [[ ! -f "$entry/manifest" || -L "$entry/manifest" ]]; then
    echo "Current iOS build cache entry has no trusted manifest" >&2
    return 1
  fi
  printf '%s\n' "$entry"
}

prune_lane() {
  local protected_entry="${1:-}"
  local total_kb
  [[ -d "$lane_root" && ! -L "$lane_root" ]] || return 0
  total_kb="$(du -sk "$lane_root" | awk '{print $1}')"
  [[ "$total_kb" =~ ^[0-9]+$ ]] || return 1
  while (( total_kb > max_kb )); do
    local candidate=""
    while IFS= read -r path; do
      [[ -n "$path" && "$path" != "$protected_entry" ]] || continue
      candidate="$path"
      break
    done < <(
      python3 - "$lane_root" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
entries = sorted(
    (path for path in root.iterdir() if path.is_dir() and not path.is_symlink()),
    key=lambda path: path.stat().st_mtime,
)
for entry in entries:
    print(entry)
PY
    )
    if [[ -z "$candidate" ]]; then
      break
    fi
    case "$candidate" in
      "$lane_root"/*) ;;
      *)
        echo "Refusing to prune cache outside lane root: $candidate" >&2
        return 1
        ;;
    esac
    echo "Pruning bounded iOS build cache entry $candidate"
    rm -rf -- "$candidate"
    total_kb="$(du -sk "$lane_root" | awk '{print $1}')"
  done
  echo "iOS build cache lane uses ${total_kb} KB (cap ${max_kb} KB)"
}

case "$mode" in
  prepare)
    package_resolved="${IOS_CI_PACKAGE_RESOLVED:-ios/example-ios.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved}"
    if [[ ! -f "$package_resolved" ]]; then
      echo "Package.resolved not found: $package_resolved" >&2
      exit 1
    fi
    xcode_fingerprint="${IOS_CI_XCODE_FINGERPRINT:-}"
    if [[ -z "$xcode_fingerprint" ]]; then
      xcode_fingerprint="$(xcodebuild -version | shasum -a 256 | awk '{print $1}')"
    elif [[ ! "$xcode_fingerprint" =~ ^[0-9a-f]{64}$ ]]; then
      echo "IOS_CI_XCODE_FINGERPRINT must be a lowercase SHA-256 digest" >&2
      exit 2
    fi
    package_fingerprint="$(shasum -a 256 "$package_resolved" | awk '{print $1}')"
    # Package.resolved does not pin local packages, so a binary target's URL or
    # checksum change in ios/Packages/*/Package.swift must key SourcePackages too.
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
    local_packages_fingerprint="$(
      cd "$repo_root" &&
        { find ios/Packages -name Package.swift -type f 2>/dev/null || true; } |
        LC_ALL=C sort |
        while IFS= read -r local_manifest; do
          printf '%s %s\n' "$(shasum -a 256 "$local_manifest" | awk '{print $1}')" "$local_manifest"
        done |
        shasum -a 256 | awk '{print $1}'
    )"
    entry="$lane_root/$xcode_fingerprint"
    reused_trusted_entry=false
    reusable_entry="$({
      python3 - "$lane_root" "$runner_slug" "$lane" "$xcode_fingerprint" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
runner = sys.argv[2]
lane = sys.argv[3]
xcode = sys.argv[4]
if not root.is_dir() or root.is_symlink():
    raise SystemExit(0)

entries = sorted(
    (path for path in root.iterdir() if path.is_dir() and not path.is_symlink()),
    key=lambda path: path.stat().st_mtime,
    reverse=True,
)
for entry in entries:
    manifest = entry / "manifest"
    if not manifest.is_file() or manifest.is_symlink():
        continue
    values = {}
    for line in manifest.read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value
    if (
        values.get("version") in {"1", "2"}
        and values.get("runner") == runner
        and values.get("lane") == lane
        and values.get("xcode") == xcode
    ):
        print(entry)
        break
PY
    } 2>/dev/null)"
    if [[ -n "$reusable_entry" ]]; then
      case "$reusable_entry" in
        "$lane_root"/*) entry="$reusable_entry" ;;
        *)
          echo "Refusing reusable iOS build cache entry outside lane root: $reusable_entry" >&2
          exit 1
          ;;
      esac
      reused_trusted_entry=true
      echo "Reusing persistent iOS build products for the unchanged Xcode toolchain: $entry"
      cached_local_packages="$(sed -n 's/^local_packages=//p' "$entry/manifest")"
      if [[ "$cached_local_packages" != "$local_packages_fingerprint" ]]; then
        echo "Local package manifests changed since this entry resolved them; discarding its SourcePackages."
        rm -rf -- "$entry/SourcePackages"
      fi
    fi
    expected_manifest="version=2
runner=$runner_slug
lane=$lane
xcode=$xcode_fingerprint
packages=$package_fingerprint
local_packages=$local_packages_fingerprint"
    if [[ "$reused_trusted_entry" != true && -e "$entry" ]]; then
      if [[ -L "$entry" || ! -d "$entry" || ! -f "$entry/manifest" || -L "$entry/manifest" ]] ||
         [[ "$(cat "$entry/manifest" 2>/dev/null || true)" != "$expected_manifest" ]]; then
        echo "Discarding invalid iOS build cache entry once before use: $entry"
        rm -rf -- "$entry"
      fi
    fi
    mkdir -p "$entry/DerivedData" "$entry/SourcePackages" "$entry/PackageCache"
    printf '%s\n' "$expected_manifest" > "$entry/manifest"
    touch "$entry"
    prune_lane "$entry"
    if [[ -n "${GITHUB_ENV:-}" ]]; then
      {
        echo "IOS_CI_BUILD_CACHE_ROOT=$cache_root"
        echo "IOS_CI_BUILD_CACHE_ENTRY=$entry"
        echo "IOS_CI_CACHE_LANE=$lane"
        echo "IOS_CI_DERIVED_DATA=$entry/DerivedData"
        echo "IOS_CI_SOURCE_PACKAGES=$entry/SourcePackages"
        echo "IOS_CI_PACKAGE_CACHE=$entry/PackageCache"
      } >> "$GITHUB_ENV"
    fi
    printf 'IOS_CI_BUILD_CACHE_ENTRY=%s\n' "$entry"
    ;;
  prune)
    # Execution-only jobs restore precompiled products and never prepare a cache.
    # A configured entry must still pass the ownership and manifest checks below.
    if [[ -z "${IOS_CI_BUILD_CACHE_ENTRY:-}" ]]; then
      echo "No build cache was prepared for this job; nothing to prune"
      exit 0
    fi
    current_entry="$(assert_current_entry)"
    touch "$current_entry"
    prune_lane ""
    ;;
  wipe-current)
    current_entry="$(assert_current_entry)"
    echo "Wiping recognized-corrupt iOS build cache entry once: $current_entry"
    rm -rf -- \
      "$current_entry/DerivedData" \
      "$current_entry/SourcePackages" \
      "$current_entry/PackageCache"
    mkdir -p \
      "$current_entry/DerivedData" \
      "$current_entry/SourcePackages" \
      "$current_entry/PackageCache"
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_temp="${RUNNER_TEMP:-/tmp}"
run_id="${GITHUB_RUN_ID:-local}"
run_attempt="${GITHUB_RUN_ATTEMPT:-0}"
exact_head_sha="${EXPECTED_HEAD_SHA:-${GITHUB_SHA:-}}"
run_dir="$(mktemp -d "${runner_temp}/example-ios-release-archive.${run_id}.${run_attempt}.XXXXXX")"
archive_path="${run_dir}/Example.xcarchive"
build_log="${run_dir}/release-archive-xcodebuild.log"

cleanup_archive() {
  rm -rf -- "${archive_path}"
}
trap cleanup_archive EXIT

if [[ ! "${exact_head_sha}" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "::error::EXPECTED_HEAD_SHA must be the exact 40-character head commit" >&2
  exit 2
fi
if [[ "$(git -C "${repo_root}" rev-parse HEAD)" != "${exact_head_sha}" ]]; then
  echo "::error::Release archive checkout does not match exact head ${exact_head_sha}" >&2
  exit 1
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "IOS_RELEASE_ARCHIVE_XCODEBUILD_LOG=${build_log}" >> "${GITHUB_ENV}"
fi

mkdir -p \
  "${IOS_CI_DERIVED_DATA:?}" \
  "${IOS_CI_SOURCE_PACKAGES:?}" \
  "${IOS_CI_PACKAGE_CACHE:?}"
bash "${repo_root}/scripts/prepare-ios-plaid-link.sh" "${IOS_CI_SOURCE_PACKAGES}"

echo "::group::Compile unsigned exact-head iOS Release archive"
archive_status=0
bash "${repo_root}/scripts/run-with-ios-cache-recovery.sh" \
  "${build_log}" -- \
  node "${repo_root}/ci/src/actions/ios/guardIosIncrementalBuild.ts" "${IOS_CI_DERIVED_DATA}" -- \
  xcodebuild archive \
  -project "${repo_root}/ios/example-ios.xcodeproj" \
  -scheme example-ios \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "${archive_path}" \
  -derivedDataPath "${IOS_CI_DERIVED_DATA}" \
  -clonedSourcePackagesDirPath "${IOS_CI_SOURCE_PACKAGES}" \
  -packageCachePath "${IOS_CI_PACKAGE_CACHE}" \
  -disableAutomaticPackageResolution \
  COMPILER_INDEX_STORE_ENABLE=NO \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  || archive_status=$?
echo "::endgroup::"

if [[ "${archive_status}" -ne 0 ]]; then
  echo "::error::Unsigned iOS Release archive failed for ${exact_head_sha}" >&2
  exit "${archive_status}"
fi
if ! find "${archive_path}/Products/Applications" \
  -maxdepth 1 -type d -name '*.app' -print -quit | grep -q .; then
  echo "::error::Unsigned iOS Release archive did not contain an application" >&2
  exit 1
fi

echo "::notice::Unsigned iOS Release archive compiled exact head ${exact_head_sha}."

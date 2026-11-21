#!/usr/bin/env bash
set -euo pipefail

archive_path="${1:-}"
if [[ -z "${archive_path}" || ! -d "${archive_path}" ]]; then
  echo "Required-reason API validation needs an existing .xcarchive path" >&2
  exit 2
fi

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/example-required-reason.XXXXXX")"
trap 'rm -rf -- "${scratch_dir}"' EXIT

applications_dir="${archive_path}/Products/Applications"
application_paths="${scratch_dir}/applications"
if ! find "${applications_dir}" -maxdepth 1 -type d -name '*.app' -print -quit >"${application_paths}"; then
  echo "Failed to enumerate applications in ${applications_dir}" >&2
  exit 1
fi
app_path="$(cat "${application_paths}")"
if [[ -z "${app_path}" ]]; then
  echo "Release archive does not contain an application in ${applications_dir}" >&2
  exit 1
fi

info_plist="${app_path}/Info.plist"
privacy_manifest="${app_path}/PrivacyInfo.xcprivacy"
if [[ ! -f "${info_plist}" || ! -f "${privacy_manifest}" ]]; then
  echo "Release application is missing Info.plist or PrivacyInfo.xcprivacy" >&2
  exit 1
fi

bundle_info_plists="${scratch_dir}/bundle-info-plists"
candidate_files="${scratch_dir}/candidate-files"
privacy_manifests="${scratch_dir}/privacy-manifests"
executable_paths="${scratch_dir}/executables"
unique_executable_paths="${scratch_dir}/executables-unique"
strings_output="${scratch_dir}/strings"
file_output="${scratch_dir}/file"
disk_space_matches="${scratch_dir}/matches"
disk_space_markers="${scratch_dir}/markers"

read_bundle_executable() {
  local bundle_info_plist="$1"
  local executable_name=""

  executable_name="$(plutil -extract CFBundleExecutable raw "${bundle_info_plist}" 2>/dev/null || true)"
  if [[ -z "${executable_name}" ]] && grep -q '<plist' "${bundle_info_plist}"; then
    executable_name="$(
      tr '\n' ' ' <"${bundle_info_plist}" |
        sed -nE 's|.*<key>[[:space:]]*CFBundleExecutable[[:space:]]*</key>[[:space:]]*<string>([^<]+)</string>.*|\1|p'
    )"
  fi

  printf '%s' "${executable_name}"
}

if ! find "${app_path}" -type f -name 'Info.plist' -print0 >"${bundle_info_plists}"; then
  echo "Failed to enumerate Release bundle metadata in ${app_path}" >&2
  exit 1
fi
while IFS= read -r -d '' bundle_info_plist; do
  executable_name="$(read_bundle_executable "${bundle_info_plist}")"
  [[ -n "${executable_name}" ]] || continue

  executable_path="$(dirname "${bundle_info_plist}")/${executable_name}"
  if [[ ! -f "${executable_path}" ]]; then
    echo "Release bundle executable is missing: ${executable_path}" >&2
    exit 1
  fi
  printf '%s\n' "${executable_path}" >>"${executable_paths}"
done <"${bundle_info_plists}"

# Include unbundled Mach-O images, such as dylibs, that have no Info.plist.
if ! find "${app_path}" -type f -print0 >"${candidate_files}"; then
  echo "Failed to enumerate Release archive files in ${app_path}" >&2
  exit 1
fi
while IFS= read -r -d '' candidate_path; do
  if ! file -b "${candidate_path}" >"${file_output}"; then
    echo "Failed to classify Release archive file for required-reason API validation: ${candidate_path}" >&2
    exit 1
  fi

  file_grep_status=0
  grep -q 'Mach-O' "${file_output}" || file_grep_status=$?
  if [[ "${file_grep_status}" -eq 0 ]]; then
    printf '%s\n' "${candidate_path}" >>"${executable_paths}"
  elif [[ "${file_grep_status}" -ne 1 ]]; then
    echo "Failed to filter Release archive file classification: ${candidate_path}" >&2
    exit 1
  fi
done <"${candidate_files}"

if ! sort -u "${executable_paths}" >"${unique_executable_paths}"; then
  echo "Failed to prepare the Release executable list for required-reason API validation" >&2
  exit 1
fi
if [[ ! -s "${unique_executable_paths}" ]]; then
  echo "Release application does not contain a bundle or Mach-O executable" >&2
  exit 1
fi

disk_space_pattern='NSFileSystem(FreeSize|Size)|NSURLVolume(AvailableCapacity(Key|ForImportantUsageKey|ForOpportunisticUsageKey)?|TotalCapacityKey)|volume(Available|Total)Capacity|attributesOfFileSystem|(^|[^[:alnum:]])(statfs|statvfs|fstatfs|fstatvfs|getmntinfo|getattrlist|fgetattrlist|getattrlistat)([^[:alnum:]]|$)'
while IFS= read -r executable_path; do
  if ! strings -a "${executable_path}" >"${strings_output}"; then
    echo "Failed to inspect Release executable for required-reason API markers: ${executable_path}" >&2
    exit 1
  fi

  grep_status=0
  grep -E "${disk_space_pattern}" "${strings_output}" >"${disk_space_matches}" || grep_status=$?
  if [[ "${grep_status}" -ne 0 && "${grep_status}" -ne 1 ]]; then
    echo "Failed to filter required-reason API markers for Release executable: ${executable_path}" >&2
    exit 1
  fi

  if ! sort -u "${disk_space_matches}" >"${disk_space_markers}"; then
    echo "Failed to sort required-reason API markers for Release executable: ${executable_path}" >&2
    exit 1
  fi

  if [[ -s "${disk_space_markers}" ]]; then
    echo "Release executable contains forbidden DiskSpace required-reason API markers: ${executable_path}" >&2
    cat "${disk_space_markers}" >&2
    exit 1
  fi
done <"${unique_executable_paths}"

if ! find "${app_path}" -type f -name 'PrivacyInfo.xcprivacy' -print0 >"${privacy_manifests}"; then
  echo "Failed to enumerate Release privacy manifests in ${app_path}" >&2
  exit 1
fi
while IFS= read -r -d '' candidate_privacy_manifest; do
  privacy_manifest_xml="$(plutil -convert xml1 -o - "${candidate_privacy_manifest}" 2>/dev/null || true)"
  if [[ -z "${privacy_manifest_xml}" ]]; then
    if grep -q '<plist' "${candidate_privacy_manifest}"; then
      privacy_manifest_xml="$(cat "${candidate_privacy_manifest}")"
    else
      echo "Release privacy manifest could not be converted to XML: ${candidate_privacy_manifest}" >&2
      exit 1
    fi
  fi
  if grep -q 'NSPrivacyAccessedAPICategoryDiskSpace' <<<"${privacy_manifest_xml}"; then
    echo "Release privacy manifest declares DiskSpace even though Local AI is not observable in production: ${candidate_privacy_manifest}" >&2
    exit 1
  fi
done <"${privacy_manifests}"

echo "Required-reason API validation passed: production DiskSpace access is absent"

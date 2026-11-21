#!/usr/bin/env bash

set -euo pipefail

readonly SCRIPT_DIR
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  cat <<'EOF'
Usage:
  scripts/setup-github-macos-runner.sh <owner/repo>

Required:
  - GITHUB_TOKEN or GH_TOKEN for a repository administrator
    (fine-grained token: Administration write; classic token: repo)

Optional env vars:
  - RUNNER_INSTALL_DIR  Empty, persistent install directory
                        (default: $HOME/actions-runner-example-app)
  - RUNNER_NAME         Runner name shown in GitHub
                        (default: example-macos-runner)
  - RUNNER_WORKDIR      Work directory relative to the install directory
                        (default: _work)
  - RUNNER_VERSION      GitHub Actions runner release tag
                        (default: v2.337.0)
  - RUNNER_LABELS       Comma-separated custom role labels
                        (default: ios-xcode)
  - RUNNER_GROUP        Runner group (default: Default)
  - RUNNER_HOOK_ROOT    Trusted host-side hook directory outside the runner
                        application (default:
                        $HOME/.local/libexec/example-actions-runner/$RUNNER_NAME)
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

readonly REPO="$1"
[[ "${REPO}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "repository must be in owner/repo format."

command -v gh >/dev/null 2>&1 ||
  fail "gh CLI not found. Install it from https://cli.github.com/."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  fail "sha256sum or shasum is required to verify the runner download."
fi

if [[ -z "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]]; then
  fail "GITHUB_TOKEN or GH_TOKEN must be set."
fi
if [[ -z "${GH_TOKEN:-}" ]]; then
  export GH_TOKEN="${GITHUB_TOKEN}"
fi

runner_version="${RUNNER_VERSION:-v2.337.0}"
if [[ "${runner_version}" != v* ]]; then
  runner_version="v${runner_version}"
fi
[[ "${runner_version}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  fail "RUNNER_VERSION must be a release tag such as v2.337.0."
readonly RUNNER_VERSION="${runner_version}"

case "$(uname -m)" in
  arm64)
    readonly DEFAULT_ARCH_LABEL="ARM64"
    readonly RUNNER_PACKAGE="actions-runner-osx-arm64-${RUNNER_VERSION#v}.tar.gz"
    ;;
  x86_64)
    readonly DEFAULT_ARCH_LABEL="X64"
    readonly RUNNER_PACKAGE="actions-runner-osx-x64-${RUNNER_VERSION#v}.tar.gz"
    ;;
  *)
    fail "unsupported architecture '$(uname -m)'."
    ;;
esac

readonly RUNNER_INSTALL_DIR="${RUNNER_INSTALL_DIR:-${HOME}/actions-runner-example-app}"
readonly RUNNER_LABELS="${RUNNER_LABELS:-ios-xcode}"
readonly RUNNER_NAME="${RUNNER_NAME:-example-macos-runner}"
readonly RUNNER_GROUP="${RUNNER_GROUP:-Default}"
readonly RUNNER_WORKDIR="${RUNNER_WORKDIR:-_work}"
readonly RUNNER_HOOK_ROOT="${RUNNER_HOOK_ROOT:-${HOME}/.local/libexec/example-actions-runner/${RUNNER_NAME}}"

[[ "${RUNNER_INSTALL_DIR}" == /* ]] || fail "RUNNER_INSTALL_DIR must be an absolute path."
[[ "${RUNNER_HOOK_ROOT}" == /* ]] || fail "RUNNER_HOOK_ROOT must be an absolute path."
[[ "${RUNNER_WORKDIR}" =~ ^[A-Za-z0-9._-]+$ ]] ||
  fail "RUNNER_WORKDIR must be a relative directory name."
case "${RUNNER_HOOK_ROOT}" in
  "${RUNNER_INSTALL_DIR}"|"${RUNNER_INSTALL_DIR}"/*)
    fail "RUNNER_HOOK_ROOT must be outside RUNNER_INSTALL_DIR."
    ;;
esac
if [[ -e "${RUNNER_INSTALL_DIR}" && ! -d "${RUNNER_INSTALL_DIR}" ]]; then
  fail "RUNNER_INSTALL_DIR must be a directory."
fi
if [[ -d "${RUNNER_INSTALL_DIR}" ]] &&
   [[ -n "$(find "${RUNNER_INSTALL_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  fail "RUNNER_INSTALL_DIR must be empty; refusing to replace an existing runner."
fi

runner_requires_ios_image=false
IFS=',' read -r -a configured_runner_labels <<< "${RUNNER_LABELS}"
for configured_runner_label in "${configured_runner_labels[@]}"; do
  if [[ "${configured_runner_label}" == "ios-xcode" ]]; then
    runner_requires_ios_image=true
    break
  fi
done
if [[ "${runner_requires_ios_image}" == true ]]; then
  command -v python3 >/dev/null 2>&1 ||
    fail "python3 is required to verify the reusable iOS runner image."
  "${SCRIPT_DIR}/provision-github-macos-runner-tools.sh"
  echo "Verifying reusable iOS runner image before registration."
  python3 "${SCRIPT_DIR}/ios-ci-image-prerequisites.py"
fi

readonly RELEASE_URL="https://github.com/actions/runner/releases/download/${RUNNER_VERSION}/${RUNNER_PACKAGE}"
if ! expected_digest="$(
  gh api "repos/actions/runner/releases/tags/${RUNNER_VERSION}" \
    --jq ".assets[] | select(.name == \"${RUNNER_PACKAGE}\") | .digest" \
    2>/dev/null
)"; then
  fail "could not read release metadata for ${RUNNER_VERSION}."
fi
[[ "${expected_digest}" =~ ^sha256:[a-f0-9]{64}$ ]] ||
  fail "GitHub did not publish a SHA-256 digest for ${RUNNER_PACKAGE}."
readonly EXPECTED_SHA256="${expected_digest#sha256:}"

download_dir="$(mktemp -d "${TMPDIR:-/tmp}/example-github-runner.XXXXXX")"
readonly DOWNLOAD_DIR="${download_dir}"
readonly DOWNLOAD_PATH="${DOWNLOAD_DIR}/${RUNNER_PACKAGE}"
cleanup() {
  rm -f -- "${DOWNLOAD_PATH}"
  rmdir "${DOWNLOAD_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

echo "Using GitHub repo: ${REPO}"
echo "Runner version: ${RUNNER_VERSION}"
echo "Package: ${RUNNER_PACKAGE}"
echo "Install directory: ${RUNNER_INSTALL_DIR}"

curl -fsSL -o "${DOWNLOAD_PATH}" "${RELEASE_URL}"
if command -v sha256sum >/dev/null 2>&1; then
  printf '%s  %s\n' "${EXPECTED_SHA256}" "${DOWNLOAD_PATH}" | sha256sum -c -
else
  actual_sha256="$(shasum -a 256 "${DOWNLOAD_PATH}" | awk '{print $1}')"
  [[ "${actual_sha256}" == "${EXPECTED_SHA256}" ]] || fail "runner package checksum mismatch."
fi

mkdir -p "${RUNNER_INSTALL_DIR}"
tar -xzf "${DOWNLOAD_PATH}" -C "${RUNNER_INSTALL_DIR}"
cd "${RUNNER_INSTALL_DIR}"

runner_token="$(gh api --method POST "repos/${REPO}/actions/runners/registration-token" --jq '.token')"
config_args=(
  --unattended
  --url "https://github.com/${REPO}"
  --token "${runner_token}"
  --name "${RUNNER_NAME}"
  --work "${RUNNER_WORKDIR}"
  --runnergroup "${RUNNER_GROUP}"
)
if [[ -n "${RUNNER_LABELS}" ]]; then
  config_args+=(--labels "${RUNNER_LABELS}")
fi
./config.sh "${config_args[@]}"

# The runner persists PATH in .path and restores that value for every job.
# SSH sessions and launchd commonly expose only Apple's system paths, which
# hides Homebrew even when it is installed. Persist the supported locations
# explicitly so baked tools are reusable after service restarts.
printf '%s\n' \
  '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' \
  > .path

hook_path="${RUNNER_HOOK_ROOT}/job-completed.sh"
# The runner package bundles Node 24, which also runs the hook itself.
./externals/node24/bin/node "${SCRIPT_DIR}/../ci/src/actions/installJobCompletedHook.ts" \
  "${RUNNER_INSTALL_DIR}" "${RUNNER_HOOK_ROOT}"
cat >> .env <<EOF
EXAMPLE_ACTIONS_RUNNER_ROOT=${RUNNER_INSTALL_DIR}
EXAMPLE_ACTIONS_RUNNER_WORKDIR=${RUNNER_WORKDIR}
ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${hook_path}
EOF

echo
echo "Runner registration completed with automatic labels self-hosted,macOS,${DEFAULT_ARCH_LABEL}."
if [[ -n "${RUNNER_LABELS}" ]]; then
  echo "Custom role labels: ${RUNNER_LABELS}"
fi
echo "Completed-job cleanup hook: ${hook_path}"
echo "Install and start the service only after reviewing docs/ci/self-hosted-macos-runner.md."
echo "  cd ${RUNNER_INSTALL_DIR}"
echo "  ./svc.sh install"
echo "  ./svc.sh start"

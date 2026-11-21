#!/usr/bin/env python3
"""Install runtimes only while baking; CI verifies prerequisites without downloads."""
import argparse
import json
import subprocess
import sys

POLICY_VERSION = 2

# The SDK and simulator runtime profile of the pinned CI Xcode.
#
# The pin itself is pinnedIosXcodeToolchain in ci/src/ios/toolchainPolicy.ts;
# the workflow's Xcode selection step activates exactly that build, and a test
# (ci/tests/selectXcode.test.ts) keeps this profile on the same version and
# build. To move the pin, change both together with values read from a real
# host:
#     xcodebuild -version
#     xcrun --sdk iphonesimulator --show-sdk-version
#     xcrun simctl list runtimes
# Never guess a build string. An exact pin against a wrong build rejects the
# real toolchain and takes the lane down.
TOOLCHAINS = (
    {
        # Xcode 27 (27A266a), released 2026-09-14 -- a stable GA build, not a
        # prerelease: Apple's releases index lists it without the "beta" that
        # marks e.g. "Xcode 27.2 beta (27B5019j)". The trailing lowercase
        # letter is ordinary in Xcode GA build strings and does not imply a
        # seed. Values read from runner ts-2 on 2026-09-17.
        'name': 'xcode-27.0',
        'xcode_version': '27.0',
        'xcode_build': '27A266a',
        'sdk_version': '27.0',
        # The iOS 27.0 simulator runtime Xcode 27.0 installs by default, as
        # `xcrun simctl list runtimes` reports it on the sagent Mac:
        # "iOS 27.0 (27.0 - 24A434)".
        'runtime_version': '27.0',
        'runtime_build': '24A434',
        'runtime_identifier': 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
    },
)

PROFILE_FIELDS = ('name', 'xcode_version', 'xcode_build', 'sdk_version',
                  'runtime_version', 'runtime_build', 'runtime_identifier')

# The reviewed default lane. Retained for callers that still describe the
# fleet by one toolchain; the admissible set is what verification uses.
PRIMARY_XCODE_VERSION = TOOLCHAINS[0]['xcode_version']
PRIMARY_XCODE_BUILD = TOOLCHAINS[0]['xcode_build']
PRIMARY_SDK_VERSION = TOOLCHAINS[0]['sdk_version']
PRIMARY_RUNTIME_VERSION = TOOLCHAINS[0]['runtime_version']
PRIMARY_RUNTIME_BUILD = TOOLCHAINS[0]['runtime_build']
PRIMARY_RUNTIME_IDENTIFIER = TOOLCHAINS[0]['runtime_identifier']


def command(*args, timeout=120):
    return subprocess.check_output(args, text=True, timeout=timeout).strip()


def describe(toolchain):
    return f"Xcode {toolchain['xcode_version']} ({toolchain['xcode_build']})"


def admissible():
    """Every declared toolchain, validated so an incomplete entry cannot pass."""
    for toolchain in TOOLCHAINS:
        missing = [field for field in PROFILE_FIELDS if not toolchain.get(field)]
        if missing:
            raise RuntimeError(
                f"Toolchain profile {toolchain.get('name', '<unnamed>')} is incomplete: "
                + ', '.join(missing)
                + '. Fill it from a real host; a guessed pin rejects the real toolchain.')
    return TOOLCHAINS


def sdk_for(purpose):
    """The SDK a purpose compiles against.

    The Release archive builds for generic/platform=iOS and never boots a
    simulator, so it needs the device SDK and no simulator runtime. Every
    other purpose runs on a simulator.
    """
    return 'iphoneos' if purpose == 'archive' else 'iphonesimulator'


def needs_simulator_runtime(purpose):
    return purpose != 'archive'


def resolve_toolchain(xcode, sdk, sdk_name='iphonesimulator'):
    """Match the host's reported Xcode and SDK against the admissible set."""
    for toolchain in admissible():
        if xcode.splitlines() == [f"Xcode {toolchain['xcode_version']}",
                                  f"Build version {toolchain['xcode_build']}"]:
            if sdk != toolchain['sdk_version']:
                raise RuntimeError(
                    f"{describe(toolchain)} requires {sdk_name} SDK "
                    f"{toolchain['sdk_version']}; found {sdk}")
            return toolchain
    expected = ', '.join(describe(toolchain) for toolchain in admissible())
    raise RuntimeError(f'Image requires a stable admissible toolchain ({expected}); found {xcode}')


def select_runtimes(payload, toolchain, purpose='all'):
    selected = [row for row in payload.get('runtimes', [])
                if row.get('isAvailable')
                and row.get('identifier') == toolchain['runtime_identifier']
                and row.get('buildversion') == toolchain['runtime_build']]
    missing = [] if selected else [
        (f"primary iOS {toolchain['runtime_version']}", toolchain['runtime_build'])]
    return selected, missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true', help='Runner host setup only; downloads missing runtimes')
    parser.add_argument('--purpose', choices=['all', 'storekit', 'onboarding', 'archive'], default='all')
    args = parser.parse_args()
    xcode = command('/usr/bin/xcodebuild', '-version')
    sdk_name = sdk_for(args.purpose)
    sdk = command('/usr/bin/xcrun', '--sdk', sdk_name, '--show-sdk-version')
    toolchain = resolve_toolchain(xcode, sdk, sdk_name)
    selected, missing = [], []
    if needs_simulator_runtime(args.purpose):
        payload = json.loads(command('/usr/bin/xcrun', 'simctl', 'list', 'runtimes', '-j'))
        selected, missing = select_runtimes(payload, toolchain, args.purpose)
    if args.install and missing:
        for name, build in missing:
            print(f'Baking {name}, build {build}', file=sys.stderr)
            download = ['/usr/bin/xcodebuild', '-downloadPlatform', 'iOS', '-buildVersion', build]
            download.extend(['-architectureVariant', 'arm64'])
            subprocess.run(download, check=True, timeout=1800, stdout=sys.stderr)
        payload = json.loads(command('/usr/bin/xcrun', 'simctl', 'list', 'runtimes', '-j'))
        selected, missing = select_runtimes(payload, toolchain, args.purpose)
    if missing:
        raise RuntimeError('Image prerequisite missing: ' + ', '.join(name for name, _ in missing)
                           + '. Install the runtime on the runner host; CI never downloads runtimes.')
    # Which toolchain produced this result is part of its provenance: with a
    # mixed fleet, "it passed" is ambiguous without naming where.
    print(json.dumps({'policyVersion': POLICY_VERSION, 'xcode': xcode,
                      'toolchain': toolchain['name'], 'sdk': f'{sdk_name} {sdk}',
                      'macOS': command('/usr/bin/sw_vers', '-productVersion'),
                      'runtimes': [{key: row.get(key) for key in ['identifier', 'version', 'buildversion']}
                                   for row in selected]}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.SubprocessError, ValueError, OSError) as error:
        print(f'::error::{error}', file=sys.stderr)
        sys.exit(1)

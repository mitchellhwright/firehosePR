#!/usr/bin/env python3
"""Provision a simulator owned by one GitHub Actions run."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


UUID_PATTERN = re.compile(
    r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
    r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"
)
WARM_TEMPLATE_NAME_PATTERN = re.compile(
    r"Example CI Warm (?:Standard|Narrow|Wide) ([0-9a-f]{12})"
)
RUNTIME_PATTERN = re.compile(r"iOS-([0-9-]+)$")
PURPOSE_LABELS = {
    "backend": "Backend Evidence",
    "evidence": "Evidence",
    "main": "Main",
    "main-budget": "Main Budget",
    "main-ui": "Main UI",
    "onboarding": "Onboarding",
    "storekit": "StoreKit",
}
# The runtimes the admissible toolchains require, as (version, identifier,
# build). Mirrors TOOLCHAINS in ios-ci-image-prerequisites.py: this file is
# copied standalone into the CI image, so it cannot import that policy and the
# two are kept in agreement by a test instead. Update both together -- a lane
# provisioning a runtime the policy does not admit is the same split-brain
# that took native CI down on 2026-09-17, just between two files.
PRIMARY_RUNTIMES = (
    ((27, 0), "com.apple.CoreSimulator.SimRuntime.iOS-27-0", "24A434"),
)
PRIMARY_RUNTIME_VERSIONS = frozenset(version for version, _, _ in PRIMARY_RUNTIMES)
PRIMARY_RUNTIME_PAIRS = frozenset(
    (identifier, build) for _, identifier, build in PRIMARY_RUNTIMES
)
# The reviewed default, for callers that still describe the lane by one runtime.
PRIMARY_RUNTIME_VERSION = PRIMARY_RUNTIMES[0][0]
PRIMARY_RUNTIME_IDENTIFIER = PRIMARY_RUNTIMES[0][1]
PRIMARY_RUNTIME_BUILD = PRIMARY_RUNTIMES[0][2]
NARROW_DEVICE_TYPE_IDENTIFIER = (
    "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation"
)


class SimulatorCleanupError(RuntimeError):
    """A prior owned simulator may still be running; do not allocate another."""


def load_simctl_json(*arguments: str) -> dict[str, Any]:
    completed = subprocess.run(
        ["xcrun", "simctl", *arguments, "-j"],
        capture_output=True,
        check=False,
        text=True,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            completed.stderr.strip()
            or f"simctl {' '.join(arguments)} failed with {completed.returncode}"
        )
    payload = json.loads(completed.stdout)
    if not isinstance(payload, dict):
        raise ValueError(f"simctl {' '.join(arguments)} returned a non-object")
    return payload


def extract_created_udid(output: str) -> str | None:
    matches = list(dict.fromkeys(UUID_PATTERN.findall(output)))
    return matches[0] if len(matches) == 1 else None


def exact_named_device_udids(payload: dict[str, Any], simulator_name: str) -> list[str]:
    devices_by_runtime = payload.get("devices")
    if not isinstance(devices_by_runtime, dict):
        raise ValueError("simulator inventory has no devices map")

    matches: list[str] = []
    for devices in devices_by_runtime.values():
        if not isinstance(devices, list):
            continue
        for device in devices:
            if not isinstance(device, dict) or device.get("name") != simulator_name:
                continue
            udid = device.get("udid")
            if isinstance(udid, str) and UUID_PATTERN.fullmatch(udid):
                matches.append(udid)
    return list(dict.fromkeys(matches))


def run_simctl(*arguments: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["xcrun", "simctl", *arguments],
        capture_output=True,
        check=False,
        text=True,
        timeout=timeout,
    )


def run_simctl_without_timeout(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["xcrun", "simctl", *arguments],
        capture_output=True,
        check=False,
        text=True,
    )


def xcode_install_fingerprint() -> str:
    result = subprocess.run(
        ["xcodebuild", "-version"],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "xcodebuild -version failed")

    identity = "\n".join(
        (os.environ.get("DEVELOPER_DIR", ""), result.stdout.strip())
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]


def warm_template_name(
    runtime_identifier: str,
    device_type_identifier: str,
    device_class: str,
) -> str:
    template_key = hashlib.sha256(
        f"bootstatus-v2|{xcode_install_fingerprint()}|{runtime_identifier}|{device_type_identifier}".encode(
            "utf-8"
        )
    ).hexdigest()[:12]
    return f"Example CI Warm {device_class.title()} {template_key}"


def warm_template_lock_path(template_name: str) -> Path:
    match = WARM_TEMPLATE_NAME_PATTERN.fullmatch(template_name)
    if match is None:
        raise ValueError("warm simulator template name is invalid")
    return Path(
        f"/tmp/example-ios-simulator-template-{os.getuid()}-{match.group(1)}.lock"
    )


def delete_warm_template_if_still_matching(
    runtime_identifier: str,
    template_udid: str,
    template_name: str,
) -> bool:
    if not UUID_PATTERN.fullmatch(template_udid):
        raise ValueError("warm simulator template UDID is invalid")
    if not re.fullmatch(
        r"com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9]+(?:-[0-9]+)*",
        runtime_identifier,
    ):
        raise ValueError("warm simulator template runtime is invalid")

    lock_path = warm_template_lock_path(template_name)
    lock_path.touch(mode=0o600, exist_ok=True)
    with lock_path.open("r+") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(
                f"Preserving locked warm simulator template {template_name}",
                file=sys.stderr,
            )
            return False

        inventory = load_simctl_json("list", "devices")
        devices_by_runtime = inventory.get("devices")
        if not isinstance(devices_by_runtime, dict):
            raise ValueError("simulator inventory has no devices map")
        devices = devices_by_runtime.get(runtime_identifier)
        if not isinstance(devices, list):
            print(
                f"Preserving warm simulator template {template_name}; "
                "its runtime is no longer present",
                file=sys.stderr,
            )
            return False
        matches = [
            device
            for device in devices
            if isinstance(device, dict)
            and device.get("udid") == template_udid
            and device.get("name") == template_name
            and device.get("isAvailable") is True
            and device.get("state") == "Shutdown"
        ]
        if len(matches) != 1:
            print(
                f"Preserving warm simulator template {template_name}; "
                "its identity or stopped state changed",
                file=sys.stderr,
            )
            return False

        for _ in range(2):
            deletion = run_simctl("delete", template_udid)
            if deletion.returncode == 0:
                return True
        print(
            f"Could not delete warm simulator template {template_name} "
            f"({template_udid})",
            file=sys.stderr,
        )
        return False


def create_simulator(
    simulator_name: str,
    device_type_identifier: str,
    runtime_identifier: str,
) -> str:
    result = run_simctl_without_timeout(
        "create",
        simulator_name,
        device_type_identifier,
        runtime_identifier,
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.strip() or result.stdout.strip() or "simctl create failed"
        )

    simulator_udid = extract_created_udid(result.stdout)
    if simulator_udid is None:
        raise RuntimeError(f"simctl create returned an invalid UDID: {result.stdout!r}")
    return simulator_udid


def warm_simulator(simulator_udid: str) -> None:
    boot_result = run_simctl("boot", simulator_udid)
    boot_message = f"{boot_result.stdout}\n{boot_result.stderr}".lower()
    if boot_result.returncode != 0 and "current state: booted" not in boot_message:
        raise RuntimeError(
            boot_result.stderr.strip() or boot_result.stdout.strip() or "simctl boot failed"
        )

    bootstatus_result = run_simctl_without_timeout("bootstatus", simulator_udid, "-b")
    # Observed on iOS 18.6: simctl exits zero after terminal migration
    # failure. Never promote that simulator into a reusable warm template.
    bootstatus_output = f"{bootstatus_result.stdout}\n{bootstatus_result.stderr}"
    migration_failed = re.search(
        r"Status=3,\s*isTerminal=YES|Data Migration Failed",
        bootstatus_output,
        re.IGNORECASE,
    ) is not None
    if bootstatus_result.returncode != 0 or migration_failed:
        raise RuntimeError(
            bootstatus_result.stderr.strip()
            or bootstatus_result.stdout.strip()
            or "simctl bootstatus failed"
        )

    shutdown_simulator(simulator_udid)


def shutdown_simulator(simulator_udid: str) -> None:
    # simctl shutdown returns when CoreSimulator has finished the shutdown, so
    # it is the blocking primitive: no command timeout (a timeout would leave
    # the device mid-transition with nothing to wait on but a poll), and the
    # workflow step's own bound covers a shutdown that never completes.
    result = run_simctl_without_timeout("shutdown", simulator_udid)
    message = f"{result.stdout}\n{result.stderr}".lower()
    if result.returncode != 0 and "current state: shutdown" not in message:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "simctl shutdown failed")


def clone_warmed_simulator(
    simulator_name: str,
    runtime_identifier: str,
    device_type_identifier: str,
    device_class: str,
) -> str:
    template_name = warm_template_name(
        runtime_identifier,
        device_type_identifier,
        device_class,
    )
    lock_path = warm_template_lock_path(template_name)

    lock_path.touch(mode=0o600, exist_ok=True)
    with lock_path.open("r+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        inventory = load_simctl_json("list", "devices")
        template_udids = exact_named_device_udids(inventory, template_name)

        if len(template_udids) > 1:
            for duplicate_udid in template_udids[1:]:
                run_simctl("shutdown", duplicate_udid)
                run_simctl("delete", duplicate_udid)
            template_udids = template_udids[:1]

        if template_udids:
            template_udid = template_udids[0]
        else:
            staging_name = f"{template_name} Staging {os.getpid()}"
            if not reap_partial_creations(staging_name):
                raise SimulatorCleanupError(f'Could not remove owned staging simulator {staging_name}')
            staging_udid = create_simulator(
                staging_name,
                device_type_identifier,
                runtime_identifier,
            )
            try:
                print(
                    f"Warming reusable simulator template {template_name}; "
                    "the first boot may perform platform migrations.",
                    file=sys.stderr,
                )
                warm_simulator(staging_udid)
                rename_result = run_simctl("rename", staging_udid, template_name)
                if rename_result.returncode != 0:
                    raise RuntimeError(
                        rename_result.stderr.strip()
                        or rename_result.stdout.strip()
                        or "simctl rename failed"
                    )
                template_udid = staging_udid
            except Exception as error:
                print(f"Simulator template warmup failed for {staging_name}: {error}", file=sys.stderr)
                # A shutdown timeout must not skip deletion and then boot another
                # candidate alongside the abandoned staging simulator.
                if not reap_partial_creations(staging_name):
                    raise SimulatorCleanupError(
                        f'Owned staging cleanup failed for {staging_name}; refusing another candidate'
                    ) from error
                raise

        try:
            shutdown_simulator(template_udid)
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
            raise SimulatorCleanupError(
                f'Reusable template {template_udid} is not proven stopped; refusing another candidate: {error}'
            ) from error

        clone_result = run_simctl_without_timeout("clone", template_udid, simulator_name)
        if clone_result.returncode != 0:
            raise RuntimeError(
                clone_result.stderr.strip()
                or clone_result.stdout.strip()
                or "simctl clone failed"
            )

        simulator_udid = extract_created_udid(clone_result.stdout)
        if simulator_udid is None:
            raise RuntimeError(f"simctl clone returned an invalid UDID: {clone_result.stdout!r}")
        return simulator_udid


def reap_partial_creations(simulator_name: str) -> bool:
    try:
        candidates = exact_named_device_udids(
            load_simctl_json("list", "devices"), simulator_name
        )
    except (
        json.JSONDecodeError,
        OSError,
        RuntimeError,
        subprocess.TimeoutExpired,
        ValueError,
    ) as error:
        print(
            f"Could not inventory partial simulator creation {simulator_name}: {error}",
            file=sys.stderr,
        )
        return False

    cleanup_succeeded = True
    for udid in candidates:
        try:
            run_simctl("shutdown", udid, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            pass

        deleted = False
        for _ in range(2):
            try:
                deletion = run_simctl("delete", udid)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if deletion.returncode == 0:
                deleted = True
                break
        if not deleted:
            cleanup_succeeded = False
            print(
                f"Could not delete partial simulator creation {udid}.",
                file=sys.stderr,
            )
    if candidates and cleanup_succeeded:
        try:
            cleanup_succeeded = not exact_named_device_udids(load_simctl_json("list", "devices"), simulator_name)
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
            cleanup_succeeded = False
        if not cleanup_succeeded:
            print(f"Could not verify removal of owned simulator {simulator_name}.", file=sys.stderr)
    return cleanup_succeeded


def runtime_version(identifier: str) -> tuple[int, ...]:
    match = RUNTIME_PATTERN.search(identifier)
    if match is None:
        return ()
    return tuple(int(part) for part in match.group(1).split("-"))


def model_score(name: str) -> tuple[int, int, int, int, int, str]:
    numbers = [int(value) for value in re.findall(r"\d+", name)]
    generation = max(numbers) if numbers else 0
    return (
        generation,
        1 if "Pro" in name else 0,
        1 if re.fullmatch(r"iPhone \d+", name) else 0,
        -1 if "Plus" in name else 0,
        -1 if "SE" in name else 0,
        name,
    )


def available_runtimes(payload: dict[str, Any]) -> list[tuple[tuple[int, ...], str]]:
    candidates: list[tuple[tuple[int, ...], str]] = []
    runtimes = payload.get("runtimes")
    if not isinstance(runtimes, list):
        raise ValueError("simulator runtime inventory has no runtimes list")
    for runtime in runtimes:
        if not isinstance(runtime, dict) or runtime.get("isAvailable") is not True:
            continue
        identifier = runtime.get("identifier")
        if not isinstance(identifier, str) or ".iOS-" not in identifier:
            continue
        version = runtime_version(identifier)
        if version:
            candidates.append((version, identifier))
    return candidates


def primary_runtimes(payload: dict[str, Any]) -> list[tuple[tuple[int, ...], str]]:
    # Version labels can also describe beta builds. Match the reviewed artifact.
    rows = payload.get("runtimes")
    if not isinstance(rows, list):
        raise ValueError("simulator runtime inventory has no runtimes list")
    return available_runtimes({"runtimes": [row for row in rows
        if isinstance(row, dict)
        and (row.get("identifier"), row.get("buildversion")) in PRIMARY_RUNTIME_PAIRS]})


def available_iphone_types(
    payload: dict[str, Any],
    device_class: str,
) -> list[tuple[tuple[Any, ...], str]]:
    candidates: list[tuple[tuple[Any, ...], str]] = []
    device_types = payload.get("devicetypes")
    if not isinstance(device_types, list):
        raise ValueError("simulator device type inventory has no devicetypes list")
    for device_type in device_types:
        if not isinstance(device_type, dict):
            continue
        name = device_type.get("name")
        identifier = device_type.get("identifier")
        if (
            not isinstance(name, str)
            or not name.startswith("iPhone")
            or not isinstance(identifier, str)
            or not identifier
        ):
            continue
        if device_class == "wide" and identifier != "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max":
            continue
        is_narrow = "mini" in name.lower() or "SE" in name
        if (
            device_class == "narrow"
            and identifier != NARROW_DEVICE_TYPE_IDENTIFIER
        ):
            continue
        if device_class == "standard" and is_narrow:
            continue
        candidates.append((model_score(name), identifier))
    return candidates


def write_outputs(
    output_path: Path,
    purpose: str,
    udid: str,
    runtime_fallback: bool,
) -> None:
    destination_key = "destination" if purpose == "storekit" else "dest"
    with output_path.open("a", encoding="utf-8") as output:
        output.write(f"{destination_key}=platform=iOS Simulator,id={udid}\n")
        output.write(f"provisioned_udid={udid}\n")
        output.write(
            f"storekit_runtime_fallback={'true' if runtime_fallback else 'false'}\n"
        )


def provision(purpose: str, device_class: str) -> int:
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    output_path_value = os.environ.get("GITHUB_OUTPUT", "")
    if not run_id.isdigit() or not run_attempt.isdigit():
        print(
            "Simulator provisioning requires numeric GITHUB_RUN_ID and "
            "GITHUB_RUN_ATTEMPT.",
            file=sys.stderr,
        )
        return 2
    if not output_path_value:
        print("Simulator provisioning requires GITHUB_OUTPUT.", file=sys.stderr)
        return 2

    try:
        runtimes = primary_runtimes(load_simctl_json("list", "runtimes"))
        device_types = available_iphone_types(
            load_simctl_json("list", "devicetypes"),
            device_class,
        )
    except (
        json.JSONDecodeError,
        OSError,
        RuntimeError,
        subprocess.TimeoutExpired,
        ValueError,
    ) as error:
        print(f"Could not inspect simulator capabilities: {error}", file=sys.stderr)
        return 1

    # Every required lane uses the reviewed stable runtime. Older runtimes and
    # newly installed betas must not silently change the image's test coverage.
    ordered_runtimes = sorted(
        (candidate for candidate in runtimes if candidate[0][:2] in PRIMARY_RUNTIME_VERSIONS),
        reverse=True,
    )
    if not ordered_runtimes:
        admissible = ", ".join(
            f"iOS {version[0]}.{version[1]} ({build})"
            for version, _, build in PRIMARY_RUNTIMES
        )
        print(f"No admissible primary runtime is available; expected {admissible}.",
              file=sys.stderr)
        return 1
    ordered_device_types = sorted(device_types, reverse=True)
    label = PURPOSE_LABELS[purpose]
    device_class_label = {"narrow": " Narrow", "wide": " Wide"}.get(device_class, "")
    simulator_name = (
        f"Example CI {label}{device_class_label} {run_id}-{run_attempt}"
    )
    errors: list[str] = []
    for version, runtime_identifier in ordered_runtimes:
        for _, device_type_identifier in ordered_device_types:
            try:
                if os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted":
                    udid = create_simulator(
                        simulator_name,
                        device_type_identifier,
                        runtime_identifier,
                    )
                else:
                    udid = clone_warmed_simulator(
                        simulator_name,
                        runtime_identifier,
                        device_type_identifier,
                        device_class,
                    )
            except SimulatorCleanupError as error:
                print(str(error), file=sys.stderr)
                return 1
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
                errors.append(str(error))
                if not reap_partial_creations(simulator_name):
                    return 1
                continue

            runtime_fallback = False
            write_outputs(
                Path(output_path_value),
                purpose,
                udid,
                runtime_fallback,
            )
            print(f"Provisioned {simulator_name} ({udid}) on {runtime_identifier}.")
            return 0

    print(
        "Could not provision an iPhone simulator from the installed runtimes and "
        "device types.",
        file=sys.stderr,
    )
    for error in errors[-3:]:
        if error:
            print(error, file=sys.stderr)
    return 1


def current_warm_template_names() -> list[str]:
    runtimes = sorted(
        primary_runtimes(load_simctl_json("list", "runtimes")),
        reverse=True,
    )
    if len(runtimes) != 1:
        raise RuntimeError("exactly one reviewed primary simulator runtime is required")
    runtime_identifier = runtimes[0][1]
    device_types = load_simctl_json("list", "devicetypes")
    names: list[str] = []
    for device_class in ("standard", "narrow", "wide"):
        candidates = sorted(
            available_iphone_types(device_types, device_class),
            reverse=True,
        )
        if not candidates:
            raise RuntimeError(
                f"no reviewed {device_class} iPhone device type is available"
            )
        for _, device_type_identifier in candidates:
            name = warm_template_name(
                runtime_identifier,
                device_type_identifier,
                device_class,
            )
            if name not in names:
                names.append(name)
    return names


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--device-class",
        choices=("narrow", "standard", "wide"),
        default="standard",
    )
    parser.add_argument("--purpose", choices=sorted(PURPOSE_LABELS))
    parser.add_argument("--print-current-warm-template-names-json", action="store_true")
    parser.add_argument(
        "--delete-warm-template",
        nargs=3,
        metavar=("RUNTIME", "UDID", "NAME"),
    )
    arguments = parser.parse_args()
    if arguments.delete_warm_template is not None:
        if (
            arguments.purpose is not None
            or arguments.print_current_warm_template_names_json
        ):
            parser.error("template deletion cannot be combined with another operation")
        try:
            deleted = delete_warm_template_if_still_matching(
                *arguments.delete_warm_template
            )
        except (
            json.JSONDecodeError,
            OSError,
            RuntimeError,
            subprocess.TimeoutExpired,
            ValueError,
        ) as error:
            print(
                f"Could not safely delete warm simulator template: {error}",
                file=sys.stderr,
            )
            return 1
        return 0 if deleted else 1
    if arguments.print_current_warm_template_names_json:
        if arguments.purpose is not None:
            parser.error("--purpose cannot be combined with template inventory output")
        try:
            print(json.dumps(current_warm_template_names()))
        except (
            json.JSONDecodeError,
            OSError,
            RuntimeError,
            subprocess.TimeoutExpired,
            ValueError,
        ) as error:
            print(f"Could not identify current warm simulator templates: {error}", file=sys.stderr)
            return 1
        return 0
    if arguments.purpose is None:
        parser.error("--purpose is required unless template inventory output is requested")
    return provision(arguments.purpose, arguments.device_class)


if __name__ == "__main__":
    raise SystemExit(main())

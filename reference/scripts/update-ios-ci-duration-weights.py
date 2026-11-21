#!/usr/bin/env python3
"""Refresh native iOS UI duration hints from successful Actions job logs."""

import argparse
import json
import pathlib
import re


TEST_RESULT = re.compile(
    r"Test Case '-\[example_iosUITests\.([^ ]+) ([^]]+)\]' passed "
    r"\(([0-9]+(?:\.[0-9]+)?) seconds\)"
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hints", required=True, type=pathlib.Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--require-count", type=int)
    parser.add_argument("logs", nargs="+", type=pathlib.Path)
    args = parser.parse_args()

    measurements: dict[str, float] = {}
    for log_path in args.logs:
        contents = log_path.read_text(encoding="utf-8-sig", errors="replace")
        for class_name, method_name, duration in TEST_RESULT.findall(contents):
            identifier = f"{class_name}/{method_name}"
            if identifier in measurements:
                raise SystemExit(f"Duplicate UI test measurement: {identifier}")
            measurements[identifier] = float(duration)

    if not measurements:
        raise SystemExit("No successful iOS UI test measurements found")
    if args.require_count is not None and len(measurements) != args.require_count:
        raise SystemExit(
            f"Expected {args.require_count} UI test measurements, found {len(measurements)}"
        )

    hints = json.loads(args.hints.read_text(encoding="utf-8"))
    tests = hints.setdefault("tests", {})
    tests.update(measurements)

    observed_by_class: dict[str, set[str]] = {}
    for identifier in measurements:
        class_name = identifier.split("/", 1)[0]
        observed_by_class.setdefault(class_name, set()).add(identifier)
    known_by_class: dict[str, set[str]] = {}
    for identifier in tests:
        class_name = identifier.split("/", 1)[0]
        known_by_class.setdefault(class_name, set()).add(identifier)
    classes = hints.setdefault("classes", {})
    for class_name, observed in observed_by_class.items():
        if observed == known_by_class[class_name]:
            classes[class_name] = round(sum(tests[item] for item in observed), 3)

    hints["source"] = args.source
    ordered_hints = {
        "schemaVersion": hints["schemaVersion"],
        "source": hints["source"],
        "classes": dict(sorted(classes.items())),
        "tests": dict(sorted(tests.items())),
    }
    args.hints.write_text(
        json.dumps(ordered_hints, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Updated {len(measurements)} iOS UI duration hints from {len(args.logs)} logs")


if __name__ == "__main__":
    main()

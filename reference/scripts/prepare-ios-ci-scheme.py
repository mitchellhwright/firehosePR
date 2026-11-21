#!/usr/bin/env python3
"""Create a CI-only Xcode scheme that launches tests without LLDB."""

from __future__ import annotations

import argparse
from pathlib import Path
import xml.etree.ElementTree as ET


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    tree = ET.parse(args.source)
    test_actions = tree.getroot().findall("TestAction")
    if len(test_actions) != 1:
        raise SystemExit(
            f"expected one TestAction in {args.source}, found {len(test_actions)}"
        )

    test_actions[0].set("selectedDebuggerIdentifier", "")
    test_actions[0].set(
        "selectedLauncherIdentifier",
        "Xcode.IDEFoundation.Launcher.PosixSpawn",
    )
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    tree.write(args.destination, encoding="UTF-8", xml_declaration=True)


if __name__ == "__main__":
    main()

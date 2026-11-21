#!/usr/bin/env python3
"""Print concise XCTest failures from an xcresult bundle for CI logs."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TestFailure:
    target_name: str
    test_name: str
    identifier: str
    failure_text: str

    @property
    def display_name(self) -> str:
        name = self.test_name or self.identifier or 'Unknown XCTest failure'
        if self.target_name and self.target_name not in name:
            return f'{self.target_name}/{name}'
        return name


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Summarize failed XCTest cases from an xcresult bundle.'
    )
    parser.add_argument('result_bundle', help='Path to the .xcresult bundle')
    parser.add_argument(
        '--xcodebuild-log',
        help='Optional raw xcodebuild log used as a fallback when xcresult has no failure details.',
    )
    return parser.parse_args()


def github_escape(value: str) -> str:
    return value.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


def github_escape_property(value: str) -> str:
    return github_escape(value).replace(':', '%3A').replace(',', '%2C')


def load_xcresult_summary(result_bundle: Path) -> dict[str, Any] | None:
    if not result_bundle.is_dir():
        print(f'No iOS test result bundle found at {result_bundle}.')
        return None

    result = subprocess.run(
        [
            'xcrun',
            'xcresulttool',
            'get',
            'test-results',
            'summary',
            '--path',
            str(result_bundle),
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    if result.returncode != 0:
        error = result.stderr.strip() or 'xcresulttool returned a non-zero status.'
        print(f'Could not read iOS test result summary: {error}')
        return None

    try:
        parsed = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        print(f'Could not parse iOS test result summary JSON: {error}')
        return None

    if isinstance(parsed, dict):
        return parsed

    print('Could not parse iOS test result summary: root JSON value was not an object.')
    return None


def collect_xcresult_failures(summary: dict[str, Any]) -> list[TestFailure]:
    failures: list[TestFailure] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            test_name = as_string(value.get('testName'))
            failure_text = as_string(value.get('failureText'))
            identifier = as_string(
                value.get('testIdentifierString') or value.get('testIdentifierURL')
            )
            target_name = as_string(value.get('targetName'))

            if 'failureText' in value and (test_name or identifier):
                failures.append(
                    TestFailure(
                        target_name=target_name,
                        test_name=test_name,
                        identifier=identifier,
                        failure_text=failure_text or 'No failure text reported by xcresult.',
                    )
                )

            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(summary)
    return dedupe_failures(failures)


def collect_log_failures(log_path: Path | None) -> list[TestFailure]:
    if log_path is None or not log_path.is_file():
        return []

    failures: list[TestFailure] = []
    pattern = re.compile(r"Test Case '-\[(?P<identifier>[^\]]+)\]' failed")

    for line in log_path.read_text(errors='replace').splitlines():
        match = pattern.search(line)
        if match is None:
            continue

        identifier = match.group('identifier')
        failures.append(
            TestFailure(
                target_name='',
                test_name=identifier,
                identifier=identifier,
                failure_text=line.strip(),
            )
        )

    return dedupe_failures(failures)


def dedupe_failures(failures: list[TestFailure]) -> list[TestFailure]:
    deduped: dict[tuple[str, str, str, str], TestFailure] = {}
    for failure in failures:
        key = (
            failure.target_name,
            failure.test_name,
            failure.identifier,
            failure.failure_text,
        )
        deduped[key] = failure
    return list(deduped.values())


def as_string(value: Any) -> str:
    return value if isinstance(value, str) else ''


def first_line(value: str) -> str:
    for line in value.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return value.strip()


def print_summary(summary: dict[str, Any] | None, failures: list[TestFailure]) -> None:
    result = as_string(summary.get('result')) if summary is not None else 'Unknown'
    total_tests = summary.get('totalTestCount') if summary is not None else None
    passed_tests = summary.get('passedTests') if summary is not None else None
    failed_tests = summary.get('failedTests') if summary is not None else None
    skipped_tests = summary.get('skippedTests') if summary is not None else None

    count_parts = []
    if isinstance(total_tests, int):
        count_parts.append(f'total={total_tests}')
    if isinstance(passed_tests, int):
        count_parts.append(f'passed={passed_tests}')
    if isinstance(failed_tests, int):
        count_parts.append(f'failed={failed_tests}')
    if isinstance(skipped_tests, int):
        count_parts.append(f'skipped={skipped_tests}')

    if count_parts:
        print(f'iOS test result: {result} ({", ".join(count_parts)})')
    else:
        print(f'iOS test result: {result}')

    if not failures:
        print('No failed XCTest cases found in the result bundle or xcodebuild log.')
        write_step_summary(summary, failures)
        return

    print('::group::Failed XCTest cases')
    print(f'{len(failures)} failed XCTest case(s):')
    for index, failure in enumerate(failures, start=1):
        message = first_line(failure.failure_text)
        print(f'{index}. {failure.display_name}')
        if message:
            print(f'   {message}')
        print(
            f'::error title={github_escape_property(failure.display_name)}::'
            f'{github_escape(message or failure.failure_text)}'
        )
    print('::endgroup::')

    write_step_summary(summary, failures)


def write_step_summary(summary: dict[str, Any] | None, failures: list[TestFailure]) -> None:
    step_summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if not step_summary:
        return

    result = as_string(summary.get('result')) if summary is not None else 'Unknown'
    failed_tests = summary.get('failedTests') if summary is not None else None

    lines = ['### iOS Test Failures', '']
    if isinstance(failed_tests, int):
        lines.append(f'Result: `{result}` with `{failed_tests}` failed test(s).')
    else:
        lines.append(f'Result: `{result}`.')
    lines.append('')

    if failures:
        for failure in failures:
            message = first_line(failure.failure_text)
            lines.append(f'- `{failure.display_name}`')
            if message:
                lines.append(f'  {message}')
    else:
        lines.append('No failed XCTest cases were reported in the result bundle.')

    with open(step_summary, 'a', encoding='utf-8') as summary_file:
        summary_file.write('\n'.join(lines))
        summary_file.write('\n')


def main() -> int:
    args = parse_args()
    result_bundle = Path(args.result_bundle)
    log_path = Path(args.xcodebuild_log) if args.xcodebuild_log else None

    summary = load_xcresult_summary(result_bundle)
    failures = collect_xcresult_failures(summary) if summary is not None else []

    if not failures:
        failures = collect_log_failures(log_path)

    print_summary(summary, failures)
    return 0


if __name__ == '__main__':
    sys.exit(main())

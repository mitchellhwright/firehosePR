#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -lt 3 || "$#" -gt 5 ]]; then
  echo "Usage: $0 <result-bundle> <suite-name> <minimum-passed> [expected-total] [allow-skips]" >&2
  exit 2
fi

result_bundle="$1"
suite_name="$2"
minimum_passed="$3"
expected_total="${4:-}"
allow_skips="${5:-false}"

[[ "$minimum_passed" =~ ^[1-9][0-9]*$ ]] || { echo "Minimum passed count must be positive" >&2; exit 2; }
[[ -z "$expected_total" || "$expected_total" =~ ^[1-9][0-9]*$ ]] || { echo "Expected total must be positive" >&2; exit 2; }
[[ "$allow_skips" == true || "$allow_skips" == false ]] || { echo "allow-skips must be true or false" >&2; exit 2; }
[[ -d "$result_bundle" ]] || { echo "$suite_name result bundle does not exist: $result_bundle" >&2; exit 2; }

xcrun xcresulttool get test-results summary --path "$result_bundle" --format json \
  | SUITE_NAME="$suite_name" MINIMUM_PASSED="$minimum_passed" EXPECTED_TOTAL="$expected_total" ALLOW_SKIPS="$allow_skips" python3 -c '
import json, os, sys
summary = json.load(sys.stdin)
name = os.environ["SUITE_NAME"]
minimum = int(os.environ["MINIMUM_PASSED"])
expected_text = os.environ["EXPECTED_TOTAL"]
expected = int(expected_text) if expected_text else None
allow_skips = os.environ["ALLOW_SKIPS"] == "true"
total = summary.get("totalTestCount")
passed = summary.get("passedTests")
failed = summary.get("failedTests")
skipped = summary.get("skippedTests")
expected_failures = summary.get("expectedFailures")
result = summary.get("result")
valid = (
    result == "Passed"
    and isinstance(total, int)
    and isinstance(passed, int)
    and isinstance(skipped, int)
    and passed >= minimum
    and failed == 0
    and expected_failures == 0
    and total == passed + skipped
    and (allow_skips or skipped == 0)
    and (expected is None or total == expected)
)
if not valid:
    raise SystemExit(
        f"{name} xcresult execution mismatch: result={result!r}, "
        f"total={total}, passed={passed}, failed={failed}, skipped={skipped}, "
        f"expectedFailures={expected_failures}, minimumPassed={minimum}, "
        f"expectedTotal={expected}, allowSkips={allow_skips}"
    )
print(f"{name} xcresult verified: total={total}, passed={passed}, skipped={skipped}")
'

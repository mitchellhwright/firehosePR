#!/usr/bin/env bash
# Run one workflow step's script and make its outcome readable in GitHub's UI.
#
# Every non-zero exit gets an annotation naming the step, who owns the failure
# and what that owner should do next, plus a line in the run summary. The
# script itself needs to know none of that: the step definition declares it
# (ci/workflows/lib/model.ts) and passes it through the environment. Scripts
# keep their own, more specific ::error:: lines; this is the floor, so no
# failure is ever just a red X with a stack trace.
#
# usage: run-step.sh SCRIPT [ARG...]
# env:   EXAMPLE_STEP_NAME EXAMPLE_STEP_OWNER EXAMPLE_STEP_NEXT_ACTION
#        [EXAMPLE_SUMMARY_TITLE] [GITHUB_STEP_SUMMARY]
set -euo pipefail

script="${1:?a script path is required}"
shift
: "${EXAMPLE_STEP_NAME:?}" "${EXAMPLE_STEP_OWNER:?}" "${EXAMPLE_STEP_NEXT_ACTION:?}"

summary="${GITHUB_STEP_SUMMARY:-}"
summary_size_before=0
if [ -n "$summary" ] && [ -f "$summary" ]; then
  summary_size_before="$(wc -c <"$summary")"
fi

status=0
bash "$script" "$@" || status=$?

owner_initial="$(printf '%s' "${EXAMPLE_STEP_OWNER:0:1}" | tr '[:lower:]' '[:upper:]')"
owner="${owner_initial}${EXAMPLE_STEP_OWNER:1}"

if [ "$status" -ne 0 ]; then
  printf '::error title=%s::%s owner — %s\n' "$EXAMPLE_STEP_NAME" "$owner" "$EXAMPLE_STEP_NEXT_ACTION"
  if [ -n "$summary" ]; then
    printf -- '- ❌ %s: %s\n' "$EXAMPLE_STEP_NAME" "$EXAMPLE_STEP_NEXT_ACTION" >>"$summary"
  fi
  exit "$status"
fi

# A controller that decided something without saying so is a silent controller;
# make that visible rather than leaving an empty section in the run summary.
if [ -n "${EXAMPLE_SUMMARY_TITLE:-}" ] && [ -n "$summary" ] && [ -f "$summary" ] &&
  [ "$(wc -c <"$summary")" -eq "$summary_size_before" ]; then
  printf '## %s\n\n(no summary written)\n' "$EXAMPLE_SUMMARY_TITLE" >>"$summary"
fi

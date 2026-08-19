#!/usr/bin/env bash
# Regression suite. Every case here was written to prove a real defect, so each one
# failed against the code that shipped it; they are kept so it cannot come back.
#
#   tests/run.sh                     run everything against ../scripts
#   SCRIPTS=<path> tests/run.sh      run against a different checkout
#
# Each case builds its own config, state and reviews root under mktemp and uses the
# stub runtime, so nothing touches real state and no agent is launched. Some cases
# call the GitHub API through `gh`, so an authenticated `gh` and network are needed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fails=0 ran=0
for t in "$HERE"/test_*.sh; do
  ran=$(( ran + 1 ))
  out="$(bash "$t" 2>&1)"
  if printf '%s\n' "$out" | grep -qE '^FAIL|FAILURES PRESENT'; then
    printf 'FAIL  %s\n' "$(basename "$t")"
    printf '%s\n' "$out" | grep -E '^FAIL|^ +(expected|actual)' | sed 's/^/      /'
    fails=$(( fails + 1 ))
  else
    printf 'ok    %s  (%s assertions)\n' "$(basename "$t")" "$(printf '%s\n' "$out" | grep -c '^PASS')"
  fi
done
printf '\n%s/%s files passed\n' "$(( ran - fails ))" "$ran"
[ "$fails" = 0 ]

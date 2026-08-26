#!/usr/bin/env bash
# Scratch evidence for the report links that would not open in a review pane.
#
# Claim under test: rt_ensure_server starts the herdr server without a terminal
# identity, so the agent in every pane it opens renders markdown links as display
# text followed by the raw URL instead of a real OSC-8 hyperlink. Claude Code's
# capability check reads FORCE_HYPERLINK first, then TERM_PROGRAM, then TERM, and
# returns false when none of them match. The launchd job that runs the poller
# inherits only SSH_AUTH_SOCK, so none of them are set, and a pane cannot inherit
# what the server never had. The printed URL then wraps across lines, which is why
# clicking one opens only the fragment before the break.
#
# Run: bash test_server_env_hyperlinks.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
export PR_REVIEW_BOARD_LOCK="$TD/.poll.lock"
mkdir -p "$TD/reviews" "$TD/workspace"
cat > "$PR_REVIEW_BOARD_CONFIG" <<CFG
{ "source": "github-reactions", "runtime": "herdr", "orgs": ["Zamua"],
  "herdr_session": "prbtest",
  "reviews_root": "$TD/reviews", "workspace_root": "$TD/workspace" }
CFG

# Stand in for herdr so no server is started: report no running session, dump the
# environment the server would have been given, and satisfy the readiness probe.
export PRB_TEST_ENV_DUMP="$TD/server.env"
mkdir -p "$TD/bin"
cat > "$TD/bin/herdr" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do
  [ "$a" = server ] && { printenv > "$PRB_TEST_ENV_DUMP"; exit 0; }
done
exit 0
STUB
chmod +x "$TD/bin/herdr"

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

echo "== bring the server up through the adapter =="
# A pointer the scrub is meant to drop, to prove this site still sheds the caller's
# herdr identity while it adds the terminal capability.
export HERDR_SESSION=leaked-from-caller
PRB_LIB_ONLY=1 source "$SCRIPTS/poll.sh" >/dev/null 2>&1
# lib.sh prepends the real tool locations, so the stub only wins after that runs.
export PATH="$TD/bin:$PATH"
rt_ensure_server
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  [ -s "$PRB_TEST_ENV_DUMP" ] && break
  sleep 0.1
done
[ -s "$PRB_TEST_ENV_DUMP" ] || { echo "FAIL  the stub server never ran"; exit 1; }

got_force="$(grep -m1 '^FORCE_HYPERLINK=' "$PRB_TEST_ENV_DUMP" | cut -d= -f2-)"
got_sess="$(grep -c '^HERDR_SESSION=' "$PRB_TEST_ENV_DUMP")"

echo
eq "the server is told the terminal renders hyperlinks" "1" "${got_force:-<unset>}"
eq "the caller's herdr session is still scrubbed"       "0" "$got_sess"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"

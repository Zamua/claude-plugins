#!/bin/bash
# agent-board test harness. Plain bash, no framework; runs poll.sh under
# /bin/bash (macOS bash 3.2) against stub adapters in tests/stubs, with all
# state redirected into a per-case temp dir via the AGENT_BOARD_* env seams.
# Prints one PASS/FAIL line per case; exits nonzero on any failure.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLL="$HERE/../scripts/poll.sh"
STUBS="$HERE/stubs"
BASH_BIN="/bin/bash"

PASS_N=0
FAIL_N=0
CASE_DIRS=""
cleanup() { local d; for d in $CASE_DIRS; do rm -rf "$d"; done; }
trap cleanup EXIT

# ---- per-case setup ----

new_case() {  # <name>
  CASE_NAME="$1"
  CASE_FAILS=""
  CASE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-board-test.XXXXXX")"
  CASE_DIRS="$CASE_DIRS $CASE_DIR"
  mkdir -p "$CASE_DIR/adapters" "$CASE_DIR/fix/rt"
  cp "$STUBS/source-stub.sh" "$CASE_DIR/adapters/"
  cp "$STUBS/runtime-stub.sh" "$CASE_DIR/adapters/"
  export AGENT_BOARD_CONFIG="$CASE_DIR/config.json"
  export AGENT_BOARD_STATE="$CASE_DIR/sessions.json"
  export AGENT_BOARD_LOCK="$CASE_DIR/poll.lock"
  export AGENT_BOARD_ADAPTER_DIR="$CASE_DIR/adapters"
  export AB_TEST_FIX="$CASE_DIR/fix"
  : >"$AB_TEST_FIX/calls.log"
}

write_config() {  # <cap> [source] [runtime]
  local cap="$1" source="${2:-stub}" runtime="${3:-stub}"
  cat >"$AGENT_BOARD_CONFIG" <<EOF
{
  "source": "$source",
  "runtime": "$runtime",
  "label": "agent",
  "cap": $cap
}
EOF
}

# ab_safe equivalent for fixture filenames
safe() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-'; }

run_once() { "$BASH_BIN" "$POLL" once >"$CASE_DIR/out.log" 2>&1; RC=$?; }

# ---- assertions ----

expect() {  # <description> <predicate...>
  local desc="$1"; shift
  "$@" || CASE_FAILS="$CASE_FAILS [$desc]"
}
has_line()  { grep -qxF -- "$2" "$1"; }              # <file> <exact line>
has_match() { grep -q -- "$2" "$1"; }                # <file> <pattern>
no_match()  { ! grep -q -- "$2" "$1"; }              # <file> <pattern>
line_count_is() {  # <file> <exact line> <count>
  [ "$(grep -cxF -- "$2" "$1")" = "$3" ]
}
in_order() {  # <file> <line-a> <line-b> : a's first occurrence precedes b's
  local na nb
  na="$(grep -nxF -- "$2" "$1" | head -1 | cut -d: -f1)"
  nb="$(grep -nxF -- "$3" "$1" | head -1 | cut -d: -f1)"
  [ -n "$na" ] && [ -n "$nb" ] && [ "$na" -lt "$nb" ]
}
rc_is()     { [ "$RC" = "$1" ]; }
rc_nonzero(){ [ "$RC" != "0" ]; }
map_has()   { [ "$(jq -r --arg k "$1" '.[$k] // empty' "$AGENT_BOARD_STATE")" = "$2" ]; }
status_is() { [ "$(cat "$AB_TEST_FIX/rt/status.$(safe "$1")" 2>/dev/null || printf 'absent')" = "$2" ]; }

report() {
  if [ -z "$CASE_FAILS" ]; then
    printf 'PASS %s\n' "$CASE_NAME"; PASS_N=$((PASS_N+1))
  else
    printf 'FAIL %s:%s\n' "$CASE_NAME" "$CASE_FAILS"; FAIL_N=$((FAIL_N+1))
    sed 's/^/     | /' "$CASE_DIR/out.log" 2>/dev/null
  fi
}

# ---- cases ----

case_spawn_under_cap() {
  new_case spawn_under_cap
  write_config 3
  printf 'octo/repo#1\n' >"$AB_TEST_FIX/candidates"
  run_once
  expect "rc 0" rc_is 0
  expect "guard queried" has_line "$AB_TEST_FIX/calls.log" "guard octo/repo#1"
  expect "spawn called" has_line "$AB_TEST_FIX/calls.log" "spawn octo/repo#1"
  expect "kickoff passed through" \
    has_match "$AB_TEST_FIX/rt/kickoff.$(safe octo/repo#1)" "kickoff for octo/repo#1"
  expect "session id mapped" map_has "octo/repo#1" "sid-$(safe octo/repo#1)"
  expect "worker running" status_is "octo/repo#1" running
  report
}

case_cap_reached_queuing() {
  new_case cap_reached_queuing
  write_config 1
  printf 'octo/a#1\nocto/b#2\n' >"$AB_TEST_FIX/candidates"
  run_once
  expect "rc 0" rc_is 0
  expect "first candidate spawned" has_line "$AB_TEST_FIX/calls.log" "spawn octo/a#1"
  expect "second candidate not spawned" no_match "$AB_TEST_FIX/calls.log" "spawn octo/b#2"
  expect "second candidate queued" has_match "$CASE_DIR/out.log" "cap 1 reached; spawn octo/b#2 queued"
  expect "exactly one spawn" line_count_is "$AB_TEST_FIX/calls.log" "spawn octo/a#1" 1
  report
}

case_resume_rc2_falls_through_to_spawn() {
  new_case resume_rc2_falls_through_to_spawn
  write_config 3
  printf 'octo/c#3\n' >"$AB_TEST_FIX/candidates"
  # stopped pane but no saved session id -> rt_resume rc 2 -> fresh spawn
  printf 'stopped' >"$AB_TEST_FIX/rt/status.$(safe octo/c#3)"
  run_once
  expect "rc 0" rc_is 0
  expect "resume attempted" has_line "$AB_TEST_FIX/calls.log" "resume octo/c#3"
  expect "spawn follows resume" in_order "$AB_TEST_FIX/calls.log" "resume octo/c#3" "spawn octo/c#3"
  expect "session id mapped by spawn" map_has "octo/c#3" "sid-$(safe octo/c#3)"
  expect "worker running" status_is "octo/c#3" running
  report
}

case_reap_on_label_loss() {
  new_case reap_on_label_loss
  write_config 3
  : >"$AB_TEST_FIX/candidates"
  printf '{"octo/d#4":"sid-d"}\n' >"$AGENT_BOARD_STATE"
  printf 'running' >"$AB_TEST_FIX/rt/status.$(safe octo/d#4)"
  printf '1' >"$AB_TEST_FIX/haslabel.$(safe octo/d#4)"
  run_once
  expect "rc 0" rc_is 0
  expect "label checked" has_line "$AB_TEST_FIX/calls.log" "has_label octo/d#4"
  expect "reap called" has_line "$AB_TEST_FIX/calls.log" "reap octo/d#4"
  expect "worker stopped" status_is "octo/d#4" stopped
  expect "session id kept after reap" map_has "octo/d#4" "sid-d"
  report
}

case_keep_running_on_haslabel_unknown() {
  new_case keep_running_on_haslabel_unknown
  write_config 3
  : >"$AB_TEST_FIX/candidates"
  printf '{"octo/e#5":"sid-e"}\n' >"$AGENT_BOARD_STATE"
  printf 'running' >"$AB_TEST_FIX/rt/status.$(safe octo/e#5)"
  printf '2' >"$AB_TEST_FIX/haslabel.$(safe octo/e#5)"
  run_once
  expect "rc 0" rc_is 0
  expect "label checked" has_line "$AB_TEST_FIX/calls.log" "has_label octo/e#5"
  expect "no reap on unknown" no_match "$AB_TEST_FIX/calls.log" "reap octo/e#5"
  expect "skip logged" has_match "$CASE_DIR/out.log" "skip reap octo/e#5: cannot read labels"
  expect "worker still running" status_is "octo/e#5" running
  report
}

case_guard_skip() {
  new_case guard_skip
  write_config 3
  printf 'octo/f#6\n' >"$AB_TEST_FIX/candidates"
  printf '1' >"$AB_TEST_FIX/guard.$(safe octo/f#6)"
  run_once
  expect "rc 0" rc_is 0
  expect "guard queried" has_line "$AB_TEST_FIX/calls.log" "guard octo/f#6"
  expect "no spawn behind guard" no_match "$AB_TEST_FIX/calls.log" "spawn octo/f#6"
  expect "guard skip logged" has_match "$CASE_DIR/out.log" "skip octo/f#6: last action not by operator"
  report
}

case_lock_single_flight() {
  new_case lock_single_flight
  write_config 3
  printf 'octo/g#7\n' >"$AB_TEST_FIX/candidates"
  # a live pass holds the lock (this shell's pid is alive)
  mkdir -p "$AGENT_BOARD_LOCK"
  printf '%s' "$$" >"$AGENT_BOARD_LOCK/pid"
  run_once
  expect "rc 0 (skip is not an error)" rc_is 0
  expect "skip logged" has_match "$CASE_DIR/out.log" "holds the lock; skipping"
  expect "no spawn while locked" no_match "$AB_TEST_FIX/calls.log" "spawn octo/g#7"
  expect "lock left intact" [ -f "$AGENT_BOARD_LOCK/pid" ]
  report
}

case_contract_validation_failure() {
  new_case contract_validation_failure
  write_config 3 broken stub
  cat >"$CASE_DIR/adapters/source-broken.sh" <<'EOF'
#!/usr/bin/env bash
src_deps() { printf ''; }
EOF
  run_once
  expect "nonzero exit" rc_nonzero
  expect "adapter named" has_match "$CASE_DIR/out.log" "adapter source-broken is missing required functions"
  expect "missing function named" has_match "$CASE_DIR/out.log" "src_spawn_candidates"
  expect "no candidates queried" no_match "$AB_TEST_FIX/calls.log" "candidates"
  report
}

# ---- main ----

case_spawn_under_cap
case_cap_reached_queuing
case_resume_rc2_falls_through_to_spawn
case_reap_on_label_loss
case_keep_running_on_haslabel_unknown
case_guard_skip
case_lock_single_flight
case_contract_validation_failure

printf '%d passed, %d failed\n' "$PASS_N" "$FAIL_N"
[ "$FAIL_N" = "0" ]

#!/usr/bin/env bash
# Claim under test: a review is launched only once its kickoff prompt lands, and a
# saved session Claude never wrote a transcript for is not resumed. Claude writes a
# session's transcript on its first message, so a lost kickoff leaves a session id
# that `claude --resume` rejects at once, and retrying it every pass never recovers.
#
# Run: bash test_resume_without_transcript.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
export PR_REVIEW_BOARD_LOCK="$TD/.poll.lock"
export CLAUDE_CONFIG_DIR="$TD/claude"
mkdir -p "$TD/reviews" "$TD/workspace" "$TD/bin" "$CLAUDE_CONFIG_DIR/projects/-reviews"

# herdr as a running session that records every call. `agent prompt` fails the
# first PRB_TEST_PROMPT_FAILS times it is called and succeeds after that.
export PRB_TEST_CALLS="$TD/calls" PRB_TEST_PROMPTS="$TD/prompts" PRB_TEST_PROMPT_FAILS=0
cat > "$TD/bin/herdr" <<'STUB'
#!/usr/bin/env bash
[ "$1" = --session ] && shift 2
printf '%s\n' "$*" >> "$PRB_TEST_CALLS"
case "$1 $2" in
  "session list") printf 'name status\nwork running\n' ;;
  "workspace list") printf '{"result":{"workspaces":[]}}' ;;
  "workspace create") printf '{"result":{"workspace":{"workspace_id":"w9"},"tab":{"tab_id":"w9:t1"},"root_pane":{"pane_id":"w9:p1"}}}' ;;
  "agent start") printf '{"result":{"type":"agent_started"}}' ;;
  "agent list") printf '{"result":{"agents":[]}}' ;;
  "agent prompt")
    n=$(( $(wc -l < "$PRB_TEST_PROMPTS" 2>/dev/null || echo 0) + 1 )); echo x >> "$PRB_TEST_PROMPTS"
    [ "$n" -le "$PRB_TEST_PROMPT_FAILS" ] && { printf '{"error":{"code":"agent_not_ready"}}'; exit 1; } ;;
esac
exit 0
STUB
chmod +x "$TD/bin/herdr"

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
called() { grep -qxF "$1" "$PRB_TEST_CALLS" && echo yes || echo no; }
called_like() { grep -q -- "$1" "$PRB_TEST_CALLS" && echo yes || echo no; }
field()  { jq -r ".reviews[\"api-10\"].$1 // empty" "$PR_REVIEW_BOARD_STATE"; }
delivered() { grep -c '^agent prompt' "$PRB_TEST_CALLS"; }

configure() {  # <claude_session or empty>
  cat > "$PR_REVIEW_BOARD_CONFIG" <<CFG
{ "source": "github-reactions", "runtime": "herdr", "orgs": ["acme"], "herdr_session": "work",
  "reviews_root": "$TD/reviews", "workspace_root": "$TD/workspace" }
CFG
  cat > "$PR_REVIEW_BOARD_STATE" <<ST
{ "last_poll": 0,
  "reviews": { "api-10": { "status": "ACTIVE", "slug": "api-10", "dir": "$TD/reviews/api-10",
    "multi": false, "prs": ["acme/api#10"], "claude_session": "$1", "agent_name": "api-10",
    "herdr_workspace": "w3", "herdr_tab": "" } },
  "pr_index": { "acme/api#10": "api-10" } }
ST
  : > "$PRB_TEST_CALLS"; : > "$PRB_TEST_PROMPTS"
}

PRB_LIB_ONLY=1 source "$SCRIPTS/poll.sh" >/dev/null 2>&1
# lib.sh prepends the real tool locations, so the stub only wins after that runs.
export PATH="$TD/bin:$PATH"
source "$SCRIPTS/adapters/runtime-herdr.sh"
sleep() { :; }

echo "== a saved session with no transcript is not resumed =="
configure 3b27764b-0000-0000-0000-000000000001
rt_resume api-10 >/dev/null 2>&1; rc=$?
eq "resume reports nothing to resume"  "2"   "$rc"
eq "claude --resume is never run"      "no"  "$(called_like '--resume ')"
eq "the dead agent's workspace closes" "yes" "$(called "workspace close w3")"

echo
echo "== a saved session with a transcript is resumed =="
configure 3b27764b-0000-0000-0000-000000000002
: > "$CLAUDE_CONFIG_DIR/projects/-reviews/3b27764b-0000-0000-0000-000000000002.jsonl"
rt_resume api-10 >/dev/null 2>&1; rc=$?
eq "resume succeeds"                   "0"   "$rc"
eq "claude --resume runs on it"        "yes" "$(called_like '--resume 3b27764b-0000-0000-0000-000000000002')"

echo
echo "== a kickoff that fails once is sent again =="
configure ""; PRB_TEST_PROMPT_FAILS=1
rt_spawn api-10 "Review it." >/dev/null 2>&1; rc=$?
eq "spawn succeeds"                    "0"   "$rc"
eq "the kickoff is sent twice"         "2"   "$(delivered)"
[ -n "$(field claude_session)" ] && ok "the session is recorded" || bad "the session is recorded" "a uuid" "empty"

echo
echo "== a kickoff that never lands fails the spawn =="
configure ""; PRB_TEST_PROMPT_FAILS=1000
rt_spawn api-10 "Review it." >/dev/null 2>&1; rc=$?
eq "spawn fails"                       "1"   "$rc"
eq "no session is recorded"            ""    "$(field claude_session)"
eq "the review reads as absent"        "absent" "$(rt_status api-10)"
eq "its new workspace closes"          "yes" "$(called "workspace close w9")"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"

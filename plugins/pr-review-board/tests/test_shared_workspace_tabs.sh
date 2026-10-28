#!/usr/bin/env bash
# Claim under test: with `herdr_workspace` set, each review opens as a tab in the
# one workspace of that label, made the first time, and its teardown closes only
# its own tab. Without it, each review keeps a workspace of its own.
#
# Run: bash test_shared_workspace_tabs.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
export PR_REVIEW_BOARD_LOCK="$TD/.poll.lock"
mkdir -p "$TD/reviews" "$TD/workspace" "$TD/bin"

# herdr as a running session that records every call. PRB_TEST_SHARED_WS is the id of
# a workspace labelled `reviews`, or empty when there is none yet.
export PRB_TEST_CALLS="$TD/calls" PRB_TEST_SHARED_WS=""
cat > "$TD/bin/herdr" <<'STUB'
#!/usr/bin/env bash
[ "$1" = --session ] && shift 2
printf '%s\n' "$*" >> "$PRB_TEST_CALLS"
case "$1 $2" in
  "session list") printf 'name status\nwork running\n' ;;
  "workspace list")
    if [ -n "$PRB_TEST_SHARED_WS" ]; then
      printf '{"result":{"workspaces":[{"workspace_id":"w1","label":"root"},{"workspace_id":"%s","label":"reviews"}]}}' "$PRB_TEST_SHARED_WS"
    else
      printf '{"result":{"workspaces":[{"workspace_id":"w1","label":"root"}]}}'
    fi ;;
  "workspace create") printf '{"result":{"workspace":{"workspace_id":"w9"},"tab":{"tab_id":"w9:t1"},"root_pane":{"pane_id":"w9:p1"}}}' ;;
  "tab create") printf '{"result":{"tab":{"tab_id":"w5:t2"},"root_pane":{"pane_id":"w5:p2"}}}' ;;
  "agent start") printf '{"result":{"type":"agent_started"}}' ;;
  "agent list") printf '{"result":{"agents":[]}}' ;;
esac
exit 0
STUB
chmod +x "$TD/bin/herdr"

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
called() { grep -qxF "$1" "$PRB_TEST_CALLS" && echo yes || echo no; }
field()  { jq -r ".reviews[\"api-10\"].$1 // empty" "$PR_REVIEW_BOARD_STATE"; }

configure() {  # <herdr_workspace or empty>
  cat > "$PR_REVIEW_BOARD_CONFIG" <<CFG
{ "source": "github-reactions", "runtime": "herdr", "orgs": ["acme"], "herdr_session": "work",
  "herdr_workspace": "$1", "reviews_root": "$TD/reviews", "workspace_root": "$TD/workspace" }
CFG
  cat > "$PR_REVIEW_BOARD_STATE" <<ST
{ "last_poll": 0,
  "reviews": { "api-10": { "status": "ACTIVE", "slug": "api-10", "dir": "$TD/reviews/api-10",
    "multi": false, "prs": ["acme/api#10"] } },
  "pr_index": { "acme/api#10": "api-10" } }
ST
  : > "$PRB_TEST_CALLS"
}

PRB_LIB_ONLY=1 source "$SCRIPTS/poll.sh" >/dev/null 2>&1
# lib.sh prepends the real tool locations, so the stub only wins after that runs.
export PATH="$TD/bin:$PATH"
source "$SCRIPTS/adapters/runtime-herdr.sh"

echo "== a shared workspace that exists gets a new tab =="
configure reviews; PRB_TEST_SHARED_WS=w5
rt_spawn api-10 "Review it." >/dev/null 2>&1
eq "the review opens as a tab in it"   "yes" "$(called "tab create --workspace w5 --cwd $TD/reviews --label api-10 --no-focus")"
eq "no workspace is made"              "no"  "$(grep -q '^workspace create' "$PRB_TEST_CALLS" && echo yes || echo no)"
eq "the tab is recorded"               "w5:t2" "$(field herdr_tab)"
: > "$PRB_TEST_CALLS"
rt_close_workspace api-10 >/dev/null 2>&1
eq "teardown closes only its tab"      "yes" "$(called "tab close w5:t2")"
eq "and leaves the workspace"          "no"  "$(grep -q '^workspace close' "$PRB_TEST_CALLS" && echo yes || echo no)"

echo
echo "== a shared workspace that does not exist yet is made, named for the config =="
configure reviews; PRB_TEST_SHARED_WS=""
rt_spawn api-10 "Review it." >/dev/null 2>&1
eq "the workspace is made with the shared label" "yes" "$(called "workspace create --cwd $TD/reviews --label reviews --no-focus")"
eq "its first tab is named for the review"       "yes" "$(called "tab rename w9:t1 api-10")"

echo
echo "== without a shared workspace each review keeps its own =="
configure ""
rt_spawn api-10 "Review it." >/dev/null 2>&1
eq "the review gets a workspace of its own" "yes" "$(called "workspace create --cwd $TD/reviews --label api-10 --no-focus")"
eq "no tab is recorded"                     ""    "$(field herdr_tab)"
: > "$PRB_TEST_CALLS"
rt_close_workspace api-10 >/dev/null 2>&1
eq "teardown closes its workspace"          "yes" "$(called "workspace close w9")"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"

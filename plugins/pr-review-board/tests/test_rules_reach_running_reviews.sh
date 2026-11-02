#!/usr/bin/env bash
# Claim under test: every pass ships the plugin's review rules into each live review's
# directory, so a running worker reads the current rules without a scope change, and
# a finished review's copy is left alone.
#
# The trigger scan, the runtime and the GitHub call are replaced by stubs, so nothing
# is spawned and no network is used.
#
# Run: bash test_rules_reach_running_reviews.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
export PR_REVIEW_BOARD_LOCK="$TD/.poll.lock"
meta="$TD/reviews/.pr-review-board"
mkdir -p "$meta/api-2" "$meta/web-3" "$TD/workspace"
cat > "$PR_REVIEW_BOARD_CONFIG" <<CFG
{ "source": "github-reactions", "runtime": "stub", "orgs": ["acme"],
  "reviews_root": "$TD/reviews", "workspace_root": "$TD/workspace" }
CFG
cat > "$PR_REVIEW_BOARD_STATE" <<ST
{ "last_poll": 0,
  "reviews": { "api-2": { "status": "ACTIVE", "slug": "api-2", "dir": "$TD/reviews/api-2", "prs": ["acme/api#2"] },
               "web-3": { "status": "CLEANEDUP", "slug": "web-3", "dir": "$TD/reviews/web-3", "prs": ["acme/web#3"] } },
  "pr_index": { "acme/api#2": "api-2", "acme/web#3": "web-3" } }
ST
printf 'old rules\n' > "$meta/api-2/REVIEW-RULES.md"
printf 'old rules\n' > "$meta/web-3/REVIEW-RULES.md"

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

PRB_LIB_ONLY=1 source "$SCRIPTS/poll.sh" >/dev/null 2>&1

src_fresh() { :; }
src_pr_facts() { return 1; }
rt_status() { printf 'running'; }
rt_running_count() { printf '1'; }

(cmd_once) >/dev/null 2>&1

eq "a live review's rules copy is the plugin's current rules after a pass" "same" \
   "$(cmp -s "$SCRIPTS/../docs/REVIEW-RULES.md" "$meta/api-2/REVIEW-RULES.md" && echo same || echo stale)"
eq "a finished review's copy is left alone" "old rules" "$(cat "$meta/web-3/REVIEW-RULES.md")"

[ "$fail" = 0 ] || echo "FAILURES PRESENT"

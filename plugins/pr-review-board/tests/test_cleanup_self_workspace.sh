#!/usr/bin/env bash
# Scratch evidence for pr-review-board review cherry-pos-5010.
#
# Claim under test: `cleanup.sh apply` run from inside the review's own herdr
# workspace tears the review down halfway and lets the poller resurrect it.
#
# Observed on cherry-pos-5010: the report was archived at 14:21:16, workspace w3 was
# closed, and then nothing else happened. The worktree, the review directory and the
# metadata directory were all untouched, and the review was still ACTIVE. 90 seconds
# later the next pass read that as an agent that had died and resumed it into w7,
# re-cloning the checkout the teardown had been asked to remove.
#
# Cause: apply closed the workspace as step 2 and marked CLEANEDUP as step 6. Closing
# a workspace kills every pane in it, so when the caller was one of those panes the
# close killed the script before it reached the mark.
#
# Expected after the fix:
#   * CLEANEDUP is written before anything is destroyed.
#   * The review's own workspace is NOT closed when the caller is inside it.
#   * The teardown still completes: worktree gone, directory gone, metadata gone.
#
# Run: bash test_cleanup_self_workspace.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
export PR_REVIEW_BOARD_LOCK="$TD/.poll.lock"
mkdir -p "$TD/reviews" "$TD/workspace"
cat > "$PR_REVIEW_BOARD_CONFIG" <<CFG
{ "source": "github-reactions", "runtime": "stub", "orgs": ["acme"],
  "reviews_root": "$TD/reviews", "workspace_root": "$TD/workspace" }
CFG

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

# A review whose directory is a real git worktree, the single-pull-request shape.
CANON="$TD/workspace/api"
git init -q "$CANON" && git -C "$CANON" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
DIR="$TD/reviews/api-10"
git -C "$CANON" worktree add -q --detach "$DIR" HEAD
META="$TD/reviews/.pr-review-board/api-10"; mkdir -p "$META"; printf '{}\n' > "$META/assignment.json"
printf '# report\n' > "$DIR/REVIEW.md"

cat > "$PR_REVIEW_BOARD_STATE" <<ST
{ "last_poll": 0,
  "reviews": { "api-10": { "status": "ACTIVE", "slug": "api-10", "dir": "$DIR",
    "multi": false, "prs": ["acme/api#10"], "claude_session": "s1",
    "agent_name": "api-10", "herdr_workspace": "w3" } },
  "pr_index": { "acme/api#10": "api-10" } }
ST

echo "== apply, run from inside the review's own workspace w3 =="
out="$(HERDR_WORKSPACE_ID=w3 bash "$SCRIPTS/cleanup.sh" apply api-10 --yes 2>&1)"
printf '%s\n' "$out" | sed 's/^/  /'
echo

eq "review is CLEANEDUP"            "CLEANEDUP" "$(jq -r '.reviews["api-10"].status' "$PR_REVIEW_BOARD_STATE")"
eq "cleaned_at was recorded"        "yes"       "$([ -n "$(jq -r '.reviews["api-10"].cleaned_at // empty' "$PR_REVIEW_BOARD_STATE")" ] && echo yes || echo no)"
eq "the poller sees no active key"  ""          "$(jq -r '.reviews | to_entries[] | select(.value.status=="ACTIVE") | .key' "$PR_REVIEW_BOARD_STATE")"
eq "review directory is gone"       "gone"      "$([ -d "$DIR" ] && echo present || echo gone)"
eq "metadata directory is gone"     "gone"      "$([ -d "$META" ] && echo present || echo gone)"
eq "report was archived"            "yes"       "$([ -f "$TD/reviews/.archive/api-10.md" ] && echo yes || echo no)"
eq "own workspace was left open"    "yes"       "$(printf '%s' "$out" | grep -q 'left open' && echo yes || echo no)"

# The ordering invariant itself: the mark must land before the first destructive step,
# so that any mid-run death leaves a terminal review rather than a resurrectable one.
mark_at="$(printf '%s\n' "$out" | grep -n 'is CLEANEDUP'     | head -1 | cut -d: -f1)"
wt_at="$(  printf '%s\n' "$out" | grep -n 'removed worktree' | head -1 | cut -d: -f1)"
eq "CLEANEDUP is marked before the worktree is removed" "yes" \
   "$([ -n "$mark_at" ] && [ -n "$wt_at" ] && [ "$mark_at" -lt "$wt_at" ] && echo yes || echo no)"
eq "own workspace was not closed"   "no"        "$(printf '%s' "$out" | grep -q 'STUB close workspace' && echo yes || echo no)"

echo
echo "== apply from outside the workspace still closes it =="
git -C "$CANON" worktree add -q --detach "$TD/reviews/api-11" HEAD
mkdir -p "$TD/reviews/.pr-review-board/api-11"
cat > "$PR_REVIEW_BOARD_STATE" <<ST
{ "last_poll": 0,
  "reviews": { "api-11": { "status": "ACTIVE", "slug": "api-11", "dir": "$TD/reviews/api-11",
    "multi": false, "prs": ["acme/api#11"], "claude_session": "s2",
    "agent_name": "api-11", "herdr_workspace": "w9" } },
  "pr_index": { "acme/api#11": "api-11" } }
ST
out2="$(HERDR_WORKSPACE_ID=w2Q bash "$SCRIPTS/cleanup.sh" apply api-11 --yes 2>&1)"
printf '%s\n' "$out2" | sed 's/^/  /'
echo
eq "other workspace was closed"     "yes"       "$(printf '%s' "$out2" | grep -q 'STUB close workspace' && echo yes || echo no)"
eq "review is CLEANEDUP"            "CLEANEDUP" "$(jq -r '.reviews["api-11"].status' "$PR_REVIEW_BOARD_STATE")"

echo
[ "$fail" = 0 ] && echo "all assertions passed" || echo "FAILURES PRESENT"
exit "$fail"

#!/usr/bin/env bash
# Scratch evidence for pr-review-board review claude-plugins-6-r2.
#
# Claim under test: when a review is promoted to an umbrella, the harness records
# `promoted_from` in state.json but _write_assignment never projects it into
# assignment.json. Both the worker persona and the scope-change notification tell
# the worker to act on `promoted_from` from the assignment, so the instruction can
# never fire and the existing checkout is never moved into the umbrella.
#
#   agents/pr-reviewer.md:  "If promoted_from is set, this review just grew ...
#                            git -C <clone> worktree move <promoted_from> ..."
#   poll.sh rt_notify text: "If promoted_from is set, move the existing checkout
#                            into the umbrella dir before continuing."
#
# Run: bash test_promoted_from_missing.sh
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

PRB_LIB_ONLY=1 source "$SCRIPTS/poll.sh" >/dev/null 2>&1

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

# A genuine two-layer stack: bottom feature/mm-1 -> main, top feature/mm-1-part2 -> feature/mm-1.
# This is the grouping the design is built for, driven through the real production path.
echo "== reaction 1: the bottom of the stack =="
k1="$(_handle_fresh 'acme/api#10' '2026-08-19T10:00:00Z' 'feature/mm-1' 'main' 'main' 'false' 'add the widget' 'https://github.com/acme/api/pull/10' 2>&1 | tail -1)"
echo "  review key: $k1"

echo "== reaction 2: the layer on top of it =="
_handle_fresh 'acme/api#11' '2026-08-19T10:01:00Z' 'feature/mm-1-part2' 'feature/mm-1' 'main' 'false' 'wire the widget up' 'https://github.com/acme/api/pull/11' 2>&1 | sed 's/^/  /'

echo
echo "== state.json =="
jq '.reviews[] | {slug, dir, multi, prs, promoted_from}' "$PR_REVIEW_BOARD_STATE"
asg="$TD/reviews/.pr-review-board/$k1/assignment.json"
echo
echo "== assignment.json (what the worker actually reads) =="
jq . "$asg"
echo

eq "state recorded promoted_from"                    "$TD/reviews/api-10" "$(jq -r '.reviews["'"$k1"'"].promoted_from // "<absent>"' "$PR_REVIEW_BOARD_STATE")"
eq "the review was promoted to an umbrella"          "true"               "$(jq -r '.reviews["'"$k1"'"].multi' "$PR_REVIEW_BOARD_STATE")"
eq "assignment.json exposes promoted_from"           "$TD/reviews/api-10" "$(jq -r '.promoted_from // "<absent>"' "$asg")"
eq "assignment.json flags the top layer as stacked"  "true"               "$(jq -r '.prs[] | select(.pr=="acme/api#11") | .meta.stacked' "$asg")"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"

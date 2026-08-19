#!/usr/bin/env bash
# Scratch evidence for pr-review-board review claude-plugins-6-r2.
#
# Claim under test: the chain rule is
#
#     any(.value.head == $newBase or .value.base == $newHead)
#
# with no exclusion for the repository default branch. Any pull request whose HEAD
# branch is the default branch - a release/promotion PR (main -> production), or a
# fork PR opened from the fork's main - therefore matches every active review that
# has a member based on main, which is nearly all of them.
#
# This is independent of the `poll.sh spawn` TSV bug: the inputs below are the exact
# correct values `src_fresh` produces for these pull requests.
#
# Scenario: a live review of acme/api#10 (feature/x -> main). Then the operator
# reacts to acme/web#20, a release PR promoting main -> production. Unrelated repo,
# unrelated change.
#
# Expected: two separate reviews.
#
# Run: bash test_chain_rule_false_positive.sh
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

echo "== reaction 1: an ordinary feature PR, acme/api#10  feature/x -> main =="
k1="$(_handle_fresh 'acme/api#10' '2026-08-19T10:00:00Z' 'feature/x' 'main' 'main' 'false' 'add the widget' 'https://github.com/acme/api/pull/10' 2>/dev/null | tail -1)"
echo "  review key: $k1"

echo "== reaction 2: an unrelated release PR, acme/web#20  main -> production =="
out="$(_handle_fresh 'acme/web#20' '2026-08-19T10:05:00Z' 'main' 'production' 'main' 'false' 'release 4.2' 'https://github.com/acme/web/pull/20' 2>&1)"
printf '%s\n' "$out" | sed 's/^/  /'

echo
echo "== pr_index =="
jq '.pr_index' "$PR_REVIEW_BOARD_STATE"
echo

eq "the feature PR keeps its own review"    "api-10" "$(jq -r '.pr_index["acme/api#10"]' "$PR_REVIEW_BOARD_STATE")"
eq "the release PR gets its OWN review"     "web-20" "$(jq -r '.pr_index["acme/web#20"] // "<none>"' "$PR_REVIEW_BOARD_STATE")"
eq "two reviews exist"                      "2"      "$(jq -r '.reviews | length' "$PR_REVIEW_BOARD_STATE")"
eq "the feature review was not promoted"    "false"  "$(jq -r '.reviews["api-10"].multi' "$PR_REVIEW_BOARD_STATE")"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"

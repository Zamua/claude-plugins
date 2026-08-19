#!/usr/bin/env bash
# Scratch evidence for pr-review-board review claude-plugins-6-r2.
#
# Claim under test: because `poll.sh spawn` mis-reads the TSV row (see
# test_spawn_tsv.sh), the pull request it forces in arrives at _match_review with
# head="main" and base="false". The chain rule is
#
#     any(.value.head == $base or .value.base == $head)
#
# so with $head == "main" it matches ANY active review that already has a member
# based on main, which is nearly every pull request. The forced pull request is
# therefore silently appended to an unrelated review, promoting it to an umbrella,
# renaming its directory and telling the live worker to move its checkout.
#
# Setup: one ACTIVE review 'other-99' covering a completely unrelated pull request
# in a different repo, feature/other -> main. Then force Zamua/claude-plugins#6 in.
#
# Expected: two separate reviews. #6 gets its own.
#
# Run: bash test_spawn_hijacks_review.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"
PR="Zamua/claude-plugins#6"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
export PR_REVIEW_BOARD_LOCK="$TD/.poll.lock"
mkdir -p "$TD/reviews" "$TD/workspace"
cat > "$PR_REVIEW_BOARD_CONFIG" <<CFG
{ "source": "github-reactions", "runtime": "stub", "orgs": ["Zamua"],
  "reviews_root": "$TD/reviews", "workspace_root": "$TD/workspace" }
CFG

# An unrelated, live review of an unrelated pull request in an unrelated repo.
mkdir -p "$TD/reviews/other-99"
cat > "$PR_REVIEW_BOARD_STATE" <<ST
{
  "last_poll": 0,
  "reviews": {
    "other-99": {
      "status": "ACTIVE", "slug": "other-99", "dir": "$TD/reviews/other-99",
      "multi": false, "created_at": "2026-01-01T00:00:00Z",
      "claude_session": "sess-other", "agent_name": "other-99",
      "prs": ["SomeoneElse/unrelated-repo#99"],
      "heads": { "SomeoneElse/unrelated-repo#99": { "head": "feature/other", "base": "main" } },
      "meta": { "SomeoneElse/unrelated-repo#99": { "title": "something else entirely" } }
    }
  },
  "pr_index": { "SomeoneElse/unrelated-repo#99": "other-99" }
}
ST

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

echo "== poll.sh spawn $PR, with an unrelated ACTIVE review already up =="
bash "$SCRIPTS/poll.sh" spawn "$PR" 2>&1 | sed 's/^/  /'
echo
echo "== resulting state =="
jq '{reviews: (.reviews | map_values({slug, dir, multi, prs, promoted_from})), pr_index}' "$PR_REVIEW_BOARD_STATE"
echo
eq "the forced PR gets its own review"        "claude-plugins-6" "$(jq -r --arg p "$PR" '.pr_index[$p] // "<none>"' "$PR_REVIEW_BOARD_STATE")"
eq "the unrelated review still covers 1 PR"   "1"                "$(jq -r '.reviews["other-99"].prs | length' "$PR_REVIEW_BOARD_STATE")"
eq "the unrelated review was not promoted"    "false"            "$(jq -r '.reviews["other-99"].multi' "$PR_REVIEW_BOARD_STATE")"
eq "the unrelated review dir is untouched"    "$TD/reviews/other-99" "$(jq -r '.reviews["other-99"].dir' "$PR_REVIEW_BOARD_STATE")"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"

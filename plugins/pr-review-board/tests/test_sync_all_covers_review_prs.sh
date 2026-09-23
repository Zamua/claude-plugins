#!/usr/bin/env bash
# Claim under test: `diffs.sh sync-all` reports on every pull request in the review,
# including one that has never been cached.
#
# sync-all is what the worker runs on each monitor wake to learn which diffs moved.
# When it walked only the pull requests already in the cache, a pull request that
# joined the review after the first pass was invisible to it: sync-all printed
# nothing for it, which reads as "nothing moved".
#
# The pull requests here do not exist, so `gh pr diff` fails and each line reports
# ERROR. That is enough: the assertion is that every pull request gets a line.
#
# Run: bash test_sync_all_covers_review_prs.sh
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
cat > "$PR_REVIEW_BOARD_STATE" <<ST
{ "last_poll": 0,
  "reviews": { "api-10": { "status": "ACTIVE", "slug": "api-10", "dir": "$TD/reviews/api-10",
    "multi": true, "prs": ["acme/api#10", "acme/web#20"] } },
  "pr_index": { "acme/api#10": "api-10", "acme/web#20": "api-10" } }
ST

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

out="$(bash "$SCRIPTS/diffs.sh" sync-all api-10 2>/dev/null)"
printf '%s\n' "$out" | sed 's/^/  /'

eq "sync-all names every pull request in the review" "acme/api#10 acme/web#20" \
   "$(printf '%s\n' "$out" | cut -f1 | sort | tr '\n' ' ' | sed 's/ $//')"

echo
[ "$fail" = 0 ] && echo "all assertions passed" || echo "FAILURES PRESENT"
exit "$fail"

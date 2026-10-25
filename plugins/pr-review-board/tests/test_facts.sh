#!/usr/bin/env bash
# Claim under test: a pass writes github.json beside each live review's board, one
# entry per pull request in the review, with what GitHub says about it, and names the
# pull request each one is stacked on by matching its base branch to another's head.
# A pull request GitHub cannot answer for leaves the last github.json in place rather
# than replacing it with a partial one.
#
# The GitHub call is replaced by canned answers, so no network is used.
#
# Run: bash test_facts.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
export PR_REVIEW_BOARD_LOCK="$TD/.poll.lock"
mkdir -p "$TD/reviews/.pr-review-board/api-2" "$TD/workspace"
cat > "$PR_REVIEW_BOARD_CONFIG" <<CFG
{ "source": "github-reactions", "runtime": "stub", "orgs": ["acme"],
  "reviews_root": "$TD/reviews", "workspace_root": "$TD/workspace" }
CFG
cat > "$PR_REVIEW_BOARD_STATE" <<ST
{ "last_poll": 0,
  "reviews": { "api-2": { "status": "ACTIVE", "slug": "api-2", "dir": "$TD/reviews/api-2", "multi": true,
                          "prs": ["acme/api#1", "acme/api#2", "acme/web#3"] } },
  "pr_index": { "acme/api#1": "api-2", "acme/api#2": "api-2", "acme/web#3": "api-2" } }
ST

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

PRB_LIB_ONLY=1 source "$SCRIPTS/poll.sh" >/dev/null 2>&1

src_pr_facts() {
  case "$1" in
    acme/api#1) printf '%s' '{"pr":"acme/api#1","title":"one","state":"OPEN","draft":false,"head":"aaa","head_ref":"feat/a","base_ref":"main","author":"ann","approved":true,"threads":[]}' ;;
    acme/api#2) printf '%s' '{"pr":"acme/api#2","title":"two","state":"OPEN","draft":true,"head":"bbb","head_ref":"feat/b","base_ref":"feat/a","author":"bo","approved":false,"threads":[{"url":"https://github.com/acme/api/pull/2#discussion_r9","resolved":false,"replied":false}]}' ;;
    acme/web#3) [ -n "${WEB_DOWN:-}" ] && return 1
                printf '%s' '{"pr":"acme/web#3","title":"three","state":"OPEN","draft":false,"head":"ccc","head_ref":"feat/a","base_ref":"feat/a","author":"cy","approved":false,"threads":[]}' ;;
  esac
}

facts="$TD/reviews/.pr-review-board/api-2/github.json"
_refresh_facts api-2 2>/dev/null
eq "a pass writes github.json for the review" "yes" "$([ -f "$facts" ] && echo yes || echo no)"
eq "every pull request in the review has an entry" "acme/api#1 acme/api#2 acme/web#3" "$(jq -r '.prs | keys | join(" ")' "$facts")"
eq "a layer names the pull request whose head is its base" "acme/api#1" "$(jq -r '.prs["acme/api#2"].base' "$facts")"
eq "the bottom layer names none" "null" "$(jq -r '.prs["acme/api#1"].base' "$facts")"
eq "a base branch of the same name in another repo is not a base" "null" "$(jq -r '.prs["acme/web#3"].base' "$facts")"
eq "approval, author, head and threads come through" "true ann aaa 1" \
   "$(jq -r '[.prs["acme/api#1"].approved, .prs["acme/api#1"].author, .prs["acme/api#1"].head, (.prs["acme/api#2"].threads | length)] | join(" ")' "$facts")"
eq "branch names stay out of the file" "null null" "$(jq -r '[.prs["acme/api#2"].head_ref, .prs["acme/api#2"].base_ref] | map(tostring) | join(" ")' "$facts")"
eq "the file says when it was written" "yes" "$(jq -r 'if (.updated_at | test("^[0-9]{4}-")) then "yes" else "no" end' "$facts")"

before="$(cat "$facts")"
WEB_DOWN=1 _refresh_facts api-2 2>/dev/null
eq "a pull request GitHub cannot answer for leaves the last file in place" "$before" "$(cat "$facts")"
eq "no partial file is left behind" "" "$(ls -A "$TD/reviews/.pr-review-board/api-2" | grep -v '^github.json$')"

[ "$fail" = 0 ] || echo "FAILURES PRESENT"

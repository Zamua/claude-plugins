#!/usr/bin/env bash
# Claim under test: a worker can review a whole stack. `stack` finds every open
# layer from any one of them, a fork and the bottom layer included, without following
# a release pull request off the default branch. `adopt` brings those layers into the
# worker's own review, promotes it to an umbrella named for the pull request that
# opened the review rather than the lowest-numbered layer, and leaves a layer another
# live review covers where it is.
#
# Fixture, one repo, default branch main:
#
#     main <- #1 feat/a <- #2 feat/b <- #3 feat/c
#                                  \<- #4 feat/d        (the stack forks)
#     main <- #5 feat/e                                 (unrelated)
#     main <- #6 main->production                       (a release PR)
#
# A live review covers #2 alone. Another live review covers #9 on feat/c.
#
# Run: bash test_adopt_stack.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
export PR_REVIEW_BOARD_LOCK="$TD/.poll.lock"
mkdir -p "$TD/reviews/api-2" "$TD/workspace"
cat > "$PR_REVIEW_BOARD_CONFIG" <<CFG
{ "source": "github-reactions", "runtime": "stub", "orgs": ["acme"],
  "reviews_root": "$TD/reviews", "workspace_root": "$TD/workspace" }
CFG
cat > "$PR_REVIEW_BOARD_STATE" <<ST
{
  "last_poll": 0,
  "reviews": {
    "api-2": {
      "status": "ACTIVE", "slug": "api-2", "dir": "$TD/reviews/api-2", "multi": false,
      "created_at": "2026-01-01T00:00:00Z", "claude_session": "s2", "agent_name": "api-2",
      "prs": ["acme/api#2"], "heads": { "acme/api#2": { "head": "feat/b", "base": "feat/a" } },
      "meta": { "acme/api#2": { "title": "layer b", "reacted_at": "2026-01-01T00:00:00Z" } }
    },
    "other-9": {
      "status": "ACTIVE", "slug": "other-9", "dir": "$TD/reviews/other-9", "multi": false,
      "created_at": "2026-01-01T00:00:00Z", "claude_session": "s9", "agent_name": "other-9",
      "prs": ["acme/api#3"], "heads": { "acme/api#3": { "head": "feat/c", "base": "feat/b" } },
      "meta": { "acme/api#3": { "title": "layer c" } }
    }
  },
  "pr_index": { "acme/api#2": "api-2", "acme/api#3": "other-9" }
}
ST
cat > "$TD/prs.json" <<'PRS'
[
  { "number": 1, "headRefName": "feat/a", "baseRefName": "main",       "title": "layer a" },
  { "number": 2, "headRefName": "feat/b", "baseRefName": "feat/a",     "title": "layer b" },
  { "number": 3, "headRefName": "feat/c", "baseRefName": "feat/b",     "title": "layer c" },
  { "number": 4, "headRefName": "feat/d", "baseRefName": "feat/b",     "title": "layer d" },
  { "number": 5, "headRefName": "feat/e", "baseRefName": "main",       "title": "unrelated" },
  { "number": 6, "headRefName": "main",   "baseRefName": "production", "title": "release" }
]
PRS

PRB_LIB_ONLY=1 source "$SCRIPTS/poll.sh" >/dev/null 2>&1

# GitHub, answered from the fixture: `gh pr list --head|--base <branch> ... --jq <expr>`.
gh() {
  [ "${1:-} ${2:-}" = "pr list" ] || return 1
  shift 2
  local head="" base="" expr="."
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --head) head="$2"; shift 2 ;;
      --base) base="$2"; shift 2 ;;
      --jq)   expr="$2"; shift 2 ;;
      *)      shift ;;
    esac
  done
  jq -c --arg h "$head" --arg b "$base" \
    '[ .[] | select(($h == "" or .headRefName == $h) and ($b == "" or .baseRefName == $b)) ]' "$TD/prs.json" \
    | jq -r "$expr"
}
src_pr_meta() {
  jq -r --arg n "${1##*#}" --arg pr "$1" '
    .[] | select((.number|tostring) == $n)
    | [ $pr, "2026-01-01T00:00:00Z", .headRefName, .baseRefName, "main", "false", .title,
        "https://github.com/acme/api/pull/\(.number)" ] | @tsv' "$TD/prs.json"
}

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
st()  { jq -r "$@" "$PR_REVIEW_BOARD_STATE"; }

echo "== stack from the middle layer =="
from_mid="$(cmd_stack 'acme/api#2' | tr '\n' ' ')"
echo "  $from_mid"
eq "the stack is every open layer, bottom first, the fork included" "acme/api#1 acme/api#2 acme/api#3 acme/api#4 " "$from_mid"

echo "== stack from the bottom layer, whose base is main =="
eq "the bottom layer finds the layers above it" "acme/api#1 acme/api#2 acme/api#3 acme/api#4 " "$(cmd_stack 'acme/api#1' | tr '\n' ' ')"

echo "== stack of a release PR whose head is main =="
eq "a head on the default branch links to nothing" "acme/api#6 " "$(cmd_stack 'acme/api#6' | tr '\n' ' ')"

echo "== adopt the rest of the stack into api-2 =="
out="$( (cmd_adopt api-2 'acme/api#1' 'acme/api#2' 'acme/api#3' 'acme/api#4') 2>/dev/null)"
printf '%s\n' "$out" | sed 's/^/  /'
eq "layers nobody covers are added"           "ADDED acme/api#1|ADDED acme/api#4" "$(printf '%s\n' "$out" | awk -F'\t' '$1=="ADDED"{print $1" "$2}' | paste -sd'|' -)"
eq "a layer already in the review says so"    "IN acme/api#2"                     "$(printf '%s\n' "$out" | awk -F'\t' '$1=="IN"{print $1" "$2}')"
eq "a layer another live review covers stays" "COVERED acme/api#3 other-9"        "$(printf '%s\n' "$out" | awk -F'\t' '$1=="COVERED"{print $1" "$2" "$3}')"
eq "the review now holds three PRs"           "acme/api#1 acme/api#2 acme/api#4"   "$(st '.reviews["api-2"].prs | sort | join(" ")')"
eq "the other review keeps its PR"            "other-9"                           "$(st '.pr_index["acme/api#3"]')"
eq "the review is promoted to an umbrella"    "true"                              "$(st '.reviews["api-2"].multi')"
eq "the worker is told where its checkout was" "$TD/reviews/api-2"                "$(st '.reviews["api-2"].promoted_from')"
eq "the umbrella is named for the PR that opened the review" "$TD/reviews/layer-b-2" "$(st '.reviews["api-2"].dir')"
eq "an adopted PR is marked as adopted"       "true"                              "$(st '.reviews["api-2"].meta["acme/api#1"].adopted')"
eq "an adopted PR has no reaction time"       "null"                              "$(st '.reviews["api-2"].meta["acme/api#1"].reacted_at')"
eq "the assignment lists the wider scope"     "3" \
  "$(jq -r '.prs | length' "$(prb_meta_dir api-2)/assignment.json" 2>/dev/null)"

echo "== adopt into a review that is not live =="
st_before="$(cat "$PR_REVIEW_BOARD_STATE")"
(cmd_adopt nope-1 'acme/api#5') >/dev/null 2>&1; rc=$?
eq "adopt refuses a review that is not ACTIVE" "1" "$rc"
eq "and writes nothing"                       "$st_before" "$(cat "$PR_REVIEW_BOARD_STATE")"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"

#!/usr/bin/env bash
# Claim under test: `poll.sh spawn <pr>` writes an assignment whose head, base,
# default branch, title and url are the pull request's own.
#
# src_pr_meta emits a tab-separated row and cmd_spawn reads it with
# `IFS=$'\t' read`. Tab is an IFS whitespace character, so bash collapses runs of
# empty fields: a row with an empty field shifts every later one into the wrong
# variable. GitHub is a stand-in here (fake-gh.sh), so the test needs no network.
#
# Run: bash test_spawn_tsv.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"
PR="acme/claude-plugins#6"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/fake-gh.sh"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
export PR_REVIEW_BOARD_LOCK="$TD/.poll.lock"
mkdir -p "$TD/reviews" "$TD/workspace"
fake_gh "$TD/gh"
cat > "$TD/gh/graphql.json" <<'GQL'
{ "data": { "repository": { "defaultBranchRef": { "name": "main" },
  "pullRequest": { "number": 6, "title": "pr-review-board: review a PR by reacting to it on GitHub",
    "url": "https://github.com/acme/claude-plugins/pull/6", "isDraft": false,
    "baseRefName": "main", "headRefName": "feat/pr-review-board" } } } }
GQL
cat > "$PR_REVIEW_BOARD_CONFIG" <<CFG
{ "source": "github-reactions", "runtime": "stub", "orgs": ["acme"],
  "reviews_root": "$TD/reviews", "workspace_root": "$TD/workspace" }
CFG

fail=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

echo "== what the source adapter actually emits =="
PRB_LIB_ONLY=1 source "$SCRIPTS/poll.sh" >/dev/null 2>&1
row="$(src_pr_meta "$PR")"
printf '%s\n' "$row" | sed 's/\t/<TAB>/g'
nfields=$(printf '%s' "$row" | awk -F'\t' '{print NF}')
eq "src_pr_meta emits 8 tab-separated fields" 8 "$nfields"

echo
echo "== what cmd_spawn's read() sees =="
IFS=$'\t' read -r a b c d e f g h <<EOF2
$row
EOF2
printf '  _pr=%s\n  _at=%s\n  head=%s\n  base=%s\n  _db=%s\n  draft=%s\n  title=%s\n  url=%s\n' \
  "$a" "$b" "$c" "$d" "$e" "$f" "$g" "$h"

echo
echo "== end to end: poll.sh spawn =="
bash "$SCRIPTS/poll.sh" spawn "$PR" >/dev/null 2>&1
asg="$TD/reviews/.pr-review-board/claude-plugins-6/assignment.json"
[ -f "$asg" ] || { echo "FAIL  no assignment file written at $asg"; exit 1; }
jq . "$asg"
echo
eq "assignment head is the PR head branch"        "feat/pr-review-board" "$(jq -r '.prs[0].head' "$asg")"
eq "assignment base is the PR base branch"        "main"                 "$(jq -r '.prs[0].base' "$asg")"
eq "assignment default_branch is the default"     "main"                 "$(jq -r '.prs[0].meta.default_branch' "$asg")"
eq "assignment carries the PR title"              "pr-review-board: review a PR by reacting to it on GitHub" "$(jq -r '.prs[0].meta.title' "$asg")"
eq "assignment carries the PR url"                "https://github.com/acme/claude-plugins/pull/6" "$(jq -r '.prs[0].meta.url' "$asg")"

echo
[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"

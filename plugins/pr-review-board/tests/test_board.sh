#!/usr/bin/env bash
# Claim under test: the board is safe to post from. `check` names what would break
# the pane or a post, `payload` and `reply` build exactly the approved comments and
# refuse one already posted or dropped, and `mark` records a post without touching
# the other comments.
#
# Posting reads the wording from the board, so a payload built from the wrong entry,
# or a second post of a comment already on GitHub, is a comment the operator never
# approved.
#
# Run: bash test_board.sh
set -uo pipefail

SCRIPTS="${SCRIPTS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)}"
B="$SCRIPTS/board.sh"

TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
export PR_REVIEW_BOARD_CONFIG="$TD/config.json"
export PR_REVIEW_BOARD_STATE="$TD/state.json"
printf '{ "reviews_root": "%s/reviews" }\n' "$TD" > "$PR_REVIEW_BOARD_CONFIG"
BOARD="$TD/board.json"
cat > "$BOARD" <<'JSON'
{ "schema": 2, "updated_at": "2026-10-21T13:00:00Z", "title": "Stock ledger", "verdict": "medium",
  "risk": "Medium.", "blast_radius": "One merchant.",
  "prs": [ { "pr": "acme/api#10", "number": 10, "url": "https://github.com/acme/api/pull/10", "title": "Ledger" },
           { "pr": "acme/api#11", "number": 11, "url": "https://github.com/acme/api/pull/11", "title": "Sweep" } ],
  "report": [ { "id": "about", "title": "What this change is about", "markdown": "Stock." } ],
  "comments": [
    { "n": 1, "pr": "acme/api#10", "severity": "medium", "confidence": "proven", "status": "approved",
      "summary": "The zero check runs early.", "path": "src/Ledger.kt", "line": 88, "side": "RIGHT",
      "body": "The zero check runs before reservations are subtracted." },
    { "n": 2, "pr": "acme/api#10", "severity": "low", "confidence": "proven", "status": "proposed",
      "summary": "A range.", "path": "src/Sweep.kt", "line": 40, "start_line": 36, "side": "RIGHT", "body": "This range resends." },
    { "n": 3, "pr": "acme/api#10", "severity": "question", "confidence": "unproven", "status": "proposed",
      "summary": "Is the description current?", "target": "review body", "body": "Is the description current?" },
    { "n": 4, "pr": "acme/api#10", "severity": "low", "confidence": "proven", "status": "proposed",
      "summary": "Reply to Bugbot.", "reply_to": 991, "body": "Not stuck, the next sweep fails it." },
    { "n": 5, "pr": "acme/api#11", "severity": "low", "confidence": "proven", "status": "posted",
      "summary": "Already up.", "path": "src/Sweep.kt", "line": 9, "side": "RIGHT", "body": "Up.",
      "posted_url": "https://github.com/acme/api/pull/11#discussion_r5" },
    { "n": 6, "pr": "acme/api#10", "severity": "low", "confidence": "proven", "status": "dropped",
      "summary": "Fixed.", "path": "src/Ledger.kt", "line": 3, "side": "RIGHT", "body": "Gone." }
  ] }
JSON

fail=0
ok()  { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n      expected %s\n      actual   %s\n' "$1" "$2" "$3"; fail=1; }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

echo "== path and check =="
eq "a spawned review's board lives in its metadata directory" "$TD/reviews/.pr-review-board/api-10/board.json" "$("$B" path api-10)"
eq "a sound board checks OK" "OK" "$("$B" check "$BOARD")"

broken="$TD/broken.json"
jq '.comments += [{ "n": 1, "pr": "acme/api#10", "severity": "medium", "confidence": "unproven", "status": "posted",
                    "summary": "x", "path": "a.kt", "body": "A plain claim." }]' "$BOARD" > "$broken"
problems="$("$B" check "$broken")"; rc=$?
eq "a broken board fails the check" "1" "$rc"
for want in "comment 1 appears 2 times" "comment 1: unproven but not worded as a question" \
            "comment 1: posted with no posted_url" "comment 1: path needs a numeric line and a LEFT or RIGHT side"; do
  printf '%s\n' "$problems" | grep -qxF "$want" && ok "check names: $want" || bad "check names: $want" "$want" "$problems"
done

echo "== stacks =="
stacked="$TD/stacked.json"
jq '.prs[0].author = "ann" | .prs[1] += {author: "bo", base: "acme/api#10"}
    | .stacks = [{ id: "ledger", title: "Stock ledger", prs: ["acme/api#10", "acme/api#11"] }]' "$BOARD" > "$stacked"
eq "a board with stacks, authors and bases checks OK" "OK" "$("$B" check "$stacked")"
jq '.prs[0].author = 7 | .prs[1].base = "acme/api#99"
    | .stacks = [{ id: "ledger", title: "Stock ledger", prs: ["acme/api#10", "acme/api#99"] },
                 { id: "ledger", title: "Again", prs: ["acme/api#10"] }, { title: "No id" }]' "$BOARD" > "$broken"
problems="$("$B" check "$broken")"; rc=$?
eq "a board with broken stacks fails the check" "1" "$rc"
for want in "stacks[2] needs an id, a title and a prs list" "stack ledger appears 2 times" "acme/api#10 is in 2 stacks" \
            "stack pr acme/api#99 is not in prs" "prs[0].author is not a string" "prs[1].base is not a pull request in prs"; do
  printf '%s\n' "$problems" | grep -qxF "$want" && ok "check names: $want" || bad "check names: $want" "$want" "$problems"
done
jq '.prs[0].approved = true' "$BOARD" > "$stacked"
eq "an approved pull request checks OK" "OK" "$("$B" check "$stacked")"
jq '.prs[0].approved = "yes"' "$BOARD" > "$broken"
eq "an approval that is not a boolean is named" "prs[0].approved is not a boolean" "$("$B" check "$broken")"
jq '.prs[0].other_open_threads = 2' "$BOARD" > "$stacked"
eq "open threads from elsewhere check OK" "OK" "$("$B" check "$stacked")"
jq '.prs[0].other_open_threads = -1' "$BOARD" > "$broken"
eq "a negative open thread count is named" "prs[0].other_open_threads is not a count" "$("$B" check "$broken")"
jq '.stacks = "ledger"' "$BOARD" > "$broken"
eq "stacks that are not a list are named" "stacks is not a list" "$("$B" check "$broken")"

echo "== payload =="
payload="$("$B" payload "$BOARD" acme/api#10 abc123 2 1 3 --summary 'Reviewed this layer.' --sign-off '--claude')"
eq "the review is a COMMENT at the reviewed head" "COMMENT abc123" "$(jq -r '"\(.event) \(.commit_id)"' <<<"$payload")"
eq "inline comments come in the order named" "src/Sweep.kt src/Ledger.kt" "$(jq -r '[.comments[].path] | join(" ")' <<<"$payload")"
eq "each inline body is the board's wording, signed off" $'The zero check runs before reservations are subtracted.\n\n--claude' "$(jq -r '.comments[1].body' <<<"$payload")"
eq "a range keeps its start line" "36 40 RIGHT" "$(jq -r '.comments[0] | "\(.start_line) \(.line) \(.side)"' <<<"$payload")"
eq "a review-body entry joins the summary, signed once" $'Reviewed this layer.\n\nIs the description current?\n\n--claude' "$(jq -r '.body' <<<"$payload")"

out="$("$B" payload "$BOARD" acme/api#11 abc123 5 --summary x 2>&1)"; rc=$?
eq "a posted comment is refused" "1" "$rc"
eq "the refusal names its url" "board: comment 5 is already posted: https://github.com/acme/api/pull/11#discussion_r5" "$out"
out="$("$B" payload "$BOARD" acme/api#10 abc123 6 --summary x 2>&1)"; rc=$?
eq "a dropped comment is refused" "1 board: comment 6 is dropped" "$rc $out"
out="$("$B" payload "$BOARD" acme/api#11 abc123 1 --summary x 2>&1)"; rc=$?
eq "a comment on another pull request is refused" "1 board: comment 1 is on acme/api#10, not acme/api#11" "$rc $out"
out="$("$B" payload "$BOARD" acme/api#10 abc123 4 --summary x 2>&1)"; rc=$?
eq "a thread reply cannot ride in a batched review" "1 board: comment 4 is a thread reply; post it with board.sh reply" "$rc $out"
out="$("$B" payload "$BOARD" acme/api#10 abc123 1 2>&1)"; rc=$?
eq "a review without a summary is refused" "1" "$rc"

echo "== reply =="
eq "a reply carries the thread and the signed body" $'991|Not stuck, the next sweep fails it.\n\n--claude' \
  "$("$B" reply "$BOARD" 4 --sign-off '--claude' | jq -r '"\(.in_reply_to)|\(.body)"')"
out="$("$B" reply "$BOARD" 1 2>&1)"; rc=$?
eq "an inline comment is not a reply" "1 board: comment 1 is not a thread reply" "$rc $out"

echo "== mark =="
before="$(jq -c '[.comments[] | select(.n != 1)]' "$BOARD")"
"$B" mark "$BOARD" 1 posted https://github.com/acme/api/pull/10#discussion_r1 >/dev/null
eq "mark records the post and its url" "posted https://github.com/acme/api/pull/10#discussion_r1" "$(jq -r '.comments[] | select(.n == 1) | "\(.status) \(.posted_url)"' "$BOARD")"
eq "mark leaves every other comment as it was" "$before" "$(jq -c '[.comments[] | select(.n != 1)]' "$BOARD")"
eq "mark moves the board's update time" "true" "$(jq -r '.updated_at != "2026-10-21T13:00:00Z"' "$BOARD")"
eq "the marked board still checks OK" "OK" "$("$B" check "$BOARD")"
out="$("$B" payload "$BOARD" acme/api#10 abc123 1 --summary x 2>&1)"; rc=$?
eq "once marked, the comment cannot be posted again" "1" "$rc"
out="$("$B" mark "$BOARD" 1 posted 2>&1)"; rc=$?
eq "posted without a url is refused" "1 board: posted needs the comment's url" "$rc $out"
out="$("$B" mark "$BOARD" 9 dropped 2>&1)"; rc=$?
eq "an unknown number is refused" "1 board: comment 9 is not on the board" "$rc $out"
"$B" mark "$BOARD" 2 dropped "Fixed in abc1234." >/dev/null
eq "dropping keeps the reason" "dropped Fixed in abc1234." "$(jq -r '.comments[] | select(.n == 2) | "\(.status) \(.status_note)"' "$BOARD")"

echo "== addressed =="
"$B" addressed "$BOARD" 5 yes "Fixed in def5678." >/dev/null
eq "addressed marks a posted comment and keeps how" "true Fixed in def5678." "$(jq -r '.comments[] | select(.n == 5) | "\(.addressed) \(.addressed_note)"' "$BOARD")"
eq "the addressed board still checks OK" "OK" "$("$B" check "$BOARD")"
"$B" addressed "$BOARD" 5 no >/dev/null
eq "addressed no reopens it and clears the note" "false null" "$(jq -r '.comments[] | select(.n == 5) | "\(.addressed) \(.addressed_note)"' "$BOARD")"
out="$("$B" addressed "$BOARD" 3 yes 2>&1)"; rc=$?
eq "only a posted comment can be addressed" "1 board: comment 3 is not posted, so it cannot be addressed" "$rc $out"
out="$("$B" addressed "$BOARD" 5 maybe 2>&1)"; rc=$?
eq "addressed takes yes or no" "1 board: addressed takes yes or no: maybe" "$rc $out"
jq '(.comments[] | select(.n == 3)).addressed = true | (.comments[] | select(.n == 4)).addressed = "yes"
    | .stacks = [{ id: "ledger", title: "Stock ledger", prs: ["acme/api#10", "acme/api#11"], verdict: "huge", risk: 3 }]' "$BOARD" > "$broken"
problems="$("$B" check "$broken")"; rc=$?
eq "a board with a bad addressed flag or stack summary fails the check" "1" "$rc"
for want in "comment 3: addressed but not posted" "comment 4: addressed is not true or false" \
            "stack ledger: verdict is not low, medium or high" "stack ledger: risk is not text"; do
  printf '%s\n' "$problems" | grep -qxF "$want" && ok "check names: $want" || bad "check names: $want" "$want" "$problems"
done

[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit "$fail"

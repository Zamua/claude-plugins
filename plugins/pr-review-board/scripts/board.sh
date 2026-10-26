#!/usr/bin/env bash
# pr-review-board board. The review agent runs this; the poller does not. The board
# is one JSON file holding the whole review: the report, every proposed comment's
# exact wording, and the ledger of what was posted. The board plugin's review view draws it,
# and posting reads from it, so what the operator approved is what goes out.
#
#   board.sh path    <key>                                  board.json of a review the poller spawned
#   board.sh check   <board.json>                           OK, or one problem per line and exit 1
#   board.sh payload <board.json> <owner/repo#N> <head-sha> <n>... --summary TEXT [--sign-off TEXT]
#                                                           one batched review, ready for `gh api --input -`
#   board.sh reply   <board.json> <n> [--sign-off TEXT]     {body, in_reply_to} for a thread reply
#   board.sh mark    <board.json> <n> <status> [url|note]   set a comment's status; posted takes its url
#   board.sh addressed <board.json> <n> yes|no [note]       whether the author settled a posted comment, and how
#
# `payload` and `reply` refuse a comment that is already posted or dropped, so a
# number named twice is never posted twice. Every write replaces the file whole.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"

_b_die() { printf 'board: %s\n' "$*" >&2; exit 1; }
_b_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# A posted comment is a record of what went out, which may be any kind of comment, so it
# needs neither a confidence nor an anchor; those exist to build a post.
_B_CHECK='
  def pr_ok: type == "string" and test("^[^/#]+/[^/#]+#[0-9]+$");
  [ (if .schema != 2 then "schema is not 2" else empty end),
    (if (.title | type) != "string" then "title is missing" else empty end),
    (if ((.verdict // "") | IN("low", "medium", "high")) | not then "verdict is not low, medium or high" else empty end),
    ((.prs // []) | to_entries[] | select((.value.pr | pr_ok) | not) | "prs[\(.key)].pr is not owner/repo#N"),
    ((.prs // []) | to_entries[] | select(.value.author != null and (.value.author | type) != "string") | "prs[\(.key)].author is not a string"),
    ((.prs // []) | to_entries[] | select(.value.approved != null and (.value.approved | type) != "boolean") | "prs[\(.key)].approved is not a boolean"),
    ((.prs // []) | to_entries[] | select(.value.state != null and ([.value.state] | inside(["OPEN", "MERGED", "CLOSED"]) | not))
       | "prs[\(.key)].state is not OPEN, MERGED or CLOSED"),
    ((.prs // []) | to_entries[] | select(.value.other_open_threads != null)
       | select((.value.other_open_threads | type) != "number" or .value.other_open_threads < 0 or (.value.other_open_threads | floor) != .value.other_open_threads)
       | "prs[\(.key)].other_open_threads is not a count"),
    ([(.prs // [])[].pr] as $known | (.prs // []) | to_entries[] | select(.value.base != null)
       | select(.value.base as $base | $known | index($base) | not) | "prs[\(.key)].base is not a pull request in prs"),
    (if .stacks != null and (.stacks | type) != "array" then "stacks is not a list" else empty end),
    (if (.stacks | type) == "array" then
       (.stacks | to_entries[]
          | select((.value | type) != "object" or (.value.id | type) != "string" or (.value.title | type) != "string" or (.value.prs | type) != "array")
          | "stacks[\(.key)] needs an id, a title and a prs list"),
       (.stacks[] | objects | select(.id | type == "string") | . as $s | "stack \($s.id)" as $id |
          (if $s.verdict != null and (($s.verdict | IN("low", "medium", "high")) | not) then "\($id): verdict is not low, medium or high" else empty end),
          (if $s.risk != null and ($s.risk | type) != "string" then "\($id): risk is not text" else empty end),
          (if $s.blast_radius != null and ($s.blast_radius | type) != "string" then "\($id): blast_radius is not text" else empty end)),
       ([.stacks[] | objects | .id | strings] | group_by(.)[] | select(length > 1) | "stack \(.[0]) appears \(length) times"),
       ([.stacks[] | objects | .prs | arrays | .[]] | group_by(.)[] | select(length > 1) | "\(.[0]) is in \(length) stacks"),
       ([(.prs // [])[].pr] as $known | .stacks[] | objects | .prs | arrays | .[]
          | select(. as $p | $known | index($p) | not) | "stack pr \(.) is not in prs")
     else empty end),
    ((.report // []) | to_entries[] | select((.value.title | type) != "string" or (.value.markdown | type) != "string")
       | "report[\(.key)] needs a title and markdown"),
    ((.comments // []) | group_by(.n)[] | select(length > 1) | "comment \(.[0].n) appears \(length) times"),
    ((.comments // [])[] | . as $c | "comment \($c.n // "?")" as $id |
      (if ($c.n | type) != "number" then "\($id): n is not a number" else empty end),
      (if (($c.status // "") | IN("proposed", "approved", "posted", "dropped")) | not
         then "\($id): status is not proposed, approved, posted or dropped" else empty end),
      (if ($c.status != "posted" or $c.confidence != null) and ((($c.confidence // "") | IN("proven", "unproven")) | not)
         then "\($id): confidence is not proven or unproven" else empty end),
      (if (($c.severity // "") | IN("live", "high", "medium", "low-medium", "low", "question")) | not
         then "\($id): severity is not live, high, medium, low-medium, low or question" else empty end),
      (if ($c.pr | pr_ok) | not then "\($id): pr is not owner/repo#N" else empty end),
      (if (($c.body // "") | length) == 0 then "\($id): body is empty" else empty end),
      (if (($c.summary // "") | length) == 0 then "\($id): summary is empty" else empty end),
      (if $c.confidence == "unproven" and ((($c.body // "") | test("[?]")) | not)
         then "\($id): unproven but not worded as a question" else empty end),
      (if $c.status == "posted" and (($c.posted_url // "") | length) == 0 then "\($id): posted with no posted_url" else empty end),
      (if $c.status != "posted" and $c.reply_to == null and $c.path == null and $c.target != "review body"
         then "\($id): needs path and line, reply_to, or target \"review body\"" else empty end),
      (if $c.path != null and (($c.line | type) != "number" or ((($c.side // "RIGHT") | IN("LEFT", "RIGHT")) | not))
         then "\($id): path needs a numeric line and a LEFT or RIGHT side" else empty end),
      (if ($c.origin != null) and ((($c.origin) | IN("new", "carried", "none")) | not)
         then "\($id): origin is not new, carried or none" else empty end),
      (if $c.addressed != null and ($c.addressed | type) != "boolean" then "\($id): addressed is not true or false" else empty end),
      (if $c.addressed == true and $c.status != "posted" then "\($id): addressed but not posted" else empty end),
      (if $c.addressed != true and (($c.addressed_note // "") | length) > 0 then "\($id): addressed_note on a comment not addressed" else empty end)
    )
  ] | .[]'

cmd_path() {  # <key>
  [ $# -eq 1 ] || _b_die "usage: board.sh path <key>"
  printf '%s/board.json\n' "$(prb_meta_dir "$1")"
}

cmd_check() {  # <board.json>
  [ $# -eq 1 ] || _b_die "usage: board.sh check <board.json>"
  [ -f "$1" ] || _b_die "no board at $1"
  local problems
  problems="$(jq -r "$_B_CHECK" "$1" 2>&1)" || _b_die "not valid JSON: $problems"
  if [ -n "$problems" ]; then printf '%s\n' "$problems"; return 1; fi
  printf 'OK\n'
}

# Picks the comments by number and fails, naming each, on one that is missing, on
# another pull request, already posted or dropped, or of the wrong kind.
_b_pick() {  # <board.json> <kind: inline|reply> <pr|""> <numbers-json>
  jq -r --arg kind "$2" --arg pr "$3" --argjson ns "$4" '
    . as $b | $ns[] | . as $n | ($b.comments // [] | map(select(.n == $n)) | first) as $c |
    if $c == null then "comment \($n) is not on the board"
    elif ($c.status == "posted") then "comment \($n) is already posted: \($c.posted_url)"
    elif ($c.status == "dropped") then "comment \($n) is dropped"
    elif ($pr != "" and $c.pr != $pr) then "comment \($n) is on \($c.pr), not \($pr)"
    elif ($kind == "reply" and $c.reply_to == null) then "comment \($n) is not a thread reply"
    elif ($kind == "inline" and $c.reply_to != null) then "comment \($n) is a thread reply; post it with board.sh reply"
    else empty end' "$1"
}

_b_numbers() {  # <n>... as a JSON array
  local out="[" sep="" n
  for n in "$@"; do
    case "$n" in ''|*[!0-9]*) _b_die "not a comment number: $n" ;; esac
    out="$out$sep$n"; sep=","
  done
  printf '%s]' "$out"
}

cmd_payload() {  # <board.json> <owner/repo#N> <head-sha> <n>... --summary TEXT [--sign-off TEXT]
  [ $# -ge 4 ] || _b_die "usage: board.sh payload <board.json> <owner/repo#N> <head-sha> <n>... --summary TEXT [--sign-off TEXT]"
  local file="$1" pr="$2" sha="$3" summary="" sign="" nums="" problems
  shift 3
  while [ $# -gt 0 ]; do
    case "$1" in
      --summary) summary="${2-}"; shift 2 ;;
      --sign-off) sign="${2-}"; shift 2 ;;
      *) nums="$nums $1"; shift ;;
    esac
  done
  [ -n "$summary" ] || _b_die "--summary is required: event COMMENT needs a review body"
  [ -n "$nums" ] || _b_die "name at least one comment"
  # shellcheck disable=SC2086
  local ns; ns="$(_b_numbers $nums)" || exit 1
  problems="$(_b_pick "$file" inline "$pr" "$ns")"
  [ -z "$problems" ] || _b_die "$problems"
  jq --arg sha "$sha" --arg summary "$summary" --arg sign "$sign" --argjson ns "$ns" '
    def signed: if $sign == "" then . else . + "\n\n" + $sign end;
    . as $b | [$ns[] | . as $n | $b.comments[] | select(.n == $n)] as $picked |
    ($picked | map(select(.path != null))) as $inline |
    ($picked | map(select(.path == null) | .body)) as $whole |
    { event: "COMMENT", commit_id: $sha,
      body: ([$summary] + $whole | join("\n\n") | signed),
      comments: [$inline[] | {path, line, side: (.side // "RIGHT"), body: (.body | signed)}
                 + (if .start_line != null then {start_line} else {} end)] }' "$file"
}

cmd_reply() {  # <board.json> <n> [--sign-off TEXT]
  [ $# -ge 2 ] || _b_die "usage: board.sh reply <board.json> <n> [--sign-off TEXT]"
  local file="$1" n="$2" sign="" problems ns
  shift 2
  [ "${1-}" = "--sign-off" ] && sign="${2-}"
  ns="$(_b_numbers "$n")" || exit 1
  problems="$(_b_pick "$file" reply "" "$ns")"
  [ -z "$problems" ] || _b_die "$problems"
  jq --argjson n "$n" --arg sign "$sign" '
    .comments[] | select(.n == $n) |
    {body: (if $sign == "" then .body else .body + "\n\n" + $sign end), in_reply_to: .reply_to}' "$file"
}

cmd_mark() {  # <board.json> <n> <status> [url|note]
  [ $# -ge 3 ] || _b_die "usage: board.sh mark <board.json> <n> <proposed|approved|posted|dropped> [url|note]"
  local file="$1" n="$2" status="$3" extra="${4-}" tmp
  _b_numbers "$n" >/dev/null || exit 1
  case "$status" in
    posted) [ -n "$extra" ] || _b_die "posted needs the comment's url" ;;
    proposed|approved|dropped) ;;
    *) _b_die "status is not proposed, approved, posted or dropped: $status" ;;
  esac
  jq -e --argjson n "$n" 'any(.comments[]?; .n == $n)' "$file" >/dev/null || _b_die "comment $n is not on the board"
  tmp="$(mktemp "$(dirname "$file")/.board.XXXXXX")"
  if jq --argjson n "$n" --arg s "$status" --arg x "$extra" --arg now "$(_b_now)" '
      .updated_at = $now |
      .comments |= map(if .n != $n then . else
        .status = $s |
        if $s == "posted" then .posted_url = $x
        elif $x != "" then .status_note = $x
        else . end end)' "$file" >"$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"; _b_die "could not update $file"
  fi
  printf '%s %s\n' "$n" "$status"
}

cmd_addressed() {  # <board.json> <n> yes|no [note]
  [ $# -ge 3 ] || _b_die "usage: board.sh addressed <board.json> <n> yes|no [note]"
  local file="$1" n="$2" answer="$3" note="${4-}" tmp
  _b_numbers "$n" >/dev/null || exit 1
  case "$answer" in yes|no) ;; *) _b_die "addressed takes yes or no: $answer" ;; esac
  jq -e --argjson n "$n" 'any(.comments[]?; .n == $n)' "$file" >/dev/null || _b_die "comment $n is not on the board"
  jq -e --argjson n "$n" 'any(.comments[]?; .n == $n and .status == "posted")' "$file" >/dev/null \
    || _b_die "comment $n is not posted, so it cannot be addressed"
  tmp="$(mktemp "$(dirname "$file")/.board.XXXXXX")"
  if jq --argjson n "$n" --arg a "$answer" --arg note "$note" --arg now "$(_b_now)" '
      .updated_at = $now |
      .comments |= map(if .n != $n then . else
        .addressed = ($a == "yes") |
        if $a == "yes" and $note != "" then .addressed_note = $note else del(.addressed_note) end end)' "$file" >"$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"; _b_die "could not update $file"
  fi
  printf '%s addressed=%s\n' "$n" "$answer"
}

case "${1-}" in
  path) shift; cmd_path "$@" ;;
  check) shift; cmd_check "$@" ;;
  payload) shift; cmd_payload "$@" ;;
  reply) shift; cmd_reply "$@" ;;
  mark) shift; cmd_mark "$@" ;;
  addressed) shift; cmd_addressed "$@" ;;
  *) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

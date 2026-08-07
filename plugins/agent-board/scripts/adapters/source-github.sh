#!/usr/bin/env bash
# agent-board source adapter: GitHub issues, via `gh`. Task id = "owner/repo#N".
#
# The label is the whole trigger: adding it spawns (or resumes), removing it reaps.
# Open/closed is deliberately not consulted - merging the PR closes the issue while
# post-merge work like a release is still the worker's. Candidates are issues
# authored by the operator carrying the label; the last-actor guard keeps other
# people's actions from driving dispatch.

src_deps() { printf 'gh jq git'; }

src_default_persona() { printf 'issue-agent'; }

_gh_login() {
  local v; v="$(ab_get gh_login "")"
  [ -n "$v" ] && { printf '%s' "$v"; return; }
  gh api user --jq .login 2>/dev/null
}
_gh_repo()  { printf '%s' "${1%#*}"; }   # owner/repo#N -> owner/repo
_gh_num()   { printf '%s' "${1##*#}"; }  # owner/repo#N -> N
_gh_owner() { local r; r="${1%#*}"; printf '%s' "${r%%/*}"; }  # owner/repo#N -> owner
_gh_name()  { local r; r="${1%#*}"; printf '%s' "${r##*/}"; }  # owner/repo#N -> repo

# ids "owner/repo#N" for issues authored by the operator, carrying the label,
# across every repo (no allowlist). Excludes PRs.
src_spawn_candidates() {
  local label login; label="$(ab_get label agent)"; login="$(_gh_login)"
  [ -n "$login" ] || { ab_log "github: no gh_login and gh auto-detect failed"; return 0; }
  gh search issues --author "$login" --label "$label" --limit 50 \
    --json repository,number,isPullRequest \
    --jq '.[] | select(.isPullRequest | not) | "\(.repository.nameWithOwner)#\(.number)"' 2>/dev/null
}

# The reap trigger, so it has to tell "label removed" apart from "could not ask":
# only a definite no reaps. An issue that no longer resolves (gh stderr carries the
# GraphQL could-not-resolve error) counts as a no, so its worker is reaped rather
# than left orphaned; any other failure (outage, auth) is unknown and the worker
# keeps running.
src_has_label() {  # <id> -> 0 has label, 1 label lost or issue gone, 2 unknown
  local repo num label out err verdict
  repo="$(_gh_repo "$1")"; num="$(_gh_num "$1")"; label="$(ab_get label agent)"
  err="$(mktemp "${TMPDIR:-/tmp}/agent-board-gh-err.XXXXXX")" || return 2
  if ! out="$(gh issue view "$num" --repo "$repo" --json labels 2>"$err")"; then
    if grep -qi 'could not resolve to a' "$err"; then rm -f "$err"; return 1; fi
    rm -f "$err"; return 2
  fi
  rm -f "$err"
  verdict="$(printf '%s' "$out" | jq -r --arg l "$label" '
    if   (.labels | type) != "array"          then "unknown"
    elif ([.labels[]?.name] | index($l))      then "yes"
    else "no" end' 2>/dev/null)"
  case "$verdict" in yes) return 0 ;; no) return 1 ;; *) return 2 ;; esac
}

src_url() {  # <id>
  local repo num; repo="$(_gh_repo "$1")"; num="$(_gh_num "$1")"
  gh issue view "$num" --repo "$repo" --json url --jq '.url' 2>/dev/null
}

src_title() {  # <id>
  local repo num; repo="$(_gh_repo "$1")"; num="$(_gh_num "$1")"
  gh issue view "$num" --repo "$repo" --json title --jq '.title' 2>/dev/null
}

# Short task pointer only; the persona carries the full protocol.
src_kickoff_context() {  # <id>
  local url title; url="$(src_url "$1")"; title="$(src_title "$1")"
  printf 'Your assigned GitHub issue: %s  %s\nTitle: %s\nRead the issue in full, including its comments and linked items, before you start. Do not merge or deploy.' "$1" "$url" "$title"
}

# Spawn guard. The newest action on the issue (latest of timeline + comments) must
# be the operator's own. Both connections are chronological, so last:1 is the most
# recent. itemTypes restricts the timeline to the fragmented set: without it, an
# exotic newest event (SubscribedEvent etc) would surface no createdAt and wedge
# the guard closed. Fails closed (returns 1) on a bot actor, another login, or
# missing data.
src_last_actor_is_me() {  # <id> -> 0 = me, 1 = not me / unknown
  local owner name num q verdict
  owner="$(_gh_owner "$1")"; name="$(_gh_name "$1")"; num="$(_gh_num "$1")"
  q='query($owner: String!, $name: String!, $number: Int!) {
        viewer { login }
        repository(owner: $owner, name: $name) {
          issue(number: $number) {
            timelineItems(last: 1, itemTypes: [
              LABELED_EVENT, UNLABELED_EVENT, ISSUE_COMMENT, CLOSED_EVENT,
              REOPENED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT,
              RENAMED_TITLE_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT,
              CROSS_REFERENCED_EVENT, REFERENCED_EVENT, PINNED_EVENT,
              UNPINNED_EVENT
            ]) { nodes {
              ... on LabeledEvent         { createdAt actor { login __typename } }
              ... on UnlabeledEvent       { createdAt actor { login __typename } }
              ... on IssueComment         { createdAt actor: author { login __typename } }
              ... on ClosedEvent          { createdAt actor { login __typename } }
              ... on ReopenedEvent        { createdAt actor { login __typename } }
              ... on AssignedEvent        { createdAt actor { login __typename } }
              ... on UnassignedEvent      { createdAt actor { login __typename } }
              ... on RenamedTitleEvent    { createdAt actor { login __typename } }
              ... on MilestonedEvent      { createdAt actor { login __typename } }
              ... on DemilestonedEvent    { createdAt actor { login __typename } }
              ... on CrossReferencedEvent { createdAt actor { login __typename } }
              ... on ReferencedEvent      { createdAt actor { login __typename } }
              ... on PinnedEvent          { createdAt actor { login __typename } }
              ... on UnpinnedEvent        { createdAt actor { login __typename } }
            } }
            comments(last: 1) { nodes { createdAt author { login __typename } } }
          } } }'
  verdict="$(gh api graphql -f query="$q" -f owner="$owner" -f name="$name" -F number="$num" 2>/dev/null | jq -r '
    .data as $d | ($d.viewer.login) as $me
    | ($d.repository.issue // {}) as $i
    | ( [ ($i.timelineItems.nodes[0] // empty | { t: .createdAt, actor: (.actor.login // null), bot: ((.actor.__typename // "") != "User") }),
          ($i.comments.nodes[0]      // empty | { t: .createdAt, actor: (.author.login // null), bot: ((.author.__typename // "") != "User") }) ] ) as $evs
    | ($evs | sort_by(.t) | last) as $x
    | if   $x == null                 then "notme"
      elif ($evs | any(.t == null))   then "notme"
      elif $x.bot                     then "notme"
      elif ($x.actor // "") == ""     then "notme"
      elif $x.actor == $me            then "me"
      else "notme" end' 2>/dev/null)"
  [ "$verdict" = "me" ]
}

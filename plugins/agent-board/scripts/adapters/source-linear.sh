#!/usr/bin/env bash
# agent-board source adapter: Linear, via the `linear` CLI (headless, verified
# 2.0.0). Uses `linear api` raw GraphQL for precise, JSON-typed queries.
# Task id = the Linear identifier, e.g. "MM-423".
#
# Contract used by poll.sh:
#   src_deps
#   src_spawn_candidates          -> ids assigned-to-me + carrying the label
#   src_has_label <id>            -> 0 has it, 1 lost it, 2 unknown
#   src_last_actor_is_me <id>     -> 0 if the newest action on the issue was the operator's (guard)
#   src_url     <id>              -> issue URL
#   src_title   <id>              -> issue title
#   src_kickoff_context <id>      -> short task description for the runtime's kickoff
#
# The label is the whole trigger: adding it spawns (or resumes), removing it reaps.
# Workflow state is deliberately not consulted - Linear moves state on its own from
# PR activity (Done on merge) while post-merge work like a release or an
# observability check is still the worker's. Eligibility uses assignee.isMe; the
# last-actor guard is what prevents a hijack.

src_deps() { printf 'linear jq'; }

_src_api() { linear api "$1" 2>/dev/null; }

_src_team() { printf '%s' "${1%-*}"; }   # MM-423 -> MM
_src_num()  { printf '%s' "${1##*-}"; }  # MM-423 -> 423

src_spawn_candidates() {
  local label q
  label="$(ab_get label agent)"
  q='query { issues(filter: {
        assignee: { isMe: { eq: true } },
        labels:   { some: { name: { eq: "'"$label"'" } } }
      }, first: 50) { nodes { identifier } } }'
  _src_api "$q" | jq -r '.data.issues.nodes[]?.identifier // empty' 2>/dev/null
}

# The reap trigger, so it has to tell "label removed" apart from "could not ask":
# only a definite no reaps. An issue that no longer resolves at all (deleted,
# archived, no longer visible) counts as a no, so its worker is reaped rather than
# left orphaned in the session.
src_has_label() {  # <id> -> 0 has label, 1 no label, 2 unknown
  local team num label q verdict
  team="$(_src_team "$1")"; num="$(_src_num "$1")"; label="$(ab_get label agent)"
  q='query { issues(filter: { team: { key: { eq: "'"$team"'" } }, number: { eq: '"$num"' } }, first: 1) {
        nodes { labels { nodes { name } } } } }'
  verdict="$(_src_api "$q" | jq -r --arg l "$label" '
    if   (.data.issues.nodes | type) != "array"                     then "unknown"
    elif (.data.issues.nodes | length) == 0                         then "no"
    elif ([.data.issues.nodes[0].labels.nodes[]?.name] | index($l))  then "yes"
    else "no" end' 2>/dev/null)"
  case "$verdict" in yes) return 0 ;; no) return 1 ;; *) return 2 ;; esac
}

src_url() {  # <id>
  local team num q; team="$(_src_team "$1")"; num="$(_src_num "$1")"
  q='query { issues(filter: { team: { key: { eq: "'"$team"'" } }, number: { eq: '"$num"' } }, first: 1) {
        nodes { url } } }'
  _src_api "$q" | jq -r '.data.issues.nodes[0].url // empty' 2>/dev/null
}

src_title() {  # <id>
  local team num q; team="$(_src_team "$1")"; num="$(_src_num "$1")"
  q='query { issues(filter: { team: { key: { eq: "'"$team"'" } }, number: { eq: '"$num"' } }, first: 1) {
        nodes { title } } }'
  _src_api "$q" | jq -r '.data.issues.nodes[0].title // empty' 2>/dev/null
}

src_kickoff_context() {  # <id>
  local url title; url="$(src_url "$1")"; title="$(src_title "$1")"
  printf 'Your assigned Linear issue: %s  %s\nTitle: %s\nStart by reading it: `linear issue view %s`' "$1" "$url" "$title" "$1"
}

# Spawn guard. The newest action on the issue (latest of history + comments) must
# be the operator's own. Linear connections are newest-first, so history(first:1)
# / comments(first:1) is the most recent. Fails closed (returns 1) on a bot actor,
# another user, or missing data.
src_last_actor_is_me() {  # <id> -> 0 = me, 1 = not me / unknown
  local team num q verdict; team="$(_src_team "$1")"; num="$(_src_num "$1")"
  q='query {
        viewer { id }
        issues(filter: { team: { key: { eq: "'"$team"'" } }, number: { eq: '"$num"' } }, first: 1) {
          nodes {
            history(first: 1)  { nodes { createdAt actor { id } botActor { id } } }
            comments(first: 1) { nodes { createdAt user  { id } botActor { id } } }
          } } }'
  verdict="$(_src_api "$q" | jq -r '
    .data as $d | ($d.viewer.id) as $me
    | ($d.issues.nodes[0] // {}) as $i
    | ( [ ($i.history.nodes[0]  // empty | { t: .createdAt, actor: (.actor.id // null), bot: (.botActor != null) }),
          ($i.comments.nodes[0] // empty | { t: .createdAt, actor: (.user.id  // null), bot: (.botActor != null) }) ]
        | sort_by(.t) | last ) as $x
    | if   $x == null      then "notme"
      elif $x.bot          then "notme"
      elif $x.actor == $me then "me"
      else "notme" end' 2>/dev/null)"
  [ "$verdict" = "me" ]
}

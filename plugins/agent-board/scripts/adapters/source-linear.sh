#!/usr/bin/env bash
# agent-board source adapter: Linear, via the `linear` CLI (headless, verified
# 2.0.0). Uses `linear api` raw GraphQL for precise, JSON-typed queries.
# Task id = the Linear identifier, e.g. "MM-423".
#
# Contract used by poll.sh:
#   src_deps
#   src_spawn_candidates          -> ids assigned-to-me + labeled + in spawn_state
#   src_state   <id>              -> Linear state NAME (e.g. "In Progress", "Done")
#   src_last_actor_is_me <id>     -> 0 if the newest action on the issue was the operator's (guard)
#   src_url     <id>              -> issue URL
#   src_title   <id>              -> issue title
#   src_kickoff_context <id>      -> short task description for the runtime's kickoff
#
# spawn_state / reap_state are matched against the exact workflow-state NAME (not
# the coarse type), so "In Progress" triggers only In Progress - not In Review,
# Ready for QA, or any other started-type state. reap_state may be a list, so a
# task reaching Done OR Canceled both reap. Eligibility uses assignee.isMe; the
# last-actor guard is what prevents a hijack.

src_deps() { printf 'linear jq'; }

_src_api() { linear api "$1" 2>/dev/null; }

_src_team() { printf '%s' "${1%-*}"; }   # MM-423 -> MM
_src_num()  { printf '%s' "${1##*-}"; }  # MM-423 -> 423

src_spawn_candidates() {
  local label state q
  label="$(ab_get label agent)"; state="$(ab_get spawn_state "In Progress")"
  q='query { issues(filter: {
        assignee: { isMe: { eq: true } },
        labels:   { some: { name: { eq: "'"$label"'" } } },
        state:    { name: { eq: "'"$state"'" } }
      }, first: 50) { nodes { identifier } } }'
  _src_api "$q" | jq -r '.data.issues.nodes[]?.identifier // empty' 2>/dev/null
}

src_state() {  # <id> -> exact workflow-state name
  local team num q; team="$(_src_team "$1")"; num="$(_src_num "$1")"
  q='query { issues(filter: { team: { key: { eq: "'"$team"'" } }, number: { eq: '"$num"' } }, first: 1) {
        nodes { state { name } } } }'
  _src_api "$q" | jq -r '.data.issues.nodes[0].state.name // empty' 2>/dev/null
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

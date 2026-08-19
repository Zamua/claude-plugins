#!/usr/bin/env bash
# pr-review-board runtime adapter: herdr (https://herdr.dev), verified on 0.7.5.
#
# Every review runs inside ONE shared herdr session (config `herdr_session`).
# Each review gets its OWN workspace, labelled with the review slug, whose first
# tab holds the review agent. The worker adds one further tab per pull request and
# runs a watched hunkt diff there; the harness does not build that layout, because
# the pull request set can grow while the review is live.
#
# Review identity for status and reap is the herdr AGENT NAME, derived
# deterministically from the slug, so a pass is re-entrant and cannot produce
# duplicates. The workspace label is cosmetic and never keyed on.
#
# herdr's `agent start` attaches an agent to an EXISTING pane already sitting at a
# shell prompt and derives the executable from `--kind`, so a launch is three
# calls: `workspace create` (owns cwd and label), `agent start`, then
# `agent prompt` for the kickoff. A just-created pane needs a moment to reach its
# prompt and answers `agent_pane_busy` until it does, so that one error is retried.
#
# The claude session id is generated HERE and passed to `claude --session-id`.
# herdr only learns an agent's session id if the claude integration hook reports
# it, and that hook is not wired into every install, so owning the uuid keeps
# spawn and resume deterministic either way.
#
# Contract used by poll.sh and the cleanup skill: rt_deps, rt_status,
# rt_running_count, rt_spawn, rt_resume (2 = no saved session), rt_notify,
# rt_close_workspace, rt_list.

rt_deps() { printf 'herdr jq uuidgen'; }

_rt_session() { prb_get herdr_session reviews; }
_rt_new_sid() { uuidgen | tr 'A-Z' 'a-z'; }

# herdr agent names must match [a-z][a-z0-9_-]{0,31}: 32 chars, leading letter.
_rt_slug_to_name() {  # <slug>
  local n; n="$(prb_safe "$1")"
  case "$n" in [a-z]*) ;; *) n="r-$n";; esac
  printf '%s' "$(printf '%s' "$n" | cut -c1-32 | sed 's/-$//')"
}

# The agent name is the review's runtime identity, so it is assigned once and then
# always read back from state. A review promoted to an umbrella gets a new slug and
# a new workspace label; recomputing the name from that slug would orphan the live
# agent and leave the review permanently 'stopped'.
_rt_name() {  # <key>
  local n; n="$(prb_review_field "$1" agent_name)"
  [ -n "$n" ] && { printf '%s' "$n"; return; }
  _rt_slug_to_name "$(prb_review_field "$1" slug)"
}

rt_ensure_server() {
  local s i=0 log; s="$(_rt_session)"
  herdr session list 2>/dev/null | awk -v x="$s" '$1==x && $2=="running"{f=1} END{exit !f}' && return 0
  log="$HOME/.config/pr-review-board/herdr-$s.log"; mkdir -p "$(dirname "$log")"
  if command -v setsid >/dev/null 2>&1; then
    ( prb_scrub_env; setsid herdr --session "$s" server >>"$log" 2>&1 & ) 2>/dev/null
  else
    ( prb_scrub_env; perl -e 'use POSIX qw(setsid); fork and exit; setsid; exec @ARGV' herdr --session "$s" server >>"$log" 2>&1 & ) 2>/dev/null
  fi
  while ! herdr --session "$s" agent list >/dev/null 2>&1; do
    i=$(( i + 1 )); [ "$i" -ge 50 ] && { prb_log "herdr server for $s did not come up"; return 1; }
    sleep 0.2
  done
  return 0
}

RT_KIND=""
RT_ARGV=()
_rt_build_argv() {
  RT_ARGV=(); RT_KIND="$(prb_get agent_kind claude)"
  local a exe="" pdir sub pm hr
  while IFS= read -r a; do
    a="$(prb_tilde "$a")"
    if [ -z "$exe" ]; then
      exe="$a"
      [ "${a##*/}" = "$RT_KIND" ] || prb_log "agent_cmd starts with '$a' but herdr launches --kind $RT_KIND; that first element is ignored"
      continue
    fi
    RT_ARGV+=("$a")
  done < <(prb_get_list agent_cmd)
  pdir="$(prb_get plugin_dir "")"; [ -n "$pdir" ] && RT_ARGV+=(--plugin-dir "$(prb_tilde "$pdir")")
  pm="$(prb_get permission_mode "")"; [ -n "$pm" ] && RT_ARGV+=(--permission-mode "$pm")
  [ "$(prb_get dangerously_skip false)" = "true" ] && RT_ARGV+=(--dangerously-skip-permissions)
  # House rules belong in the worker's system prompt, not only in the assignment
  # file, so they bind even on a turn where it has not re-read the assignment.
  hr="$(prb_get house_rules "")"; [ -n "$hr" ] && RT_ARGV+=(--append-system-prompt "$hr")
  sub="$(prb_get worker_subagent pr-reviewer)"; [ -n "$sub" ] && RT_ARGV+=(--agent "$sub")
}

# The review's workspace, holding one pane at a shell prompt. Echoes
# "<workspace_id> <pane_id>".
_rt_new_workspace() {  # <cwd> <label>
  local s out ws pane; s="$(_rt_session)"
  out="$( prb_scrub_env; herdr --session "$s" workspace create --cwd "$1" --label "$2" --no-focus 2>&1 )"
  ws="$(printf '%s' "$out"   | jq -r '.result.workspace.workspace_id // empty' 2>/dev/null)"
  pane="$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null)"
  [ -n "$ws" ] && [ -n "$pane" ] || { prb_log "workspace create '$2' failed in $s: $out"; return 1; }
  printf '%s %s' "$ws" "$pane"
}

# Attach the agent under an EXACT name. Only agent_pane_busy is retried (the pane's
# shell has not finished coming up); any other error fails immediately. No
# name-suffix fallback: a clash means the review is already up, and suffixing would
# create the duplicates this is designed to prevent.
_rt_agent_start() {  # <name> <pane> <argv...>
  local s name pane out code i=0; s="$(_rt_session)"; name="$1"; pane="$2"; shift 2
  while [ "$i" -lt 15 ]; do
    out="$( prb_scrub_env; herdr --session "$s" agent start "$name" --kind "$RT_KIND" --pane "$pane" -- "$@" 2>&1 )"
    printf '%s' "$out" | jq -e '.result.type == "agent_started"' >/dev/null 2>&1 && return 0
    code="$(printf '%s' "$out" | jq -r '.error.code // empty' 2>/dev/null)"
    [ "$code" = "agent_pane_busy" ] || { prb_log "agent start '$name' failed in $s: $out"; return 1; }
    i=$(( i + 1 )); sleep 1
  done
  prb_log "agent start '$name': pane $pane never reached a shell prompt"
  return 1
}

# Not waited on: a poll pass has no business blocking on a review's first turn.
_rt_prompt() {  # <name> <text>
  ( prb_scrub_env; herdr --session "$(_rt_session)" agent prompt "$1" "$2" >/dev/null 2>&1 ) \
    || prb_log "prompt to '$1' failed"
}

_rt_agent_alive() { herdr --session "$(_rt_session)" agent list 2>/dev/null | jq -e --arg n "$1" '.result.agents[]? | select(.name==$n)' >/dev/null 2>&1; }

rt_status() {  # <key> -> absent|running|stopped
  local key="$1" s name
  [ -n "$(prb_review_field "$key" claude_session)" ] || { printf 'absent'; return; }
  name="$(prb_review_field "$key" agent_name)"
  [ -n "$name" ] || { printf 'absent'; return; }
  # shellcheck disable=SC2034
  s="$(_rt_session)"
  herdr session list 2>/dev/null | awk -v x="$s" '$1==x && $2=="running"{f=1} END{exit !f}' || { printf 'stopped'; return; }
  _rt_agent_alive "$name" && printf 'running' || printf 'stopped'
}

rt_running_count() {
  local n=0 k
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    [ "$(rt_status "$k")" = "running" ] && n=$(( n + 1 ))
  done < <(prb_active_keys)
  printf '%s' "$n"
}

# Bring a review up. The review dir must already exist; poll.sh creates it and
# writes the assignment, so the agent's cwd is its own review dir from turn one.
rt_spawn() {  # <key> <context>
  local key="$1" context="$2" slug dir name sid ws pane pair
  rt_ensure_server || return 1
  _rt_build_argv
  slug="$(prb_review_field "$key" slug)"; dir="$(prb_review_field "$key" dir)"
  name="$(_rt_name "$key")"; sid="$(_rt_new_sid)"
  # cwd is the reviews ROOT, not $dir. Claude prompts for reads outside its cwd, and a
  # background agent cannot answer that, so the assignment, the rules copy and every
  # checkout have to sit inside one cwd. This is why a narrow per-review cwd stalls.
  pair="$(_rt_new_workspace "$(prb_reviews_root)" "$slug")" || return 1
  ws="${pair%% *}"; pane="${pair##* }"
  if ! _rt_agent_start "$name" "$pane" ${RT_ARGV[@]+"${RT_ARGV[@]}"} --session-id "$sid"; then
    herdr --session "$(_rt_session)" workspace close "$ws" >/dev/null 2>&1
    return 1
  fi
  prb_review_set_field "$key" claude_session "$sid"
  prb_review_set_field "$key" agent_name "$name"
  prb_review_set_field "$key" herdr_workspace "$ws"
  _rt_prompt "$name" "$context"
  prb_log "spawned $key (session=$(_rt_session) workspace=$ws label=$slug claude=$sid)"
}

# Recover a review whose agent died while the review is still ACTIVE. Resume never
# re-reviews from scratch: the report and the notes are already on disk.
rt_resume() {  # <key> ; 2 = no saved session
  local key="$1" sid slug dir name ws pane pair
  sid="$(prb_review_field "$key" claude_session)"
  [ -n "$sid" ] || { prb_log "resume $key: no saved session"; return 2; }
  rt_ensure_server || return 1
  _rt_build_argv
  slug="$(prb_review_field "$key" slug)"; dir="$(prb_review_field "$key" dir)"
  name="$(_rt_name "$key")"
  prb_review_set_field "$key" agent_name "$name"
  pair="$(_rt_new_workspace "$(prb_reviews_root)" "$slug")" || return 1
  ws="${pair%% *}"; pane="${pair##* }"
  if ! _rt_agent_start "$name" "$pane" ${RT_ARGV[@]+"${RT_ARGV[@]}"} --resume "$sid"; then
    herdr --session "$(_rt_session)" workspace close "$ws" >/dev/null 2>&1
    return 1
  fi
  prb_review_set_field "$key" herdr_workspace "$ws"
  _rt_prompt "$name" "Resumed. Re-open the hunkt diff for each pull request in your assignment, re-check every pull request and thread for activity since your last pass, and continue. Do not redo finished work."
  prb_log "resumed $key (workspace=$ws claude=$sid)"
}

# Tell a live review that its scope changed, e.g. another pull request was reacted to.
rt_notify() {  # <key> <text>
  local name; name="$(prb_review_field "$1" agent_name)"
  [ -n "$name" ] || return 1
  _rt_agent_alive "$name" || return 1
  _rt_prompt "$name" "$2"
}

# Keep a live workspace's label in step after a promotion. Cosmetic only: identity
# is the agent name, never the label.
rt_relabel() {  # <key> <label>
  local ws; ws="$(prb_review_field "$1" herdr_workspace)"
  [ -n "$ws" ] || return 0
  herdr --session "$(_rt_session)" workspace rename "$ws" "$2" >/dev/null 2>&1
}

# Teardown, for the cleanup skill only. Closing the workspace takes the agent pane
# and every hunkt tab with it.
rt_close_workspace() {  # <key>
  local ws s; ws="$(prb_review_field "$1" herdr_workspace)"; s="$(_rt_session)"
  [ -n "$ws" ] || { prb_log "close $1: no recorded workspace"; return 0; }
  herdr --session "$s" workspace close "$ws" >/dev/null 2>&1 \
    && prb_log "closed herdr workspace $ws for $1" \
    || prb_log "close $1: workspace $ws already gone"
}

rt_list() {
  local k
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    printf '%s\t%s\t%s\t%s\n' "$k" "$(prb_review_status "$k")" "$(rt_status "$k")" "$(prb_review_field "$k" dir)"
  done < <(prb_review_keys)
}

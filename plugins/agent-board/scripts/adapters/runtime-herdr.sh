#!/usr/bin/env bash
# agent-board runtime adapter: herdr (https://herdr.dev), verified on 0.7.5.
#
# ALL tasks run inside ONE shared herdr session (config `herdr_session`, default
# "agent-board"); each task gets its OWN workspace (label = task id + a short slug
# of the issue title, e.g. "mm-474-send-nelnet-files") with one agent pane. Task
# identity for status/reap is the herdr AGENT NAME (deterministic = ab_safe(issue-id)).
# The workspace label is cosmetic only - never keyed on - so it carries the title;
# the agent name stays the bare id.
#
# herdr's `agent start` attaches an agent to an EXISTING pane already sitting at a
# shell prompt, and derives the executable from `--kind`, so a launch takes three
# calls: `workspace create`, which owns cwd and label, `agent start --kind --pane`,
# then `agent prompt` for the kickoff. A just-created pane needs a moment to reach
# its shell prompt, and answers `agent_pane_busy` until it does, so that one error
# is retried.
#
# The claude session id is generated HERE and handed to `claude --session-id <uuid>`.
# herdr only learns an agent's session id if the claude integration hook reports it,
# and that hook is not wired into every install, so `agent_session` reads null;
# owning the uuid keeps spawn and resume deterministic either way.
#
# spawn  = workspace create -> agent start -> agent prompt (kickoff)
# reap   = close that task's pane by name; herdr auto-drops the empty workspace.
# resume = the same three calls with `--resume <mapped uuid>` and a nudge prompt.
#
# Contract used by poll.sh: rt_deps, rt_status, rt_running_count, rt_spawn,
# rt_resume (ret 2 = no saved sid), rt_reap, rt_list.

rt_deps() { printf 'herdr jq uuidgen'; }

_rt_session() { ab_get herdr_session agent-board; }   # the ONE shared session
_rt_name()    { ab_safe "$1"; }                        # per-task agent name (identity) + label base
_rt_new_sid() { uuidgen | tr 'A-Z' 'a-z'; }            # the claude session id we own

# Cosmetic workspace label: the task id plus a short slug of the issue title when
# the source exposes one (src_title), e.g. "mm-474-send-nelnet-files". Falls back
# to the bare id (GitHub source has no src_title, empty title, etc). NEVER used as
# identity - status/reap key on the agent name (_rt_name) only - so enriching it is
# safe. Title slug is lowercased, non-[a-z0-9_-] collapsed to '-', trimmed, and
# capped so labels stay short.
_rt_label() {  # <id> -> "<id-safe>" or "<id-safe>-<title-slug>"
  local id name title slug
  id="$1"; name="$(_rt_name "$id")"
  command -v src_title >/dev/null 2>&1 || { printf '%s' "$name"; return; }
  title="$(src_title "$id" 2>/dev/null)"
  [ -n "$title" ] || { printf '%s' "$name"; return; }
  slug="$(ab_safe "$title" | tr -s '-' | sed -e 's/^-//' -e 's/-*$//')"
  if [ "${#slug}" -gt 40 ]; then                       # cap length, break on a word
    slug="$(printf '%s' "$slug" | cut -c1-40)"
    case "$slug" in *-?*) slug="${slug%-*}";; esac      # drop trailing partial word
    slug="$(printf '%s' "$slug" | sed 's/-*$//')"
  fi
  [ -n "$slug" ] && printf '%s-%s' "$name" "$slug" || printf '%s' "$name"
}

# RT_KIND is herdr's agent kind, which fixes the executable; RT_ARGV is everything
# after it. agent_cmd's first element is dropped, and flagged when it disagrees with
# the kind, because a wrapper or an absolute path there would silently not be what
# runs. RT_ARGV can legitimately be empty, so every expansion has to be the
# ${RT_ARGV[@]+"${RT_ARGV[@]}"} form; bash 3.2 errors on a bare empty-array
# expansion under set -u.
RT_KIND=""
RT_ARGV=()
_rt_build_argv() {
  RT_ARGV=(); RT_KIND="$(ab_get agent_kind claude)"
  local a exe="" pdir sub pm
  while IFS= read -r a; do
    case "$a" in "~/"*) a="$HOME/${a#\~/}";; esac
    if [ -z "$exe" ]; then
      exe="$a"
      [ "${a##*/}" = "$RT_KIND" ] || ab_log "agent_cmd starts with '$a' but herdr launches --kind $RT_KIND; that first element is ignored"
      continue
    fi
    RT_ARGV+=("$a")
  done < <(ab_get_list agent_cmd)
  pdir="$(ab_get plugin_dir "")"; [ -n "$pdir" ] && RT_ARGV+=(--plugin-dir "$pdir")
  pm="$(ab_get permission_mode "")"; [ -n "$pm" ] && RT_ARGV+=(--permission-mode "$pm")
  [ "$(ab_get dangerously_skip false)" = "true" ] && RT_ARGV+=(--dangerously-skip-permissions)
  sub="$(ab_get worker_subagent linear-worker)"; [ -n "$sub" ] && RT_ARGV+=(--agent "$sub")
}

rt_ensure_server() {
  local s i=0 log; s="$(_rt_session)"
  if herdr session list 2>/dev/null | awk -v x="$s" '$1==x && $2=="running"{f=1} END{exit !f}'; then return 0; fi
  log="$HOME/.config/agent-board/herdr-$s.log"; mkdir -p "$(dirname "$log")"
  if command -v setsid >/dev/null 2>&1; then
    ( ab_scrub_env; setsid herdr --session "$s" server >>"$log" 2>&1 & ) 2>/dev/null
  else
    ( ab_scrub_env; perl -e 'use POSIX qw(setsid); fork and exit; setsid; exec @ARGV' herdr --session "$s" server >>"$log" 2>&1 & ) 2>/dev/null
  fi
  while ! herdr --session "$s" agent list >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -ge 50 ] && { ab_log "herdr server for $s did not come up"; return 1; }
    sleep 0.2
  done
  return 0
}

# A task's own workspace, holding one pane at a shell prompt; echo the pane id.
_rt_new_pane() {  # <cwd> <label> -> pane_id
  local s out pane; s="$(_rt_session)"
  out="$( ab_scrub_env; herdr --session "$s" workspace create --cwd "$1" --label "$2" --no-focus 2>&1 )"
  pane="$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null)"
  [ -n "$pane" ] || { ab_log "workspace create '$2' failed in $s: $out"; return 1; }
  printf '%s' "$pane"
}

# Attach the agent to a pane under an EXACT name. Retries only agent_pane_busy (the
# pane's shell has not finished coming up); any other error fails immediately. No
# name-suffix fallback: a name clash means the task is already up (poll won't call
# this then), and suffixing would create the very duplicates we're avoiding.
_rt_agent_start() {  # <name> <pane> <argv...>
  local s name pane out code i=0; s="$(_rt_session)"; name="$1"; pane="$2"; shift 2
  while [ "$i" -lt 15 ]; do
    out="$( ab_scrub_env; herdr --session "$s" agent start "$name" --kind "$RT_KIND" --pane "$pane" -- "$@" 2>&1 )"
    printf '%s' "$out" | jq -e '.result.type == "agent_started"' >/dev/null 2>&1 && return 0
    code="$(printf '%s' "$out" | jq -r '.error.code // empty' 2>/dev/null)"
    [ "$code" = "agent_pane_busy" ] || { ab_log "agent start '$name' failed in $s: $out"; return 1; }
    i=$((i+1)); sleep 1
  done
  ab_log "agent start '$name': pane $pane never reached a shell prompt"
  return 1
}

# Submit the kickoff or nudge prompt. Deliberately not waited on: the poll pass has
# no business blocking on the worker's first turn.
_rt_prompt() {  # <name> <text>
  ( ab_scrub_env; herdr --session "$(_rt_session)" agent prompt "$1" "$2" >/dev/null 2>&1 ) \
    || ab_log "prompt to '$1' failed"
}

_rt_drop_pane() { herdr --session "$(_rt_session)" pane close "$1" >/dev/null 2>&1; }

# --- identity for status/reap: the AGENT NAME (reliable for fresh AND resumed) ---
_rt_agent_alive() {  # <name> -> 0 if a live agent with this exact name exists
  herdr --session "$(_rt_session)" agent list 2>/dev/null | jq -e --arg n "$1" '.result.agents[]? | select(.name==$n)' >/dev/null 2>&1
}
_rt_pane_by_name() {  # <name> -> pane_id
  herdr --session "$(_rt_session)" agent list 2>/dev/null | jq -r --arg n "$1" '.result.agents[]? | select(.name==$n) | .pane_id' 2>/dev/null | head -1
}

rt_status() {  # <id> -> absent|running|stopped
  local id="$1" s name; name="$(_rt_name "$id")"
  [ -n "$(ab_map_get "$id")" ] || { printf 'absent'; return; }   # never spawned
  s="$(_rt_session)"
  herdr session list 2>/dev/null | awk -v x="$s" '$1==x && $2=="running"{f=1} END{exit !f}' || { printf 'stopped'; return; }
  _rt_agent_alive "$name" && printf 'running' || printf 'stopped'
}

rt_running_count() {
  local n=0 id
  while IFS= read -r id; do [ -n "$id" ] || continue; [ "$(rt_status "$id")" = "running" ] && n=$((n+1)); done < <(ab_map_keys)
  printf '%s' "$n"
}

rt_spawn() {  # <id> <context>
  local id="$1" context="$2" name label pane sid
  rt_ensure_server || return 1
  _rt_build_argv
  name="$(_rt_name "$id")"; label="$(_rt_label "$id")"; sid="$(_rt_new_sid)"
  pane="$(_rt_new_pane "$(ab_workspace_root)" "$label")" || return 1
  if ! _rt_agent_start "$name" "$pane" ${RT_ARGV[@]+"${RT_ARGV[@]}"} --session-id "$sid"; then
    _rt_drop_pane "$pane"; return 1                  # leave no empty workspace behind
  fi
  ab_map_set "$id" "$sid"                            # only once the agent is really up
  _rt_prompt "$name" "$context"
  ab_log "spawned $id (session=$(_rt_session) workspace=$label claude=$sid)"
}

rt_resume() {  # <id> ; returns 2 if no saved sid
  local id="$1" sid name label pane nudge
  sid="$(ab_map_get "$id")"; [ -n "$sid" ] || { ab_log "resume $id: no saved sid"; return 2; }
  rt_ensure_server || return 1
  _rt_build_argv
  name="$(_rt_name "$id")"; label="$(_rt_label "$id")"
  nudge="Resumed. Re-check the PR for new automated review comments and continue; do not redo finished work."
  pane="$(_rt_new_pane "$(ab_workspace_root)" "$label")" || return 1
  if ! _rt_agent_start "$name" "$pane" ${RT_ARGV[@]+"${RT_ARGV[@]}"} --resume "$sid"; then
    _rt_drop_pane "$pane"; return 1
  fi
  _rt_prompt "$name" "$nudge"
  ab_log "resumed $id (session=$(_rt_session) workspace=$label claude=$sid)"
}

rt_reap() {  # <id> -- close the task's pane (its workspace auto-drops); keep the sid
  local id="$1" s pane; s="$(_rt_session)"
  [ -n "$(ab_map_get "$id")" ] || return 0
  pane="$(_rt_pane_by_name "$(_rt_name "$id")")"
  if [ -n "$pane" ]; then
    herdr --session "$s" pane close "$pane" >/dev/null 2>&1 && ab_log "reaped $id (closed pane $pane in $s, workspace dropped, sid kept)" || ab_log "reap $id: pane close failed"
  else
    ab_log "reap $id: no live pane (already stopped)"
  fi
}

rt_list() {
  local id
  while IFS= read -r id; do [ -n "$id" ] || continue; printf '%s\t%s\t%s\n' "$id" "$(rt_status "$id")" "$(ab_map_get "$id")"; done < <(ab_map_keys)
}

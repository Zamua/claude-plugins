#!/usr/bin/env bash
# agent-board runtime adapter: herdr (https://herdr.dev), verified on 0.7.4.
#
# One herdr SESSION per task (name = ab_session_name), isolated from the operator's
# default session. Reap = `session stop` (preserves a `stopped`, resumable session;
# NEVER `session delete`). Resume = restart the session server, then
# `agent start ... -- <agent_cmd> --agent <subagent> --resume <id>`, where <id> is
# the claude session id herdr remembers in agent_session.value.
#
# The worker persona is loaded natively as a Claude Code subagent via `--agent`
# (default worker_subagent = linear-worker), so the persona is the session's system
# prompt at launch; the only thing sent afterward is the short task pointer. This
# requires the plugin to be discoverable (installed, or `plugin_dir` set).
#
# Contract used by poll.sh:
#   rt_deps
#   rt_status   <id>            -> absent | running | stopped
#   rt_running_count
#   rt_spawn    <id> <context>  -> fresh worker; sends <context> as the first message
#   rt_resume   <id>            -> restore worker w/ context (ret 2 = no saved id)
#   rt_reap     <id>            -> stop (preserve)
#   rt_list                     -> "<id>\t<status>\t<claude-session-id>"
#
# Verbs confirmed for 0.7.4 (docs are wrong: no --kind/--pane, no `agent prompt`):
# `agent start <name> --cwd P --no-focus -- <argv>`, `agent send`, `pane send-keys`,
# `agent wait --status`, `agent list`, `session stop|list`.

rt_deps() { printf 'herdr jq'; }

# Build the launch argv into RT_ARGV: the configured agent_cmd (~/ expanded), then
# an optional --plugin-dir, then --agent <worker_subagent> so the persona loads as
# the subagent system prompt.
RT_ARGV=()
_rt_build_argv() {
  RT_ARGV=(); local a pdir sub
  while IFS= read -r a; do
    case "$a" in "~/"*) a="$HOME/${a#\~/}";; esac
    RT_ARGV+=("$a")
  done < <(ab_get_list agent_cmd)
  [ "${#RT_ARGV[@]}" -gt 0 ] || RT_ARGV=(claude)
  pdir="$(ab_get plugin_dir "")"; [ -n "$pdir" ] && RT_ARGV+=(--plugin-dir "$pdir")
  sub="$(ab_get worker_subagent linear-worker)"; RT_ARGV+=(--agent "$sub")
}

# Ensure a detached, clean-env herdr server is up for this session. The scrub is
# what keeps worker transcripts on (so --resume has something to load).
rt_ensure_server() {  # <sname>
  local sname="$1" i=0 log
  if herdr session list 2>/dev/null | awk -v s="$sname" '$1==s && $2=="running"{f=1} END{exit !f}'; then
    return 0
  fi
  log="$HOME/.config/agent-board/herdr-$sname.log"; mkdir -p "$(dirname "$log")"
  # Detach so the server outlives this short-lived poll pass. TODO(launchd): the
  # scheduler job may need AbandonProcessGroup / setsid to keep this alive after
  # the pass exits; verify when wiring `poll.sh install`.
  ( ab_scrub_env; nohup herdr --session "$sname" server >>"$log" 2>&1 & disown ) 2>/dev/null
  while ! herdr --session "$sname" agent list >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -ge 50 ] && { ab_log "herdr server for $sname did not come up"; return 1; }
    sleep 0.2
  done
  return 0
}

# Start an agent; echo its pane_id. Retries once with a unique suffix if the base
# name is refused (e.g. a restored-but-dead record left by a prior session stop).
_rt_agent_start() {  # <sname> <name> <cwd> <argv...>
  local sname="$1" name="$2" cwd="$3"; shift 3
  local out pane
  out="$( ab_scrub_env; herdr --session "$sname" agent start "$name" --cwd "$cwd" --no-focus -- "$@" 2>&1 )"
  pane="$(printf '%s' "$out" | jq -r '.result.agent.pane_id // empty' 2>/dev/null)"
  if [ -z "$pane" ]; then
    name="${name}-$(date +%s)"
    out="$( ab_scrub_env; herdr --session "$sname" agent start "$name" --cwd "$cwd" --no-focus -- "$@" 2>&1 )"
    pane="$(printf '%s' "$out" | jq -r '.result.agent.pane_id // empty' 2>/dev/null)"
  fi
  [ -n "$pane" ] || { ab_log "agent start failed on $sname: $out"; return 1; }
  printf '%s' "$pane"
}

# Deliver a prompt to a live worker: type the text, then submit with Enter.
rt_send() {  # <sname> <pane> <text>
  herdr --session "$1" agent send "$2" "$3" >/dev/null 2>&1
  herdr --session "$1" pane send-keys "$2" enter >/dev/null 2>&1
}

rt_wait_idle() { herdr --session "$1" agent wait "$2" --status idle --timeout 60000 >/dev/null 2>&1; }

_rt_sid_by_pane() {  # <sname> <pane>
  herdr --session "$1" agent list 2>/dev/null \
    | jq -r --arg p "$2" '.result.agents[]? | select(.pane_id==$p) | .agent_session.value // empty' 2>/dev/null | head -1
}

# saved claude session id: our map first (authoritative), then herdr's restored record.
rt_saved_session_id() {  # <id>
  local id="$1" sname sid
  sid="$(ab_map_get "$id")"; [ -n "$sid" ] && { printf '%s' "$sid"; return; }
  sname="$(ab_session_name "$id")"
  herdr --session "$sname" agent list 2>/dev/null \
    | jq -r '.result.agents[]? | .agent_session.value // empty' 2>/dev/null | head -1
}

rt_status() {  # <id> -> absent|running|stopped
  local sname; sname="$(ab_session_name "$1")"
  herdr session list 2>/dev/null | awk -v s="$sname" '$1==s{print $2; f=1} END{if(!f) print "absent"}'
}

rt_running_count() {
  local n=0 id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    [ "$(rt_status "$id")" = "running" ] && n=$((n+1))
  done < <(ab_map_keys)
  printf '%s' "$n"
}

rt_spawn() {  # <id> <context>
  local id="$1" context="$2" sname name pane sid cwd
  sname="$(ab_session_name "$id")"; name="$(ab_safe "$id")"; cwd="$(ab_workspace_root)"
  rt_ensure_server "$sname" || return 1
  _rt_build_argv
  pane="$(_rt_agent_start "$sname" "$name" "$cwd" "${RT_ARGV[@]}")" || return 1
  rt_wait_idle "$sname" "$pane"
  rt_send "$sname" "$pane" "$context"
  sid="$(_rt_sid_by_pane "$sname" "$pane")"
  [ -n "$sid" ] && ab_map_set "$id" "$sid"
  ab_log "spawned $id (session=$sname pane=$pane claude=${sid:-?})"
}

rt_resume() {  # <id> ; returns 2 if no saved session id
  local id="$1" sname name sid pane cwd nudge
  sname="$(ab_session_name "$id")"; name="$(ab_safe "$id")"; cwd="$(ab_workspace_root)"
  rt_ensure_server "$sname" || return 1
  sid="$(rt_saved_session_id "$id")"
  [ -n "$sid" ] || { ab_log "resume $id: no saved claude session id"; return 2; }
  _rt_build_argv
  pane="$(_rt_agent_start "$sname" "$name" "$cwd" "${RT_ARGV[@]}" --resume "$sid")" || return 1
  rt_wait_idle "$sname" "$pane"
  nudge="$(printf 'You have been resumed. Re-read issue %s and its latest comments for anything that changed while paused, then continue. Do not redo finished work.' "$id")"
  rt_send "$sname" "$pane" "$nudge"
  ab_map_set "$id" "$sid"
  ab_log "resumed $id (session=$sname pane=$pane claude=$sid)"
}

rt_reap() {  # <id>
  local sname; sname="$(ab_session_name "$1")"
  if herdr session stop "$sname" >/dev/null 2>&1; then ab_log "reaped $1 (stopped $sname, preserved for resume)"
  else ab_log "reap $1: session stop failed for $sname"; fi
}

rt_list() {
  local id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    printf '%s\t%s\t%s\n' "$id" "$(rt_status "$id")" "$(ab_map_get "$id")"
  done < <(ab_map_keys)
}

#!/usr/bin/env bash
# agent-board runtime adapter: herdr (https://herdr.dev), verified on 0.7.4.
#
# ALL tasks run as AGENTS (panes) inside ONE shared herdr session (config
# `herdr_session`, default "agent-board"), NOT a session per task. Task identity
# within the session is the claude session id (agent_session.value), captured at
# spawn and stored in the map - so status/reap/resume key on the sid and are robust
# to agent-name reuse. The shared session is created once and persists.
#
# spawn  = agent start in the shared session, kickoff passed as claude's positional
#          prompt (auto-submits, stays interactive).
# reap   = close that task's pane (worker stops; claude transcript persists; sid kept).
# resume = agent start --resume <sid> in the shared session.
#
# Contract used by poll.sh:
#   rt_deps
#   rt_status <id> -> absent | running | stopped
#   rt_running_count
#   rt_spawn <id> <context>
#   rt_resume <id>            (returns 2 = no saved sid)
#   rt_reap <id>
#   rt_list

rt_deps() { printf 'herdr jq'; }

_rt_session() { ab_get herdr_session agent-board; }   # the ONE shared session
_rt_name()    { ab_safe "$1"; }                        # per-task agent display name

# Build the launch argv: agent_cmd (~/ expanded), optional --plugin-dir, worker
# permission mode (a background worker can't answer prompts), then --agent.
RT_ARGV=()
_rt_build_argv() {
  RT_ARGV=(); local a pdir sub pm
  while IFS= read -r a; do
    case "$a" in "~/"*) a="$HOME/${a#\~/}";; esac
    RT_ARGV+=("$a")
  done < <(ab_get_list agent_cmd)
  [ "${#RT_ARGV[@]}" -gt 0 ] || RT_ARGV=(claude)
  pdir="$(ab_get plugin_dir "")"; [ -n "$pdir" ] && RT_ARGV+=(--plugin-dir "$pdir")
  pm="$(ab_get permission_mode "")"; [ -n "$pm" ] && RT_ARGV+=(--permission-mode "$pm")
  [ "$(ab_get dangerously_skip false)" = "true" ] && RT_ARGV+=(--dangerously-skip-permissions)
  sub="$(ab_get worker_subagent linear-worker)"; RT_ARGV+=(--agent "$sub")
}

# Ensure the ONE shared session's detached, clean-env server is up (idempotent).
rt_ensure_server() {
  local s i=0 log; s="$(_rt_session)"
  if herdr session list 2>/dev/null | awk -v x="$s" '$1==x && $2=="running"{f=1} END{exit !f}'; then return 0; fi
  log="$HOME/.config/agent-board/herdr-$s.log"; mkdir -p "$(dirname "$log")"
  # Detach into its own session so it outlives the short-lived (launchd) poll pass.
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

# Start an agent in the shared session; echo its pane_id. Retries once with a
# unique name if the base is refused (the name is cosmetic; identity is the sid).
_rt_agent_start() {  # <name> <cwd> <argv...>
  local s name cwd out pane; s="$(_rt_session)"; name="$1"; cwd="$2"; shift 2
  out="$( ab_scrub_env; herdr --session "$s" agent start "$name" --cwd "$cwd" --no-focus -- "$@" 2>&1 )"
  pane="$(printf '%s' "$out" | jq -r '.result.agent.pane_id // empty' 2>/dev/null)"
  if [ -z "$pane" ]; then
    name="${name}-$(date +%s)"
    out="$( ab_scrub_env; herdr --session "$s" agent start "$name" --cwd "$cwd" --no-focus -- "$@" 2>&1 )"
    pane="$(printf '%s' "$out" | jq -r '.result.agent.pane_id // empty' 2>/dev/null)"
  fi
  [ -n "$pane" ] || { ab_log "agent start failed in $s: $out"; return 1; }
  printf '%s' "$pane"
}

# claude sid reported for a pane (retry; the integration reports a beat after start)
_rt_sid_by_pane() {
  herdr --session "$(_rt_session)" agent list 2>/dev/null \
    | jq -r --arg p "$1" '.result.agents[]? | select(.pane_id==$p) | .agent_session.value // empty' 2>/dev/null | head -1
}
_rt_capture_sid() {
  local i=0 sid
  while [ "$i" -lt 30 ]; do sid="$(_rt_sid_by_pane "$1")"; [ -n "$sid" ] && { printf '%s' "$sid"; return; }; i=$((i+1)); sleep 0.5; done
}

# live pane hosting the agent whose claude sid == $1 (empty if none)
_rt_pane_for_sid() {
  herdr --session "$(_rt_session)" agent list 2>/dev/null \
    | jq -r --arg sid "$1" '.result.agents[]? | select(.agent_session.value==$sid) | .pane_id' 2>/dev/null | head -1
}

rt_status() {  # <id> -> absent|running|stopped
  local sid s; sid="$(ab_map_get "$1")"
  [ -n "$sid" ] || { printf 'absent'; return; }
  s="$(_rt_session)"
  herdr session list 2>/dev/null | awk -v x="$s" '$1==x && $2=="running"{f=1} END{exit !f}' || { printf 'stopped'; return; }
  [ -n "$(_rt_pane_for_sid "$sid")" ] && printf 'running' || printf 'stopped'
}

rt_running_count() {
  local n=0 id
  while IFS= read -r id; do [ -n "$id" ] || continue; [ "$(rt_status "$id")" = "running" ] && n=$((n+1)); done < <(ab_map_keys)
  printf '%s' "$n"
}

rt_spawn() {  # <id> <context>
  local id="$1" context="$2" pane sid
  rt_ensure_server || return 1
  _rt_build_argv
  pane="$(_rt_agent_start "$(_rt_name "$id")" "$(ab_workspace_root)" "${RT_ARGV[@]}" "$context")" || return 1
  sid="$(_rt_capture_sid "$pane")"; [ -n "$sid" ] && ab_map_set "$id" "$sid"
  ab_log "spawned $id (session=$(_rt_session) pane=$pane claude=${sid:-?})"
}

rt_resume() {  # <id> ; returns 2 if no saved sid
  local id="$1" sid pane nudge
  sid="$(ab_map_get "$id")"; [ -n "$sid" ] || { ab_log "resume $id: no saved sid"; return 2; }
  rt_ensure_server || return 1
  _rt_build_argv
  nudge="Resumed. Re-check the PR for new automated review comments and continue; do not redo finished work."
  pane="$(_rt_agent_start "$(_rt_name "$id")" "$(ab_workspace_root)" "${RT_ARGV[@]}" --resume "$sid" "$nudge")" || return 1
  ab_map_set "$id" "$sid"
  ab_log "resumed $id (session=$(_rt_session) pane=$pane claude=$sid)"
}

rt_reap() {  # <id> -- close the task's pane; keep the sid for a later resume
  local id="$1" s sid pane; s="$(_rt_session)"; sid="$(ab_map_get "$id")"
  [ -n "$sid" ] || return 0
  pane="$(_rt_pane_for_sid "$sid")"
  if [ -n "$pane" ]; then
    herdr --session "$s" pane close "$pane" >/dev/null 2>&1 && ab_log "reaped $id (closed pane $pane in $s, sid kept)" || ab_log "reap $id: pane close failed"
  else
    ab_log "reap $id: no live pane (already stopped)"
  fi
}

rt_list() {
  local id
  while IFS= read -r id; do [ -n "$id" ] || continue; printf '%s\t%s\t%s\n' "$id" "$(rt_status "$id")" "$(ab_map_get "$id")"; done < <(ab_map_keys)
}

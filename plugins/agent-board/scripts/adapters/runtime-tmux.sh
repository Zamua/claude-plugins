#!/usr/bin/env bash
# agent-board runtime adapter: tmux (default).
#
# ALL tasks run as WINDOWS of ONE shared detached session (config `tmux_session`,
# default "agent-board"). Window name = ab_safe(task id) and IS the task identity.
# tmux prefix-matches bare target names, so sessions and windows are always
# addressed with the exact-match forms "=<session>" and "=<session>:=<name>".
#
# The claude session id is minted here (uuidgen) and handed to
# `claude --session-id <uuid>`, so spawn and resume stay deterministic.
#
# spawn  = new-window running: env -u <scrub vars> AB_EXE AB_ARGV --session-id <sid> <kickoff>
# reap   = kill-window on the exact target; the sid is kept for a later resume.
# resume = the same launch with --resume <sid> and a nudge prompt.
#
# A window whose claude exits or crashes simply disappears, so rt_status reads
# "stopped" and the next pass auto-resumes it: that IS the crash-recovery signal.
#
# Operator attach: tmux attach -t <session>.

rt_deps() { printf 'tmux jq uuidgen'; }

_rt_session() { ab_get tmux_session agent-board; }    # the ONE shared session
_rt_name()    { ab_safe "$1"; }                       # per-task window name (identity)
_rt_new_sid() { uuidgen | tr 'A-Z' 'a-z'; }           # the claude session id we own

_rt_session_alive() { tmux has-session -t "=$(_rt_session)" 2>/dev/null; }
_rt_window_alive()  {  # <name>
  tmux list-windows -t "=$(_rt_session)" -F '#W' 2>/dev/null | grep -qxF "$1"
}

# Pane cwd for every window; created up front so tmux -c never points nowhere.
_rt_root() { local r; r="$(ab_workspace_root)"; mkdir -p "$r" 2>/dev/null; printf '%s' "$r"; }

# Shared detached session, created on demand. ab_scrub_env runs in the creating
# subshell: a tmux SERVER started here captures this environment and hands it to
# every window, so nested-claude vars must not leak in.
_rt_ensure_session() {
  local s; s="$(_rt_session)"
  _rt_session_alive && return 0
  ( ab_scrub_env; tmux new-session -d -s "$s" -c "$(_rt_root)" ) 2>/dev/null
  _rt_session_alive || { ab_log "could not create tmux session $s"; return 1; }
}

# One shell string with every word single-quoted: tmux joins its command args
# with spaces and hands them to default-shell -c, so raw interpolation (of the
# kickoff text especially) would be a quoting hole. POSIX '...' quoting (not
# printf %q, whose $'...' output non-bash default-shells mangle) keeps newlines
# and metacharacters intact under any sh. The env -u prefix re-scrubs per
# window, covering a pre-existing server whose environment ab_scrub_env never
# saw.
_rt_q() { local q="'"; printf "'%s'" "${1//$q/$q\\$q$q}"; }
_rt_cmdstr() {  # <trailing argv...> -> one quoted command string on stdout
  local words=(env) v out=""
  # shellcheck disable=SC2086  # AB_SCRUB_VARS is a space-separated list
  for v in $AB_SCRUB_VARS; do words+=(-u "$v"); done
  words+=("$AB_EXE")
  words+=(${AB_ARGV[@]+"${AB_ARGV[@]}"})
  words+=("$@")
  for v in "${words[@]}"; do out="$out$(_rt_q "$v") "; done
  printf '%s' "$out"
}

_rt_launch() {  # <name> <cmdstr>
  tmux new-window -d -t "=$(_rt_session):" -n "$1" -c "$(_rt_root)" "$2"
}

rt_status() {  # <id> -> absent|running|stopped
  local id="$1"
  [ -n "$(ab_map_get "$id")" ] || { printf 'absent'; return; }   # never spawned
  if _rt_session_alive && _rt_window_alive "$(_rt_name "$id")"; then
    printf 'running'
  else
    printf 'stopped'
  fi
}

rt_running_count() {
  local n=0 id
  while IFS= read -r id; do [ -n "$id" ] || continue; [ "$(rt_status "$id")" = "running" ] && n=$((n+1)); done < <(ab_map_keys)
  printf '%s' "$n"
}

rt_spawn() {  # <id> <kickoff>
  local id="$1" kickoff="$2" name sid cmdstr
  _rt_ensure_session || return 1
  name="$(_rt_name "$id")"
  if _rt_window_alive "$name"; then ab_log "spawn $id: window $name already exists; not duplicating"; return 1; fi
  ab_build_worker_argv
  sid="$(_rt_new_sid)"
  cmdstr="$(_rt_cmdstr --session-id "$sid" "$kickoff")"
  _rt_launch "$name" "$cmdstr" || { ab_log "new-window failed for $id"; return 1; }
  ab_map_set "$id" "$sid"                              # only once the window exists
  ab_log "spawned $id (session=$(_rt_session) window=$name claude=$sid)"
}

rt_resume() {  # <id> ; returns 2 if no saved sid
  local id="$1" sid name cmdstr nudge
  sid="$(ab_map_get "$id")"; [ -n "$sid" ] || { ab_log "resume $id: no saved sid"; return 2; }
  _rt_ensure_session || return 1
  name="$(_rt_name "$id")"
  if _rt_window_alive "$name"; then ab_log "resume $id: window $name already exists; not duplicating"; return 1; fi
  ab_build_worker_argv
  nudge="Resumed. Re-check the PR for new automated review comments and continue; do not redo finished work."
  cmdstr="$(_rt_cmdstr --resume "$sid" "$nudge")"
  _rt_launch "$name" "$cmdstr" || { ab_log "new-window failed for $id"; return 1; }
  ab_log "resumed $id (session=$(_rt_session) window=$name claude=$sid)"
}

rt_reap() {  # <id> ; kill the window, keep the sid for a later resume
  local id="$1" s name; s="$(_rt_session)"; name="$(_rt_name "$id")"
  [ -n "$(ab_map_get "$id")" ] || return 0
  if _rt_session_alive && _rt_window_alive "$name"; then
    tmux kill-window -t "=$s:=$name" 2>/dev/null \
      && ab_log "reaped $id (killed window $name in $s, sid kept)" \
      || ab_log "reap $id: kill-window failed"
  else
    ab_log "reap $id: no live window (already stopped)"
  fi
}

rt_list() {
  local id
  while IFS= read -r id; do [ -n "$id" ] || continue; printf '%s\t%s\t%s\n' "$id" "$(rt_status "$id")" "$(ab_map_get "$id")"; done < <(ab_map_keys)
}

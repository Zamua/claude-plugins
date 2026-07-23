#!/usr/bin/env bash
# agent-board runtime adapter: herdr (https://herdr.dev), verified on 0.7.4.
#
# ALL tasks run inside ONE shared herdr session (config `herdr_session`, default
# "agent-board"); each task gets its OWN workspace (label = task id + a short slug
# of the issue title, e.g. "mm-474-send-nelnet-files") with one agent pane. Task
# identity for status/reap is the herdr AGENT NAME (deterministic = ab_safe(issue-id)),
# which both fresh AND resumed agents report reliably. (herdr reports
# agent_session.value=null for `claude --resume` sessions, so we do NOT key on it.)
# The workspace label is cosmetic only - never keyed on - so it carries the title;
# the agent name stays the bare id. The claude session id is captured at spawn and
# kept in the map ONLY to pass to `--resume`.
#
# spawn  = agent start (kickoff as claude's positional prompt) -> move pane to its
#          own new workspace (label = id + title slug) -> capture the claude sid into the map.
# reap   = close that task's pane by name; herdr auto-drops the empty workspace.
# resume = agent start --resume <mapped sid> -> move to its own workspace.
#
# Contract used by poll.sh: rt_deps, rt_status, rt_running_count, rt_spawn,
# rt_resume (ret 2 = no saved sid), rt_reap, rt_list.

rt_deps() { printf 'herdr jq'; }

_rt_session() { ab_get herdr_session agent-board; }   # the ONE shared session
_rt_name()    { ab_safe "$1"; }                        # per-task agent name (identity) + label base

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

# Start an agent in the shared session under an EXACT name; echo its pane_id.
# No name-suffix fallback: a name clash means the task is already up (poll won't
# call this then), and suffixing would create the very duplicates we're avoiding.
_rt_agent_start() {  # <name> <cwd> <argv...>
  local s name cwd out pane; s="$(_rt_session)"; name="$1"; cwd="$2"; shift 2
  out="$( ab_scrub_env; herdr --session "$s" agent start "$name" --cwd "$cwd" --no-focus -- "$@" 2>&1 )"
  pane="$(printf '%s' "$out" | jq -r '.result.agent.pane_id // empty' 2>/dev/null)"
  [ -n "$pane" ] || { ab_log "agent start '$name' failed in $s: $out"; return 1; }
  printf '%s' "$pane"
}

# Move a fresh agent pane into its OWN new workspace under a display label. Best-effort.
_rt_own_workspace() { herdr --session "$(_rt_session)" pane move "$1" --new-workspace --label "$2" --no-focus >/dev/null 2>&1; }

# claude sid for a pane (fresh spawns report it; resumes report null - that's fine,
# we only need it at first spawn to seed the map).
_rt_sid_by_pane() {
  herdr --session "$(_rt_session)" agent list 2>/dev/null \
    | jq -r --arg p "$1" '.result.agents[]? | select(.pane_id==$p) | .agent_session.value // empty' 2>/dev/null | head -1
}
_rt_capture_sid() { local i=0 sid; while [ "$i" -lt 20 ]; do sid="$(_rt_sid_by_pane "$1")"; [ -n "$sid" ] && { printf '%s' "$sid"; return; }; i=$((i+1)); sleep 0.5; done; }

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
  local id="$1" context="$2" pane sid label
  rt_ensure_server || return 1
  _rt_build_argv
  pane="$(_rt_agent_start "$(_rt_name "$id")" "$(ab_workspace_root)" "${RT_ARGV[@]}" "$context")" || return 1
  sid="$(_rt_capture_sid "$pane")"; [ -n "$sid" ] && ab_map_set "$id" "$sid"
  label="$(_rt_label "$id")"
  _rt_own_workspace "$pane" "$label"
  ab_log "spawned $id (session=$(_rt_session) workspace=$label claude=${sid:-?})"
}

rt_resume() {  # <id> ; returns 2 if no saved sid
  local id="$1" sid pane nudge label
  sid="$(ab_map_get "$id")"; [ -n "$sid" ] || { ab_log "resume $id: no saved sid"; return 2; }
  rt_ensure_server || return 1
  _rt_build_argv
  nudge="Resumed. Re-check the PR for new automated review comments and continue; do not redo finished work."
  pane="$(_rt_agent_start "$(_rt_name "$id")" "$(ab_workspace_root)" "${RT_ARGV[@]}" --resume "$sid" "$nudge")" || return 1
  label="$(_rt_label "$id")"
  _rt_own_workspace "$pane" "$label"
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

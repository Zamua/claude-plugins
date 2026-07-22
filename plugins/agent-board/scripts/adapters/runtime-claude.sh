#!/usr/bin/env bash
# agent-board runtime adapter: native claude background agents (`claude --bg`).
# The original agent-board runtime, ported behind the rt_* contract. One bg agent
# per task, each in its own git worktree (claude --worktree) off a managed clone.
#
# Aligned with the new re-entrant model: reap = `claude stop` (transcript kept,
# resumable via `claude respawn`). It NEVER deletes the worktree, branch, or
# session; teardown is manual. The worker persona is loaded as a Claude Code
# subagent via `--agent <worker_subagent>` (default issue-agent).

rt_deps() { printf 'claude gh jq git'; }

# ---- managed clones (this runtime owns its working dirs) ----
_cb_workdir() {
  local w; w="$(ab_get workdir "")"
  [ -n "$w" ] && { printf '%s' "$w"; return; }
  printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/agent-board/repos"
}
# ensure a managed clone of owner/repo, refreshed to its remote default branch so
# a worker's --worktree forks from a current base; echo the clone path.
_cb_ensure_clone() {  # owner/repo -> path
  local slug="$1" dir def; dir="$(_cb_workdir)/$slug"
  if [ ! -d "$dir/.git" ]; then
    mkdir -p "$(dirname "$dir")"
    gh repo clone "$slug" "$dir" -- --quiet >/dev/null 2>&1 || { ab_log "clone failed: $slug"; return 1; }
  fi
  if git -C "$dir" fetch --quiet origin >/dev/null 2>&1; then
    def="$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"
    [ -z "$def" ] && { git -C "$dir" remote set-head origin -a >/dev/null 2>&1; def="$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"; }
    [ -z "$def" ] && def=main
    if git -C "$dir" show-ref --verify --quiet "refs/remotes/origin/$def"; then
      git -C "$dir" checkout --quiet "$def" >/dev/null 2>&1 && git -C "$dir" reset --hard --quiet "origin/$def" >/dev/null 2>&1 \
        || ab_log "could not refresh $slug to origin/$def"
    fi
  else
    ab_log "fetch failed for $slug (using cached clone)"
  fi
  printf '%s' "$dir"
}

_cb_name() { printf '%s-%s' "$(ab_get agent_name_prefix agent-board)" "$(ab_safe "$1")"; }
_cb_live() { claude agents --json 2>/dev/null | jq -r '.[] | select(.kind=="background") | .id' 2>/dev/null; }

rt_status() {  # <id> -> absent|running|stopped
  local sid; sid="$(ab_map_get "$1")"
  [ -n "$sid" ] || { printf 'absent'; return; }
  if _cb_live | grep -qxF "$sid"; then printf 'running'; else printf 'stopped'; fi
}

rt_running_count() {
  local live n=0 id sid; live="$(_cb_live)"
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    sid="$(ab_map_get "$id")"; [ -n "$sid" ] && grep -qxF "$sid" <<<"$live" && n=$((n+1))
  done < <(ab_map_keys)
  printf '%s' "$n"
}

rt_spawn() {  # <id> <context>
  local id="$1" context="$2" repo num clone name pm house pdir sid="" tries=0
  repo="${id%#*}"; num="${id##*#}"
  clone="$(_cb_ensure_clone "$repo")" || return 1
  name="$(_cb_name "$id")"
  # dedup: adopt an already-running agent with this deterministic name
  local existing; existing="$(claude agents --json 2>/dev/null | jq -r --arg n "$name" '.[]|select(.kind=="background" and .name==$n)|.id' | head -1)"
  if [ -n "$existing" ]; then ab_map_set "$id" "$existing"; ab_log "$id already running ($existing); adopted"; return 0; fi
  pm="$(ab_get permission_mode acceptEdits)"; house="$(ab_get house_rules "")"; pdir="$(ab_get plugin_dir "")"
  local sub; sub="$(ab_get worker_subagent issue-agent)"
  local cmd=(claude --bg --agent "$sub" --name "$name" --add-dir "$clone" --permission-mode "$pm")
  [ "$(ab_get worktree true)" = "true" ]          && cmd+=(--worktree)
  [ -n "$pdir" ]                                  && cmd+=(--plugin-dir "$pdir")
  [ "$(ab_get dangerously_skip false)" = "true" ] && cmd+=(--dangerously-skip-permissions)
  [ -n "$house" ]                                 && cmd+=(--append-system-prompt "$house")
  cmd+=("$context Begin now.")
  ( cd "$clone" && "${cmd[@]}" >/dev/null 2>&1 ) || { ab_log "launch failed for $id"; return 1; }
  # --session-id is ignored by --bg; capture the agent's assigned id by name.
  while [ -z "$sid" ] && [ "$tries" -lt 12 ]; do
    sleep 1; tries=$((tries + 1))
    sid="$(claude agents --json 2>/dev/null | jq -r --arg n "$name" '.[]|select(.kind=="background" and .name==$n)|.id' | head -1)"
  done
  [ -n "$sid" ] || { ab_log "$id launched but agent id not found (see 'claude agents')"; return 1; }
  ab_map_set "$id" "$sid"; ab_log "spawned $id (claude-bg $sid, worktree off $clone)"
}

rt_resume() {  # <id> ; returns 2 if no saved session id
  local id="$1" sid; sid="$(ab_map_get "$id")"
  [ -n "$sid" ] || { ab_log "resume $id: no saved session id"; return 2; }
  claude respawn "$sid" >/dev/null 2>&1 && ab_log "resumed $id (respawn $sid)" || { ab_log "respawn failed for $id"; return 1; }
}

rt_reap() {  # <id> ; stop + preserve (transcript kept for respawn)
  local sid; sid="$(ab_map_get "$1")"; [ -n "$sid" ] || return 0
  claude stop "$sid" >/dev/null 2>&1 && ab_log "reaped $1 (stopped $sid, preserved)" || ab_log "reap $1: stop failed"
}

rt_list() {
  local id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    printf '%s\t%s\t%s\n' "$id" "$(rt_status "$id")" "$(ab_map_get "$id")"
  done < <(ab_map_keys)
}

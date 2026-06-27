#!/usr/bin/env bash
# agent-board poller + management CLI. All behavior is config-driven.
#   poll.sh once         one dispatch/resume/teardown pass (what the scheduler runs)
#   poll.sh status       show the board: eligible issues, running agents, the map
#   poll.sh dispatch <owner/repo> <number>        force-dispatch one issue now
#   poll.sh stop <key>   stop a running agent (key = owner/repo#N); transcript kept
#   poll.sh resume <key> respawn a stopped agent
#   poll.sh install      install the scheduler (launchd on macOS, cron line elsewhere)
#   poll.sh uninstall    remove the scheduler
#   poll.sh config-init  write a starter config + sessions file
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

AB_LOCK_DIR=""   # global so the EXIT trap can release the poll lock after cmd_once returns

# launch a fresh background worker for an issue; record key -> session uuid
ab_launch() {  # repo_path slug number url
  local repo="$1" slug="$2" num="$3" url="$4"
  local key="$slug#$num" name perm house pdir
  name="$(ab_get agent_name_prefix agent-board)-$(ab_safe "$slug")-$num"
  # Dedup (belt + suspenders with the poll lock): never launch a second agent
  # for an issue. If one with this exact name is already running, adopt its id.
  local existing
  existing="$(claude agents --json 2>/dev/null | jq -r --arg n "$name" '.[]|select(.kind=="background" and .name==$n)|.id' | head -1)"
  if [ -n "$existing" ]; then
    ab_log "$key already has a running agent ($existing); adopting, no relaunch"
    local ewt; ewt="$(claude agents --json 2>/dev/null | jq -r --arg n "$name" '.[]|select(.kind=="background" and .name==$n)|.cwd' | head -1)"
    ab_map_set "$key" "$existing" "$ewt"; return 0
  fi
  perm="$(ab_get permission_mode acceptEdits)"
  house="$(ab_get house_rules "")"
  pdir="$(ab_get plugin_dir "")"
  # Build ONE argv array (never empty) so it is safe under `set -u` on bash 3.2,
  # the macOS /bin/bash the launchd job runs (empty "${a[@]}" errors there).
  local cmd=(claude --bg --agent issue-agent --name "$name" --add-dir "$repo" --permission-mode "$perm")
  [ "$(ab_get worktree true)" = "true" ]          && cmd+=(--worktree)
  [ -n "$pdir" ]                                  && cmd+=(--plugin-dir "$pdir")
  [ "$(ab_get dangerously_skip false)" = "true" ] && cmd+=(--dangerously-skip-permissions)
  [ -n "$house" ]                                 && cmd+=(--append-system-prompt "$house")

  local prompt="You are an agent-board worker assigned to GitHub issue ${url} (repo ${slug}). \
Follow your issue-agent operating instructions exactly: post a comment that you've started, do the \
work on a branch in this worktree, push and open a PR linked to the issue, then watch the issue and \
the PR for new comments and respond to each. Do NOT merge and do NOT deploy. Begin now."
  cmd+=("$prompt")

  ab_log "dispatch $key -> launching bg agent (name $name)"
  ( cd "$repo" && "${cmd[@]}" >/dev/null 2>&1 ) || { ab_log "launch failed for $key"; return 1; }
  # --session-id is ignored by --bg; capture the agent's assigned short id by name.
  local id="" wt="" tries=0
  while [ -z "$id" ] && [ "$tries" -lt 12 ]; do
    sleep 1; tries=$((tries + 1))
    id="$(claude agents --json 2>/dev/null | jq -r --arg n "$name" '.[] | select(.kind=="background" and .name==$n) | .id' | head -1)"
  done
  [ -n "$id" ] || { ab_log "$key launched but agent id not found (see 'claude agents')"; return 1; }
  # Record the worktree path (agent cwd) alongside the id so cleanup-on-stop can
  # prune the worktree + branch deterministically, even after the session is gone.
  wt="$(claude agents --json 2>/dev/null | jq -r --arg n "$name" '.[] | select(.kind=="background" and .name==$n) | .cwd' | head -1)"
  ab_map_set "$key" "$id" "$wt"
  ab_log "$key -> agent id $id${wt:+ (worktree $wt)}"
}

cmd_once() {
  ab_need claude gh jq git || return 1
  # Global single-flight lock: only one pass runs at a time, so two overlapping
  # passes can never both launch an agent for the same issue. Atomic mkdir works
  # everywhere (no flock on macOS); a stale lock from a dead pass is reclaimed.
  local lock="${AGENT_BOARD_LOCK:-$HOME/.config/agent-board/.poll.lock}"
  mkdir -p "$(dirname "$lock")"
  if ! mkdir "$lock" 2>/dev/null; then
    local holder=""; [ -f "$lock/pid" ] && holder="$(< "$lock/pid")"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      ab_log "another pass (pid $holder) holds the lock; skipping this run"; return 0
    fi
    ab_log "reclaiming stale poll lock (holder '${holder:-?}' gone)"
    rm -rf "$lock"; mkdir "$lock" 2>/dev/null || { ab_log "lost lock race; skipping"; return 0; }
  fi
  echo "$$" > "$lock/pid"
  AB_LOCK_DIR="$lock"
  trap 'rm -rf "$AB_LOCK_DIR"' EXIT
  local label login cap running
  label="$(ab_get label agent)"; login="$(ab_gh_login)"; cap="$(ab_get cap 3)"
  [ -n "$login" ] || { ab_log "no gh_login configured and gh auto-detect failed"; return 1; }
  running="$(ab_running_count)"
  ab_log "pass start: login=$login label=$label cap=$cap running=$running"

  # Loop 1: reconcile KNOWN issues (in the map) via the FRESH per-issue endpoint
  # (gh issue view), which - unlike `gh issue list` - has no read-after-write lag.
  # CLOSED + running -> stop; OPEN + stopped -> respawn (lag-free reopen/resume).
  local key sid slug num st
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    sid="$(ab_map_get "$key")"; [ -n "$sid" ] || continue
    slug="${key%#*}"; num="${key##*#}"
    st="$(ab_issue_state "$slug" "$num")"
    if [ "$st" = "CLOSED" ]; then
      # Issue done -> full cleanup (stop + worktree + branch + session + map entry).
      # Runs whether or not the agent is still up, so a closed issue never leaves a
      # stray worktree/session behind. map_del here means a later reopen is picked
      # up fresh by Loop 2 (not resumed) - consistent with closed = done.
      if ab_is_running "$sid"; then running=$((running > 0 ? running - 1 : 0)); fi
      ab_log "issue $key closed -> cleaning up $sid"
      ab_cleanup_worker "$key" "$sid"
    elif [ "$st" = "OPEN" ] && ! ab_is_running "$sid"; then
      if [ "$running" -ge "$cap" ]; then ab_log "cap $cap reached; resume of $key queued"
      else
        ab_log "issue $key reopened/stopped -> respawn $sid"
        claude respawn "$sid" >/dev/null 2>&1 && running=$((running + 1)) || ab_log "respawn failed for $key"
      fi
    fi
  done < <(ab_map_keys)

  # Loop 2: discover NEW eligible issues across ALL repos via cross-repo search
  # (absent from the map). Clone-on-demand into the managed workdir, then launch.
  local url path
  while IFS=$'\t' read -r slug num url; do
    [ -n "$num" ] || continue
    key="$slug#$num"
    [ -n "$(ab_map_get "$key")" ] && continue                   # known -> Loop 1 owns it
    [ "$(ab_issue_state "$slug" "$num")" = "OPEN" ] || continue # search lags; confirm fresh
    if [ "$running" -ge "$cap" ]; then ab_log "cap $cap reached; queue $key"; continue; fi
    path="$(ab_ensure_clone "$slug")" || continue
    ab_launch "$path" "$slug" "$num" "$url" && running=$((running + 1))
  done < <(ab_search_issues "$label" "$login")
  ab_log "pass done: running=$running"
}

cmd_status() {
  ab_need claude gh jq git || return 1
  local label login live; label="$(ab_get label agent)"; login="$(ab_gh_login)"; live="$(ab_live_sessions)"
  printf 'agent-board status\n'
  printf '  config:  %s\n' "$AB_CONFIG"
  printf '  login=%s  label=%s  cap=%s  running=%s\n' "$login" "$label" "$(ab_get cap 3)" "$(ab_running_count)"
  printf '  tracked issues:\n'
  local key sid
  while IFS= read -r key; do
    sid="$(ab_map_get "$key")"
    if grep -qxF "$sid" <<<"$live"; then printf '    %-30s RUNNING  %s\n' "$key" "$sid"
    else printf '    %-30s stopped  %s\n' "$key" "$sid"; fi
  done < <(ab_map_keys)
  printf '  workdir: %s\n' "$(ab_workdir)"
  printf '  eligible open issues (all repos):\n'
  local slug num url
  while IFS=$'\t' read -r slug num url; do [ -n "$num" ] && printf '    %-24s %s\n' "$slug#$num" "$url"; done \
    < <(ab_search_issues "$label" "$login")
}

cmd_stop()   { local s; s="$(ab_map_get "$1")"; [ -n "$s" ] || { ab_log "no session for $1"; return 1; }; claude stop "$s"; }
cmd_resume() { local s; s="$(ab_map_get "$1")"; [ -n "$s" ] || { ab_log "no session for $1"; return 1; }; claude respawn "$s"; }
cmd_dispatch() {  # owner/repo number
  ab_need claude gh jq git || return 1
  local slug="$1" num="$2" url path
  url="$(gh issue view "$num" --repo "$slug" --json url --jq .url 2>/dev/null)"
  [ -n "$url" ] || { ab_log "could not resolve issue $num in $slug"; return 1; }
  path="$(ab_ensure_clone "$slug")" || return 1
  ab_launch "$path" "$slug" "$num" "$url"
}

cmd_install() {
  local interval log; interval="$(ab_get poll_seconds 90)"; log="$HOME/.config/agent-board/poll.log"
  mkdir -p "$HOME/.config/agent-board"
  if [ "$(uname)" = "Darwin" ]; then
    local label="com.agent-board.poller" plist
    plist="$HOME/Library/LaunchAgents/$label.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    sed -e "s#@POLL@#$HERE/poll.sh#g" -e "s#@INTERVAL@#$interval#g" -e "s#@LABEL@#$label#g" -e "s#@LOG@#$log#g" \
        "$HERE/../launchd/com.agent-board.poller.plist" >"$plist"
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist" && ab_log "installed launchd job $label (every ${interval}s); logs: $log"
  else
    ab_log "non-macOS: add this crontab line (cron min resolution is 60s):"
    printf '* * * * * %s once >> %s 2>&1\n' "$HERE/poll.sh" "$log"
  fi
}
cmd_uninstall() {
  if [ "$(uname)" = "Darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/com.agent-board.poller.plist"
    launchctl unload "$plist" 2>/dev/null || true; rm -f "$plist"; ab_log "removed launchd job"
  else ab_log "remove the agent-board crontab line manually"; fi
}
cmd_config_init() {
  mkdir -p "$(dirname "$AB_CONFIG")"
  if [ -f "$AB_CONFIG" ]; then ab_log "config already exists at $AB_CONFIG"
  else cp "$HERE/../config.example.json" "$AB_CONFIG"; ab_log "wrote starter config to $AB_CONFIG - edit 'repos' (local paths) + optionally 'gh_login'"; fi
  ab_map_init
}

main() {
  local cmd="${1:-help}"; shift 2>/dev/null || true
  case "$cmd" in
    once)        cmd_once "$@" ;;
    status)      cmd_status "$@" ;;
    dispatch)    cmd_dispatch "$@" ;;
    stop)        cmd_stop "$@" ;;
    resume)      cmd_resume "$@" ;;
    install)     cmd_install "$@" ;;
    uninstall)   cmd_uninstall "$@" ;;
    config-init) cmd_config_init "$@" ;;
    help|-h|--help) sed -n '2,10p' "$HERE/poll.sh" | sed 's/^#\{0,1\} \{0,1\}//' ;;
    *) ab_log "unknown command: $cmd (try: help)"; exit 2 ;;
  esac
}
main "$@"

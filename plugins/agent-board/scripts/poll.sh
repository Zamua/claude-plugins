#!/usr/bin/env bash
# agent-board poller + management CLI. Thin harness: it only decides spawn / reap
# / resume from the task board's state; everything object-level (repos, worktrees,
# PRs) is the worker's job. Config-driven; source + runtime are pluggable adapters:
#   source=linear runtime=herdr   (work)      source=github runtime=claude  (personal)
#
#   poll.sh once            one spawn/resume/reap pass (what the scheduler runs)
#   poll.sh status          show the board + tracked sessions
#   poll.sh spawn  <id>     force-spawn one task now (MM-476, or owner/repo#N)
#   poll.sh resume <id>     force-resume one task's session
#   poll.sh reap   <id>     stop (preserve) one task's session
#   poll.sh install         install the scheduler (launchd on macOS, cron line elsewhere)
#   poll.sh uninstall       remove the scheduler
#   poll.sh config-init     write a starter config
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
# Load the configured source + runtime adapters (default linear + herdr).
AB_SOURCE="$(ab_get source linear)"; AB_RUNTIME="$(ab_get runtime herdr)"
# shellcheck disable=SC1090
source "$HERE/adapters/source-$AB_SOURCE.sh"   || { ab_log "no source adapter: $AB_SOURCE"; exit 1; }
# shellcheck disable=SC1090
source "$HERE/adapters/runtime-$AB_RUNTIME.sh" || { ab_log "no runtime adapter: $AB_RUNTIME"; exit 1; }

cmd_once() {
  ab_need $(src_deps) $(rt_deps) git || return 1
  ab_lock || return 0
  trap 'ab_unlock' EXIT
  local cap running reap_states reap_disp id st rc st_now
  cap="$(ab_get cap 3)"
  # reap_state may be a scalar ("Done") or a list (["Done","Canceled"]); a task
  # reaching ANY listed state gets reaped. State names have spaces, so use the
  # non-splitting lines helper, not ab_get_list.
  reap_states="$(ab_get_lines reap_state completed)"
  reap_disp="$(printf '%s' "$reap_states" | tr '\n' ',' | sed 's/,$//')"
  running="$(rt_running_count)"
  ab_log "pass start: source=$AB_SOURCE runtime=$AB_RUNTIME cap=$cap reap=$reap_disp running=$running"

  # Pass 1: SPAWN / RESUME. Candidates are the source's spawn-eligible tasks.
  # Re-entrant: running -> no-op; stopped -> resume; absent -> spawn. Guarded so
  # we only ever act when the operator took the last action on the task.
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if ! src_last_actor_is_me "$id"; then
      ab_log "skip $id: last action not by operator (spawn guard)"; continue
    fi
    st="$(rt_status "$id")"
    case "$st" in
      running) : ;;
      stopped)
        if [ "$running" -ge "$cap" ]; then ab_log "cap $cap reached; resume $id queued"; continue; fi
        rt_resume "$id"; rc=$?
        if   [ "$rc" = "2" ]; then rt_spawn "$id" "$(src_kickoff_context "$id")" && running=$((running+1))
        elif [ "$rc" = "0" ]; then running=$((running+1)); fi ;;
      absent)
        if [ "$running" -ge "$cap" ]; then ab_log "cap $cap reached; spawn $id queued"; continue; fi
        rt_spawn "$id" "$(src_kickoff_context "$id")" && running=$((running+1)) ;;
    esac
  done < <(src_spawn_candidates)

  # Pass 2: REAP. Any tracked task whose state reached a reap state -> stop
  # (preserve). Exact full-line match against the reap-states list; an empty state
  # (e.g. a source API hiccup) never reaps.
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    [ "$(rt_status "$id")" = "running" ] || continue
    st_now="$(src_state "$id")"; [ -n "$st_now" ] || continue
    if printf '%s\n' "$reap_states" | grep -Fxq -- "$st_now"; then
      rt_reap "$id"; running=$(( running > 0 ? running - 1 : 0 ))
    fi
  done < <(ab_map_keys)
  ab_log "pass done: running=$running"
}

cmd_status() {
  ab_need $(src_deps) $(rt_deps) || return 1
  printf 'agent-board  (%s -> %s)\n' "$AB_SOURCE" "$AB_RUNTIME"
  printf '  config:  %s\n' "$AB_CONFIG"
  printf '  label=%s  spawn=%s  reap=%s  cap=%s  running=%s\n' \
    "$(ab_get label agent)" "$(ab_get spawn_state started)" \
    "$(ab_get_lines reap_state completed | tr '\n' ',' | sed 's/,$//')" \
    "$(ab_get cap 3)" "$(rt_running_count)"
  printf '  tracked sessions:\n'
  local id st sid
  while IFS=$'\t' read -r id st sid; do printf '    %-22s %-8s %s\n' "$id" "$st" "$sid"; done < <(rt_list)
  printf '  spawn-eligible now:\n'
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if src_last_actor_is_me "$id"; then printf '    %-22s guard:ok\n' "$id"
    else printf '    %-22s guard:SKIP (last action not yours)\n' "$id"; fi
  done < <(src_spawn_candidates)
}

cmd_spawn()  { ab_need $(src_deps) $(rt_deps) git || return 1; rt_spawn "$1" "$(src_kickoff_context "$1")"; }
cmd_resume() { ab_need $(src_deps) $(rt_deps) || return 1; rt_resume "$1"; }
cmd_reap()   { ab_need $(rt_deps) || return 1; rt_reap "$1"; }

cmd_install() {
  local interval log; interval="$(ab_get poll_seconds 90)"; log="$HOME/.config/agent-board/poll.log"
  mkdir -p "$HOME/.config/agent-board"
  if [ "$(uname)" = "Darwin" ]; then
    local label="com.agent-board.poller" plist
    plist="$HOME/Library/LaunchAgents/$label.plist"; mkdir -p "$HOME/Library/LaunchAgents"
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
  else cp "$HERE/../config.example.json" "$AB_CONFIG"; ab_log "wrote starter config to $AB_CONFIG - set source/runtime + spawn_state/reap_state/label/agent_cmd"; fi
  ab_map_init
}

main() {
  local cmd="${1:-help}"; shift 2>/dev/null || true
  case "$cmd" in
    once)        cmd_once "$@" ;;
    status)      cmd_status "$@" ;;
    spawn)       cmd_spawn "$@" ;;
    resume)      cmd_resume "$@" ;;
    reap)        cmd_reap "$@" ;;
    install)     cmd_install "$@" ;;
    uninstall)   cmd_uninstall "$@" ;;
    config-init) cmd_config_init "$@" ;;
    help|-h|--help) sed -n '2,18p' "$HERE/poll.sh" | sed 's/^# \{0,1\}//' ;;
    *) ab_log "unknown command: $cmd (try: help)"; exit 2 ;;
  esac
}
main "$@"

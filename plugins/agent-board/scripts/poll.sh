#!/usr/bin/env bash
# agent-board poller + management CLI. All behavior is config-driven.
#   poll.sh once         one dispatch/resume/teardown pass (what the scheduler runs)
#   poll.sh status       show the board: eligible issues, running agents, the map
#   poll.sh dispatch <repo_path> <issue_number>   force-dispatch one issue now
#   poll.sh stop <key>   stop a running agent (key = owner/repo#N); transcript kept
#   poll.sh resume <key> respawn a stopped agent
#   poll.sh install      install the scheduler (launchd on macOS, cron line elsewhere)
#   poll.sh uninstall    remove the scheduler
#   poll.sh config-init  write a starter config + sessions file
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

# map a configured repo path from a slug
ab_repo_for_slug() {
  local repo
  while IFS= read -r repo; do
    [ "$(ab_slug "$repo")" = "$1" ] && { printf '%s' "$repo"; return; }
  done < <(ab_repos)
}

# launch a fresh background worker for an issue; record key -> session uuid
ab_launch() {  # repo_path slug number url
  local repo="$1" slug="$2" num="$3" url="$4"
  local key="$slug#$num" uuid name perm house
  uuid="$(ab_uuid)"
  name="$(ab_get agent_name_prefix agent-board)-$(ab_safe "$slug")-$num"
  perm="$(ab_get permission_mode acceptEdits)"
  house="$(ab_get house_rules "")"
  local wt=();    [ "$(ab_get worktree true)" = "true" ] && wt=(--worktree)
  local danger=(); [ "$(ab_get dangerously_skip false)" = "true" ] && danger=(--dangerously-skip-permissions)
  local extra=(); [ -n "$house" ] && extra=(--append-system-prompt "$house")

  local prompt="You are an agent-board worker assigned to GitHub issue ${url} (repo ${slug}). \
Follow your issue-agent operating instructions exactly: post a comment that you've started, do the \
work on a branch in this worktree, push and open a PR linked to the issue, then watch the issue and \
the PR for new comments and respond to each. Do NOT merge and do NOT deploy. Begin now."

  ab_log "dispatch $key -> bg session $uuid (name $name)"
  ( cd "$repo" && claude --bg --agent issue-agent --session-id "$uuid" \
      "${wt[@]}" --name "$name" --add-dir "$repo" --permission-mode "$perm" \
      "${danger[@]}" "${extra[@]}" "$prompt" >/dev/null 2>&1 ) \
    || { ab_log "launch failed for $key"; return 1; }
  ab_map_set "$key" "$uuid"
}

cmd_once() {
  ab_need claude gh jq git uuidgen || return 1
  local label login cap running
  label="$(ab_get label agent)"; login="$(ab_gh_login)"; cap="$(ab_get cap 3)"
  [ -n "$login" ] || { ab_log "no gh_login configured and gh auto-detect failed"; return 1; }
  running="$(ab_running_count)"
  ab_log "pass start: login=$login label=$label cap=$cap running=$running"

  # 1. teardown: stop agents whose issue is now CLOSED (transcript kept for reopen)
  local key sid slug num repo st
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    sid="$(ab_map_get "$key")"; [ -n "$sid" ] || continue
    ab_is_running "$sid" || continue
    slug="${key%#*}"; num="${key##*#}"; repo="$(ab_repo_for_slug "$slug")"; [ -n "$repo" ] || continue
    st="$(ab_issue_state "$repo" "$num")"
    if [ "$st" = "CLOSED" ]; then
      ab_log "issue $key closed -> stop $sid"
      claude stop "$sid" >/dev/null 2>&1 || true
      running=$((running > 0 ? running-1 : 0))
    fi
  done < <(ab_map_keys)

  # 2. dispatch new / resume reopened, eligible OPEN issues, up to the cap
  local url
  while IFS= read -r repo; do
    [ -n "$repo" ] || continue
    slug="$(ab_slug "$repo")"; [ -n "$slug" ] || { ab_log "no git remote slug for $repo"; continue; }
    while IFS=$'\t' read -r num url; do
      [ -n "$num" ] || continue
      key="$slug#$num"; sid="$(ab_map_get "$key")"
      if [ -n "$sid" ] && ab_is_running "$sid"; then continue; fi          # already working
      if [ "$running" -ge "$cap" ]; then ab_log "cap $cap reached; queue $key"; continue; fi
      if [ -n "$sid" ]; then
        ab_log "reopen/restart $key -> respawn $sid"
        claude respawn "$sid" >/dev/null 2>&1 \
          || { ab_log "respawn failed; relaunching $key"; ab_launch "$repo" "$slug" "$num" "$url" || continue; }
      else
        ab_launch "$repo" "$slug" "$num" "$url" || continue
      fi
      running=$((running+1))
    done < <(ab_eligible_issues "$repo" "$label" "$login")
  done < <(ab_repos)
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
  printf '  eligible open issues:\n'
  local repo slug num url
  while IFS= read -r repo; do
    [ -n "$repo" ] || continue; slug="$(ab_slug "$repo")"
    while IFS=$'\t' read -r num url; do [ -n "$num" ] && printf '    %-18s %s\n' "$slug#$num" "$url"; done \
      < <(ab_eligible_issues "$repo" "$label" "$login")
  done < <(ab_repos)
}

cmd_stop()   { local s; s="$(ab_map_get "$1")"; [ -n "$s" ] || { ab_log "no session for $1"; return 1; }; claude stop "$s"; }
cmd_resume() { local s; s="$(ab_map_get "$1")"; [ -n "$s" ] || { ab_log "no session for $1"; return 1; }; claude respawn "$s"; }
cmd_dispatch() {
  ab_need claude gh jq git uuidgen || return 1
  local repo="$1" num="$2" slug url
  slug="$(ab_slug "$repo")"; url="$(cd "$repo" && gh issue view "$num" --json url --jq .url 2>/dev/null)"
  [ -n "$url" ] || { ab_log "could not resolve issue $num in $repo"; return 1; }
  ab_launch "$repo" "$slug" "$num" "$url"
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

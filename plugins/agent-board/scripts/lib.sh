#!/usr/bin/env bash
# agent-board shared helpers. Everything is config-driven - no hardcoded
# logins, repos, or paths. Sourced by poll.sh and the board skill.
set -uo pipefail

# Schedulers (launchd/cron) run with a minimal PATH; make the common tool
# locations discoverable so claude/gh/jq/git resolve however they were installed.
export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

AB_CONFIG="${AGENT_BOARD_CONFIG:-$HOME/.config/agent-board/config.json}"
AB_STATE="${AGENT_BOARD_STATE:-$HOME/.config/agent-board/sessions.json}"

ab_log() { printf '%s agent-board: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >&2; }

ab_need() {
  local ok=0 c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || { ab_log "missing dependency: $c"; ok=1; }; done
  return $ok
}

# ---- config (top-level keys, with defaults) ----
ab_get() {
  local key="$1" def="${2-}" v
  [ -f "$AB_CONFIG" ] || { printf '%s' "$def"; return; }
  v=$(jq -r --arg k "$key" '.[$k] // empty' "$AB_CONFIG" 2>/dev/null)
  if [ -n "$v" ] && [ "$v" != "null" ]; then printf '%s' "$v"; else printf '%s' "$def"; fi
}

# the github login to filter issues by; configured value or auto-detected
ab_gh_login() {
  local v; v=$(ab_get gh_login "")
  if [ -n "$v" ]; then printf '%s' "$v"; else gh api user --jq .login 2>/dev/null; fi
}

# configured local repo paths, one per line (empty if unset)
ab_repos() {
  [ -f "$AB_CONFIG" ] || return 0
  jq -r '.repos[]? // empty' "$AB_CONFIG" 2>/dev/null
}

# owner/repo slug from a local repo's origin remote
ab_slug() {
  git -C "$1" config --get remote.origin.url 2>/dev/null \
    | sed -E 's#^(git@[^:]+:|https?://[^/]+/)##; s#\.git$##' | head -1
}

# a filesystem/agent-name-safe token from a slug
ab_safe() { printf '%s' "$1" | tr '/:.@' '----'; }

ab_uuid() { uuidgen | tr 'A-Z' 'a-z'; }

# ---- session map: "owner/repo#N" -> session uuid ----
ab_map_init() { [ -f "$AB_STATE" ] || { mkdir -p "$(dirname "$AB_STATE")"; printf '{}\n' >"$AB_STATE"; }; }
ab_map_get()  { ab_map_init; jq -r --arg k "$1" '.[$k] // empty' "$AB_STATE"; }
ab_map_set()  {
  ab_map_init; local tmp; tmp=$(mktemp)
  jq --arg k "$1" --arg v "$2" '.[$k]=$v' "$AB_STATE" >"$tmp" && mv "$tmp" "$AB_STATE"
}
ab_map_keys() { ab_map_init; jq -r 'keys[]' "$AB_STATE"; }
ab_map_vals() { ab_map_init; jq -r '.[]' "$AB_STATE"; }

# ---- live background agents (by sessionId) ----
ab_live_sessions() {
  claude agents --json 2>/dev/null | jq -r '.[] | select(.kind=="background") | .sessionId' 2>/dev/null
}
ab_is_running() { ab_live_sessions | grep -qxF "$1"; }            # arg: session uuid
ab_running_count() {                                              # our mapped sessions that are live
  local live n=0 sid; live=$(ab_live_sessions)
  while IFS= read -r sid; do
    [ -n "$sid" ] && grep -qxF "$sid" <<<"$live" && n=$((n+1))
  done < <(ab_map_vals)
  printf '%s' "$n"
}

# ---- gh issue helpers (run inside a repo path) ----
# eligible OPEN issues: "<number>\t<url>" lines
ab_eligible_issues() {  # args: repo_path label login
  ( cd "$1" 2>/dev/null && gh issue list --label "$2" --author "$3" --state open \
      --json number,url --jq '.[] | "\(.number)\t\(.url)"' 2>/dev/null )
}
ab_issue_state() {  # args: repo_path number  -> OPEN|CLOSED|""
  ( cd "$1" 2>/dev/null && gh issue view "$2" --json state --jq '.state' 2>/dev/null )
}

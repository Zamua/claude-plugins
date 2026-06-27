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

# the managed directory that holds agent-board's own clones (one per repo), kept
# separate from the user's working checkouts. Configurable; sensible XDG default.
ab_workdir() {
  local w; w="$(ab_get workdir "")"
  if [ -n "$w" ]; then printf '%s' "$w"; else printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/agent-board/repos"; fi
}

# ensure a managed clone of owner/repo exists; echo its path (clone if missing)
ab_ensure_clone() {  # owner/repo
  local slug="$1" dir; dir="$(ab_workdir)/$slug"
  if [ ! -d "$dir/.git" ]; then
    mkdir -p "$(dirname "$dir")"
    gh repo clone "$slug" "$dir" -- --quiet >/dev/null 2>&1 || { ab_log "clone failed: $slug"; return 1; }
  fi
  printf '%s' "$dir"
}

# owner/repo slug from a local repo's origin remote (used to label worktrees)
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

# ---- live background agents (by short id) ----
# `--session-id` is ignored by `--bg`; claude assigns the agent its own short
# `id` (also the sessionId prefix). That short id is what stop/respawn/logs take
# and what `claude agents --json` reports, so it is the lifecycle key we track.
ab_live_sessions() {
  claude agents --json 2>/dev/null | jq -r '.[] | select(.kind=="background") | .id' 2>/dev/null
}
ab_is_running() { ab_live_sessions | grep -qxF "$1"; }            # arg: agent short id
ab_running_count() {                                              # our mapped sessions that are live
  local live n=0 sid; live=$(ab_live_sessions)
  while IFS= read -r sid; do
    [ -n "$sid" ] && grep -qxF "$sid" <<<"$live" && n=$((n+1))
  done < <(ab_map_vals)
  printf '%s' "$n"
}

# ---- gh issue helpers (cross-repo; no allowlist) ----
# all eligible OPEN issues the user authored with the label, across EVERY repo:
# "owner/repo\t<number>\t<url>" lines. Excludes PRs.
ab_search_issues() {  # args: label login
  gh search issues --author "$2" --label "$1" --state open --limit 50 \
    --json repository,number,url,isPullRequest \
    --jq '.[] | select(.isPullRequest | not) | "\(.repository.nameWithOwner)\t\(.number)\t\(.url)"' 2>/dev/null
}
# fresh per-issue state (no read-after-write lag, unlike search): OPEN|CLOSED|""
ab_issue_state() {  # args: owner/repo number
  gh issue view "$2" --repo "$1" --json state --jq '.state' 2>/dev/null
}

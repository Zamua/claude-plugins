#!/usr/bin/env bash
# agent-board shared core. Provider-agnostic: config, logging, the poll lock, the
# task->session map, and small helpers. Source-specific logic (Linear) lives in
# adapters/source-*.sh and runtime-specific logic (herdr) in adapters/runtime-*.sh;
# poll.sh sources this plus the two adapters the config selects.
#
# Kept bash-3.2-safe: the launchd job runs macOS /bin/bash. No associative arrays,
# no ${x,,}, no mapfile; never expand a possibly-empty array under `set -u`.
set -uo pipefail

# Schedulers (launchd/cron) run with a minimal PATH; make common tool locations
# discoverable so claude/herdr/linear/jq/git resolve however they were installed.
export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

AB_CONFIG="${AGENT_BOARD_CONFIG:-$HOME/.config/agent-board/config.json}"
AB_STATE="${AGENT_BOARD_STATE:-$HOME/.config/agent-board/sessions.json}"

ab_log() { printf '%s agent-board: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >&2; }

ab_need() {
  local ok=0 c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || { ab_log "missing dependency: $c"; ok=1; }; done
  return $ok
}

# ---- config ----
# a scalar string value (or the default)
ab_get() {
  local key="$1" def="${2-}" v
  [ -f "$AB_CONFIG" ] || { printf '%s' "$def"; return; }
  v=$(jq -r --arg k "$key" '.[$k] // empty' "$AB_CONFIG" 2>/dev/null)
  if [ -n "$v" ] && [ "$v" != "null" ]; then printf '%s' "$v"; else printf '%s' "$def"; fi
}
# a value that may be a JSON array OR a whitespace-separated string: emit one
# element per line. Used for agent_cmd so a full argv (model/effort/mcp flags)
# round-trips exactly when given as an array. Empty -> nothing.
ab_get_list() {
  [ -f "$AB_CONFIG" ] || return 0
  jq -r --arg k "$1" '
    .[$k] as $v
    | if   $v == null        then empty
      elif ($v|type)=="array"  then $v[]
      elif ($v|type)=="string" then ($v / " ")[]
      else $v end' "$AB_CONFIG" 2>/dev/null
}

# a value that may be a JSON array OR a single scalar: emit one element per line,
# WITHOUT splitting scalars on whitespace (unlike ab_get_list). Used for state
# names, which contain spaces ("In Progress"), so reap_state can be a list like
# ["Done","Canceled"] while a bare scalar ("Done") still yields one entry. Empty or
# absent -> the default arg (one line), so callers get back-compat behavior.
ab_get_lines() {  # <key> [default]
  local key="$1" def="${2-}" out=""
  if [ -f "$AB_CONFIG" ]; then
    out=$(jq -r --arg k "$key" '
      .[$k] as $v
      | if   $v == null        then empty
        elif ($v|type)=="array"  then $v[]
        else $v end' "$AB_CONFIG" 2>/dev/null)
  fi
  if [ -n "$out" ]; then printf '%s\n' "$out"; elif [ -n "$def" ]; then printf '%s\n' "$def"; fi
}

# workspace root the workers operate under (per the user global CLAUDE.md flow).
ab_workspace_root() {
  local w; w="$(ab_get workspace_root "")"
  [ -n "$w" ] && { printf '%s' "$w"; return; }
  printf '%s' "$HOME/workspace"
}

# deterministic herdr session name for a task, so spawn/reap/resume are
# re-entrant with no duplicates. Lowercased issue id (matches ~/workspace/<id>
# and feature/<id>), with an optional configurable prefix.
ab_session_name() {  # <issue-id>
  local id pfx; pfx="$(ab_get session_prefix "")"
  id="$(printf '%s' "$1" | tr 'A-Z' 'a-z')"
  printf '%s%s' "$pfx" "$id"
}

# a filesystem/agent-name-safe token
ab_safe() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-'; }

# Env vars that, if inherited from a parent claude session, mark a nested claude
# as a "child" and disable its transcript, which would break `claude --resume`.
# Scrub them (plus any inherited herdr socket/session pointers) before launching
# herdr so workers save transcripts and every call honors explicit --session.
# Harmless under launchd (already a clean env); essential if ever run from inside
# a claude session. Call inside the subshell that execs herdr.
AB_SCRUB_VARS="CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS CLAUDE_CODE_SESSION_ID CLAUDE_CODE_WORKING_DIR HERDR_SOCKET_PATH HERDR_SESSION HERDR_WORKSPACE_ID HERDR_PANE_ID"
ab_scrub_env() { local v; for v in $AB_SCRUB_VARS; do unset "$v" 2>/dev/null || true; done; }

# ---- task -> claude-session-id map (for resume) ----
# Value is the claude session id captured at spawn. Persisted so a reap (stop)
# keeps it and a later resume can `claude --resume <id>`. Reap NEVER deletes the
# entry (stop preserves); only a full manual teardown removes it.
ab_map_init() { [ -f "$AB_STATE" ] || { mkdir -p "$(dirname "$AB_STATE")"; printf '{}\n' >"$AB_STATE"; }; }
ab_map_get()  { ab_map_init; jq -r --arg k "$1" '.[$k] // empty' "$AB_STATE" 2>/dev/null; }
ab_map_set()  { ab_map_init; local tmp; tmp=$(mktemp); jq --arg k "$1" --arg v "$2" '.[$k]=$v' "$AB_STATE" >"$tmp" && mv "$tmp" "$AB_STATE"; }
ab_map_del()  { ab_map_init; local tmp; tmp=$(mktemp); jq --arg k "$1" 'del(.[$k])' "$AB_STATE" >"$tmp" && mv "$tmp" "$AB_STATE"; }
ab_map_keys() { ab_map_init; jq -r 'keys[]' "$AB_STATE" 2>/dev/null; }

# ---- single-flight poll lock ----
# Atomic mkdir works everywhere (no flock on macOS); a stale lock from a dead
# pass is reclaimed. Guarantees two overlapping passes can't act on one task.
AB_LOCK_DIR=""
ab_lock() {
  local lock="${AGENT_BOARD_LOCK:-$HOME/.config/agent-board/.poll.lock}"
  mkdir -p "$(dirname "$lock")"
  if ! mkdir "$lock" 2>/dev/null; then
    local holder=""; [ -f "$lock/pid" ] && holder="$(cat "$lock/pid" 2>/dev/null)"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      ab_log "another pass (pid $holder) holds the lock; skipping"; return 1
    fi
    ab_log "reclaiming stale poll lock (holder '${holder:-?}' gone)"
    rm -rf "$lock"; mkdir "$lock" 2>/dev/null || { ab_log "lost lock race; skipping"; return 1; }
  fi
  printf '%s' "$$" > "$lock/pid"; AB_LOCK_DIR="$lock"; return 0
}
ab_unlock() { [ -n "$AB_LOCK_DIR" ] && rm -rf "$AB_LOCK_DIR"; AB_LOCK_DIR=""; }

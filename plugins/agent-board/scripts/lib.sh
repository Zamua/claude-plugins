#!/usr/bin/env bash
# agent-board shared core. Provider-agnostic: config, logging, the poll lock, the
# task->session map, the worker argv builder, and small helpers. Source-specific
# logic lives in adapters/source-*.sh and runtime-specific logic in
# adapters/runtime-*.sh; poll.sh sources this plus the two adapters the config
# selects.
#
# Kept bash-3.2-safe: the launchd job runs macOS /bin/bash. No associative arrays,
# no ${x,,}, no mapfile; never expand a possibly-empty array under `set -u`.
set -uo pipefail

# Schedulers (launchd/cron) run with a minimal PATH; make common tool locations
# discoverable so claude/tmux/herdr/gh/linear/jq/git resolve however they were
# installed.
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
      elif ($v|type)=="string" then ($v | gsub("\\s+"; " ") | split(" ")[] | select(length > 0))
      else $v end' "$AB_CONFIG" 2>/dev/null
}

# leading-~/ expansion for config-supplied paths (schedulers run without a shell
# to expand it)
# shellcheck disable=SC2088  # the literal two-char prefix is the match target
ab_tilde() { case "$1" in "~/"*) printf '%s' "$HOME/${1#\~/}";; *) printf '%s' "$1";; esac; }

# workspace root the workers operate under; pane cwd. Empty config falls back to
# $HOME/workspace.
ab_workspace_root() {
  local w; w="$(ab_get workspace_root "")"
  [ -n "$w" ] && { ab_tilde "$w"; return; }
  printf '%s' "$HOME/workspace"
}

# a filesystem/agent-name-safe token
ab_safe() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-'; }

# ---- worker argv builder (shared by both pane runtimes) ----
# Sets AB_EXE (agent_cmd first element, default "claude") and AB_ARGV
# (everything after the executable), in order: the agent_cmd tail,
# --plugin-dir <plugin_dir> when set, --permission-mode <permission_mode>
# (uniform default acceptEdits), --dangerously-skip-permissions when
# dangerously_skip is true, --append-system-prompt <house_rules> when non-empty,
# and --agent <persona> where persona = worker_subagent or, when empty, the
# source's src_default_persona. tmux execs AB_EXE directly; herdr derives the
# executable from agent_kind and treats AB_EXE as advisory. AB_ARGV can be
# empty: expand it as ${AB_ARGV[@]+"${AB_ARGV[@]}"} (bash 3.2 under set -u).
AB_EXE=""
AB_ARGV=()
ab_build_worker_argv() {
  AB_EXE=""; AB_ARGV=()
  local a pdir pm hr sub
  while IFS= read -r a; do
    a="$(ab_tilde "$a")"
    if [ -z "$AB_EXE" ]; then AB_EXE="$a"; continue; fi
    AB_ARGV+=("$a")
  done < <(ab_get_list agent_cmd)
  [ -n "$AB_EXE" ] || AB_EXE="claude"
  pdir="$(ab_get plugin_dir "")"
  [ -n "$pdir" ] && AB_ARGV+=(--plugin-dir "$(ab_tilde "$pdir")")
  pm="$(ab_get permission_mode acceptEdits)"
  [ -n "$pm" ] && AB_ARGV+=(--permission-mode "$pm")
  [ "$(ab_get dangerously_skip false)" = "true" ] && AB_ARGV+=(--dangerously-skip-permissions)
  hr="$(ab_get house_rules "")"
  [ -n "$hr" ] && AB_ARGV+=(--append-system-prompt "$hr")
  sub="$(ab_get worker_subagent "")"
  if [ -z "$sub" ] && declare -F src_default_persona >/dev/null; then
    sub="$(src_default_persona)"
  fi
  [ -n "$sub" ] && AB_ARGV+=(--agent "$sub")
  return 0
}

# Env vars that, if inherited from a parent claude session, mark a nested claude
# as a "child" and disable its transcript, which would break `claude --resume`.
# Scrub them (plus any inherited herdr socket/session pointers) before launching
# a worker so it saves transcripts and honors explicit session flags. Harmless
# under launchd (already a clean env); essential if ever run from inside a
# claude session. Call inside the subshell that execs the worker.
AB_SCRUB_VARS="CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS CLAUDE_CODE_SESSION_ID CLAUDE_CODE_WORKING_DIR HERDR_SOCKET_PATH HERDR_SESSION HERDR_WORKSPACE_ID HERDR_PANE_ID"
ab_scrub_env() { local v; for v in $AB_SCRUB_VARS; do unset "$v" 2>/dev/null || true; done; }

# ---- task -> claude-session-id map (for resume) ----
# Value is the claude session id captured at spawn. Persisted so a reap (stop)
# keeps it and a later resume can `claude --resume <id>`. Nothing deletes
# entries; retire one by editing the file.
ab_map_init() { [ -f "$AB_STATE" ] || { mkdir -p "$(dirname "$AB_STATE")"; printf '{}\n' >"$AB_STATE"; }; }
ab_map_get()  { ab_map_init; jq -r --arg k "$1" '.[$k] // empty' "$AB_STATE" 2>/dev/null; }
ab_map_set()  { ab_map_init; local tmp; tmp=$(mktemp); jq --arg k "$1" --arg v "$2" '.[$k]=$v' "$AB_STATE" >"$tmp" && mv "$tmp" "$AB_STATE"; }
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

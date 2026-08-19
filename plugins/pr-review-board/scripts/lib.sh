#!/usr/bin/env bash
# pr-review-board shared core: config, logging, the poll lock, and the review
# state store. Source-specific logic (GitHub reactions) lives in
# adapters/source-*.sh and runtime-specific logic (herdr) in adapters/runtime-*.sh.
#
# Kept bash-3.2-safe: the launchd job runs macOS /bin/bash. No associative
# arrays, no ${x,,}, no mapfile; never expand a possibly-empty array under `set -u`.
set -uo pipefail

# Schedulers run with a minimal PATH; make the tool locations we depend on
# discoverable however they were installed (nix, homebrew, cargo).
export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

PRB_CONFIG="${PR_REVIEW_BOARD_CONFIG:-$HOME/.config/pr-review-board/config.json}"
PRB_STATE="${PR_REVIEW_BOARD_STATE:-$HOME/.config/pr-review-board/state.json}"

prb_log() { printf '%s pr-review-board: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >&2; }

prb_need() {
  local rc=0 c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || { prb_log "missing dependency: $c"; rc=1; }; done
  return $rc
}

# ---- config ----
prb_get() {  # <key> [default]
  local key="$1" def="${2-}" v
  [ -f "$PRB_CONFIG" ] || { printf '%s' "$def"; return; }
  v=$(jq -r --arg k "$key" '.[$k] // empty' "$PRB_CONFIG" 2>/dev/null)
  if [ -n "$v" ] && [ "$v" != "null" ]; then printf '%s' "$v"; else printf '%s' "$def"; fi
}

# A value that may be a JSON array OR a whitespace-separated string: one element
# per line. Used for agent_cmd so a full argv round-trips exactly, and for orgs.
prb_get_list() {  # <key>
  [ -f "$PRB_CONFIG" ] || return 0
  jq -r --arg k "$1" '
    .[$k] as $v
    | if   $v == null          then empty
      elif ($v|type)=="array"  then $v[]
      elif ($v|type)=="string" then ($v / " ")[]
      else $v end' "$PRB_CONFIG" 2>/dev/null
}

# Leading-~/ expansion for config-supplied paths. A scheduler runs without a shell
# to expand it, so an unexpanded "~/reviews" would create a directory literally
# named '~' in the pass's cwd.
# shellcheck disable=SC2088  # the literal two-char prefix is the match target
prb_tilde() { case "$1" in "~/"*) printf '%s' "$HOME/${1#\~/}";; *) printf '%s' "$1";; esac; }

prb_reviews_root()   { local v; v="$(prb_get reviews_root "")";   [ -n "$v" ] && prb_tilde "$v" || printf '%s' "$HOME/workspace/reviews"; }
prb_workspace_root() { local v; v="$(prb_get workspace_root "")"; [ -n "$v" ] && prb_tilde "$v" || printf '%s' "$HOME/workspace"; }

# Harness metadata lives OUTSIDE the review directory, because that directory is
# itself a git worktree for a single-pull-request review and `git worktree add`
# refuses a non-empty target. Keeping the assignment, the cached diffs and the pane
# session ids here leaves the checkout clean and nothing to gitignore but the report.
prb_meta_dir() {  # <key>
  printf '%s/.pr-review-board/%s' "$(prb_reviews_root)" "$1"
}

# A filesystem- and agent-name-safe token.
prb_safe() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-' | tr -s '-' | sed -e 's/^-//' -e 's/-$//'; }

# Env vars that, inherited from a parent claude session, mark a nested claude as a
# "child" and disable its transcript, which would break `claude --resume`. Scrub
# them plus inherited herdr pointers before launching herdr, so workers save
# transcripts and every call honors an explicit --session. Call inside the
# subshell that execs herdr.
PRB_SCRUB_VARS="CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS CLAUDE_CODE_SESSION_ID CLAUDE_CODE_WORKING_DIR HERDR_SOCKET_PATH HERDR_SESSION HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID"
prb_scrub_env() { local v; for v in $PRB_SCRUB_VARS; do unset "$v" 2>/dev/null || true; done; }

# ---- state ----
# {
#   "last_poll": <epoch>,                     # seconds; epoch avoids BSD/GNU date parsing
#   "reviews":   { "<key>": { ... } },
#   "pr_index":  { "owner/repo#N": "<key>" }  # a PR belongs to at most one review
# }
#
# A review record:
#   status        ACTIVE | CLEANEDUP        CLEANEDUP is terminal: never resurrected
#   slug          herdr label + dir basename
#   dir           the review dir (single PR) or umbrella dir (multiple)
#   multi         true when the review covers more than one PR
#   claude_session the uuid we own, for --resume
#   agent_name    herdr agent name, the runtime identity
#   prs           [ "owner/repo#N", ... ]
#   heads         { "owner/repo#N": { "head": ..., "base": ... } } for chain grouping
prb_state_init() {
  [ -f "$PRB_STATE" ] && return 0
  mkdir -p "$(dirname "$PRB_STATE")"
  printf '{"last_poll":0,"reviews":{},"pr_index":{}}\n' >"$PRB_STATE"
}

# Read-modify-write through a temp file. Every mutation goes through here so a
# crash mid-write cannot truncate the store.
prb_state_edit() {  # <jq-filter> [--arg k v ...]
  prb_state_init
  local filter="$1"; shift
  local tmp; tmp="$(mktemp)" || return 1
  if jq "$@" "$filter" "$PRB_STATE" >"$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$PRB_STATE"
  else
    rm -f "$tmp"; prb_log "state write failed: $filter"; return 1
  fi
}
prb_state_read() { prb_state_init; jq -r "$@" "$PRB_STATE" 2>/dev/null; }

prb_last_poll()     { prb_state_read '.last_poll // 0'; }
prb_set_last_poll() { prb_state_edit '.last_poll = ($t|tonumber)' --arg t "$1"; }

prb_review_json()   { prb_state_read --arg k "$1" '.reviews[$k] // empty'; }
# `// empty` would swallow a literal false, since jq treats false as absent, so a
# boolean field set to false would read back as "" and mislead any caller testing for
# the string "false".
prb_review_field()  { prb_state_read --arg k "$1" --arg f "$2" '.reviews[$k][$f] | if . == null then empty else . end'; }
prb_review_status() { local s; s="$(prb_review_field "$1" status)"; [ -n "$s" ] && printf '%s' "$s" || printf 'ABSENT'; }
prb_review_keys()   { prb_state_read '.reviews | keys[]'; }
prb_active_keys()   { prb_state_read '.reviews | to_entries[] | select(.value.status=="ACTIVE") | .key'; }
prb_review_prs()    { prb_state_read --arg k "$1" '.reviews[$k].prs[]? // empty'; }

prb_review_put() {  # <key> <json>
  prb_state_edit '.reviews[$k] = ($v|fromjson)' --arg k "$1" --arg v "$2"
}
prb_review_set_field() {  # <key> <field> <value>
  prb_state_edit '.reviews[$k][$f] = $v' --arg k "$1" --arg f "$2" --arg v "$3"
}

prb_pr_review() { prb_state_read --arg p "$1" '.pr_index[$p] // empty'; }

# Bind a PR to a review and record its branch pair, so later chain grouping can
# match a fresh PR against the PRs an active review already covers.
prb_pr_bind() {  # <pr> <key> <head> <base>
  prb_state_edit '
    .pr_index[$p] = $k
    | .reviews[$k].prs = ((.reviews[$k].prs // []) + [$p] | unique)
    | .reviews[$k].heads[$p] = { head: $h, base: $b }
    | .reviews[$k].multi = (((.reviews[$k].prs // []) | length) > 1)
  ' --arg p "$1" --arg k "$2" --arg h "$3" --arg b "$4"
}

# ---- single-flight poll lock ----
# Atomic mkdir works everywhere (no flock on macOS); a lock left by a dead pass
# is reclaimed. Guarantees two overlapping passes cannot act on one review.
PRB_LOCK_DIR=""
prb_lock() {
  local lock="${PR_REVIEW_BOARD_LOCK:-$HOME/.config/pr-review-board/.poll.lock}"
  mkdir -p "$(dirname "$lock")"
  if ! mkdir "$lock" 2>/dev/null; then
    local holder=""; [ -f "$lock/pid" ] && holder="$(cat "$lock/pid" 2>/dev/null)"
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      prb_log "another pass (pid $holder) holds the lock; skipping"; return 1
    fi
    prb_log "reclaiming stale poll lock (holder '${holder:-?}' gone)"
    rm -rf "$lock"; mkdir "$lock" 2>/dev/null || { prb_log "lost lock race; skipping"; return 1; }
  fi
  printf '%s' "$$" > "$lock/pid"; PRB_LOCK_DIR="$lock"; return 0
}
prb_unlock() { [ -n "$PRB_LOCK_DIR" ] && rm -rf "$PRB_LOCK_DIR"; PRB_LOCK_DIR=""; }

#!/usr/bin/env bash
# agent-board source adapter: GitHub issues (via `gh`). The original agent-board
# source, ported behind the src_* contract. Task id = "owner/repo#N".
#
# The label is the whole trigger: adding it spawns (or resumes), removing it reaps.
# Open/closed is deliberately not consulted - merging the PR closes the issue while
# post-merge work like a release is still the worker's. Candidates are issues
# authored by the operator with the label (the author filter is the anti-hijack
# gate for personal repos).

src_deps() { printf 'gh jq git'; }

_gh_login() {
  local v; v="$(ab_get gh_login "")"
  [ -n "$v" ] && { printf '%s' "$v"; return; }
  gh api user --jq .login 2>/dev/null
}
_gh_repo() { printf '%s' "${1%#*}"; }   # owner/repo#N -> owner/repo
_gh_num()  { printf '%s' "${1##*#}"; }  # owner/repo#N -> N

# ids "owner/repo#N" for issues authored by the operator, carrying the label,
# across every repo (no allowlist). Excludes PRs.
src_spawn_candidates() {
  local label login; label="$(ab_get label agent)"; login="$(_gh_login)"
  [ -n "$login" ] || { ab_log "github: no gh_login and gh auto-detect failed"; return 0; }
  gh search issues --author "$login" --label "$label" --limit 50 \
    --json repository,number,isPullRequest \
    --jq '.[] | select(.isPullRequest | not) | "\(.repository.nameWithOwner)#\(.number)"' 2>/dev/null
}

# The reap trigger, so it has to tell "label removed" apart from "could not ask":
# only a definite no reaps. A failed lookup (gone repo, gh outage) is unknown, so
# the worker keeps running.
src_has_label() {  # <id> -> 0 has label, 1 no label, 2 unknown
  local repo num label out verdict
  repo="$(_gh_repo "$1")"; num="$(_gh_num "$1")"; label="$(ab_get label agent)"
  out="$(gh issue view "$num" --repo "$repo" --json labels 2>/dev/null)" || return 2
  verdict="$(printf '%s' "$out" | jq -r --arg l "$label" '
    if   (.labels | type) != "array"          then "unknown"
    elif ([.labels[]?.name] | index($l))      then "yes"
    else "no" end' 2>/dev/null)"
  case "$verdict" in yes) return 0 ;; no) return 1 ;; *) return 2 ;; esac
}

src_url() {  # <id>
  local repo num; repo="$(_gh_repo "$1")"; num="$(_gh_num "$1")"
  gh issue view "$num" --repo "$repo" --json url --jq '.url' 2>/dev/null
}

# Short task description handed to the runtime; the issue-agent persona (delivered
# by the claude-bg runtime via --agent) carries the full protocol.
src_kickoff_context() {  # <id>
  local repo url; repo="$(_gh_repo "$1")"; url="$(src_url "$1")"
  printf 'You are assigned GitHub issue %s (repo %s). Work on a branch in your worktree, open a PR that Closes the issue, and watch the issue + PR for review comments. Do not merge or deploy.' "$url" "$repo"
}

# Guard. For personal GitHub repos the author filter in src_spawn_candidates is the
# anti-hijack gate, so this passes. (Linear's shared workspace needs the stricter
# last-actor check; that lives in source-linear.sh.)
src_last_actor_is_me() { return 0; }

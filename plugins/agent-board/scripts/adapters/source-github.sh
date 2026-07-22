#!/usr/bin/env bash
# agent-board source adapter: GitHub issues (via `gh`). The original agent-board
# source, ported behind the src_* contract. Task id = "owner/repo#N".
#
# State vocabulary here is GitHub's: use spawn_state="open", reap_state="closed"
# in config for this mode. Candidates are OPEN issues authored by the operator
# with the label (the author filter is the anti-hijack gate for personal repos).

src_deps() { printf 'gh jq git'; }

_gh_login() {
  local v; v="$(ab_get gh_login "")"
  [ -n "$v" ] && { printf '%s' "$v"; return; }
  gh api user --jq .login 2>/dev/null
}
_gh_repo() { printf '%s' "${1%#*}"; }   # owner/repo#N -> owner/repo
_gh_num()  { printf '%s' "${1##*#}"; }  # owner/repo#N -> N

# ids "owner/repo#N" for OPEN issues authored by the operator, carrying the label,
# across every repo (no allowlist). Excludes PRs.
src_spawn_candidates() {
  local label login; label="$(ab_get label agent)"; login="$(_gh_login)"
  [ -n "$login" ] || { ab_log "github: no gh_login and gh auto-detect failed"; return 0; }
  gh search issues --author "$login" --label "$label" --state open --limit 50 \
    --json repository,number,isPullRequest \
    --jq '.[] | select(.isPullRequest | not) | "\(.repository.nameWithOwner)#\(.number)"' 2>/dev/null
}

# lowercased GitHub state so it matches spawn_state/reap_state (open|closed).
src_state() {  # <id>
  local repo num st; repo="$(_gh_repo "$1")"; num="$(_gh_num "$1")"
  st="$(gh issue view "$num" --repo "$repo" --json state --jq '.state' 2>/dev/null)"
  printf '%s' "$st" | tr 'A-Z' 'a-z'
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

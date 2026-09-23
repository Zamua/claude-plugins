#!/usr/bin/env bash
# pr-review-board diff cache. The review agent runs this; the poller does not. It
# keeps each pull request's diff on disk and tells the agent when one has actually
# moved, so a monitor wake with nothing new costs nothing.
#
#   diffs.sh sync  <key> <owner/repo#N>      refresh that cached diff; CHANGED|UNCHANGED
#   diffs.sh sync-all <key>                  refresh every pull request in the review
#   diffs.sh diff  <key> <owner/repo#N>      path to the cached diff, for reading
#   diffs.sh list  <key>
#
# <key> is the review key from the assignment file, not a path. Cached diffs live in
# the review's metadata directory, deliberately outside the checkout, so nothing here
# shows up in `git status`.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"

_d_state() { printf '%s/diffs.json' "$(prb_meta_dir "$1")"; }
_d_slug()  { printf '%s-%s' "$(prb_safe "$(basename "${1%%#*}")")" "${1##*#}"; }
_d_patch() { printf '%s/patches/%s.patch' "$(prb_meta_dir "$1")" "$(_d_slug "$2")"; }

_d_state_init() { local f; f="$(_d_state "$1")"; mkdir -p "$(dirname "$f")"; [ -f "$f" ] || printf '{"prs":{}}\n' >"$f"; }
_d_set() {  # <key> <jq-expr> [--argjson/--arg pairs...]
  _d_state_init "$1"
  local f tmp key="$1" expr="$2"; shift 2
  f="$(_d_state "$key")"; tmp="$(mktemp)"
  jq "$@" "$expr" "$f" >"$tmp" && mv "$tmp" "$f" || rm -f "$tmp"
}

# Write the pull request's current diff to its cache file. Returns 1 when the diff
# is unchanged, so the monitor loop can tell "moved" from "nothing happened", and 2
# on a real failure.
_d_write_patch() {  # <key> <pr>
  local key="$1" pr="$2" repo num out tmp
  repo="${pr%%#*}"; num="${pr##*#}"
  out="$(_d_patch "$key" "$pr")"; mkdir -p "$(dirname "$out")"
  tmp="$(mktemp)"
  if ! gh pr diff "$num" --repo "$repo" >"$tmp" 2>/dev/null; then
    rm -f "$tmp"; prb_log "gh pr diff failed for $pr"; return 2
  fi
  if [ ! -s "$tmp" ]; then rm -f "$tmp"; prb_log "$pr has an empty diff"; return 2; fi
  if [ -f "$out" ] && cmp -s "$tmp" "$out"; then rm -f "$tmp"; return 1; fi
  mv "$tmp" "$out"
  _d_set "$key" '.prs[$p] = {patch: $f}' --arg p "$pr" --arg f "$out"
  return 0
}

cmd_sync() {  # <key> <pr> -> CHANGED | UNCHANGED
  local key="$1" pr="$2" rc
  _d_write_patch "$key" "$pr"; rc=$?
  case "$rc" in
    0) prb_log "$pr: diff moved"; printf 'CHANGED\n' ;;
    1) printf 'UNCHANGED\n' ;;
    *) return 1 ;;
  esac
}

# Driven by the review's pull request list, not by what is already cached, so a pull
# request that joined the review is picked up on the first wake after it arrives.
cmd_sync_all() {  # <key>
  local key="$1" pr
  while IFS= read -r pr; do
    [ -n "$pr" ] || continue
    printf '%s\t%s\n' "$pr" "$(cmd_sync "$key" "$pr" 2>/dev/null || echo ERROR)"
  done < <(prb_review_prs "$key")
}

cmd_diff() {  # <key> <pr>
  local p; p="$(_d_patch "$1" "$2")"
  [ -f "$p" ] || _d_write_patch "$1" "$2" >/dev/null || true
  [ -f "$p" ] && printf '%s\n' "$p"
}

cmd_list() {
  _d_state_init "$1"
  jq -r '.prs | to_entries[] | "\(.key)\t\(.value.patch)"' "$(_d_state "$1")"
}

case "${1:-help}" in
  sync)     shift; cmd_sync "$@" ;;
  sync-all) shift; cmd_sync_all "$@" ;;
  diff)     shift; cmd_diff "$@" ;;
  list)     shift; cmd_list "$@" ;;
  *) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$HERE/diffs.sh" ;;
esac

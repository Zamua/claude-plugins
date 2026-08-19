#!/usr/bin/env bash
# pr-review-board layout helper. The review agent runs this; the poller does not.
# It owns the one part of the workflow with non-obvious tool behaviour: keeping a
# live hunkt diff in step with a pull request that is still moving.
#
#   layout.sh open  <key> <owner/repo#N> [--workspace ID]
#   layout.sh sync  <key> <owner/repo#N>      refresh that diff in place
#   layout.sh sync-all <key>                  refresh every open diff
#   layout.sh sid   <key> <owner/repo#N>      the hunkt session id
#   layout.sh list  <key>
#   layout.sh close <key> <owner/repo#N>
#
# <key> is the review key from the assignment file, not a path. Patches and session
# ids live in the review's metadata directory, deliberately outside the checkout.
#
# Verified against hunkt 0.18.0 and herdr 0.7.5:
#
#   * `hunkt session reload` accepts only `diff` and `show`. Handed a patch session
#     it does NOT error, it silently reloads the session as a working-tree diff of
#     the cwd and the review is gone. Never call reload here.
#   * `hunkt patch <file> --watch` reloads when the file is rewritten, and inline
#     notes SURVIVE that reload. So the refresh path is: rewrite the patch file.
#     That is what `sync` does, and why the diff is a file rather than a pipe.
#   * A patch session reports no repo, so `--repo` cannot select it. Every
#     `hunkt session` call must pass the explicit session id, captured at open time.
#
# Line anchors still drift when a force-push rewrites a hunk, so after a sync the
# agent must re-derive anchors from `hunkt session review <sid> --json` and re-place
# its notes rather than trusting the ones that survived.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"

# Inside a herdr pane the injected socket already points at the right server, so
# passing --session there is redundant and actively wrong if the two disagree. Only
# a call from outside any pane needs the configured session name.
_l_hd() {
  if [ "${HERDR_ENV:-}" = 1 ] || [ -n "${HERDR_SOCKET_PATH:-}" ]; then
    herdr "$@"
  else
    herdr --session "$(prb_get herdr_session pr-review-board)" "$@"
  fi
}

_l_dir()   { prb_review_field "$1" dir; }
_l_state() { printf '%s/hunkt.json' "$(prb_meta_dir "$1")"; }
_l_slug()  { printf '%s-%s' "$(prb_safe "$(basename "${1%%#*}")")" "${1##*#}"; }
_l_patch() { printf '%s/patches/%s.patch' "$(prb_meta_dir "$1")" "$(_l_slug "$2")"; }

# The tab's shell lands in the pull request's own checkout when there is one, so the
# operator can build and grep from it. Patch rendering itself needs no repo.
_l_cwd() {  # <key> <pr>
  local dir sub; dir="$(_l_dir "$1")"
  sub="$dir/$(_l_slug "$2")"
  [ -d "$sub" ] && printf '%s' "$sub" || printf '%s' "$dir"
}

_l_state_init() { local f; f="$(_l_state "$1")"; mkdir -p "$(dirname "$f")"; [ -f "$f" ] || printf '{}\n' >"$f"; }
_l_get() { _l_state_init "$1"; jq -r --arg p "$2" --arg f "$3" '.[$p][$f] // empty' "$(_l_state "$1")"; }
_l_put() {  # <key> <pr> <json>
  _l_state_init "$1"
  local f tmp; f="$(_l_state "$1")"; tmp="$(mktemp)"
  jq --arg p "$2" --argjson v "$3" '.[$p] = $v' "$f" >"$tmp" && mv "$tmp" "$f" || rm -f "$tmp"
}

# Write the pull request's current diff to its patch file. A live watched session
# picks the rewrite up on its own. Returns 1 when the diff is unchanged, so callers
# can tell "refreshed" from "nothing moved", and 2 on a real failure.
_l_write_patch() {  # <key> <pr>
  local key="$1" pr="$2" repo num out tmp
  repo="${pr%%#*}"; num="${pr##*#}"
  out="$(_l_patch "$key" "$pr")"; mkdir -p "$(dirname "$out")"
  tmp="$(mktemp)"
  if ! gh pr diff "$num" --repo "$repo" >"$tmp" 2>/dev/null; then
    rm -f "$tmp"; prb_log "gh pr diff failed for $pr"; return 2
  fi
  if [ ! -s "$tmp" ]; then rm -f "$tmp"; prb_log "$pr has an empty diff"; return 2; fi
  if [ -f "$out" ] && cmp -s "$tmp" "$out"; then rm -f "$tmp"; return 1; fi
  mv "$tmp" "$out"; return 0
}

# Find the session hunkt just created. Matched on the launch cwd plus the patch
# basename, which is unique per pull request, because several review sessions can be
# live at once and none of them expose a repo to match on.
_l_capture_sid() {  # <cwd> <patch-basename>
  local cwd="$1" base="$2" i=0 sid
  while [ "$i" -lt 30 ]; do
    sid="$(hunkt session list --json 2>/dev/null | jq -r --arg cwd "$cwd" --arg b "$base" '
      .sessions[]? | select(.inputKind=="patch" and .cwd==$cwd and (.sourceLabel|endswith($b))) | .sessionId' | head -1)"
    [ -n "$sid" ] && { printf '%s' "$sid"; return 0; }
    i=$(( i + 1 )); sleep 0.5
  done
  return 1
}

cmd_open() {  # <key> <pr> [--workspace ID]
  local key="$1" pr="$2"; shift 2
  local ws="${HERDR_WORKSPACE_ID:-}" out tab pane patch base sid label cwd
  while [ $# -gt 0 ]; do case "$1" in --workspace) ws="$2"; shift 2;; *) shift;; esac; done
  [ -n "$ws" ] || { prb_log "no workspace: pass --workspace or run inside a herdr pane"; return 1; }
  [ -n "$(_l_dir "$key")" ] || { prb_log "unknown review key '$key'"; return 1; }
  prb_need gh jq hunkt herdr || return 1

  sid="$(_l_get "$key" "$pr" session_id)"
  if [ -n "$sid" ] && hunkt session get "$sid" >/dev/null 2>&1; then
    prb_log "$pr already open (session $sid)"; printf '%s\n' "$sid"; return 0
  fi

  _l_write_patch "$key" "$pr"; [ $? -le 1 ] || return 1
  patch="$(_l_patch "$key" "$pr")"; base="$(basename "$patch")"
  cwd="$(_l_cwd "$key" "$pr")"; label="$(basename "${pr%%#*}")#${pr##*#}"

  out="$(_l_hd tab create --workspace "$ws" --cwd "$cwd" --label "$label" --no-focus 2>&1)"
  tab="$(printf  '%s' "$out" | jq -r '.result.tab.tab_id // empty')"
  pane="$(printf '%s' "$out" | jq -r '.result.root_pane.pane_id // empty')"
  [ -n "$tab" ] && [ -n "$pane" ] || { prb_log "tab create failed for $pr: $out"; return 1; }

  # The pane needs a moment to reach its prompt before a command will take.
  local i=0
  while [ "$i" -lt 20 ]; do
    _l_hd pane run "$pane" "cd $(printf '%q' "$cwd") && hunkt patch $(printf '%q' "$patch") --watch" >/dev/null 2>&1 && break
    i=$(( i + 1 )); sleep 0.5
  done

  sid="$(_l_capture_sid "$cwd" "$base")" || {
    prb_log "hunkt session for $pr never appeared; pane output follows"
    _l_hd pane read "$pane" --source recent-unwrapped --lines 40 2>/dev/null | tail -20
    return 1
  }
  _l_put "$key" "$pr" "$(jq -nc --arg s "$sid" --arg t "$tab" --arg p "$pane" --arg f "$patch" --arg c "$cwd" \
      '{session_id:$s,tab_id:$t,pane_id:$p,patch:$f,cwd:$c}')"
  prb_log "opened $pr: tab=$tab hunkt=$sid"
  printf '%s\n' "$sid"
}

cmd_sync() {  # <key> <pr> -> CHANGED | UNCHANGED | CHANGED-NO-SESSION
  local key="$1" pr="$2" rc sid
  _l_write_patch "$key" "$pr"; rc=$?
  case "$rc" in
    0) sid="$(_l_get "$key" "$pr" session_id)"
       if [ -n "$sid" ] && ! hunkt session get "$sid" >/dev/null 2>&1; then
         prb_log "$pr: diff refreshed but its hunkt session is gone; re-open it"
         printf 'CHANGED-NO-SESSION\n'; return 0
       fi
       prb_log "$pr: diff refreshed, watched session reloaded"; printf 'CHANGED\n' ;;
    1) printf 'UNCHANGED\n' ;;
    *) return 1 ;;
  esac
}

cmd_sync_all() {  # <key>
  local key="$1" pr
  while IFS= read -r pr; do
    [ -n "$pr" ] || continue
    printf '%s\t%s\n' "$pr" "$(cmd_sync "$key" "$pr" 2>/dev/null || echo ERROR)"
  done < <(jq -r 'keys[]' "$(_l_state "$key")" 2>/dev/null)
}

cmd_sid()  { _l_get "$1" "$2" session_id; }
cmd_list() { _l_state_init "$1"; jq -r 'to_entries[] | "\(.key)\t\(.value.session_id)\t\(.value.tab_id)"' "$(_l_state "$1")"; }
cmd_close() {
  local key="$1" pr="$2" tab; tab="$(_l_get "$key" "$pr" tab_id)"
  [ -n "$tab" ] && _l_hd tab close "$tab" >/dev/null 2>&1
  local f tmp; f="$(_l_state "$key")"; tmp="$(mktemp)"
  jq --arg p "$pr" 'del(.[$p])' "$f" >"$tmp" && mv "$tmp" "$f" || rm -f "$tmp"
  prb_log "closed $pr"
}

case "${1:-help}" in
  open)     shift; cmd_open "$@" ;;
  sync)     shift; cmd_sync "$@" ;;
  sync-all) shift; cmd_sync_all "$@" ;;
  sid)      shift; cmd_sid "$@" ;;
  list)     shift; cmd_list "$@" ;;
  close)    shift; cmd_close "$@" ;;
  *) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$HERE/layout.sh" ;;
esac

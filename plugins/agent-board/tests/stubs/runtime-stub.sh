#!/usr/bin/env bash
# Test stub runtime adapter. State lives under AB_TEST_FIX/rt:
#   status.<safe-id>      current status (absent when missing)
#   kickoff.<safe-id>     kickoff text handed to the last rt_spawn
# Session ids go through the real ab_map_* store so tests exercise the same
# persistence poll.sh relies on. Calls are appended to calls.log.

_rts_dir()  { printf '%s/rt' "${AB_TEST_FIX:?AB_TEST_FIX not set}"; }
_rts_call() { printf '%s\n' "$*" >>"${AB_TEST_FIX:?}/calls.log"; }
_rts_status_file() { printf '%s/status.%s' "$(_rts_dir)" "$(ab_safe "$1")"; }

rt_deps() { printf ''; }

rt_status() {  # <id> -> absent|running|stopped
  local f; f="$(_rts_status_file "$1")"
  if [ -f "$f" ]; then cat "$f"; else printf 'absent'; fi
}

rt_running_count() {
  local n=0 f
  for f in "$(_rts_dir)"/status.*; do
    [ -f "$f" ] || continue
    [ "$(cat "$f")" = "running" ] && n=$((n+1))
  done
  printf '%s' "$n"
}

rt_spawn() {  # <id> <kickoff>
  _rts_call "spawn $1"
  printf '%s' "$2" >"$(_rts_dir)/kickoff.$(ab_safe "$1")"
  printf 'running' >"$(_rts_status_file "$1")"
  ab_map_set "$1" "sid-$(ab_safe "$1")"
}

rt_resume() {  # <id> ; rc 2 when no saved session id
  _rts_call "resume $1"
  local sid; sid="$(ab_map_get "$1")"
  [ -n "$sid" ] || return 2
  printf 'running' >"$(_rts_status_file "$1")"
  return 0
}

rt_reap() {  # <id> ; stop, keep the map entry
  _rts_call "reap $1"
  printf 'stopped' >"$(_rts_status_file "$1")"
}

rt_list() {
  local id
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    printf '%s\t%s\t%s\n' "$id" "$(rt_status "$id")" "$(ab_map_get "$id")"
  done < <(ab_map_keys)
}

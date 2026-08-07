#!/usr/bin/env bash
# Test stub source adapter. Fixture-driven via the AB_TEST_FIX directory:
#   candidates            one task id per line for src_spawn_candidates
#   guard.<safe-id>       rc for src_last_actor_is_me (missing file -> 0)
#   haslabel.<safe-id>    rc for src_has_label (missing file -> 0)
# Every query is appended to calls.log so tests can assert call sequences.

_stub_fix()  { printf '%s' "${AB_TEST_FIX:?AB_TEST_FIX not set}"; }
_stub_call() { printf '%s\n' "$*" >>"$(_stub_fix)/calls.log"; }
_stub_rc()   {  # <fixture-file> <default-rc>
  local f; f="$(_stub_fix)/$1"
  if [ -f "$f" ]; then return "$(cat "$f")"; fi
  return "$2"
}

src_deps() { printf ''; }

src_spawn_candidates() {
  _stub_call "candidates"
  cat "$(_stub_fix)/candidates" 2>/dev/null
  return 0
}

src_has_label() {  # <id>
  _stub_call "has_label $1"
  _stub_rc "haslabel.$(ab_safe "$1")" 0
}

src_last_actor_is_me() {  # <id>
  _stub_call "guard $1"
  _stub_rc "guard.$(ab_safe "$1")" 0
}

src_kickoff_context() { printf 'kickoff for %s' "$1"; }
src_title()           { printf 'title %s' "$1"; }
src_default_persona() { printf 'stub-persona'; }

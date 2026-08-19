#!/usr/bin/env bash
# pr-review-board layout helper. The review agent runs this; the poller does not.
# It owns two things: the pane the operator reads the report in, and telling the
# agent when a pull request's diff has actually moved.
#
#   layout.sh open  <key> [--pane ID]         report pane beside the agent
#   layout.sh sync  <key> <owner/repo#N>      refresh that cached diff; CHANGED|UNCHANGED
#   layout.sh sync-all <key>                  refresh every cached diff
#   layout.sh diff  <key> <owner/repo#N>      path to the cached diff, for reading
#   layout.sh list  <key>
#   layout.sh close <key>
#
# <key> is the review key from the assignment file, not a path. Cached diffs and
# pane ids live in the review's metadata directory, deliberately outside the
# checkout, so nothing here shows up in `git status`.
#
# Verified against herdr 0.7.5 and nvim 0.12.4:
#
#   * `herdr pane split` takes no command. Split first, read the new pane id from
#     `.result.pane.pane_id`, then `herdr pane run` in it, same as a tab.
#   * `pane run` returns success once the API takes the keystrokes, so it reports a
#     command it silently dropped into a shell that had not reached its prompt.
#     `pane wait-output --match NORMAL` on nvim's statusline is the only proof it
#     launched. Without `--timeout` that call waits forever.
#   * The agent rewrites REVIEW.md repeatedly, and nvim does not notice on its own.
#     A `vim.uv` timer calling `checktime` every two seconds is what makes the pane
#     live; without it the operator reads a stale report and has no way to know.
#     Verified by rewriting the file and reading the reloaded buffer back.
#   * nvim opens it with `-R`. The buffer is a view of the agent's output, so a
#     modified buffer would only collide with the next rewrite.
#   * `vim.diagnostic.enable(false)` is exactly what `<leader>ud` runs under
#     LazyVim, by way of `Snacks.toggle.diagnostics`. Global, so it holds for
#     language servers that attach after startup.
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
_l_state() { printf '%s/layout.json' "$(prb_meta_dir "$1")"; }
_l_slug()  { printf '%s-%s' "$(prb_safe "$(basename "${1%%#*}")")" "${1##*#}"; }
_l_patch() { printf '%s/patches/%s.patch' "$(prb_meta_dir "$1")" "$(_l_slug "$2")"; }
_l_report(){ printf '%s/REVIEW.md' "$(_l_dir "$1")"; }

_l_state_init() { local f; f="$(_l_state "$1")"; mkdir -p "$(dirname "$f")"; [ -f "$f" ] || printf '{"review":{},"prs":{}}\n' >"$f"; }
_l_set() {  # <key> <jq-expr> [--argjson/--arg pairs...]
  _l_state_init "$1"
  local f tmp key="$1" expr="$2"; shift 2
  f="$(_l_state "$key")"; tmp="$(mktemp)"
  jq "$@" "$expr" "$f" >"$tmp" && mv "$tmp" "$f" || rm -f "$tmp"
}

# The report pane's nvim: read-only, diagnostics off, and polling the file so the
# agent's rewrites appear without the operator doing anything.
_l_nvim_cmd() {  # <report-path>
  printf 'nvim -R -c %q -c %q %q' \
    'lua vim.diagnostic.enable(false)' \
    'lua vim.uv.new_timer():start(2000, 2000, vim.schedule_wrap(function() pcall(vim.cmd, "silent checktime") end))' \
    "$1"
}

# Write the pull request's current diff to its cache file. Returns 1 when the diff
# is unchanged, so the monitor loop can tell "moved" from "nothing happened", and 2
# on a real failure.
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
  mv "$tmp" "$out"
  _l_set "$key" '.prs[$p] = {patch: $f}' --arg p "$pr" --arg f "$out"
  return 0
}

cmd_open() {  # <key> [--pane ID]
  local key="$1"; shift
  local pane="${HERDR_PANE_ID:-}" dir report out new
  while [ $# -gt 0 ]; do case "$1" in --pane) pane="$2"; shift 2;; *) shift;; esac; done
  dir="$(_l_dir "$key")"
  [ -n "$dir" ] || { prb_log "unknown review key '$key'"; return 1; }
  [ -n "$pane" ] || { prb_log "no pane: pass --pane or run inside a herdr pane"; return 1; }
  prb_need gh jq herdr nvim || return 1

  new="$(_l_state_init "$key"; jq -r '.review.pane_id // empty' "$(_l_state "$key")")"
  if [ -n "$new" ] && _l_hd pane get "$new" >/dev/null 2>&1; then
    prb_log "report pane already open ($new)"; printf '%s\n' "$new"; return 0
  fi

  # nvim on a file that does not exist yet cannot be reloaded into, so seed it.
  report="$(_l_report "$key")"
  [ -f "$report" ] || printf '# Review in progress\n' >"$report"

  out="$(_l_hd pane split --pane "$pane" --direction right --ratio 0.5 --cwd "$dir" 2>&1)"
  new="$(printf '%s' "$out" | jq -r '.result.pane.pane_id // empty')"
  [ -n "$new" ] || { prb_log "pane split failed: $out"; return 1; }

  # `pane run` reports success as soon as the API accepts the keystrokes, even when
  # the shell has not reached its prompt and drops them. So prove nvim is up by
  # waiting for its statusline, and check before every attempt rather than after, or
  # a retry types the command into an nvim that did start.
  local i=0 up=
  while [ "$i" -lt 5 ]; do
    if _l_hd pane wait-output "$new" --match NORMAL --source visible --timeout 3000 >/dev/null 2>&1; then
      up=1; break
    fi
    _l_hd pane run "$new" "$(_l_nvim_cmd "$report")" >/dev/null 2>&1
    i=$(( i + 1 ))
  done
  [ -n "$up" ] || prb_log "nvim did not come up in $new; read the pane to see why"

  _l_hd pane rename "$new" "REVIEW.md" >/dev/null 2>&1
  _l_set "$key" '.review = {pane_id: $p, report: $r}' --arg p "$new" --arg r "$report"
  prb_log "opened report pane $new on $report"
  printf '%s\n' "$new"
}

cmd_sync() {  # <key> <pr> -> CHANGED | UNCHANGED
  local key="$1" pr="$2" rc
  _l_write_patch "$key" "$pr"; rc=$?
  case "$rc" in
    0) prb_log "$pr: diff moved"; printf 'CHANGED\n' ;;
    1) printf 'UNCHANGED\n' ;;
    *) return 1 ;;
  esac
}

cmd_sync_all() {  # <key>
  local key="$1" pr
  while IFS= read -r pr; do
    [ -n "$pr" ] || continue
    printf '%s\t%s\n' "$pr" "$(cmd_sync "$key" "$pr" 2>/dev/null || echo ERROR)"
  done < <(_l_state_init "$key"; jq -r '.prs | keys[]' "$(_l_state "$key")" 2>/dev/null)
}

cmd_diff() {  # <key> <pr>
  local p; p="$(_l_patch "$1" "$2")"
  [ -f "$p" ] || _l_write_patch "$1" "$2" >/dev/null || true
  [ -f "$p" ] && printf '%s\n' "$p"
}

cmd_list() {
  _l_state_init "$1"
  jq -r '"report\t\(.review.pane_id // "-")\t\(.review.report // "-")",
         (.prs | to_entries[] | "\(.key)\t\(.value.patch)")' "$(_l_state "$1")"
}

cmd_close() {  # <key>
  local key="$1" pane
  _l_state_init "$key"
  pane="$(jq -r '.review.pane_id // empty' "$(_l_state "$key")")"
  [ -n "$pane" ] && _l_hd pane close "$pane" >/dev/null 2>&1
  _l_set "$key" '.review = {}'
  prb_log "closed the report pane for $key"
}

case "${1:-help}" in
  open)     shift; cmd_open "$@" ;;
  sync)     shift; cmd_sync "$@" ;;
  sync-all) shift; cmd_sync_all "$@" ;;
  diff)     shift; cmd_diff "$@" ;;
  list)     shift; cmd_list "$@" ;;
  close)    shift; cmd_close "$@" ;;
  *) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$HERE/layout.sh" ;;
esac

#!/usr/bin/env bash
# pr-review-board teardown. Split into `plan` and `apply` so the operator always
# sees exactly what is about to be destroyed before anything is.
#
#   cleanup.sh list
#   cleanup.sh plan  <key|slug|owner/repo#N|pr-url>
#   cleanup.sh apply <key|slug|owner/repo#N|pr-url> --yes
#
# apply, in order: archive the report, mark the review CLEANEDUP, remove each
# worktree, delete the review directory and its metadata, close the herdr workspace.
#
# The mark comes before the destruction and the workspace close comes last, both for
# the same reason: closing a workspace kills every pane in it, so a cleanup run from
# inside the review's own workspace used to die midway with the review still ACTIVE
# and its agent gone, which the next poll pass read as a crashed agent and resumed.
# That case is now refused outright, and any other mid-run death leaves a review that
# is terminal rather than one that comes back.
#
# CLEANEDUP is terminal. The poller never resurrects a cleaned-up review, so a later
# reaction on one of its pull requests starts a fresh review instead.
#
# Canonical clones are never touched. Only worktrees this review created are removed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
source "$HERE/adapters/runtime-$(prb_get runtime herdr).sh"

# Accept a review key, a slug, a PR reference, or a pull request URL.
_c_resolve() {  # <token> -> key
  local t="$1" k
  [ -n "$(prb_review_json "$t")" ] && { printf '%s' "$t"; return 0; }
  case "$t" in
    *github.com/*/pull/*)
      t="$(printf '%s' "$t" | sed -E 's#^.*github\.com/([^/]+/[^/]+)/pull/([0-9]+).*$#\1@\2#' | tr '@' '#')" ;;
  esac
  k="$(prb_pr_review "$t")"; [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  k="$(prb_state_read --arg s "$t" '.reviews | to_entries[] | select(.value.slug==$s) | .key' | head -1)"
  [ -n "$k" ] && { printf '%s' "$k"; return 0; }
  return 1
}

# The canonical clone that owns a worktree, read from git rather than guessed from
# a naming convention.
_c_owner_repo() {  # <worktree-path> -> canonical clone path, or empty
  local wt="$1" common
  [ -d "$wt" ] || return 1
  common="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  # --path-format needs git 2.31+; fall back to resolving a relative answer.
  if [ -z "$common" ]; then
    common="$(git -C "$wt" rev-parse --git-common-dir 2>/dev/null)" || return 1
    case "$common" in /*) ;; *) common="$wt/$common";; esac
  fi
  [ -n "$common" ] || return 1
  common="$(cd "$common" 2>/dev/null && pwd)" || return 1
  printf '%s' "$(dirname "$common")"
}

# Every worktree this review created: the review dir itself for a single-pull-request
# review, or one child per pull request under an umbrella.
_c_worktrees() {  # <key>
  local dir multi pr sub
  dir="$(prb_review_field "$1" dir)"; multi="$(prb_review_field "$1" multi)"
  [ -n "$dir" ] || return 0
  if [ "$multi" = "true" ]; then
    while IFS= read -r pr; do
      [ -n "$pr" ] || continue
      sub="$dir/$(prb_safe "$(basename "${pr%%#*}")")-${pr##*#}"
      { [ -d "$sub/.git" ] || [ -f "$sub/.git" ]; } && printf '%s\n' "$sub"
    done < <(prb_review_prs "$1")
  else
    { [ -d "$dir/.git" ] || [ -f "$dir/.git" ]; } && printf '%s\n' "$dir"
  fi
  return 0
}

cmd_list() {
  printf '%-34s %-10s %-9s %s\n' KEY STATUS AGENT DIR
  local k rs as dir
  while IFS=$'\t' read -r k rs as dir; do printf '%-34s %-10s %-9s %s\n' "$k" "$rs" "$as" "$dir"; done < <(rt_list)
}

cmd_plan() {
  local key dir wt owner
  key="$(_c_resolve "$1")" || { prb_log "no review matches '$1' (try: cleanup.sh list)"; return 1; }
  dir="$(prb_review_field "$key" dir)"
  printf 'Review:    %s  (%s)\n' "$key" "$(prb_review_status "$key")"
  printf 'Slug:      %s\n' "$(prb_review_field "$key" slug)"
  printf 'Directory: %s\n' "$dir"
  printf 'Pull requests:\n'
  while IFS= read -r p; do [ -n "$p" ] && printf '  %s\n' "$p"; done < <(prb_review_prs "$key")
  printf '\nWould do:\n'
  if [ -f "$dir/REVIEW.md" ]; then
    printf '  archive   %s/REVIEW.md -> %s/.archive/%s.md\n' "$dir" "$(prb_reviews_root)" "$(prb_review_field "$key" slug)"
  else
    printf '  archive   (no REVIEW.md found; nothing to keep)\n'
  fi
  printf '  state     mark %s CLEANEDUP (terminal, before anything destructive)\n' "$key"
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    owner="$(_c_owner_repo "$wt" || true)"
    printf '  worktree  remove %s   (from %s)\n' "$wt" "${owner:-unknown}"
  done < <(_c_worktrees "$key")
  printf '  delete    %s\n' "$dir"
  printf '  delete    %s   (cached diffs, assignment, pane ids)\n' "$(prb_meta_dir "$key")"
  local ws; ws="$(prb_review_field "$key" herdr_workspace)"
  if [ -n "$ws" ] && [ "$ws" = "${HERDR_WORKSPACE_ID:-}" ]; then
    printf '  close     herdr workspace %s   SKIPPED: it is the one you are running in\n' "$ws"
  else
    printf '  close     herdr workspace %s   (last; it takes every pane with it)\n' "${ws:-none}"
  fi
  printf '\nNothing above has happened yet. Run: cleanup.sh apply %s --yes\n' "$key"
}

cmd_apply() {
  local key="" yes=0 a
  for a in "$@"; do case "$a" in --yes) yes=1;; *) [ -z "$key" ] && key="$a";; esac; done
  key="$(_c_resolve "$key")" || { prb_log "no review matches"; return 1; }
  [ "$yes" = 1 ] || { prb_log "refusing to tear down without --yes; run 'plan' first"; return 1; }
  prb_lock || return 1
  trap 'prb_unlock' EXIT

  local dir slug arch wt owner
  dir="$(prb_review_field "$key" dir)"; slug="$(prb_review_field "$key" slug)"
  [ -n "$dir" ] || { prb_log "review '$key' has no directory recorded"; return 1; }

  # 1. The report is the deliverable, so it outlives the directory holding it.
  if [ -f "$dir/REVIEW.md" ]; then
    arch="$(prb_reviews_root)/.archive"; mkdir -p "$arch"
    cp "$dir/REVIEW.md" "$arch/$slug.md" && prb_log "archived report to $arch/$slug.md"
  fi

  # 2. Terminal state, BEFORE anything destructive. The pull request bindings stay,
  # so status still explains where a pull request went, but the poller will not
  # resurrect it. Order matters: a teardown that dies partway used to leave the
  # review ACTIVE with its workspace already gone, which the next pass read as an
  # agent that had died and resumed, re-cloning everything just deleted.
  prb_review_set_field "$key" status CLEANEDUP
  prb_review_set_field "$key" cleaned_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  prb_log "review '$key' is CLEANEDUP"

  # 3. Worktrees, then their administrative entries.
  while IFS= read -r wt; do
    [ -n "$wt" ] || continue
    owner="$(_c_owner_repo "$wt" || true)"
    if [ -n "$owner" ]; then
      git -C "$owner" worktree remove --force "$wt" 2>/dev/null \
        && prb_log "removed worktree $wt" \
        || prb_log "could not remove worktree $wt; leaving it in place"
      git -C "$owner" worktree prune 2>/dev/null
    else
      prb_log "no owning clone for $wt; leaving it in place"
    fi
  done < <(_c_worktrees "$key")

  # 4. Whatever is left of the review directory.
  if [ -d "$dir" ]; then
    case "$dir" in
      "$(prb_reviews_root)"/?*) rm -rf "$dir" && prb_log "deleted $dir" ;;
      *) prb_log "refusing to delete '$dir': outside $(prb_reviews_root)" ;;
    esac
  fi

  # 5. Harness metadata for this review, which lives outside the checkout.
  local meta; meta="$(prb_meta_dir "$key")"
  case "$meta" in
    "$(prb_reviews_root)"/.pr-review-board/?*) [ -d "$meta" ] && rm -rf "$meta" && prb_log "deleted $meta" ;;
  esac

  # 6. The workspace, last, because closing it takes every pane inside it. When the
  # caller is one of those panes, closing it kills this process, so that case is
  # refused rather than obeyed: everything above is already done, and one leftover
  # workspace the operator closes by hand beats a teardown that cannot finish.
  local ws; ws="$(prb_review_field "$key" herdr_workspace)"
  if [ -n "$ws" ] && [ "$ws" = "${HERDR_WORKSPACE_ID:-}" ]; then
    prb_log "workspace $ws is the one you are running in, so it is left open; close it with 'herdr workspace close $ws' once you are done"
  else
    rt_close_workspace "$key"
  fi
}

case "${1:-help}" in
  list)  shift; cmd_list "$@" ;;
  plan)  shift; cmd_plan "$@" ;;
  apply) shift; cmd_apply "$@" ;;
  *) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$HERE/cleanup.sh" ;;
esac

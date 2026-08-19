#!/usr/bin/env bash
# pr-review-board poller + management CLI. A thin harness: it decides which pull
# requests you asked to have reviewed, groups them into reviews, and brings a
# review agent up. Everything object-level (clones, worktrees, diffs, the report pane,
# tests, the report) is the worker's job.
#
# The trigger is a reaction you added to a pull request recently. There is no
# un-react trigger: reaping is manual, via the pr-review-board:cleanup skill.
#
#   poll.sh once            one pass (spawn / append / recover)
#   poll.sh status          the board: active reviews and their agents
#   poll.sh fresh           what the trigger sees right now, without acting
#   poll.sh spawn <pr>      force one pull request into a review now
#   poll.sh assignment <k>  print a review's assignment file path
#   poll.sh install         arm the scheduler (launchd on macOS, else a cron line)
#   poll.sh uninstall       disarm the scheduler
#   poll.sh config-init     write a starter config
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
# Pluggable adapters, selected by config. `runtime: "stub"` exercises the trigger,
# the grouping and the assignment without launching any agent, which is how a new
# config is validated before the scheduler is armed.
PRB_SOURCE="$(prb_get source github-reactions)"; PRB_RUNTIME="$(prb_get runtime herdr)"
# shellcheck disable=SC1090
source "$HERE/adapters/source-$PRB_SOURCE.sh"   || { prb_log "no source adapter: $PRB_SOURCE"; exit 1; }
# shellcheck disable=SC1090
source "$HERE/adapters/runtime-$PRB_RUNTIME.sh" || { prb_log "no runtime adapter: $PRB_RUNTIME"; exit 1; }

# An adapter that silently lacks a contract function fails deep inside a pass with a
# "command not found", so check the whole contract up front instead.
prb_validate_adapter() {  # <name> <required-fn>...
  local name="$1" fn missing=""; shift
  for fn in "$@"; do declare -F "$fn" >/dev/null || missing="$missing $fn"; done
  [ -z "$missing" ] || { prb_log "adapter $name is missing required functions:$missing"; exit 1; }
}
prb_validate_adapter "source-$PRB_SOURCE" src_deps src_fresh src_pr_meta src_kickoff_context src_cutoff_iso
prb_validate_adapter "runtime-$PRB_RUNTIME" rt_deps rt_status rt_running_count rt_spawn rt_resume rt_notify rt_relabel rt_close_workspace rt_list

# ---- grouping ----
# A conventional branch carries its tracker id, e.g. feature/abc-123. Two pull
# requests naming the same id are one change across repos, which is the cross-repo
# pattern worth grouping. Matched only at the start of the branch or right after a
# '/', so a stray "fix-12" mid-branch does not collide.
_issue_key() {  # <branch> -> key or empty
  local b pat; b="$(printf '%s' "$1" | tr 'A-Z' 'a-z')"
  pat="$(prb_get issue_key_pattern '[a-z]{2,4}-[0-9]+')"
  printf '%s' "$b" | sed -E 's#^[^/]*/##' | grep -oE "^$pat" | head -1
}

# Does this pull request belong to a review we already know about? Two signals:
#
#   chain  its base is another member's head, or its head is another member's base.
#          That is a stack, and it is authoritative.
#   issue  it shares a tracker id with a member.
#
# Only ACTIVE reviews match. A CLEANEDUP review is terminal, so a later reaction on
# one of its pull requests starts a fresh review rather than reopening a closed one.
_match_review() {  # <pr> <head> <base> <default-branch> -> review key or empty
  local pr="$1" head="$2" base="$3" defbr="$4" repo ik k
  repo="${pr%%#*}"
  ik="$(_issue_key "$head")"
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    # A stack lives in ONE repo, and its linking branch is always a feature branch.
    # Without the same-repo guard, one repo's release pull request (head `main`) links
    # to every review in every other repo whose members target `main`. Without the
    # default-branch guard, the same happens within a repo.
    if prb_state_read --arg k "$k" --arg repo "$repo" --arg h "$head" --arg b "$base" --arg d "$defbr" -e '
          .reviews[$k].heads // {} | to_entries
          | any(
              (.key | split("#")[0]) == $repo
              and (
                   (.value.head == $b and $b != $d)
                or (.value.base == $h and $h != $d)
              )
            )' >/dev/null 2>&1; then
      printf '%s' "$k"; return 0
    fi
    if [ -n "$ik" ]; then
      if prb_state_read --arg k "$k" --arg ik "$ik" --arg pat "$(prb_get issue_key_pattern '[a-z]{2,4}-[0-9]+')" -e '
            .reviews[$k].heads // {} | to_entries
            | any(
                (.value.head | ascii_downcase | sub("^[^/]*/"; ""))
                | capture("^(?<k>" + $pat + ")").k == $ik
              )' >/dev/null 2>&1; then
        printf '%s' "$k"; return 0
      fi
    fi
  done < <(prb_active_keys)
  return 1
}

# ---- naming ----
_repo_short() { local r="${1%%#*}"; printf '%s' "${r##*/}"; }
_pr_num()     { printf '%s' "${1##*#}"; }

# A single-pull-request review keeps the established reviews/<repo>-<number> name.
_slug_single() { printf '%s-%s' "$(prb_safe "$(_repo_short "$1")")" "$(_pr_num "$1")"; }

# An umbrella is named for the change, anchored by the number of the pull request
# that opened it, so it stays unique and greppable while still reading as English.
_slug_umbrella() {  # <anchor-pr> <title>
  local s; s="$(prb_safe "$2")"
  # Drop the trailing partial word ONLY when the title was long enough to be cut,
  # otherwise every umbrella silently loses the last word of its title.
  if [ "${#s}" -gt 40 ]; then
    s="$(printf '%s' "$s" | cut -c1-40 | sed 's/-[^-]*$//')"
  fi
  s="$(printf '%s' "$s" | sed 's/-$//')"
  [ -n "$s" ] || s="$(prb_safe "$(_repo_short "$1")")"
  printf '%s-%s' "$s" "$(_pr_num "$1")"
}

# ---- assignment ----
# The worker's contract, rewritten from state after every scope change so it is
# always the full current picture rather than a diff the worker has to replay.
_write_assignment() {  # <key>
  local key="$1" dir meta f
  dir="$(prb_review_field "$key" dir)"
  [ -n "$dir" ] || return 1
  meta="$(prb_meta_dir "$key")"
  mkdir -p "$meta" || return 1
  # Ship the review rules INTO the review workspace. The agent's cwd is the reviews
  # root, so a copy here is readable without a permission prompt; the canonical doc
  # in the plugin directory is outside any agent cwd and reading it stalls a
  # background worker that has nobody to approve it.
  [ -f "$HERE/../docs/REVIEW-RULES.md" ] && cp "$HERE/../docs/REVIEW-RULES.md" "$meta/REVIEW-RULES.md"
  f="$meta/assignment.json"
  prb_state_read --arg k "$key" \
      --arg meta "$meta" \
      --arg reviews_root "$(prb_reviews_root)" \
      --arg workspace_root "$(prb_workspace_root)" \
      --arg house "$(prb_get house_rules "")" '
    .reviews[$k]
    | { key: $k, slug: .slug, dir: .dir, multi: (.multi // false),
        meta_dir: $meta, rules: ($meta + "/REVIEW-RULES.md"),
        promoted_from: (.promoted_from // null),
        status: .status, created_at: .created_at,
        reviews_root: $reviews_root, workspace_root: $workspace_root,
        house_rules: $house,
        prs: [ .prs[]? as $p
               | { pr: $p,
                   repo: ($p | split("#")[0]),
                   number: ($p | split("#")[1] | tonumber),
                   head: (.heads[$p].head // ""),
                   base: (.heads[$p].base // ""),
                   meta: (.meta[$p] // {}) } ] }' > "$f.tmp" 2>/dev/null \
    && mv "$f.tmp" "$f" || { rm -f "$f.tmp"; prb_log "could not write assignment for $key"; return 1; }
  printf '%s' "$f"
}

# ---- the pass ----
_handle_fresh() {  # <pr> <reactedAt> <head> <base> <defaultBranch> <isDraft> <title> <url>
  local pr="$1" at="$2" head="$3" base="$4" defbr="$5" draft="$6" title="$7" url="$8"
  local existing key slug dir stacked=false

  # Only a live review claims a pull request. A CLEANEDUP review is finished, so a
  # NEW reaction can open a fresh review on the same pull request. Nothing revives
  # spontaneously: the old reaction's timestamp is long outside the window, so
  # re-reviewing takes an actual new reaction (remove the emoji, add it again).
  existing="$(prb_pr_review "$pr")"
  if [ -n "$existing" ] && [ "$(prb_review_status "$existing")" = "ACTIVE" ]; then
    prb_log "skip $pr: already covered by active review '$existing'"
    return 0
  fi
  [ -n "$existing" ] && prb_log "$pr was covered by '$existing' ($(prb_review_status "$existing")); starting a fresh review"

  [ "$base" = "$defbr" ] || stacked=true

  key="$(_match_review "$pr" "$head" "$base" "$defbr")" || key=""
  if [ -n "$key" ]; then
    # Joining a live review. Promote a single-pull-request review to an umbrella so
    # each member gets its own checkout; the worker moves the existing worktree in.
    local was_multi old_dir new_dir
    was_multi="$(prb_review_field "$key" multi)"
    old_dir="$(prb_review_field "$key" dir)"
    prb_pr_bind "$pr" "$key" "$head" "$base"
    prb_state_edit '.reviews[$k].meta[$p] = {reacted_at:$at,title:$t,url:$u,is_draft:($d=="true"),default_branch:$db,stacked:($s=="true")}' \
      --arg k "$key" --arg p "$pr" --arg at "$at" --arg t "$title" --arg u "$url" --arg d "$draft" --arg db "$defbr" --arg s "$stacked"
    if [ "$was_multi" != "true" ]; then
      # Name the umbrella after the pull request that OPENED the review, not
      # whichever one joined, so the directory does not depend on arrival order.
      local anchor anchor_title
      anchor="$(prb_state_read --arg k "$key" '.reviews[$k].prs[0] // empty')"
      anchor_title="$(prb_state_read --arg k "$key" --arg p "$anchor" '.reviews[$k].meta[$p].title // empty')"
      new_dir="$(prb_reviews_root)/$(_slug_umbrella "${anchor:-$pr}" "${anchor_title:-$title}")"
      mkdir -p "$new_dir"
      prb_review_set_field "$key" dir "$new_dir"
      prb_review_set_field "$key" slug "$(basename "$new_dir")"
      prb_review_set_field "$key" promoted_from "$old_dir"
      rt_relabel "$key" "$(basename "$new_dir")" 2>/dev/null || true
      prb_log "promoted review '$key' to umbrella $new_dir (was $old_dir)"
    fi
    _write_assignment "$key" >/dev/null
    rt_notify "$key" "Scope change: $pr ($title) was added to this review. Re-read $(prb_meta_dir "$key")/assignment.json, which is now authoritative. If promoted_from is set, move the existing checkout into the umbrella dir before continuing. Review it and fold it into the report." \
      || prb_log "review '$key' is not live; the next pass will recover it"
    prb_log "appended $pr to review '$key'"
    return 0
  fi

  # A new review. Single pull request until something joins it. A key already in
  # use belongs to a finished review whose record is kept, so take the next free
  # one rather than overwriting the history.
  local n=2
  slug="$(_slug_single "$pr")"
  key="$slug"
  while [ -n "$(prb_review_json "$key")" ]; do key="$slug-r$n"; n=$(( n + 1 )); done
  dir="$(prb_reviews_root)/$key"
  mkdir -p "$dir" || { prb_log "cannot create $dir"; return 1; }
  prb_review_put "$key" "$(jq -nc --arg s "$key" --arg d "$dir" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{status:"ACTIVE",slug:$s,dir:$d,multi:false,created_at:$now,prs:[],heads:{},meta:{}}')"
  prb_pr_bind "$pr" "$key" "$head" "$base"
  prb_state_edit '.reviews[$k].meta[$p] = {reacted_at:$at,title:$t,url:$u,is_draft:($d=="true"),default_branch:$db,stacked:($s=="true")}' \
    --arg k "$key" --arg p "$pr" --arg at "$at" --arg t "$title" --arg u "$url" --arg d "$draft" --arg db "$defbr" --arg s "$stacked"
  _write_assignment "$key" >/dev/null
  prb_log "new review '$key' for $pr (stacked=$stacked draft=$draft)"
  printf '%s\n' "$key"
}

cmd_once() {
  prb_need $(src_deps) $(rt_deps) git || return 1
  prb_lock || return 0
  trap 'prb_unlock' EXIT
  prb_state_init

  local cap running started_at pending="" k st rc line
  cap="$(prb_get cap 3)"
  running="$(rt_running_count)"
  started_at="$(date -u +%s)"
  prb_log "pass start: cap=$cap running=$running"

  # 1. New reactions -> new or extended reviews. Oldest reaction first, so the
  # earliest of a burst anchors the group and later ones join it in the same pass.
  local tmp; tmp="$(mktemp)"
  if ! src_fresh | sort -t"$(printf '\t')" -k2,2 > "$tmp"; then
    prb_log "trigger scan failed; leaving last_poll untouched so nothing is missed"
    rm -f "$tmp"; return 1
  fi
  while IFS=$'\t' read -r pr at head base defbr draft title url; do
    [ -n "$pr" ] || continue
    k="$(_handle_fresh "$pr" "$at" "$head" "$base" "$defbr" "$draft" "$title" "$url")"
    [ -n "$k" ] && pending="$pending$k"$'\n'
  done < "$tmp"
  rm -f "$tmp"

  # 2. Bring up reviews that need an agent: brand new ones, plus any ACTIVE review
  # whose agent died. Both are the same decision, so both go through one loop.
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    st="$(rt_status "$k")"
    [ "$st" = "running" ] && continue
    if [ "$running" -ge "$cap" ]; then prb_log "cap $cap reached; '$k' queued for the next pass"; continue; fi
    case "$st" in
      absent) rt_spawn "$k" "$(src_kickoff_context "$k")" && running=$(( running + 1 )) ;;
      stopped)
        rt_resume "$k"; rc=$?
        if   [ "$rc" = 2 ]; then rt_spawn "$k" "$(src_kickoff_context "$k")" && running=$(( running + 1 ))
        elif [ "$rc" = 0 ]; then running=$(( running + 1 )); fi ;;
    esac
  done < <(prb_active_keys)

  # Only a clean pass advances the watermark. A failed scan leaves it alone, so the
  # widening window re-covers the gap instead of dropping a reaction.
  prb_set_last_poll "$started_at"
  prb_log "pass done: running=$running"
}

cmd_fresh() {
  prb_need $(src_deps) || return 1
  printf '%-42s %-22s %-28s %s\n' PR REACTED-AT HEAD STATE
  local pr at head base defbr draft title url cov state
  while IFS=$'\t' read -r pr at head base defbr draft title url; do
    [ -n "$pr" ] || continue
    cov="$(prb_pr_review "$pr")"
    if [ -n "$cov" ]; then state="covered by $cov ($(prb_review_status "$cov"))"; else state="WOULD SPAWN"; fi
    printf '%-42s %-22s %-28s %s\n' "$pr" "$at" "$head" "$state"
  done < <(src_fresh)
}

cmd_status() {
  prb_need $(src_deps) $(rt_deps) || return 1
  local last
  last="$(prb_last_poll)"
  printf 'pr-review-board\n'
  printf '  config:    %s\n' "$PRB_CONFIG"
  printf '  state:     %s\n' "$PRB_STATE"
  printf '  orgs:      %s\n' "$(prb_get_list orgs | tr '\n' ' ')"
  printf '  reaction:  %s   window: %ss   cap: %s   running: %s\n' \
    "$(prb_get reaction EYES)" "$(prb_get spawn_window_seconds 600)" "$(prb_get cap 3)" "$(rt_running_count)"
  if [ "$last" -gt 0 ] 2>/dev/null; then
    printf '  last poll: %s (%ss ago)\n' \
      "$(date -u -r "$last" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" "$(( $(date -u +%s) - last ))"
  else
    printf '  last poll: never (first pass uses the flat %ss window)\n' "$(prb_get spawn_window_seconds 600)"
  fi
  printf '  reviews:\n'
  local k rs as dir
  while IFS=$'\t' read -r k rs as dir; do
    printf '    %-34s %-10s agent:%-8s %s\n' "$k" "$rs" "$as" "$dir"
    while IFS= read -r p; do [ -n "$p" ] && printf '        %s\n' "$p"; done < <(prb_review_prs "$k")
  done < <(rt_list)
}

cmd_spawn() {  # <owner/repo#N> -- force, ignoring the freshness window
  prb_need $(src_deps) $(rt_deps) git || return 1
  prb_lock || return 1
  trap 'prb_unlock' EXIT
  prb_state_init
  local pr="$1" row k at head base defbr draft title url _pr
  row="$(src_pr_meta "$pr")"
  [ -n "$row" ] || { prb_log "cannot read $pr"; return 1; }
  IFS=$'\t' read -r _pr at head base defbr draft title url <<EOF2
$row
EOF2
  k="$(_handle_fresh "$pr" "$at" "$head" "$base" "$defbr" "$draft" "$title" "$url")"
  [ -n "$k" ] || { k="$(prb_pr_review "$pr")"; }
  [ -n "$k" ] || return 1
  # Same decision as a poll pass: a stopped review is RESUMED. Spawning over it would
  # mint a second session id and abandon the running review's transcript.
  local st rc; st="$(rt_status "$k")"
  case "$st" in
    running) prb_log "review '$k' is already running" ;;
    stopped) rt_resume "$k"; rc=$?; [ "$rc" = 2 ] && rt_spawn "$k" "$(src_kickoff_context "$k")" ;;
    *)       rt_spawn "$k" "$(src_kickoff_context "$k")" ;;
  esac
}

cmd_assignment() { printf '%s/assignment.json\n' "$(prb_meta_dir "$1")"; }

# An installed plugin lives under a VERSION-scoped directory, and superseded versions
# are not pruned, so a scheduler pinned to today's path would quietly keep running
# stale code after every update, and break outright if the cache is ever pruned. The
# scheduler therefore points at this launcher, which resolves the newest installed
# version on each tick. A dev checkout has no version directory, so it falls through
# to the path it was installed from.
_write_launcher() {  # -> launcher path
  local launcher base
  launcher="$HOME/.config/pr-review-board/run-poll.sh"
  mkdir -p "$(dirname "$launcher")"
  case "$HERE" in
    */pr-review-board/*/scripts) base="$(cd "$HERE/../.." && pwd)" ;;
    *)                           base="" ;;
  esac
  {
    echo '#!/usr/bin/env bash'
    echo '# Generated by `poll.sh install`. Do not edit; re-run install instead.'
    echo 'set -uo pipefail'
    printf 'FALLBACK=%s\n' "$(printf '%q' "$HERE/poll.sh")"
    printf 'BASE=%s\n' "$(printf '%q' "$base")"
    echo 'if [ -n "$BASE" ] && [ -d "$BASE" ]; then'
    echo '  newest="$(ls -1 "$BASE" 2>/dev/null | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)"'
    echo '  if [ -n "$newest" ] && [ -x "$BASE/$newest/scripts/poll.sh" ]; then'
    echo '    exec "$BASE/$newest/scripts/poll.sh" once'
    echo '  fi'
    echo 'fi'
    echo 'exec "$FALLBACK" once'
  } > "$launcher"
  chmod +x "$launcher"
  printf '%s' "$launcher"
}

cmd_install() {
  local interval log label plist launcher
  interval="$(prb_get poll_seconds 90)"; log="$HOME/.config/pr-review-board/poll.log"
  mkdir -p "$HOME/.config/pr-review-board"
  launcher="$(_write_launcher)"
  prb_log "launcher: $launcher (resolves the newest installed version per tick)"
  if [ "$(uname)" = "Darwin" ]; then
    label="com.pr-review-board.poller"; plist="$HOME/Library/LaunchAgents/$label.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    sed -e "s#@POLL@#$launcher#g" -e "s#@INTERVAL@#$interval#g" -e "s#@LABEL@#$label#g" -e "s#@LOG@#$log#g" \
      "$HERE/../launchd/com.pr-review-board.poller.plist" >"$plist"
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist" && prb_log "armed launchd job $label (every ${interval}s); logs: $log"
  else
    prb_log "non-macOS: add this crontab line (cron resolution is 60s):"
    printf '* * * * * %s >> %s 2>&1\n' "$launcher" "$log"
  fi
}
cmd_uninstall() {
  if [ "$(uname)" = "Darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/com.pr-review-board.poller.plist"
    launchctl unload "$plist" 2>/dev/null || true; rm -f "$plist"
    rm -f "$HOME/.config/pr-review-board/run-poll.sh"
    prb_log "disarmed launchd job and removed its launcher"
  else prb_log "remove the pr-review-board crontab line manually"; fi
}
cmd_config_init() {
  mkdir -p "$(dirname "$PRB_CONFIG")"
  if [ -f "$PRB_CONFIG" ]; then prb_log "config already exists at $PRB_CONFIG"
  else cp "$HERE/../config.example.json" "$PRB_CONFIG"; prb_log "wrote starter config to $PRB_CONFIG - set orgs and reaction"; fi
  prb_state_init
}

main() {
  local cmd="${1:-help}"; shift 2>/dev/null || true
  case "$cmd" in
    once)        cmd_once "$@" ;;
    fresh)       cmd_fresh "$@" ;;
    status)      cmd_status "$@" ;;
    spawn)       cmd_spawn "$@" ;;
    assignment)  cmd_assignment "$@" ;;
    install)     cmd_install "$@" ;;
    uninstall)   cmd_uninstall "$@" ;;
    config-init) cmd_config_init "$@" ;;
    help|-h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$HERE/poll.sh" ;;
    *) prb_log "unknown command: $cmd (try: help)"; exit 2 ;;
  esac
}
# Sourcing with PRB_LIB_ONLY=1 loads the harness without running a command, so the
# grouping rules can be exercised directly.
[ "${PRB_LIB_ONLY:-}" = 1 ] || main "$@"

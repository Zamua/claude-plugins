#!/usr/bin/env bash
# pr-review-board runtime adapter: stub. Records what a real runtime would have
# done and launches nothing. Set `"runtime": "stub"` to validate a config, the
# trigger, the grouping and the assignment file before arming the scheduler.

rt_deps() { printf 'jq'; }
rt_ensure_server() { return 0; }
rt_status() { [ -n "$(prb_review_field "$1" claude_session)" ] && printf 'running' || printf 'absent'; }
rt_running_count() { local n=0 k; while IFS= read -r k; do [ -n "$k" ] && [ "$(rt_status "$k")" = running ] && n=$(( n + 1 )); done < <(prb_active_keys); printf '%s' "$n"; }
rt_spawn() { prb_review_set_field "$1" claude_session "stub-$(date -u +%s)"; prb_review_set_field "$1" agent_name "stub"; prb_log "STUB spawn '$1' cwd=$(prb_review_field "$1" dir)"; prb_log "STUB kickoff: $2"; }
rt_resume() { prb_log "STUB resume '$1'"; }
rt_notify() { prb_log "STUB notify '$1': $2"; }
rt_close_workspace() { prb_log "STUB close workspace for '$1'"; }
rt_list() { local k; while IFS= read -r k; do [ -n "$k" ] && printf '%s\t%s\t%s\t%s\n' "$k" "$(prb_review_status "$k")" "$(rt_status "$k")" "$(prb_review_field "$k" dir)"; done < <(prb_review_keys); }
rt_relabel() { prb_log "STUB relabel  -> " "$1" "$2"; }

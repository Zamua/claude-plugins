#!/usr/bin/env bash
# agent-board comment watcher. The worker arms this via the Monitor tool. It
# polls a GitHub issue OR pull request for comment activity and prints ONE line
# whenever the comment count changes - Monitor delivers that line to the agent,
# waking it to read and respond. Run from inside the repo worktree (gh resolves
# the repo from the working directory).
#
#   watch-comments.sh issue <number> [interval_seconds]
#   watch-comments.sh pr    <number> [interval_seconds]
set -uo pipefail
kind="${1:?usage: watch-comments.sh issue|pr <number> [interval]}"
num="${2:?missing number}"
interval="${3:-45}"

case "$kind" in
  issue) view() { gh issue view "$num" --json comments --jq '.comments | length' 2>/dev/null; } ;;
  pr)    view() { gh pr view    "$num" --json comments --jq '.comments | length' 2>/dev/null; } ;;
  *) echo "watch-comments: kind must be 'issue' or 'pr'" >&2; exit 2 ;;
esac

last=""
while true; do
  cur="$(view)"
  if [ -n "$cur" ] && [ "$cur" != "$last" ]; then
    [ -n "$last" ] && echo "agent-board: new activity on $kind #$num (comments $last -> $cur) - read the latest comments and respond, then keep watching."
    last="$cur"
  fi
  sleep "$interval"
done

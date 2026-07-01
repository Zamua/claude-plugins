#!/usr/bin/env bash
# telegram-topics: spawn ONE detached tmux session running a FOREGROUND Claude
# bound to a single Telegram forum topic. Invoked by the proxy (proxy/proxy.ts)
# with the topic's parameters in the environment.
#
# Channel injection only works foreground, so each topic gets its own
# foreground Claude in its own tmux session (a --bg agent silently drops
# channel notifications). This mirrors the proven single-session bridge: a NEW
# tmux SESSION captures this process's environment as its session environment,
# so the pane shell + the claude child + its MCP inherit TELEGRAM_TOPIC_ID and
# TELEGRAM_PROXY_URL, and the pane shell expands the $-refs in the command.
set -u

# Schedulers / detached parents run with a minimal PATH; make claude/tmux/bun
# discoverable however they were installed.
export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"

: "${TG_SESSION:?TG_SESSION required}"
: "${TG_SPAWN_DIR:?TG_SPAWN_DIR required}"
: "${TELEGRAM_TOPIC_ID:?TELEGRAM_TOPIC_ID required}"
: "${TELEGRAM_PROXY_URL:?TELEGRAM_PROXY_URL required}"
: "${TG_MARKETPLACE:?TG_MARKETPLACE required}"
: "${TG_SETTINGS:?TG_SETTINGS required}"
: "${TG_KICKOFF:?TG_KICKOFF required}"

# Dedup: never spawn a second session for a topic. The '=' forces an EXACT
# match so tg-<cid>-4 cannot match tg-<cid>-45.
if tmux has-session -t "=$TG_SESSION" 2>/dev/null; then
  echo "telegram-topics: session $TG_SESSION already exists; not spawning" >&2
  exit 0
fi

# Export so the NEW tmux session captures them as its session environment: the
# pane shell expands $TG_MARKETPLACE/$TG_SETTINGS/$TG_KICKOFF in the command,
# and claude + its MCP child inherit TELEGRAM_TOPIC_ID / TELEGRAM_PROXY_URL.
export TELEGRAM_TOPIC_ID TELEGRAM_PROXY_URL TG_MARKETPLACE TG_SETTINGS TG_KICKOFF

# IMPORTANT: --dangerously-load-development-channels is VARIADIC so it MUST use
# the =form; the space form would greedy-consume the kickoff prompt as another
# channel entry. Pass it INSTEAD of --channels (both would double-register).
# Pre-allow the 4 MCP tools via --settings (a detached session cannot answer a
# permission prompt) and run --permission-mode acceptEdits. `exec` so the pane
# dies with claude, so the proxy's tmux-ls reconcile drops the topic cleanly.
tmux new-session -d -s "$TG_SESSION" -c "$TG_SPAWN_DIR" \
  'exec claude --dangerously-load-development-channels="$TG_MARKETPLACE" \
     --settings "$TG_SETTINGS" \
     --permission-mode acceptEdits \
     "$TG_KICKOFF"'

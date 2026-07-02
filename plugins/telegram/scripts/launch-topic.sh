#!/usr/bin/env bash
# telegram-topics: spawn ONE detached tmux session running a FOREGROUND Claude
# bound to a single Telegram forum topic. Invoked by the proxy (proxy/proxy.ts)
# with the topic's parameters in the environment.
#
# Channel injection only works foreground, so each topic gets its own
# foreground Claude in its own tmux session (a --bg agent silently drops
# channel notifications). This mirrors the proven single-session bridge. The
# per-topic vars are handed to the new session EXPLICITLY via `new-session -e`
# (see the note above the tmux call) so the pane shell + the claude child + its
# MCP inherit TELEGRAM_TOPIC_ID / TELEGRAM_PROXY_URL regardless of whether a
# tmux server was already running.
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
: "${TG_CLAUDE_SESSION_ID:?TG_CLAUDE_SESSION_ID required}"
# TG_RESUME is optional: "1" = resume the topic's existing claude session (no
# kickoff, keeps history); empty = first spawn (mint the session + send kickoff).
: "${TG_RESUME:=}"

# Dedup: never spawn a second session for a topic. The '=' forces an EXACT
# match so tg-<cid>-4 cannot match tg-<cid>-45.
if tmux has-session -t "=$TG_SESSION" 2>/dev/null; then
  echo "telegram-topics: session $TG_SESSION already exists; not spawning" >&2
  exit 0
fi

# Pass every var the session needs EXPLICITLY via `tmux new-session -e`. Do NOT
# rely on new-session inheriting this launcher's environment: when the tmux
# server is ALREADY running (e.g. the single-session bridge's server), a new
# session takes the SERVER's environment (seeded at server start), NOT the
# launcher's, so freshly-set vars are empty - the command's $-refs expand to ""
# and claude rejects the untagged `--dangerously-load-development-channels=`,
# killing the pane instantly. `-e` sets them on the session so the pane shell
# can expand $TG_MARKETPLACE/$TG_SETTINGS/$TG_KICKOFF and claude + its MCP child
# inherit TELEGRAM_TOPIC_ID / TELEGRAM_PROXY_URL. (Requires tmux >= 3.2.)

# IMPORTANT: --dangerously-load-development-channels is VARIADIC so it MUST use
# the =form; the space form would greedy-consume the following arg as another
# channel entry. Pass it INSTEAD of --channels (both would double-register).
# --permission-mode auto = checked auto-approve: a guard model vets each command
# and auto-approves the safe ones, so routine work runs without a prompt (chosen
# over --dangerously-skip-permissions, which skips ALL checks). Caveat: a
# detached pane cannot answer an interactive confirm, so if auto mode ever
# escalates a genuinely risky command it will block until attended; re-activate
# the permission relay (below) to route such escalations to Telegram if needed.
# --disallowedTools=AskUserQuestion REMOVES the AskUserQuestion tool: a detached
# pane cannot answer its interactive multiple-choice UI, so a call to it would
# hang the session with no way to unstick it remotely. NB the =form is required
# (the flag is variadic, like --channels, and the space form eats the next arg),
# and the disallowedTools SETTINGS key does NOT work for it - only this CLI flag
# does (verified: with the settings key the model still rendered the tool).
# `exec` so the pane dies with claude and the proxy's tmux-ls reconcile drops it.
#
# Session continuity: the proxy mints a claude session id per topic and passes
# it here. A FIRST spawn uses --session-id <id> + the kickoff (creates the
# session); a re-spawn (TG_RESUME=1) uses --resume <id> and NO kickoff, so the
# topic stays one continuous conversation across kills / crashes / restarts. The
# branch runs INSIDE the pane command so the pane shell picks the right form.
tmux new-session -d -s "$TG_SESSION" -c "$TG_SPAWN_DIR" \
  -e TG_MARKETPLACE="$TG_MARKETPLACE" \
  -e TG_SETTINGS="$TG_SETTINGS" \
  -e TG_KICKOFF="$TG_KICKOFF" \
  -e TG_CLAUDE_SESSION_ID="$TG_CLAUDE_SESSION_ID" \
  -e TG_RESUME="$TG_RESUME" \
  -e TELEGRAM_TOPIC_ID="$TELEGRAM_TOPIC_ID" \
  -e TELEGRAM_PROXY_URL="$TELEGRAM_PROXY_URL" \
  'if [ -n "$TG_RESUME" ]; then \
     exec claude --dangerously-load-development-channels="$TG_MARKETPLACE" \
       --settings "$TG_SETTINGS" --permission-mode auto \
       --disallowedTools=AskUserQuestion \
       --resume "$TG_CLAUDE_SESSION_ID"; \
   else \
     exec claude --dangerously-load-development-channels="$TG_MARKETPLACE" \
       --settings "$TG_SETTINGS" --permission-mode auto \
       --disallowedTools=AskUserQuestion \
       --session-id "$TG_CLAUDE_SESSION_ID" "$TG_KICKOFF"; \
   fi'

# --dangerously-load-development-channels shows a one-key "local development"
# confirmation dialog in an interactive session (third-party channel plugins are
# not first-party-approved, and allowedChannelPlugins is only honored in managed
# settings). A detached pane has no one to answer it, so the session would hang
# before connecting. Auto-confirm with a short-lived DETACHED watcher: poll the
# pane for the dialog text, send "1"+Enter when it appears, then exit. Its fds
# are detached from this script so the proxy's synchronous spawn returns at once.
# NB: pane-target commands (capture-pane/send-keys) do NOT accept the "=name"
# exact-match prefix that has-session does; an exact session name already
# resolves to that session (an exact match beats a prefix match), so pass the
# bare name.
(
  for _ in $(seq 1 60); do
    if tmux capture-pane -t "$TG_SESSION" -p 2>/dev/null | grep -q 'local development'; then
      tmux send-keys -t "$TG_SESSION" 1 Enter
      break
    fi
    sleep 0.25
  done
) </dev/null >/dev/null 2>&1 &

#!/usr/bin/env bash
# telegram-topics: spawn ONE detached multiplexer session running a FOREGROUND
# Claude bound to a single Telegram forum topic. Invoked by the proxy
# (proxy/proxy.ts) with the topic's parameters in the environment.
#
# Channel injection only works foreground, so each topic gets its own
# foreground Claude in its own detached session (a --bg agent silently drops
# channel notifications). This mirrors the proven single-session bridge.
#
# TWO BACKENDS, selected by TG_MUX (set by the proxy from
# TELEGRAM_TOPICS_MULTIPLEXER; default tmux):
#   tmux   the original backend. Per-topic vars are handed to the new session
#          EXPLICITLY via `new-session -e` (see the note in spawn_tmux) so the
#          pane shell + the claude child + its MCP inherit them regardless of
#          whether a tmux server was already running.
#   herdr  the herdr.dev agent multiplexer. Vars are injected with a
#          `/usr/bin/env VAR=...` prefix on the pane command - REQUIRED because
#          a herdr pane inherits the herdr SERVER's environment (often a
#          minimal launchd one), never this launcher's. PATH is forwarded the
#          same way so `claude` resolves under the server's env too.
# The claude invocation itself (PANE_CMD below) is byte-identical for both.
set -u

# Schedulers / detached parents run with a minimal PATH; make claude/tmux/
# herdr/bun discoverable however they were installed.
export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"

: "${TG_SESSION:?TG_SESSION required}"
: "${TG_SPAWN_DIR:?TG_SPAWN_DIR required}"
: "${TELEGRAM_TOPIC_ID:?TELEGRAM_TOPIC_ID required}"
: "${TELEGRAM_PROXY_URL:?TELEGRAM_PROXY_URL required}"
: "${TG_MARKETPLACE:?TG_MARKETPLACE required}"
: "${TG_SETTINGS:?TG_SETTINGS required}"
# TG_HOOK: absolute path to the Stop hook (hooks/stop-reply-guard.py). The
# session's --settings override references it as $TG_HOOK so that committed file
# needs no hardcoded path; forwarded into the pane like the rest.
: "${TG_HOOK:?TG_HOOK required}"
# TG_FAILOVER_HOOK: the StopFailure hook (hooks/rate-limit-failover.py) that
# reports a usage-limit stall to the proxy for model failover. Optional so an
# older proxy still spawns; the settings hook entry just no-ops without it.
: "${TG_FAILOVER_HOOK:=}"
: "${TG_KICKOFF:?TG_KICKOFF required}"
: "${TG_CLAUDE_SESSION_ID:?TG_CLAUDE_SESSION_ID required}"
# TG_RESUME is optional: "1" = resume the topic's existing claude session (no
# kickoff, keeps history); empty = first spawn (mint the session + send kickoff).
: "${TG_RESUME:=}"
# TG_MODEL is optional: a model id passed as the --model FLAG (empty = account
# default). Set by the proxy from TELEGRAM_TOPICS_MODEL.
: "${TG_MODEL:=}"
# TG_MUX is optional: which multiplexer hosts the session (default tmux).
: "${TG_MUX:=tmux}"
# MCP_TIMEOUT (ms, claude's MCP-startup ceiling) is forwarded into the pane with a
# GENEROUS default. Root cause of a real incident (2026-07-29): a topic with a
# HUGE transcript (shale) resumed so slowly that the Telegram CHANNEL MCP's
# startup exceeded the default timeout and claude DROPPED it - the session ran but
# with no channel, so nothing polled the proxy and every message to that topic
# silently queued undrained. Small-transcript topics loaded in time and were fine.
# A generous ceiling is harmless for fast loaders (the MCP connects as soon as
# it's ready; the timeout only bites a slow resume) and rescues the big ones.
# Overridable via the environment. Measured: 180000 recovered shale end-to-end.
: "${MCP_TIMEOUT:=180000}"

# Resolve claude NOW, under this launcher's explicit PATH, and pass the
# ABSOLUTE path into the pane (TG_CLAUDE_BIN). The pane's shell re-runs its
# init files, and a managed /etc/zshenv (e.g. nix-darwin's) can REPLACE PATH
# wholesale - which silently dropped ~/.local/bin and killed every spawn with
# exit 127 when the mini moved to nix-darwin (2026-07-17). Exec'ing the
# absolute path is immune to any shell-init PATH games; TG_PATH additionally
# restores the full PATH inside the pane so claude's OWN children (its Bash
# tool) inherit a working environment.
TG_CLAUDE_BIN=$(command -v claude) || {
  echo "telegram-topics: claude not found on the launcher PATH" >&2
  exit 1
}
TG_PATH="$PATH"

# The pane command, IDENTICAL for both backends. Runs under a shell INSIDE the
# pane with the TG_*/TELEGRAM_* vars present in its environment (each backend
# has its own way of getting them there - see spawn_tmux / spawn_herdr).
#
# IMPORTANT: --dangerously-load-development-channels is VARIADIC so it MUST use
# the =form; the space form would greedy-consume the following arg as another
# channel entry. Pass it INSTEAD of --channels (both would double-register).
# --permission-mode auto = checked auto-approve: a guard model vets each command
# and auto-approves the safe ones, so routine work runs without a prompt (chosen
# over --dangerously-skip-permissions, which skips ALL checks). Caveat: a
# detached pane cannot answer an interactive confirm, so if auto mode ever
# escalates a genuinely risky command it will block until attended.
# --disallowedTools=AskUserQuestion REMOVES the AskUserQuestion tool: a detached
# pane cannot answer its interactive multiple-choice UI. NB the =form is
# required (variadic, like --channels), and the disallowedTools SETTINGS key
# does NOT work for it - only the CLI flag does.
# `exec` so the pane dies with claude and the proxy's reconcile drops it.
#
# Session continuity: a FIRST spawn uses --session-id <id> + the kickoff; a
# re-spawn (TG_RESUME=1) uses --resume <id> and NO kickoff. TG_MODEL is the
# --model FLAG (a settings `model` is ignored by a --resume'd session; the flag
# overrides even on resume). Args built with `set --` so a bracketed id like
# claude-fable-5[1m] stays ONE properly-quoted arg.
PANE_CMD='export PATH="$TG_PATH"; \
 set -- --dangerously-load-development-channels="$TG_MARKETPLACE" \
        --settings "$TG_SETTINGS" --permission-mode auto \
        --disallowedTools=AskUserQuestion; \
 [ -n "$TG_MODEL" ] && set -- "$@" --model "$TG_MODEL"; \
 if [ -n "$TG_RESUME" ]; then \
   exec "$TG_CLAUDE_BIN" "$@" --resume "$TG_CLAUDE_SESSION_ID"; \
 else \
   exec "$TG_CLAUDE_BIN" "$@" --session-id "$TG_CLAUDE_SESSION_ID" "$TG_KICKOFF"; \
 fi'

# --dangerously-load-development-channels can show a one-key "local
# development" confirmation dialog (third-party channel plugins are not
# first-party-approved, and allowedChannelPlugins is only honored in managed
# settings). A detached pane has no one to answer it, so each backend runs a
# short-lived DETACHED watcher: poll the pane text for the dialog, send
# "1"+Enter when it appears, then exit. The watcher's fds are detached so the
# proxy's synchronous spawn returns at once.
# WATCHER WINDOW: 2 minutes (480 x 0.25s). A BIG-transcript --resume renders
# the dialog long after spawn (the transcript loads first); the original 15s
# window lost that race twice (2026-07-17/18: sessions came up REPL-alive but
# plugin-less, with messages queueing undrained at the proxy). The dialog does
# not appear on every boot (claude >= 2.1.214 often skips it), so most
# watchers just poll quietly and exit.
# WRAP-PROOF MATCHING: in a NARROW pane the dialog text wraps mid-phrase
# ("for local\n       development"), so a plain grep for "local development"
# never matches at ANY window length (this silently defeated the herdr watcher,
# 2026-07-18). Each watcher therefore strips ALL whitespace (and, for the herdr
# socket path, JSON-encoded \n sequences) from the captured text and greps for
# the squashed phrase - immune to wrapping and indentation.
DIALOG_SQUASHED='Iamusingthisforlocaldevelopment'
WATCHER_TRIES=480

spawn_tmux() {
  # Dedup: never spawn a second session for a topic. The '=' forces an EXACT
  # match so claude-x-4 cannot match claude-x-45.
  if tmux has-session -t "=$TG_SESSION" 2>/dev/null; then
    echo "telegram-topics: session $TG_SESSION already exists; not spawning" >&2
    exit 0
  fi

  # Pass every var the session needs EXPLICITLY via `tmux new-session -e`. Do
  # NOT rely on new-session inheriting this launcher's environment: when the
  # tmux server is ALREADY running, a new session takes the SERVER's
  # environment (seeded at server start), NOT the launcher's, so freshly-set
  # vars would be empty - the command's $-refs expand to "" and claude rejects
  # the untagged --dangerously-load-development-channels=, killing the pane
  # instantly. (Requires tmux >= 3.2.)
  tmux new-session -d -s "$TG_SESSION" -c "$TG_SPAWN_DIR" \
    -e MCP_TIMEOUT="$MCP_TIMEOUT" \
    -e TG_PATH="$TG_PATH" \
    -e TG_CLAUDE_BIN="$TG_CLAUDE_BIN" \
    -e TG_MARKETPLACE="$TG_MARKETPLACE" \
    -e TG_SETTINGS="$TG_SETTINGS" \
    -e TG_HOOK="$TG_HOOK" \
    -e TG_FAILOVER_HOOK="$TG_FAILOVER_HOOK" \
    -e TG_MODEL="$TG_MODEL" \
    -e TG_KICKOFF="$TG_KICKOFF" \
    -e TG_CLAUDE_SESSION_ID="$TG_CLAUDE_SESSION_ID" \
    -e TG_RESUME="$TG_RESUME" \
    -e TELEGRAM_TOPIC_ID="$TELEGRAM_TOPIC_ID" \
    -e TELEGRAM_PROXY_URL="$TELEGRAM_PROXY_URL" \
    "$PANE_CMD"

  # Auto-confirm watcher. NB: pane-target commands (capture-pane/send-keys) do
  # NOT accept the "=name" exact-match prefix that has-session does; an exact
  # session name already resolves exactly, so pass the bare name.
  (
    for _ in $(seq 1 "$WATCHER_TRIES"); do
      if tmux capture-pane -t "$TG_SESSION" -p 2>/dev/null | tr -d ' \t\n' | grep -q "$DIALOG_SQUASHED"; then
        tmux send-keys -t "$TG_SESSION" 1 Enter
        break
      fi
      sleep 0.25
    done
  ) </dev/null >/dev/null 2>&1 &
}

spawn_herdr() {
  local herdr_bin sock pane_id ws_id root_pane
  herdr_bin=$(command -v herdr || echo /opt/homebrew/bin/herdr)
  # Default-session socket; HERDR_SOCKET_PATH overrides (matches herdr's own
  # resolution order for the default session).
  sock="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"

  # Dedup, status-aware. A LABEL ALONE IS NOT A LIVE SESSION: herdr restores its
  # panes on login (from session.json) with labels intact while the claude
  # process inside died with the logout, and it reports such an empty shell as
  # `agent_status: "unknown"` (a real agent is idle/working/done/blocked). The
  # old label-only guard refused to spawn over those corpses, so a topic that was
  # running at logout could never come back (2026-07-23). Now: a live agent means
  # skip; a STALE labeled pane is closed first so the spawn below replaces it
  # (leaving it would also strand a duplicate label).
  local pane_state stale_pane
  pane_state=$("$herdr_bin" pane list 2>/dev/null | python3 -c '
import json, sys
label = sys.argv[1]
try:
    panes = json.load(sys.stdin).get("result", {}).get("panes", [])
except Exception:
    print("parse-error")            # fail open: spawn, herdr dedups on its own
    raise SystemExit
for p in panes:
    if p.get("label") == label:
        status = p.get("agent_status") or "unknown"
        print(("live " if status != "unknown" else "stale ") + str(p.get("pane_id") or ""))
        raise SystemExit
print("absent")
' "$TG_SESSION" 2>/dev/null) || pane_state="parse-error"

  case "$pane_state" in
    live*)
      echo "telegram-topics: session $TG_SESSION already exists; not spawning" >&2
      exit 0
      ;;
    stale*)
      stale_pane="${pane_state#stale }"
      echo "telegram-topics: clearing stale pane $stale_pane for $TG_SESSION (no agent running)" >&2
      [ -n "$stale_pane" ] && "$herdr_bin" pane close "$stale_pane" >/dev/null 2>&1
      ;;
  esac

  # One WORKSPACE per topic-Claude (operator preference: agents as workspace
  # tabs, not side-by-side splits in one shared workspace). Create it labeled
  # with the session name, remember its auto-created empty ROOT pane (closed
  # after the agent lands - `agent start` always splits a NEW pane, it never
  # reuses the root), and never steal UI focus. If workspace creation fails
  # (older herdr, server hiccup) fall back to spawning without --workspace -
  # a shared-workspace pane beats no session.
  local ws_out
  ws_out=$("$herdr_bin" workspace create --cwd "$TG_SPAWN_DIR" --label "$TG_SESSION" --no-focus 2>/dev/null) || ws_out=''
  ws_id=$(printf '%s' "$ws_out" | sed -n 's/.*"workspace_id":"\([^"]*\)".*/\1/p' | head -1)
  root_pane=$(printf '%s' "$ws_out" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1)

  # Spawn. A herdr pane inherits the herdr SERVER's environment (not this
  # launcher's), so every var - PATH included, or `claude` may not resolve
  # under a launchd-started server - is injected with a /usr/bin/env prefix on
  # the pane command (the herdr equivalent of tmux's `new-session -e`).
  local out
  out=$("$herdr_bin" agent start "$TG_SESSION" ${ws_id:+--workspace "$ws_id"} --no-focus --cwd "$TG_SPAWN_DIR" -- \
    /usr/bin/env \
    PATH="$PATH" \
    MCP_TIMEOUT="$MCP_TIMEOUT" \
    TG_PATH="$TG_PATH" \
    TG_CLAUDE_BIN="$TG_CLAUDE_BIN" \
    TG_MARKETPLACE="$TG_MARKETPLACE" \
    TG_SETTINGS="$TG_SETTINGS" \
    TG_HOOK="$TG_HOOK" \
    TG_FAILOVER_HOOK="$TG_FAILOVER_HOOK" \
    TG_MODEL="$TG_MODEL" \
    TG_KICKOFF="$TG_KICKOFF" \
    TG_CLAUDE_SESSION_ID="$TG_CLAUDE_SESSION_ID" \
    TG_RESUME="$TG_RESUME" \
    TELEGRAM_TOPIC_ID="$TELEGRAM_TOPIC_ID" \
    TELEGRAM_PROXY_URL="$TELEGRAM_PROXY_URL" \
    bash -c "$PANE_CMD") || {
    echo "telegram-topics: herdr agent start failed (is the herdr server running?)" >&2
    exit 1
  }
  # agent start echoes one JSON object; the pane_id is the handle the watcher
  # needs for pane.read / send-keys.
  pane_id=$(printf '%s' "$out" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1)

  # Close the workspace's empty root pane so the agent is the workspace's sole
  # pane. Guard: never close the pane the agent itself landed in.
  if [ -n "$root_pane" ] && [ "$root_pane" != "$pane_id" ]; then
    "$herdr_bin" pane close "$root_pane" >/dev/null 2>&1 || true
  fi

  # Auto-confirm watcher: poll the pane's visible text over the socket API
  # (newline-delimited JSON; pane.read requires source=visible), answer the
  # dialog with send-keys, exit. Skipped if the pane_id could not be parsed -
  # the session still runs; a human can answer the dialog via `herdr`.
  if [ -n "$pane_id" ]; then
    (
      for _ in $(seq 1 "$WATCHER_TRIES"); do
        # sed strips JSON-encoded newlines (literal backslash-n) BEFORE the
        # space strip, so a phrase wrapped across pane lines squashes back
        # together; see the wrap-proof matching note above.
        if printf '{"id":"w","method":"pane.read","params":{"pane_id":"%s","source":"visible"}}\n' "$pane_id" \
          | nc -U "$sock" 2>/dev/null | sed 's/\\n//g; s/ //g' | grep -q "$DIALOG_SQUASHED"; then
          "$herdr_bin" pane send-keys "$pane_id" 1 Enter
          break
        fi
        sleep 0.25
      done
    ) </dev/null >/dev/null 2>&1 &
  else
    echo "telegram-topics: could not parse herdr pane_id; dialog watcher skipped" >&2
  fi
}

case "$TG_MUX" in
  tmux) spawn_tmux ;;
  herdr) spawn_herdr ;;
  *)
    echo "telegram-topics: unknown TG_MUX '$TG_MUX' (expected tmux|herdr)" >&2
    exit 1
    ;;
esac

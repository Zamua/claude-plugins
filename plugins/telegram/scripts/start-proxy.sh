#!/usr/bin/env bash
# telegram-topics: start the proxy (one token, one getUpdates poll, HTTP demux).
# Runs in the FOREGROUND; use a terminal, tmux, or the launchd template for
# durability. Env comes from the real environment or a `.env` (this plugin dir
# or ~/.claude/channels/telegram-topics/). See .env.example for the keys.
#
# ONE-TOKEN CAVEAT: Telegram allows exactly one getUpdates consumer per token.
# The proxy and any other poller on the same token (e.g. the single-session
# claude-telegram bridge) will fight for the slot. Stop the other one first.
set -u

export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="$HERE/../proxy"

cd "$PROXY_DIR" || { echo "cannot cd to $PROXY_DIR" >&2; exit 1; }

# `bun install` only ever makes node_modules a directory. A symlink or a file in
# its place (one pointing at itself fails every start with ELOOP) is removed so
# the install below rebuilds it; rm on a symlink removes only the link.
if [ -L node_modules ] || { [ -e node_modules ] && [ ! -d node_modules ]; }; then
  echo "telegram-topics: replacing a node_modules that is not a directory: $(ls -ld node_modules)" >&2
  rm -f node_modules
fi

exec bun run start

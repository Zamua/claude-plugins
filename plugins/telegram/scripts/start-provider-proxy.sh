#!/usr/bin/env bash
# Start the loopback provider bridge without copying credentials into pm2 or
# the Telegram plugin configuration. OpenCode owns its API key file; this
# adapter reads it at process start and exports it only to the bridge process.
set -eu

export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

auth_file="${TELEGRAM_OPENCODE_AUTH_FILE:-$HOME/.local/share/opencode/auth.json}"
if [ -f "$auth_file" ]; then
  opencode_key=$(jq -r '."opencode-go".key // empty' "$auth_file")
  if [ -n "$opencode_key" ]; then
    export CCP_OPENCODE_API_KEY="$opencode_key"
  fi
fi

exec claude-code-proxy serve --no-monitor --port "${TELEGRAM_PROVIDER_PROXY_PORT:-18765}"

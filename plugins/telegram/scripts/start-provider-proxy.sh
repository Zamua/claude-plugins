#!/usr/bin/env bash
# Start the loopback provider bridge without copying credentials into pm2 or
# the Telegram plugin configuration. OpenCode owns its API key file; this
# adapter reads it at process start and exports it only to the bridge process.
set -eu

export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# The bridge validates Claude's session/Agent identity and only continues an
# append-only transcript when the request is a safe extension. This avoids
# resending a large main or subagent transcript on every tool round; an explicit
# operator value (including 0) still wins.
export CCP_CODEX_PREVIOUS_RESPONSE_ID="${CCP_CODEX_PREVIOUS_RESPONSE_ID:-1}"

auth_file="${TELEGRAM_OPENCODE_AUTH_FILE:-$HOME/.local/share/opencode/auth.json}"
if [ -f "$auth_file" ]; then
  opencode_key=$(jq -r '."opencode-go".key // empty' "$auth_file")
  if [ -n "$opencode_key" ]; then
    export CCP_OPENCODE_API_KEY="$opencode_key"
  fi
fi

proxy_bin="${TELEGRAM_PROVIDER_PROXY_BIN:-}"
home_manager_proxy="$HOME/.local/state/nix/profiles/home-manager/home-path/bin/claude-code-proxy"
if [ -z "$proxy_bin" ] && [ -x "$home_manager_proxy" ]; then
  proxy_bin="$home_manager_proxy"
fi
proxy_bin="${proxy_bin:-claude-code-proxy}"

exec "$proxy_bin" serve --no-monitor --port "${TELEGRAM_PROVIDER_PROXY_PORT:-18765}"

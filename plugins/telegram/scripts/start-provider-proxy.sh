#!/usr/bin/env bash
# Start the loopback provider bridge without copying credentials into pm2 or
# the Telegram plugin configuration. OpenCode owns its API key file; this
# adapter reads it at process start and exports it only to the bridge process.
set -eu

# The bridge writes operational metadata locally. Keep new logs private and
# repair older rotations that predate this wrapper's restrictive umask.
umask 077
proxy_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/claude-code-proxy"
if [ -d "$proxy_state_dir" ]; then
  find "$proxy_state_dir" -maxdepth 1 -type f -name 'proxy*' -exec chmod 600 {} +
fi
for pm2_log in \
  "$HOME/.pm2/logs/claude-code-proxy-out.log" \
  "$HOME/.pm2/logs/claude-code-proxy-error.log"
do
  [ ! -f "$pm2_log" ] || chmod 600 "$pm2_log"
done

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

# nix-darwin installs the patched bridge into the per-user system profile. The
# standalone home-manager profile is a stale leftover and must not win.
proxy_bin="${TELEGRAM_PROVIDER_PROXY_BIN:-}"
system_profile_proxy="/etc/profiles/per-user/$USER/bin/claude-code-proxy"
if [ -z "$proxy_bin" ] && [ -x "$system_profile_proxy" ]; then
  proxy_bin="$system_profile_proxy"
fi
proxy_bin="${proxy_bin:-claude-code-proxy}"

exec "$proxy_bin" serve --no-monitor --port "${TELEGRAM_PROVIDER_PROXY_PORT:-18765}"

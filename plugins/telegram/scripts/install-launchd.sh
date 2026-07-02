#!/usr/bin/env bash
# telegram-topics: install the proxy as a launchd agent, so it auto-starts on
# login (RunAtLoad) and auto-restarts on crash (KeepAlive) with NO external
# service manager (native macOS launchd - the plugin stays self-contained).
#
# Idempotent: re-run to reinstall + reload after editing the plist/env. Uninstall:
#   launchctl unload ~/Library/LaunchAgents/com.telegram-topics.proxy.plist
#   rm ~/Library/LaunchAgents/com.telegram-topics.proxy.plist
#
# NB: the proxy will OWN the bot token's getUpdates slot. Stop any other poller
# on the same token first (e.g. the single-session claude-telegram bridge if it
# shares the token - it should not, use a separate token).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$HERE/.." && pwd)"
LABEL="com.telegram-topics.proxy"
TEMPLATE="$PLUGIN_DIR/launchd/$LABEL.plist"
START_PROXY="$PLUGIN_DIR/scripts/start-proxy.sh"
LOG="$HOME/Library/Logs/telegram-topics-proxy.log"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -f "$TEMPLATE" ] || { echo "template not found: $TEMPLATE" >&2; exit 1; }
[ -f "$START_PROXY" ] || { echo "start-proxy.sh not found: $START_PROXY" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"

# Fill the two placeholders and install (launchd ignores the XML comment).
sed -e "s#@STARTPROXY@#$START_PROXY#g" -e "s#@LOG@#$LOG#g" "$TEMPLATE" > "$DEST"

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

echo "installed + loaded $LABEL"
echo "  plist:  $DEST"
echo "  log:    $LOG"
echo "  status: $(launchctl list | grep "$LABEL" || echo 'not listed')"

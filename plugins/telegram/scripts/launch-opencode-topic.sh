#!/usr/bin/env bash
# Start one persistent OpenCode TUI in its own Herdr workspace.
# Telegram input is injected through Herdr; the Telegram MCP is added as a
# config layer through OPENCODE_CONFIG_CONTENT and remains outbound-only.
set -u

export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"

: "${OC_SESSION:?OC_SESSION required}"
: "${OC_SPAWN_DIR:?OC_SPAWN_DIR required}"
: "${OC_BIN:?OC_BIN required}"
: "${OC_ARGS_JSON:?OC_ARGS_JSON required}"
: "${OC_CONFIG_CONTENT:?OC_CONFIG_CONTENT required}"
: "${TELEGRAM_TOPIC_ID:?TELEGRAM_TOPIC_ID required}"
: "${TELEGRAM_PROXY_URL:?TELEGRAM_PROXY_URL required}"

HERDR_BIN=$(command -v herdr || echo /opt/homebrew/bin/herdr)

pane_state=$($HERDR_BIN pane list 2>/dev/null | python3 -c '
import json, sys
label = sys.argv[1]
try:
    panes = json.load(sys.stdin).get("result", {}).get("panes", [])
except Exception:
    print("parse-error")
    raise SystemExit
for pane in panes:
    if pane.get("label") == label:
        status = pane.get("agent_status") or "unknown"
        print(("live " if status != "unknown" else "stale ") + str(pane.get("pane_id") or ""))
        raise SystemExit
print("absent")
' "$OC_SESSION" 2>/dev/null) || pane_state="parse-error"

case "$pane_state" in
  live*)
    exit 0
    ;;
  stale*)
    stale_pane="${pane_state#stale }"
    [ -n "$stale_pane" ] && "$HERDR_BIN" pane close "$stale_pane" >/dev/null 2>&1
    ;;
esac

workspace=$($HERDR_BIN workspace create --cwd "$OC_SPAWN_DIR" --label "$OC_SESSION" --no-focus 2>/dev/null) || workspace=''
pane_id=$(printf '%s' "$workspace" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$pane_id" ]; then
  echo "telegram-topics: Herdr workspace creation failed for $OC_SESSION" >&2
  exit 1
fi
"$HERDR_BIN" pane rename "$pane_id" "$OC_SESSION" >/dev/null 2>&1 || true

script=$(mktemp "${TMPDIR:-/tmp}/tg-oc-XXXXXX") || {
  echo "telegram-topics: could not create OpenCode launch script" >&2
  exit 1
}
python3 - "$script" "$OC_BIN" "$OC_ARGS_JSON" "$PATH" "$TELEGRAM_TOPIC_ID" "$TELEGRAM_PROXY_URL" "$OC_CONFIG_CONTENT" <<'PY'
import json, shlex, sys

path, binary, encoded, env_path, topic, proxy, config = sys.argv[1:]
args = json.loads(encoded)
with open(path, "w", encoding="utf-8") as handle:
    handle.write("#!/usr/bin/env bash\n")
    handle.write("rm -f -- " + shlex.quote(path) + "\n")
    handle.write("export PATH=" + shlex.quote(env_path) + "\n")
    handle.write("export TELEGRAM_TOPIC_ID=" + shlex.quote(topic) + "\n")
    handle.write("export TELEGRAM_PROXY_URL=" + shlex.quote(proxy) + "\n")
    handle.write("export TG_INBOUND_MODE=pane\n")
    handle.write("export TELEGRAM_HARNESS=opencode\n")
    handle.write("export OPENCODE_CONFIG_CONTENT=" + shlex.quote(config) + "\n")
    handle.write("exec " + shlex.join([binary, *args]) + "\n")
PY
chmod 700 "$script"

if ! "$HERDR_BIN" pane run "$pane_id" "exec bash $script" >/dev/null 2>&1; then
  echo "telegram-topics: could not start OpenCode in Herdr pane $pane_id" >&2
  rm -f "$script"
  exit 1
fi

#!/usr/bin/env bash
# Start one persistent harness-locked agent (Antigravity, OpenCode) in its own
# Herdr workspace. Telegram input is injected through Herdr; the Telegram MCP the
# agent loads stays outbound-only (TG_INBOUND_MODE=pane).
#
# HX_ENV_JSON is an optional {NAME: value} object of extra exports for the pane,
# such as OpenCode's OPENCODE_CONFIG_CONTENT.
set -u

export PATH="$HOME/.local/bin:$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"

: "${HX_HARNESS:?HX_HARNESS required}"
: "${HX_SESSION:?HX_SESSION required}"
: "${HX_SPAWN_DIR:?HX_SPAWN_DIR required}"
: "${HX_BIN:?HX_BIN required}"
: "${HX_ARGS_JSON:?HX_ARGS_JSON required}"
: "${TELEGRAM_TOPIC_ID:?TELEGRAM_TOPIC_ID required}"
: "${TELEGRAM_PROXY_URL:?TELEGRAM_PROXY_URL required}"
[ -n "${HX_ENV_JSON:-}" ] || HX_ENV_JSON='{}'

HERDR_BIN=$(command -v herdr || echo /opt/homebrew/bin/herdr)

# A pane can outlive its agent (herdr restores labeled panes after a restart), so
# only a non-"unknown" agent status counts as live; a stale pane is closed.
pane_state=$("$HERDR_BIN" pane list 2>/dev/null | python3 -c '
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
' "$HX_SESSION" 2>/dev/null) || pane_state="parse-error"

case "$pane_state" in
  live*)
    exit 0
    ;;
  stale*)
    stale_pane="${pane_state#stale }"
    [ -n "$stale_pane" ] && "$HERDR_BIN" pane close "$stale_pane" >/dev/null 2>&1
    ;;
esac

workspace=$("$HERDR_BIN" workspace create --cwd "$HX_SPAWN_DIR" --label "$HX_SESSION" --no-focus 2>/dev/null) || workspace=''
pane_id=$(printf '%s' "$workspace" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$pane_id" ]; then
  echo "telegram-topics: Herdr workspace creation failed for $HX_SESSION" >&2
  exit 1
fi
"$HERDR_BIN" pane rename "$pane_id" "$HX_SESSION" >/dev/null 2>&1 || true

# The pane inherits the Herdr server's environment, not ours, and `pane run`
# types its argument into the pane shell, so everything goes in a short script
# that deletes itself on entry.
script=$(mktemp "${TMPDIR:-/tmp}/tg-$HX_HARNESS-XXXXXX") || {
  echo "telegram-topics: could not create the $HX_HARNESS launch script" >&2
  exit 1
}
if ! python3 - "$script" "$HX_BIN" "$HX_ARGS_JSON" "$PATH" "$TELEGRAM_TOPIC_ID" "$TELEGRAM_PROXY_URL" "$HX_HARNESS" "$HX_ENV_JSON" <<'PY'
import json, re, shlex, sys

path, binary, encoded, env_path, topic, proxy, harness, extra = sys.argv[1:]
args = json.loads(encoded)
extra_env = json.loads(extra)
if not isinstance(extra_env, dict):
    sys.exit("HX_ENV_JSON must be a JSON object")
for name in extra_env:
    if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", name):
        sys.exit("HX_ENV_JSON has an invalid variable name: " + name)
with open(path, "w", encoding="utf-8") as handle:
    handle.write("#!/usr/bin/env bash\n")
    handle.write("rm -f -- " + shlex.quote(path) + "\n")
    handle.write("export PATH=" + shlex.quote(env_path) + "\n")
    handle.write("export TELEGRAM_TOPIC_ID=" + shlex.quote(topic) + "\n")
    handle.write("export TELEGRAM_PROXY_URL=" + shlex.quote(proxy) + "\n")
    handle.write("export TG_INBOUND_MODE=pane\n")
    handle.write("export TELEGRAM_HARNESS=" + shlex.quote(harness) + "\n")
    for name, value in extra_env.items():
        handle.write("export " + name + "=" + shlex.quote(str(value)) + "\n")
    handle.write("exec " + shlex.join([binary, *args]) + "\n")
PY
then
  echo "telegram-topics: could not write the $HX_HARNESS launch script" >&2
  rm -f "$script"
  exit 1
fi
chmod 700 "$script"

if ! "$HERDR_BIN" pane run "$pane_id" "exec bash $script" >/dev/null 2>&1; then
  echo "telegram-topics: could not start $HX_HARNESS in Herdr pane $pane_id" >&2
  rm -f "$script"
  exit 1
fi

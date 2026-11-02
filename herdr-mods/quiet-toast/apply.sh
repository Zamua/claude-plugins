#!/usr/bin/env bash
# Drops Herdr's "an agent finished" toasts and keeps every other one, by patching the shipped
# toast mod in place. Herdr has no setting for which toasts show and always draws them with
# mods/toast, so there is nothing to point elsewhere. Herdr restores its own mod on each start and
# keeps the patched copy as toast-edited; with --agent, launchd runs this again whenever that happens.
#
#   apply.sh                  patch, keeping the shipped file as toast-main.js.orig
#   apply.sh --undo           put the shipped file back
#   apply.sh --agent          also patch again by itself after every Herdr start (a launchd agent)
#   apply.sh --agent --undo   remove that agent and put the shipped file back
set -euo pipefail

home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
mod=$home/mods/toast/main.js
orig=$home/toast-main.js.orig
label=com.herdr.quiet-toast
agent=$HOME/Library/LaunchAgents/$label.plist

if [ "${1:-}" = --agent ]; then
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  if [ "${2:-}" = --undo ]; then
    rm -f "$agent"
    exec "$0" --undo
  fi
  cat > "$agent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$(cd "$(dirname "$0")" && pwd)/apply.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>WatchPaths</key><array><string>$mod</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$agent"
  exit 0
fi

if [ "${1:-}" = --undo ]; then
  [ -f "$orig" ] && cp "$orig" "$mod" && rm "$orig"
  exit 0
fi
# Copies Herdr set aside on a start are this patch; the live one is patched again below
for kept in "$home"/mods/toast-edited*; do
  [ -f "$kept/main.js" ] && grep -q 'isFinished' "$kept/main.js" && rm -rf "$kept"
done
[ -f "$mod" ] || exit 0
grep -q 'isFinished' "$mod" && exit 0
cp -p "$mod" "$orig"

python3 -I - "$mod" <<'EOF'
import sys
path = sys.argv[1]
src = open(path).read()
head = 'export default class Toast extends View {\n'
assert head in src, "the toast mod changed shape; patch it by hand"
rule = (
    '// Herdr posts these when an agent finishes while nobody is looking\n'
    'const isFinished = (p) => p.action?.name === "agent.focus" && / finished$/.test(p.title ?? "");\n\n'
)
init = (
    '  init(_props, cx) {\n'
    '    const p = props() ?? {};\n'
    '    this.dropped = isFinished(p);\n'
    '    if (this.dropped) closeOverlay(p.overlay);\n'
    '  }\n\n'
)
src = src.replace(head, rule + head + init, 1)
src = src.replace('  render(cx) {\n', '  render(cx) {\n    if (this.dropped) return div();\n', 1)
open(path, "w").write(src)
EOF
if command -v herdr-app >/dev/null; then herdr-app check "$home/mods/toast"; fi

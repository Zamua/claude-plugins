#!/usr/bin/env bash
# Drops Herdr's "an agent finished" toasts and keeps every other one, by patching the shipped
# toast mod in place. Herdr has no setting for which toasts show and always draws them with
# mods/toast, so there is nothing to point elsewhere. Herdr restores its own mod on its next
# start (keeping the patched copy as toast-edited), so run this again after a restart.
#
#   apply.sh          patch, keeping the shipped file as toast-main.js.orig
#   apply.sh --undo   put the shipped file back
set -euo pipefail

home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
mod=$home/mods/toast/main.js
orig=$home/toast-main.js.orig

if [ "${1:-}" = --undo ]; then
  [ -f "$orig" ] && cp "$orig" "$mod" && rm "$orig"
  exit 0
fi
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
herdr-app check "$home/mods/toast"

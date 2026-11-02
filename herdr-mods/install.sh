#!/usr/bin/env bash
# Puts these mods and layouts into the Herdr app's folder. Each mod's files are hard links, not
# symlinks: Herdr refuses a module whose real path is outside its mod folder and serves no icon
# through a symlinked one. Hard links keep the repo the source while it edits files in place;
# run this again after a git pull or checkout, which replaces them.
#
#   install.sh             link every mod folder here and layouts/*.json
#   install.sh --remove    take them out again
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}

for dir in "$here"/*/; do
  name=$(basename "$dir")
  [ -f "$dir/main.js" ] || continue
  target=$home/mods/$name
  if [ "${1:-}" = --remove ]; then
    rm -rf "$target"
    continue
  fi
  [ -L "$target" ] && rm "$target"
  mkdir -p "$target"
  for file in "$dir"*; do
    case $(basename "$file") in gpui-kit.d.ts | jsconfig.json) continue ;; esac
    [ -f "$file" ] && ln -f "$file" "$target/"
  done
done

for layout in "$here"/layouts/*.json; do
  target=$home/layouts/$(basename "$layout")
  if [ "${1:-}" = --remove ]; then
    rm -f "$target"
  else
    ln -sf "$layout" "$target"
  fi
done
